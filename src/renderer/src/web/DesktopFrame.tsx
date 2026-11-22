import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { NOTIFY_TOPICS, type DeviceNotifications, type HostDirEntry, type MessageBoxSpec } from '../../../shared/remote-access';
import { DataTable, type DataCol } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { ICONS } from '../components/icons';
import { MenuBar } from '../components/MenuBar';
import { fmtDateTime, fmtSize } from '../format';
import { ComputerMenu } from './ComputerMenu';
import { useOverlay, type ShellController } from './controller';
import { useDeviceForm } from './device-form';
import './desktop-device.css';
import { DevicePick } from './DevicePick';
import { filterLabel, HOST_COMPUTER, messageResult, placeGroup } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser } from './file-flows';
import { FileViewContent, viewerLayout } from './file-view';
import { LocalMessageBox, useMessageAnswer, type MessageBoxProps } from './message-box';
import { Notifications } from './Notifications';
import { PathBar } from './PathBar';
import { CloseButton, TitleBar } from './ws-titlebar';
import { Tabs } from '../components/Tabs';
import { CheckboxField, Field, FormGroup } from '../components/ui';
import { WindowActions } from '../components/WindowActions';
import { PLACE_ICONS } from './places';
import { childStack, frontWindow, isBlocked, mainWindow, topModal, useShellState, windowSrc, type OpenDialog, type PathRequest, type WebWindow } from './store';

// ---------- window geometry (desktop only) ----------

const TITLE_H = 32;
const MENU_H = 28;
const MIN_W = 280;
const MIN_H = 160;
const MARGIN = 8;
const CASCADE = 24;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Placed extends Rect {
  /** The spec size it was placed for: a new one (the setup window becoming its builder) places it again. */
  specW: number;
  specH: number;
  /** Maximized: the size to go back to. */
  restore?: Rect;
}

