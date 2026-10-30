import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HostDirEntry, MenuItemSpec, MessageBoxSpec } from '../../../shared/remote-access';
import { Icon } from '../components/Icon';
import { ICONS } from '../components/icons';
import { fmtDateTime } from '../format';
import type { ShellController } from './controller';
import { useThisDevice } from './device-flows';
import './desktop-device.css';
import { filterLabel, messageCancelId, messageDefaultId, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser, type LocalMessage } from './file-flows';
import { shortcutText, type MenuNav } from './menu-model';
import { useMenuState } from './menu-state';
import { childStack, frontWindow, isBlocked, mainWindow, topModal, useShellState, windowSrc, type OpenDialog, type OpenMenu, type PathRequest, type WebWindow } from './store';

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
  useEffect(() => {
    if (!device) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [device, controller]);

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
      const inside = keepInside(old, area);
      const next = { ...old, ...inside };
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

  return (
    <div className={`ws-root${dragging ? ' ws-dragging' : ''}`}>
      <div className="ws-desktop" ref={areaRef}>
        {main && (
          <div className={`ws-main${front?.w === main.w ? ' active' : ''}`} inert={isBlocked(s, main.w) || shellModal}>
            {main.menu && <MenuBar controller={controller} win={main} />}
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
            flash={flash === win.w}
            backdrop={modal?.w === win.w}
            onMove={(r) => move(win.w, r)}
            onToggleMax={() => toggleMax(win)}
            onDragging={setDragging}
          />
        ))}
      </div>
      <div className="ws-taskbar" role="toolbar" aria-label="Windows" inert={shellModal}>
        {s.windows.length > 1 &&
          s.windows.map((win) => (
            <button key={win.w} className={`ws-task${front?.w === win.w ? ' active' : ''}`} onClick={() => controller.activate(win.w)}>
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
        <PopupMenu key={m.menuId} controller={controller} menu={m} />
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
      {s.toasts.length > 0 && (
        <div className="ws-toasts" aria-live="polite">
          {s.toasts.map((t) => (
            <div key={t.id} className="ws-toast" role="status" onClick={() => controller.openToast(t)}>
              <div className="ws-toast-title">{t.title}</div>
              {t.body && <div className="ws-toast-body">{t.body}</div>}
              <CloseButton
                className="ws-toast-close"
                onClick={(e) => {
                  e.stopPropagation();
                  controller.closeToast(t.id);
                }}
              />
            </div>
          ))}
        </div>
      )}
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

function CloseButton({ onClick, className = 'ws-close' }: { onClick: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button className={className} aria-label="Close" onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    </button>
  );
}

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

interface ChildWindowProps {
  controller: ShellController;
  win: WebWindow;
  rect: Rect;
  area: Area;
  z: number;
  active: boolean;
  blocked: boolean;
  flash: boolean;
  /** The modal window in front: it dims and blocks what's behind it. */
  backdrop: boolean;
  onMove: (r: Rect) => void;
  onToggleMax: () => void;
  onDragging: (on: boolean) => void;
}

function ChildWindow({ controller, win, rect, area, z, active, blocked, flash, backdrop, onMove, onToggleMax, onDragging }: ChildWindowProps) {
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
      {backdrop && <div className="ws-backdrop" style={{ zIndex: z - 1 }} onPointerDown={() => controller.flashFront()} />}
      <div
        className={`ws-window${active ? ' active' : ''}${flash ? ' flash' : ''}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: z }}
        role="dialog"
        aria-modal={win.modal || undefined}
        aria-label={win.title}
        inert={blocked}
        onPointerDown={() => controller.activate(win.w)}
      >
        <div className="ws-titlebar" onPointerDown={(e) => drag(e, 'move')} onDoubleClick={onToggleMax}>
          <span className="ws-title">{win.title}</span>
          <CloseButton onClick={() => controller.close(win.w)} />
        </div>
        {win.menu && <MenuBar controller={controller} win={win} />}
        <WindowFrame controller={controller} win={win} />
        {win.resizable && EDGES.map((edge) => <div key={edge} className={`ws-resize ws-resize-${edge}`} onPointerDown={(e) => drag(e, edge)} />)}
      </div>
    </>
  );
}

// ---------- menus ----------

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const DOT = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" fill="currentColor" />
  </svg>
);
const CHEVRON = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3.5 1.5L7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

interface MenuListProps {
  nav: MenuNav;
  depth: number;
  isMac: boolean;
  onHover: (depth: number, index: number) => void;
  onChoose: (depth: number, index: number) => void;
  /** The outermost list's page position; submenus sit next to their item. */
  at?: { x: number; y: number };
}

function MenuList({ nav, depth, isMac, onHover, onChoose, at }: MenuListProps) {
  const level = nav[depth];
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ dx: 0, dy: 0, flip: false });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Kept on screen: measured where it would be without the last shift.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = r.left - fitRef.current.dx;
    const right = r.right - fitRef.current.dx;
    const top = r.top - fitRef.current.dy;
    const bottom = r.bottom - fitRef.current.dy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const flip = depth > 0 && (fitRef.current.flip || right > vw - 4);
    const dx = depth === 0 && right > vw - 4 ? Math.max(vw - 4 - right, 4 - left) : 0;
    const dy = bottom > vh - 4 ? Math.max(vh - 4 - bottom, 4 - top) : 0;
    setFit({ dx, dy, flip });
  }, [level?.items, depth]);
  if (!level) return null;
  const style: React.CSSProperties = at
    ? { position: 'fixed', left: at.x + fit.dx, top: at.y + fit.dy }
    : { position: 'absolute', top: -5 + fit.dy, ...(fit.flip ? { right: '100%' } : { left: '100%' }) };
  return (
    <div ref={ref} className="ws-menu" role="menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {level.items.map((it, i) =>
        it.type === 'separator' ? (
          <div key={it.id} className="ws-menu-sep" role="separator" />
        ) : (
          <div
            key={it.id}
            role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
            aria-checked={it.type === 'checkbox' || it.type === 'radio' ? !!it.checked : undefined}
            aria-disabled={!it.enabled || undefined}
            aria-haspopup={it.type === 'submenu' || undefined}
            className={`ws-menu-item${i === level.active ? ' active' : ''}${it.enabled ? '' : ' disabled'}`}
            onPointerEnter={() => onHover(depth, i)}
            onClick={(e) => {
              e.stopPropagation();
              onChoose(depth, i);
            }}
          >
            <span className="ws-menu-check">{it.checked ? (it.type === 'radio' ? DOT : it.type === 'checkbox' ? CHECK : null) : null}</span>
            <span className="ws-menu-label">{it.label}</span>
            <span className="ws-menu-key">{shortcutText(it, isMac)}</span>
            <span className="ws-menu-arrow">{it.type === 'submenu' ? CHEVRON : null}</span>
            {it.type === 'submenu' && level.active === i && nav[depth + 1] && (
              <MenuList nav={nav} depth={depth + 1} isMac={isMac} onHover={onHover} onChoose={onChoose} />
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** A window's menu bar: File, Task, View… */
function MenuBar({ controller, win }: { controller: ShellController; win: WebWindow }) {
  const items = win.menu ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const close = () => {
    setOpen(null);
    menu.reset();
  };
  const neighbour = (from: number, dir: 1 | -1): number => {
    for (let k = 1; k <= items.length; k++) {
      const i = (from + dir * k + items.length) % items.length;
      if (items[i]?.enabled && items[i].submenu?.length) return i;
    }
    return from;
  };
  const openAt = (i: number, byKeyboard: boolean) => {
    const top = items[i];
    if (!top?.enabled || !top.submenu?.length) return;
    setOpen(i);
    menu.open(top.submenu, byKeyboard);
    buttons.current[i]?.focus();
  };
  const menu = useMenuState({
    pick: (item) => {
      close();
      controller.pick(win.w, win.w, item);
    },
    close,
    prev: () => open !== null && openAt(neighbour(open, -1), true),
    next: () => open !== null && openAt(neighbour(open, 1), true),
  });
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [isOpen, controller]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (menu.key(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, menu]);
  // The menu went away under it (a new menu bar from the server): close.
  useEffect(() => {
    if (open !== null && !items[open]?.submenu) close();
  });

  /** The top-level item under the pointer while a menu is open (the catcher covers the bar). */
  const hit = (x: number, y: number): number =>
    buttons.current.findIndex((b) => {
      const r = b?.getBoundingClientRect();
      return !!r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
  const anchor = open !== null ? buttons.current[open]?.getBoundingClientRect() : undefined;

  return (
    <div className="ws-menubar" role="menubar">
      {items.map((top, i) => (
        <button
          key={top.id}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          className={`ws-menubar-item${open === i ? ' open' : ''}`}
          role="menuitem"
          aria-haspopup={!!top.submenu || undefined}
          aria-expanded={open === i}
          disabled={!top.enabled}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (open === i) close();
            else openAt(i, false);
          }}
          onClick={() => {
            // A top-level item without a menu of its own is picked like any other.
            if (!top.submenu) controller.pick(win.w, win.w, top);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && open === null) {
              e.preventDefault();
              openAt(i, true);
            }
          }}
        >
          {top.label}
        </button>
      ))}
      {open !== null &&
        anchor &&
        createPortal(
          <div
            className="ws-catcher"
            onPointerDown={(e) => {
              const i = hit(e.clientX, e.clientY);
              if (i >= 0 && i !== open) openAt(i, false);
              else close();
            }}
            onPointerMove={(e) => {
              const i = hit(e.clientX, e.clientY);
              if (i >= 0 && i !== open && items[i]?.submenu) openAt(i, false);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <MenuList nav={menu.nav} depth={0} isMac={controller.isMac} onHover={menu.hover} onChoose={menu.choose} at={{ x: anchor.left, y: anchor.bottom }} />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A context menu the computer popped up over a window. */
function PopupMenu({ controller, menu: m }: { controller: ShellController; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const box = useRef<HTMLDivElement>(null);
  const menu = useMenuState({
    pick: (item: MenuItemSpec) => controller.pick(m.menuId, m.w, item),
    close: () => controller.dismissMenu(m.menuId),
  });
  useLayoutEffect(() => menu.open(m.items, false), [m.items]);
  useEffect(() => box.current?.focus(), []);
  return createPortal(
    <div
      className="ws-catcher"
      onPointerDown={() => controller.dismissMenu(m.menuId)}
      onContextMenu={(e) => {
        e.preventDefault();
        controller.dismissMenu(m.menuId);
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="ws-menu-focus"
        onKeyDown={(e) => {
          if (menu.key(e.key)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <MenuList nav={menu.nav} depth={0} isMac={controller.isMac} onHover={menu.hover} onChoose={menu.choose} at={at} />
      </div>
    </div>,
    document.body,
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
        <div className="ws-titlebar">
          <span className="ws-title">{title}</span>
          <CloseButton onClick={onClose} />
        </div>
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
function MessageBox({ spec, onAnswer }: { spec: MessageBoxSpec; onAnswer: (response: number, checkboxChecked: boolean) => void }) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  const def = messageDefaultId(spec);
  return (
    <ShellDialog title={spec.title || 'Looper'} width={460} className="ws-msgbox" onClose={() => onAnswer(messageCancelId(spec), checked)}>
      <div className="ws-msgbox-body">
        <MessageIcon type={spec.type} />
        <div className="ws-msgbox-text">
          <div className="ws-msgbox-message">{spec.message}</div>
          {spec.detail && <div className="ws-msgbox-detail">{spec.detail}</div>}
          {spec.checkboxLabel && (
            <label className="checkbox-field">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              {spec.checkboxLabel}
            </label>
          )}
        </div>
      </div>
      <div className="editor-footer">
        {spec.buttons.map((label, i) => (
          <button key={i} className={`btn${i === def ? ' primary' : ''}`} autoFocus={i === def} onClick={() => onAnswer(i, checked)}>
            {label}
          </button>
        ))}
      </div>
    </ShellDialog>
  );
}

function LocalMessageBox({ msg }: { msg: LocalMessage | null }) {
  return msg ? <MessageBox spec={msg.spec} onAnswer={(r) => msg.onAnswer(r)} /> : null;
}

const fmtSize = (n: number | undefined): string => (n === undefined ? '' : `${Math.max(1, Math.ceil(n / 1024)).toLocaleString()} KB`);

const FILE_ICON = <path d="M4 1.5h5l3 3v10H4Z M9 1.5v3h3" />;
const UP_ICON = <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />;

/** The computer's folders: Up, the path, New Folder, and the list. */
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
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) list.current?.focus();
  }, [autoFocus]);
  const last = browser.selected[browser.selected.length - 1];
  const index = browser.entries.findIndex((e) => e.path === last);
  useEffect(() => setNaming(null), [browser.path]);
  useEffect(() => {
    if (last) list.current?.querySelector(`[data-path="${CSS.escape(last)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [last]);
  const onKey = (e: ReactKeyboardEvent) => {
    const n = browser.entries.length;
    const go = (i: number) => {
      e.preventDefault();
      if (n) browser.select(browser.entries[clamp(i, 0, n - 1)]);
    };
    if (e.key === 'ArrowDown') go(index + 1);
    else if (e.key === 'ArrowUp') go(index < 0 ? 0 : index - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault();
      onActivate(browser.entries[index]);
    } else if (e.key === 'Backspace') {
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
  return (
    <div className="ws-browser">
      <div className="ws-browser-bar">
        <button className="ws-icon-btn" aria-label="Up" disabled={browser.path === null} onClick={browser.up}>
          <Icon>{UP_ICON}</Icon>
        </button>
        <nav className="ws-crumbs" aria-label="Path">
          {browser.crumbs.map((c, i) => (
            <span key={c.path ?? ''} className="ws-crumb-part">
              {i > 0 && <span className="ws-crumb-sep">{CHEVRON}</span>}
              <button className="ws-crumb" onClick={() => browser.go(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        {newFolder && (
          <button className="btn small" disabled={browser.path === null || naming !== null} onClick={() => setNaming('New folder')}>
            New Folder
          </button>
        )}
      </div>
      <div ref={list} className="ws-files" role="listbox" aria-label="Files" aria-multiselectable={multi || undefined} tabIndex={0} onKeyDown={onKey}>
        {browser.path !== null && (
          <div className="ws-file ws-file-head" aria-hidden="true">
            <span />
            <span>Name</span>
            <span>Date modified</span>
            <span>Size</span>
          </div>
        )}
        {naming !== null && (
          <div className="ws-file editing">
            <Icon>{ICONS.folder}</Icon>
            <input
              autoFocus
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
          </div>
        )}
        {browser.entries.map((entry) => (
          <div
            key={entry.path}
            data-path={entry.path}
            role="option"
            aria-selected={browser.selected.includes(entry.path)}
            className={`ws-file${browser.selected.includes(entry.path) ? ' selected' : ''}`}
            onClick={(e) => browser.select(entry, { toggle: e.ctrlKey || e.metaKey })}
            onDoubleClick={() => onActivate(entry)}
          >
            <Icon>{entry.dir ? ICONS.folder : FILE_ICON}</Icon>
            <span className="ws-file-name">{entry.name}</span>
            <span className="muted">{entry.modifiedAt ? fmtDateTime(entry.modifiedAt) : ''}</span>
            <span className="muted ws-file-size">{entry.dir ? '' : fmtSize(entry.size)}</span>
          </div>
        ))}
        {!browser.loading && browser.entries.length === 0 && naming === null && <div className="ws-files-empty muted">This folder is empty.</div>}
      </div>
    </div>
  );
}

function FileDialog({ controller, dialog }: { controller: ShellController; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const input = useRef<HTMLInputElement>(null);
  const onDevice = f.source === 'device';
  return (
    <ShellDialog title={f.title} width={760} height={onDevice ? undefined : 540} className="ws-filedialog" onClose={f.cancel}>
      {f.sources.length > 1 && (
        <div className="tabs ws-sources" role="tablist">
          {f.sources.map((src) => (
            <button key={src} role="tab" aria-selected={f.source === src} className={`tab${f.source === src ? ' active' : ''}`} onClick={() => f.setSource(src)}>
              {src === 'computer' ? 'This Computer' : 'This Device'}
            </button>
          ))}
        </div>
      )}
      {onDevice ? (
        // Save to This Device needs only the file name below.
        f.kind === 'open' && (
          <div className="ws-device">
            <button className="btn primary" autoFocus disabled={!!f.busy} onClick={() => input.current?.click()}>
              {f.multi ? 'Choose Files…' : 'Choose File…'}
            </button>
            <input
              ref={input}
              type="file"
              hidden
              multiple={f.multi}
              accept={f.extensions ? f.extensions.map((x) => `.${x}`).join(',') : undefined}
              onChange={(e) => {
                f.fromDevice([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            {f.busy && <div className="muted">{f.busy}</div>}
          </div>
        )
      ) : (
        <HostBrowserView browser={f.browser} multi={f.multi} onActivate={f.activate} newFolder autoFocus={f.kind === 'open'} />
      )}
      {(f.kind === 'save' || f.extensions) && (
        <div className="ws-filename">
          {f.kind === 'save' && (
            <label className="field">
              <span className="field-label">File name</span>
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
            </label>
          )}
          <div className="muted ws-filter">{filterLabel(dialog.spec.filters)}</div>
        </div>
      )}
      <div className="editor-footer">
        {!(onDevice && f.kind === 'open') && (
          <button className="btn primary" disabled={!f.canConfirm} onClick={f.confirm}>
            {f.confirmLabel}
          </button>
        )}
        <button className="btn" onClick={f.cancel}>
          Cancel
        </button>
      </div>
      <LocalMessageBox msg={f.message} />
    </ShellDialog>
  );
}

/** This Device: the name it was paired as, the computer, notifications, and Unpair. */
function ThisDeviceWindow({ controller, onClose }: { controller: ShellController; onClose: () => void }) {
  const d = useThisDevice(controller);
  const usable = d.push === 'on' || d.push === 'off';
  return (
    <ShellDialog title="This Device" width={380} className="ws-thisdevice" onClose={onClose}>
      <div className="ws-thisdevice-body">
        <div className="ws-thisdevice-name">{d.name || '\u00a0'}</div>
        <div className="muted">Paired with {d.computer}</div>
        <label className="checkbox-field">
          <input type="checkbox" checked={d.push === 'on'} disabled={!usable || d.busy} onChange={(e) => d.setNotifications(e.target.checked)} />
          Notifications
        </label>
      </div>
      <div className="editor-footer">
        <button className="btn" onClick={d.unpair}>
          Unpair This Device
        </button>
        <button className="btn primary" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
      <LocalMessageBox msg={d.message} />
    </ShellDialog>
  );
}

/** A folder or file on the computer the user asked to see (Open Working Directory, Copy Path's neighbours…). */
function PathDialog({ controller, req }: { controller: ShellController; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  if (!p.browser) return <LocalMessageBox msg={p.message} />;
  return (
    <ShellDialog title={p.name} width={760} height={540} className="ws-filedialog" onClose={p.close}>
      <HostBrowserView browser={p.browser} multi={false} onActivate={p.activate} newFolder={false} autoFocus />
      <div className="editor-footer">
        <button className="btn primary" disabled={!p.canDownload} onClick={p.download}>
          Download
        </button>
        <button className="btn" onClick={p.openOnComputer}>
          Open on Computer
        </button>
        <button className="btn" onClick={p.close}>
          Close
        </button>
      </div>
      <LocalMessageBox msg={p.message} />
    </ShellDialog>
  );
}