interface Area {
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A new window: its spec size (the page's, plus the title bar) fit in the page, centered, stepped off any window already there. */
function placeWindow(win: WebWindow, area: Area, others: Rect[]): Rect {
  const width = Math.round(clamp(win.width + 2, Math.min(MIN_W, area.width), area.width - 2 * MARGIN));
  const height = Math.round(clamp(win.height + TITLE_H + (win.menu ? MENU_H : 0) + 2, Math.min(MIN_H, area.height), area.height - 2 * MARGIN));
  let x = Math.round((area.width - width) / 2);
  let y = Math.round((area.height - height) / 2);
  while (others.some((o) => o.x === x && o.y === y) && x + width + CASCADE <= area.width && y + height + CASCADE <= area.height) {
    x += CASCADE;
    y += CASCADE;
  }
  return { x, y, width, height };
}

/** Keep a window's title bar reachable after the page got smaller. */
function keepInside(r: Rect, area: Area): Rect {
  const width = Math.min(r.width, area.width);
  const height = Math.min(r.height, area.height);
  return { width, height, x: clamp(r.x, Math.min(0, 100 - width), Math.max(0, area.width - 100)), y: clamp(r.y, 0, Math.max(0, area.height - TITLE_H)) };
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function dragRect(mode: 'move' | Edge, r: Rect, dx: number, dy: number, area: Area): Rect {
  if (mode === 'move') return keepInside({ ...r, x: r.x + dx, y: r.y + dy }, area);
  let { x, y, width, height } = r;
  if (mode.includes('e')) width = clamp(r.width + dx, MIN_W, area.width - r.x);
  if (mode.includes('s')) height = clamp(r.height + dy, MIN_H, area.height - r.y);
  if (mode.includes('w')) {
    width = clamp(r.width - dx, MIN_W, r.x + r.width);
    x = r.x + r.width - width;
  }
  if (mode.includes('n')) {
    height = clamp(r.height - dy, MIN_H, r.y + r.height);
    y = r.y + r.height - height;
  }
  return { x, y, width, height };
}

function useAreaSize(ref: React.RefObject<HTMLDivElement | null>): Area {
  const [area, setArea] = useState<Area>({ width: window.innerWidth, height: window.innerHeight });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setArea((a) => (a.width === el.clientWidth && a.height === el.clientHeight ? a : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return area;
}

// ---------- the frame ----------

/** The desktop browser's look: the main window fills the page, the others are dialogs over it. */
export function DesktopFrame({ controller }: { controller: ShellController }) {
  const s = useShellState(controller.store);
  const main = mainWindow(s);
  const stack = childStack(s);
  const front = frontWindow(s);
  const modal = topModal(s);
  const shellModal = s.dialogs.length > 0 || s.paths.length > 0;
  const areaRef = useRef<HTMLDivElement>(null);
  const area = useAreaSize(areaRef);
  const placed = useRef(new Map<string, Placed>());
  const [, redraw] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [device, setDevice] = useState(false);
  useOverlay(controller, device);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    controller.onFlash = (w) => {
      setFlash(w);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(null), 450);
    };
    return () => {
      controller.onFlash = null;
      clearTimeout(timer);
    };
  }, [controller]);

  // Placed while drawing: a window shows at its place from its first frame.
  const live = new Set(stack.map((x) => x.w));
  for (const w of [...placed.current.keys()]) if (!live.has(w)) placed.current.delete(w);
  const rectOf = (win: WebWindow): Placed => {
    const old = placed.current.get(win.w);
    if (old && old.specW === win.width && old.specH === win.height) {
      // A maximized window follows the page's size.
      const next = old.restore ? { ...old, x: 0, y: 0, width: area.width, height: area.height } : { ...old, ...keepInside(old, area) };
      placed.current.set(win.w, next);
      return next;
    }
    const others = [...placed.current.entries()].filter(([w]) => w !== win.w).map(([, r]) => r);
    const next: Placed = { ...placeWindow(win, area, others), specW: win.width, specH: win.height };
    placed.current.set(win.w, next);
    return next;
  };
  const move = (w: string, r: Rect) => {
    const old = placed.current.get(w);
    if (!old) return;
    placed.current.set(w, { ...old, ...r, restore: undefined });
    redraw((n) => n + 1);
  };
  const toggleMax = (win: WebWindow) => {
    const old = placed.current.get(win.w);
    if (!old || !win.resizable) return;
    placed.current.set(win.w, old.restore ? { ...old, ...old.restore, restore: undefined } : { ...old, x: 0, y: 0, width: area.width, height: area.height, restore: { x: old.x, y: old.y, width: old.width, height: old.height } });
    redraw((n) => n + 1);
  };
  const minimized = new Set(s.minimized);
  const minimize = (w: string) => {
    controller.store.dispatch({ t: 'minimize', w });
    const next = frontWindow(controller.state);
    if (next) controller.activate(next.w);
  };
  const restore = (w: string) => {
    controller.store.dispatch({ t: 'restore', w });
    controller.session.focusWindow(w);
  };
  /** A click on what the modal window blocks: the main window minimizes it (it still blocks), another window flashes it. */
  const blockedClick = (onMain: boolean) => {
    if (!modal) return;
    if (minimized.has(modal.w)) restore(modal.w);
    else if (onMain) minimize(modal.w);
    else controller.flashFront();
  };
  const onBackdrop = (e: ReactPointerEvent) => {
    const box = areaRef.current?.getBoundingClientRect();
    const x = e.clientX - (box?.left ?? 0);
    const y = e.clientY - (box?.top ?? 0);
    const onChild = stack.some((win) => {
      const r = placed.current.get(win.w);
      return win.w !== modal?.w && !minimized.has(win.w) && !!r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    });
    blockedClick(!onChild);
  };
  const taskClick = (win: WebWindow) => {
    if (minimized.has(win.w)) restore(win.w);
    else if (modal && modal.w !== win.w) blockedClick(win.w === main?.w);
    else controller.activate(win.w);
  };

  return (
    <div className={`ws-root${dragging ? ' ws-dragging' : ''}`}>
      <div className="ws-desktop" ref={areaRef}>
        {main && (
          <div className={`ws-main${front?.w === main.w ? ' active' : ''}`} inert={isBlocked(s, main.w) || shellModal}>
            {main.menu && <MenuBar items={main.menu} isMac={controller.isMac} onPick={(item) => controller.pick(main.w, main.w, item)} onOpenChange={(open) => controller.setOverlay(open)} />}
            <WindowFrame controller={controller} win={main} />
          </div>
        )}
        {stack.map((win, i) => (
          <ChildWindow
            key={win.w}
            controller={controller}
            win={win}
            rect={rectOf(win)}
            area={area}
            z={10 + i * 2}
            active={front?.w === win.w}
            blocked={isBlocked(s, win.w) || shellModal}
            minimized={minimized.has(win.w)}
            flash={flash === win.w}
            backdrop={modal?.w === win.w}
            onBackdrop={onBackdrop}
            onMove={(r) => move(win.w, r)}
            onToggleMax={() => toggleMax(win)}
            onMinimize={() => minimize(win.w)}
            onDragging={setDragging}
          />
        ))}
      </div>
      <div className="ws-taskbar" role="toolbar" aria-label="Windows" inert={shellModal}>
        {s.windows.map((win) => (
          <button key={win.w} className={`ws-task${front?.w === win.w ? ' active' : ''}`} onClick={() => taskClick(win)}>
            {win.title || 'Looper'}
          </button>
        ))}
        <button className={`ws-task ws-device-btn${device ? ' active' : ''}`} onClick={() => setDevice(true)}>
          This Device
        </button>
      </div>
      {device && <ThisDeviceWindow controller={controller} onClose={() => setDevice(false)} />}
      {!s.connected && <div className="ws-connection" role="status">{s.everConnected ? 'Reconnecting…' : 'Connecting…'}</div>}
      {s.menus.map((m) => (
        <ComputerMenu key={m.menuId} controller={controller} menu={m} />
      ))}
      {s.dialogs.map((d) =>
        d.kind === 'message' ? (
          <MessageBox key={d.dialogId} spec={d.spec} onAnswer={(r, c) => controller.answer(d.dialogId, messageResult(r, c))} />
        ) : (
          <FileDialog key={d.dialogId} controller={controller} dialog={d} />
        ),
      )}
      {s.paths.map((p) => (
        <PathDialog key={p.id} controller={controller} req={p} />
      ))}
      <Notifications controller={controller} toasts={s.toasts} />
    </div>
  );
}

function WindowFrame({ controller, win }: { controller: ShellController; win: WebWindow }) {
  return (
    <iframe
      key={`${win.w}:${win.nonce}`}
      ref={controller.frameRef(win.w)}
      className="ws-frame"
      title={win.title}
      src={windowSrc(win)}
      allow="clipboard-read; clipboard-write"
    />
  );
}

/** Minimize or Maximize/Restore in a title bar, drawn like Windows' own. */
function CaptionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="ws-caption" aria-label={label} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
        {children}
      </svg>
    </button>
  );
}

const MINIMIZE_GLYPH = <path d="M0 5.5h10" />;
const MAXIMIZE_GLYPH = <rect x="0.5" y="0.5" width="9" height="9" />;
const RESTORE_GLYPH = (
  <>
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5v-2h7v7h-2" />
  </>
);

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

interface ChildWindowProps {
  controller: ShellController;
  win: WebWindow;
  rect: Placed;
  area: Area;
  z: number;
  active: boolean;
  blocked: boolean;
  /** In the window list only: hidden, its page kept. */
  minimized: boolean;
  flash: boolean;
  /** The modal window in front: it dims and blocks what's behind it. */
  backdrop: boolean;
  onBackdrop: (e: ReactPointerEvent) => void;
  onMove: (r: Rect) => void;
  onToggleMax: () => void;
  onMinimize: () => void;
  onDragging: (on: boolean) => void;
}

function ChildWindow({ controller, win, rect, area, z, active, blocked, minimized, flash, backdrop, onBackdrop, onMove, onToggleMax, onMinimize, onDragging }: ChildWindowProps) {
  const drag = (e: ReactPointerEvent<HTMLElement>, mode: 'move' | Edge) => {
    if (e.button !== 0) return;
    e.preventDefault();
    controller.activate(win.w);
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY, r: { ...rect } };
    el.setPointerCapture(e.pointerId);
    onDragging(true);
    const onMoveEv = (ev: PointerEvent) => onMove(dragRect(mode, start.r, ev.clientX - start.x, ev.clientY - start.y, area));
    const up = () => {
      el.removeEventListener('pointermove', onMoveEv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onDragging(false);
      controller.focusFront();
    };
    el.addEventListener('pointermove', onMoveEv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <>
      {backdrop && <div className={`ws-backdrop${minimized ? ' minimized' : ''}`} style={{ zIndex: z - 1 }} onPointerDown={onBackdrop} />}
      <div
        className={`ws-window${active ? ' active' : ''}${flash ? ' flash' : ''}${minimized ? ' minimized' : ''}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: z }}
        role="dialog"
        aria-modal={win.modal || undefined}
        aria-label={win.title}
        aria-hidden={minimized || undefined}
        inert={blocked || minimized}
        onPointerDown={() => controller.activate(win.w)}
      >
        <div className="ws-titlebar" onPointerDown={(e) => drag(e, 'move')} onDoubleClick={onToggleMax}>
          <span className="ws-title">{win.title}</span>
          <CaptionButton label="Minimize" onClick={onMinimize}>
            {MINIMIZE_GLYPH}
          </CaptionButton>
          {win.resizable && (
            <CaptionButton label={rect.restore ? 'Restore Down' : 'Maximize'} onClick={onToggleMax}>
              {rect.restore ? RESTORE_GLYPH : MAXIMIZE_GLYPH}
            </CaptionButton>
          )}
          <CloseButton onClick={() => controller.close(win.w)} />
        </div>
        {win.menu && <MenuBar items={win.menu} isMac={controller.isMac} onPick={(item) => controller.pick(win.w, win.w, item)} onOpenChange={(open) => controller.setOverlay(open)} />}
        <WindowFrame controller={controller} win={win} />
        {/* Maximized, it fills the page: its edges don't resize it, as on Windows. */}
        {win.resizable && !rect.restore && EDGES.map((edge) => <div key={edge} className={`ws-resize ws-resize-${edge}`} onPointerDown={(e) => drag(e, edge)} />)}
      </div>
    </>
  );
}

// ---------- dialogs ----------

function ShellDialog({ title, width, height, onClose, className, children }: { title: string; width: number; height?: number; onClose: () => void; className?: string; children: ReactNode }) {
  return (
    <div className="ws-modal-layer">
      <div
        className={`ws-dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${width}px, calc(100vw - 24px))`, ...(height ? { height: `min(${height}px, calc(100vh - 24px))` } : {}) }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <TitleBar title={title} onClose={onClose} />
        {children}
      </div>
    </div>
  );
}

function MessageIcon({ type }: { type: MessageBoxSpec['type'] }) {
  if (!type || type === 'none') return null;
  const glyph = type === 'error' ? 'M11 11l10 10M21 11l-10 10' : type === 'question' ? 'M12.5 12.5a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.2-1.5 2.3v.5M16 22.2v.3' : 'M16 10v8M16 21.7v.3';
  return (
    <svg className={`ws-msg-icon ${type}`} width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      {type === 'warning' ? <path d="M16 3L30 28H2Z" className="shape" /> : <circle cx="16" cy="16" r="14" className="shape" />}
      <path d={type === 'info' ? 'M16 14v8M16 9.7v.3' : glyph} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** A message box: the computer's (showMessageBox) or the shell's own. */
function MessageBox({ spec, onAnswer }: MessageBoxProps) {
  const { checked, setChecked, answer } = useMessageAnswer(spec, onAnswer);
  const def = spec.defaultId;
  return (
    <ShellDialog title={spec.title || 'Looper'} width={460} className="ws-msgbox" onClose={() => answer(spec.cancelId)}>
      <div className="ws-msgbox-body">
        <MessageIcon type={spec.type} />
        <div className="ws-msgbox-text">
          <div className="ws-msgbox-message">{spec.message}</div>
          {spec.detail && <div className="ws-msgbox-detail">{spec.detail}</div>}
          {spec.checkboxLabel && (
            <CheckboxField label={spec.checkboxLabel} checked={checked} onChange={setChecked} />
          )}
        </div>
      </div>
      <div className="editor-footer">
        {spec.buttons.map((label, i) => (
          <button key={i} className={`btn${i === def ? ' primary' : ''}`} autoFocus={i === def} onClick={() => answer(i)}>
            {label}
          </button>
        ))}
      </div>
    </ShellDialog>
  );
}


const FILE_ICON = <path d="M4 1.5h5l3 3v10H4Z M9 1.5v3h3" />;
const UP_ICON = <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />;
const BACK_ICON = <path d="M13 8H3M7.5 3.5L3 8l4.5 4.5" />;
const FORWARD_ICON = <path d="M3 8h10M8.5 3.5L13 8l-4.5 4.5" />;

/** An icon button in the browser's bar; its label shows as its tooltip too. */
function BarButton({ label, icon, disabled, onClick }: { label: string; icon: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="ws-icon-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Icon>{icon}</Icon>
    </button>
  );
}

/** A row's key: its path, made fit for an element's id. */
const rowId = (path: string): string => encodeURIComponent(path);
const pathOf = (id: string): string => decodeURIComponent(id);

const FILE_COLS: readonly DataCol<HostDirEntry>[] = [
  {
    label: 'Name',
    min: 120,
    title: (e) => e.name,
    cell: (e) => (
      <span className="ws-file-name">
        <Icon>{e.place ? PLACE_ICONS[e.place] : e.dir ? ICONS.folder : FILE_ICON}</Icon>
        {e.name}
      </span>
    ),
  },
  { label: 'Date modified', width: 150, cellClass: 'muted', cell: (e) => (e.modifiedAt ? fmtDateTime(e.modifiedAt) : '') },
  { label: 'Size', width: 80, num: true, cellClass: 'muted', cell: (e) => (e.dir || e.size === undefined ? '' : fmtSize(e.size)) },
];

/**
 * The host computer's folders: Back, Forward, Up, Home, the path, New Folder, and the list (a DataTable, several
 * rows selectable when the dialog picks several). Alt+Left, Alt+Right and Alt+Up go Back, Forward and Up, and
 * Backspace in the list goes Up, as in File Explorer.
 */
function HostBrowserView({
  browser,
  multi,
  onActivate,
  newFolder,
  autoFocus,
}: {
  browser: HostBrowser;
  multi: boolean;
  onActivate: (e: HostDirEntry) => void;
  newFolder: boolean;
  autoFocus: boolean;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  /** The row the keyboard is on among several selected; the last one selected otherwise. */
  const [lead, setLead] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  useEffect(() => {
    if (autoFocus) list.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    setNaming(null);
    setLead(null);
  }, [browser.path]);
  const focus = lead !== null && browser.selected.includes(lead) ? lead : browser.selected[browser.selected.length - 1];
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') browser.back();
      else if (e.key === 'ArrowRight') browser.forward();
      else browser.up();
    } else if (e.key === 'Backspace' && e.target === list.current) {
      e.preventDefault();
      browser.up();
    }
  };
  const create = async () => {
    if (naming === null) return;
    if (await browser.makeDir(naming)) {
      setNaming(null);
      list.current?.focus();
    }
  };
  const places = browser.path === null;
  return (
    <div className="ws-browser" onKeyDown={onKey}>
      <div className="ws-browser-bar">
        <BarButton label="Back" icon={BACK_ICON} disabled={!browser.canBack} onClick={browser.back} />
        <BarButton label="Forward" icon={FORWARD_ICON} disabled={!browser.canForward} onClick={browser.forward} />
        <BarButton label="Up" icon={UP_ICON} disabled={browser.path === null} onClick={browser.up} />
        <BarButton label="Home" icon={PLACE_ICONS.home} disabled={browser.home === null || browser.path === browser.home} onClick={() => browser.go(browser.home)} />
        <PathBar browser={browser} />
        {newFolder && <BarButton label="New Folder" icon={ICONS.newProject} disabled={browser.path === null || naming !== null} onClick={() => setNaming('New folder')} />}
      </div>
      <DataTable
        cols={FILE_COLS}
        rows={browser.entries}
        rowKey={(e) => rowId(e.path)}
        idPrefix={idPrefix}
        selected={focus ? rowId(focus) : null}
        onSelect={(e) => browser.select(e)}
        multiSelect={
          multi
            ? {
                keys: browser.selected.map(rowId),
                onChange: (keys, at) => {
                  setLead(pathOf(at));
                  browser.setSelection(keys.map(pathOf));
                },
              }
            : undefined
        }
        onOpen={onActivate}
        label="Files"
        groupOf={places ? (e) => placeGroup(e.place) : undefined}
        storageKey="host-files"
        wrapClass={`ws-files${places ? ' places' : ''}`}
        tableRef={list}
        empty={browser.loading || naming !== null ? null : <span className="ws-files-empty">This folder is empty.</span>}
        note={
          naming !== null && (
            <span className="ws-file-new">
              <Icon>{ICONS.folder}</Icon>
              <input
                autoFocus
                aria-label="New folder name"
                value={naming}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void create();
                  else if (e.key === 'Escape') {
                    setNaming(null);
                    list.current?.focus();
                  }
                }}
              />
            </span>
          )
        }
      />
    </div>
  );
}

function FileDialog({ controller, dialog }: { controller: ShellController; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const onDevice = f.source === 'device';
  return (
    <ShellDialog title={f.title} width={760} height={onDevice ? undefined : 540} className="ws-filedialog" onClose={f.cancel}>
      {f.sources.length > 1 && (
        <Tabs
          tabs={f.sources.map((src) => ({ id: src, label: src === 'computer' ? HOST_COMPUTER : 'This Device' }))}
          active={f.source}
          onSelect={(id) => f.setSource(id as (typeof f.sources)[number])}
          label="Location"
          className="ws-sources"
        />
      )}
      {onDevice ? (
        // Save to This Device needs only the file name below.
        f.kind === 'open' && (
          <DevicePick f={f} filters={dialog.spec.filters} label={['Choose File…', 'Choose Files…']} className="ws-device" buttonClass="btn primary" busyClass="muted" autoFocus />
        )
      ) : (
        <HostBrowserView browser={f.browser} multi={f.multi} onActivate={f.activate} newFolder autoFocus={f.kind === 'open'} />
      )}
      {(f.kind === 'save' || f.extensions) && (
        <div className="ws-filename">
          {f.kind === 'save' && (
            <Field label="File name">
              <input
                value={f.name}
                autoFocus
                onChange={(e) => f.setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    f.confirm();
                  }
                }}
              />
            </Field>
          )}
          <div className="muted ws-filter">{filterLabel(dialog.spec.filters)}</div>
        </div>
      )}
      {/* Open from This Device commits with Choose File…: the row has only Cancel, which abandons the open. */}
      {onDevice && f.kind === 'open' ? (
        <WindowActions cancel={f.cancel} />
      ) : (
        <WindowActions confirm={{ label: f.confirmLabel, run: f.confirm, disabled: !f.canConfirm }} cancel={f.cancel} />
      )}
      <LocalMessageBox msg={f.message} box={MessageBox} />
    </ShellDialog>
  );
}

/**
 * This Device: its name and notifications, saved with Save (Cancel leaves no change), the computer
 * it's paired with, and Unpair, a command of its own apart from the commit buttons.
 */
function ThisDeviceWindow({ controller, onClose }: { controller: ShellController; onClose: () => void }) {
  const d = useDeviceForm(controller);
  const [notify, setNotify] = useState<boolean | null>(null);
  /** The switches as changed here; null: as the computer has them. */
  const [topics, setTopics] = useState<DeviceNotifications | null>(null);
  const shownTopics = topics ?? d.notify;
  const named = !!d.nameText.trim();
  const save = () => {
    if (!named || d.busy) return;
    // Notifications first, still inside the click: turning them on asks for permission.
    const pushing = notify !== null && notify !== (d.push === 'on') ? d.setNotifications(notify) : Promise.resolve(true);
    const next = d.newName();
    void (async () => {
      if (!(await pushing)) return;
      if (topics && !(await d.saveNotify(topics))) return;
      if (next && !(await d.rename(next))) return;
      onClose();
    })();
  };
  return (
    <ShellDialog title="This Device" width={400} className="ws-thisdevice" onClose={onClose}>
      {/* Enter in the name runs Save through WindowActions, which stops the form's own submit; a submit that gets through saves the same way. */}
      <form
        className="ws-thisdevice-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="ws-thisdevice-body">
          <Field label="Name">
            <input autoFocus value={d.nameText} maxLength={64} onChange={(e) => d.setNameText(e.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">{HOST_COMPUTER}</span>
            <span className="ws-thisdevice-value">{d.computer || '\u00a0'}</span>
          </div>
          <FormGroup title="Notifications">
            <CheckboxField label="Allow notifications" note={d.hint} checked={notify ?? d.push === 'on'} disabled={!d.usable || d.busy} onChange={setNotify} />
            {NOTIFY_TOPICS.map((t) => (
              <CheckboxField
                key={t.id}
                label={t.label}
                checked={!!shownTopics?.[t.id]}
                disabled={!shownTopics || d.busy}
                onChange={(on) => shownTopics && setTopics({ ...shownTopics, [t.id]: on })}
              />
            ))}
          </FormGroup>
          <div className="ws-thisdevice-commands">
            <button type="button" className="btn" onClick={d.unpair}>
              Unpair This Device
            </button>
          </div>
        </div>
        <WindowActions confirm={{ label: 'Save', run: save, disabled: !named || d.busy }} cancel={onClose} />
      </form>
      <LocalMessageBox msg={d.message} box={MessageBox} />
    </ShellDialog>
  );
}

/** A folder or file on the host computer the user asked to see (Open Working Directory, an attachment clicked…). */
function PathDialog({ controller, req }: { controller: ShellController; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  // The focus starts in the viewer (Enter downloads, Esc closes), not in the window behind it.
  const viewer = useRef<HTMLDivElement>(null);
  const viewing = !!p.view;
  useEffect(() => {
    if (viewing) viewer.current?.focus();
  }, [viewing]);
  if (p.view) {
    const steps = p.steps;
    return (
      <ShellDialog title={p.name} width={900} height={680} className="ws-viewer" onClose={p.close}>
        <div ref={viewer} className={`ws-viewer-body${viewerLayout(p.view)}`} tabIndex={0}>
          <FileViewContent view={p.view} name={p.name} classes={{ note: 'muted ws-viewer-note', text: 'ws-viewer-text' }} image={(url) => <img className="ws-viewer-image" src={url} alt={p.name} />} />
        </div>
        <WindowActions
          confirm={{ label: 'Download to This Device', run: p.view.toDevice }}
          cancel={p.close}
          extras={[
            ...(steps
              ? [
                  { id: 'previous-image', label: 'Previous', disabled: steps.index <= 0, run: () => steps.go(steps.index - 1) },
                  { id: 'next-image', label: 'Next', disabled: steps.index >= steps.count - 1, run: () => steps.go(steps.index + 1) },
                ]
              : []),
            { id: 'download-to-host', label: `Download to ${HOST_COMPUTER}`, run: p.view.toHost },
          ]}
        />
        <LocalMessageBox msg={p.message} box={MessageBox} />
      </ShellDialog>
    );
  }
  if (!p.browser) return <LocalMessageBox msg={p.message} box={MessageBox} />;
  return (
    <ShellDialog title={p.name} width={760} height={540} className="ws-filedialog" onClose={p.close}>
      <HostBrowserView browser={p.browser} multi={false} onActivate={p.activate} newFolder={false} autoFocus />
      <WindowActions
        confirm={{ label: 'Download', run: p.download, disabled: !p.canDownload }}
        cancel={p.close}
        extras={[{ id: 'open-on-host', label: `Open on ${HOST_COMPUTER}`, run: p.openOnComputer }]}
      />
      <LocalMessageBox msg={p.message} box={MessageBox} />
    </ShellDialog>
  );
}
