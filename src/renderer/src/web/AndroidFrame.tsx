import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec, MessageBoxSpec } from '../../../shared/remote-access';
import { useConnection } from './connection';
import type { ShellController } from './controller';
import { OfflineBanner } from './OfflineBanner';
import { useThisDevice } from './device-flows';
import { messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser, type LocalMessage } from './file-flows';
import { AxisDrag } from './gestures';
import { CHECK, FileRows, FileViewBody } from './phone-files';
import { phoneMenu } from './more-menu';
import {
  deviceNoun,
  isLongMenu,
  menuGroups,
  actionMenu,
  moreFor,
  PhoneWindows,
  pickMore,
  Scrim,
  usePhoneShell,
  useSubmenus,
  type BackLayer,
  type OpenMore,
  type PhoneShell,
  type Screen,
} from './phone-shell';
import type { OpenDialog, OpenMenu, PathRequest, Toast } from './store';
import { barModel, dismissFor, plainLabel, type PageNavAction } from './nav-bar-model';
import { ARROW_BACK, CLOSE, MENU_OPEN, MdBarRow, NavIcon } from './NavBarRow';
import type { PageNavTabs } from './page-nav';
import { BarHostContext, NavBar, type NavBarProps } from '../components/NavBar';
import { TabIcon } from '../components/phone/tab-icons';
import './android.css';

const ARROW_RIGHT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor" />
  </svg>
);
const NEW_FOLDER = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 6h-8l-2-2H4c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z" fill="currentColor" />
  </svg>
);

/** Android, after Material 3: windows as screens with a top app bar, dialogs, and bottom sheets. */
export function AndroidFrame({ controller }: { controller: ShellController }) {
  const [more, setMore] = useState<OpenMore | null>(null);
  const [device, setDevice] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const local: BackLayer[] = [];
  if (device) local.push(() => setDevice(false));
  if (more) local.push(() => setMore(null));
  if (railOpen) local.push(() => setRailOpen(false));
  const shell = usePhoneShell(controller, 'android', local);
  const { s } = shell;
  const overlay = !!more || device || railOpen;
  useEffect(() => {
    if (!overlay) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [overlay, controller]);

  const openMore = (sc: Screen, button: HTMLElement) => setMore({ ...moreFor(sc, DEVICE_LABEL), w: sc.win.w, anchor: button.getBoundingClientRect() });
  const openActionMenu = (sc: Screen, action: PageNavAction, button: HTMLElement) => setMore({ ...actionMenu(action), w: sc.win.w, anchor: button.getBoundingClientRect() });

  return (
    <div ref={shell.rootRef} className={`ph-root android${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <PhoneWindows
        shell={shell}
        controller={controller}
        renderBar={(sc) => <TopBar shell={shell} controller={controller} sc={sc} onMore={openMore} onActionMenu={openActionMenu} onMenu={() => setRailOpen(true)} />}
        dragToDismiss={(p) => p === 'bottom-sheet'}
      />
      {railOpen && shell.top?.nav?.navigation && <ModalRail tabs={shell.top.nav.navigation} onClose={() => setRailOpen(false)} />}
      {!s.connected && !s.everConnected && (
        <div className="ph-connection" role="status">
          Connecting…
        </div>
      )}
      {device && <DeviceSheet controller={controller} onClose={() => setDevice(false)} />}
      {s.paths.map((p) => (
        <PathScreen key={p.id} controller={controller} shell={shell} req={p} />
      ))}
      {s.dialogs.map((d) =>
        d.kind === 'message' ? (
          <Dialog key={d.dialogId} spec={d.spec} onAnswer={(r, c) => controller.answer(d.dialogId, messageResult(r, c))} />
        ) : (
          <FileScreen key={d.dialogId} controller={controller} shell={shell} dialog={d} />
        ),
      )}
      {more && (
        <Menu
          items={more.items}
          style={{ right: Math.max(8, window.innerWidth - more.anchor.right), top: more.anchor.top }}
          onClose={() => setMore(null)}
          onPick={(item) => {
            setMore(null);
            pickMore(controller, more, item, () => setDevice(true));
          }}
        />
      )}
      {s.menus.map((m) => (
        <PopupMenu key={m.menuId} controller={controller} shell={shell} menu={m} />
      ))}
      <Snackbar controller={controller} toasts={s.toasts} ownsBottom={!!shell.top?.nav?.ownsBottom} />
    </div>
  );
}

// ---------- the top app bar ----------

/** The label of This device in the main window's overflow menu. */
const DEVICE_LABEL = 'This device';

function TopBar({
  shell,
  controller,
  sc,
  onMore,
  onActionMenu,
  onMenu,
}: {
  shell: PhoneShell;
  controller: ShellController;
  sc: Screen;
  onMore: (sc: Screen, button: HTMLElement) => void;
  onActionMenu: (sc: Screen, action: PageNavAction, button: HTMLElement) => void;
  onMenu: () => void;
}) {
  const nav = sc.nav;
  const goBack = () => shell.goBack();
  const actionMenuHere = (action: PageNavAction, button: HTMLElement) => onActionMenu(sc, action, button);
  const menu = nav?.navigation ? onMenu : undefined;
  const model = barModel({
    title: nav?.title ?? sc.win.title,
    back: nav?.back ? goBack : undefined,
    cancel: nav?.cancel,
    confirm: nav?.confirm,
    actions: nav?.actions,
    dismiss: dismissFor(sc.pres, { back: goBack, close: () => controller.close(sc.win.w) }),
    menu,
  });
  const more = moreFor(sc, DEVICE_LABEL).items.length > 0 ? (button: HTMLElement) => onMore(sc, button) : undefined;
  const connection = useConnection(controller);
  const split = shell.tablet ? nav?.split : undefined;
  if (split) {
    // Two panes (Material: List-detail): a bar over each. The list's has the window's own Back, the detail's the page's.
    const list = barModel({ title: split.title, actions: split.actions, dismiss: sc.pres === 'push' ? { kind: 'back', run: goBack } : null, menu });
    const detail = barModel({ title: nav?.title ?? '', back: nav?.back ? goBack : undefined, cancel: nav?.cancel, confirm: nav?.confirm, actions: nav?.actions, dismiss: null });
    return (
      <header className="md-bar">
        <div className="md-bar-split">
          <div className="md-bar-pane" style={{ width: split.width }}>
            <MdBarRow model={list} onActionMenu={actionMenuHere} />
          </div>
          <div className="md-bar-pane main">
            <MdBarRow model={detail} onMore={more} onActionMenu={actionMenuHere} />
          </div>
          {split.inspector && (
            <div className="md-bar-pane" style={{ width: split.inspector.width }}>
              <MdBarRow model={barModel({ title: split.inspector.title, dismiss: null })} />
            </div>
          )}
        </div>
        <OfflineBanner connection={connection} />
      </header>
    );
  }
  return (
    <header className={`md-bar${sc.pres === 'bottom-sheet' ? ' sheet' : ''}`}>
      {sc.pres === 'bottom-sheet' && <div className="md-handle" aria-hidden="true" />}
      <MdBarRow model={model} onMore={more} onActionMenu={actionMenuHere} dialogLike={sc.pres === 'full-dialog' || sc.pres === 'dialog'} />
      <OfflineBanner connection={connection} />
    </header>
  );
}

/** Material's modal expanded navigation rail: the views over the content, opened from the top app bar's menu icon. */
function ModalRail({ tabs, onClose }: { tabs: PageNavTabs; onClose: () => void }) {
  return (
    <div className="md-sheet-layer">
      <Scrim className="md-scrim" onTap={onClose} />
      <nav className="md-modal-rail ph-scroll" aria-label="Looper">
        <button className="md-icon-btn" aria-label="Close navigation menu" onClick={onClose}>
          {MENU_OPEN}
        </button>
        {tabs.items.map(([id, label, icon]) => (
          <button
            key={id}
            className={`md-rail-item${id === tabs.value ? ' on' : ''}`}
            aria-current={id === tabs.value ? 'page' : undefined}
            onClick={() => {
              tabs.select(id);
              onClose();
            }}
          >
            <TabIcon id={id} addonIcon={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------- menus ----------

const isChoice =(it: MenuItemSpec) => it.type === 'checkbox' || it.type === 'radio';

function MenuItems({ items, title, onUp, onItem }: { items: MenuItemSpec[]; title: string | null; onUp: () => void; onItem: (it: MenuItemSpec) => void }) {
  const checks = items.some(isChoice);
  const groups = menuGroups(items);
  // The up row heads the first group, even when the level has no items of its own.
  if (title !== null && !groups.length) groups.push([]);
  return (
    <div className="md-menu-list ph-scroll" role="menu">
      {groups.map((group, gi) => (
        <div key={gi} className="md-menu-group" role="group">
          {gi === 0 && title !== null && (
            <button className="md-menu-item md-menu-up" onClick={onUp}>
              <span className="md-menu-lead">{ARROW_BACK}</span>
              <span className="md-menu-label">{title}</span>
            </button>
          )}
          {group.map((it) => (
            <button
              key={it.id}
              role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
              aria-checked={isChoice(it) ? !!it.checked : undefined}
              aria-haspopup={it.type === 'submenu' || undefined}
              className={`md-menu-item${isChoice(it) && it.checked ? ' checked' : ''}`}
              disabled={!it.enabled}
              onClick={() => onItem(it)}
            >
              {checks ? (
                <span className="md-menu-lead">{it.checked ? CHECK : null}</span>
              ) : (
                it.icon && (
                  <span className="md-menu-lead">
                    <NavIcon name={it.icon} size={24} />
                  </span>
                )
              )}
              <span className="md-menu-label">{plainLabel(it.label)}</span>
              {it.type === 'submenu' && <span className="md-menu-trail">{ARROW_RIGHT}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A Material menu: the ⋮ overflow menu, or a popup at the finger. */
function Menu({ items, style, onPick, onClose }: { items: MenuItemSpec[]; style: React.CSSProperties; onPick: (it: MenuItemSpec) => void; onClose: () => void }) {
  const sub = useSubmenus(items);
  return (
    <div className="md-menu-layer" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => e.preventDefault()}>
      <div className="md-menu" style={style}>
        <MenuItems items={sub.level} title={sub.title} onUp={sub.up} onItem={(it) => (it.type === 'submenu' ? sub.open(it) : onPick(it))} />
      </div>
    </div>
  );
}

/** A menu the computer popped up (a long press): at the finger, or a bottom sheet when it's long on a phone. */
function PopupMenu({ controller, shell, menu: m }: { controller: ShellController; shell: PhoneShell; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const items = useMemo(() => phoneMenu(m.items), [m.items]);
  const sub = useSubmenus(items);
  const pick = (it: MenuItemSpec) => (it.type === 'submenu' ? sub.open(it) : controller.pick(m.menuId, m.w, it));
  const dismiss = () => controller.dismissMenu(m.menuId);
  if (isLongMenu(sub.level, shell.vp.width, shell.vp.height)) {
    return (
      <BottomSheet onClose={dismiss} label="Menu">
        <MenuItems items={sub.level} title={sub.title} onUp={sub.up} onItem={pick} />
      </BottomSheet>
    );
  }
  const width = 220;
  // 44 dp items, 4 dp padding in each group, 2 dp between groups.
  const groups = menuGroups(sub.level);
  const rows = groups.reduce((n, g) => n + g.length, 0) + (sub.title !== null ? 1 : 0);
  // A long one stops at .md-menu's max-height and scrolls.
  const height = Math.min(rows * 44 + Math.max(1, groups.length) * 8 + Math.max(0, groups.length - 1) * 2, shell.vp.height * 0.7);
  const left = Math.max(8, Math.min(at.x, shell.vp.width - width - 8));
  const top = at.y + height + 8 <= shell.vp.height ? at.y : Math.max(8, at.y - height);
  return <Menu items={items} style={{ left, top, minWidth: width }} onPick={(it) => controller.pick(m.menuId, m.w, it)} onClose={dismiss} />;
}

// ---------- dialogs ----------

/**
 * A Material 3 dialog: headline, supporting text, text buttons at the right
 * end with the dismissing one to the left of the confirming one (the
 * default), stacked when there are more than fit.
 */
export function Dialog({ spec, onAnswer, input }: { spec: MessageBoxSpec; onAnswer: (response: number, checked: boolean) => void; input?: { value: string; onChange: (v: string) => void } }) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  const cancel = spec.cancelId;
  const def = spec.defaultId;
  const idx = spec.buttons.map((_, i) => i);
  const confirm = def !== cancel ? def : idx.find((i) => i !== cancel);
  const order = [cancel, ...idx.filter((i) => i !== cancel && i !== confirm), ...(confirm !== undefined ? [confirm] : [])].filter((i) => i < spec.buttons.length);
  const stacked = spec.buttons.length > 2 || spec.buttons.join('').length > 24;
  // On <body>: a dialog inside a sheet would otherwise be caught in the sheet's moving card.
  return createPortal(
    <div className="md-dialog-layer">
      <Scrim className="md-scrim" onTap={() => onAnswer(cancel, checked)} />
      <div className="md-dialog" role="alertdialog" aria-modal="true" aria-label={spec.message}>
        <h2 className="md-dialog-headline">{spec.message}</h2>
        {spec.detail && <p className="md-dialog-text">{spec.detail}</p>}
        {input && (
          <input
            className="md-outlined-input"
            value={input.value}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => input.onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm !== undefined && onAnswer(confirm, checked)}
          />
        )}
        {spec.checkboxLabel && (
          <label className="md-check-row">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {spec.checkboxLabel}
          </label>
        )}
        <div className={`md-dialog-actions${stacked ? ' stacked' : ''}`}>
          {(stacked ? [...order].reverse() : order).map((i) => (
            <button key={i} className="md-text-btn" onClick={() => onAnswer(i, checked)}>
              {plainLabel(spec.buttons[i])}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function LocalDialog({ msg }: { msg: LocalMessage | null }) {
  return msg ? <Dialog spec={msg.spec} onAnswer={(r) => msg.onAnswer(r)} /> : null;
}

function NewFolderDialog({ browser, onDone }: { browser: HostBrowser; onDone: () => void }) {
  const [name, setName] = useState('New folder');
  return (
    <Dialog
      spec={{ message: 'New folder', buttons: ['Cancel', 'Create'], cancelId: 0, defaultId: 1 }}
      input={{ value: name, onChange: setName }}
      onAnswer={(r) => {
        if (r === 1) void browser.makeDir(name).then((made) => made && onDone());
        else onDone();
      }}
    />
  );
}

/** A modal bottom sheet with a drag handle; drag it down, tap the scrim or go back to close. */
function BottomSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef(new AxisDrag('y'));
  const move = (offset: number | null) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = offset === null ? '' : 'none';
    el.style.transform = offset === null ? '' : `translateY(${offset}px)`;
  };
  return (
    <div className="md-sheet-layer">
      <Scrim className="md-scrim" onTap={onClose} />
      <div ref={card} className="md-bottom-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div
          className="md-handle-area"
          onPointerDown={(e) => {
            drag.current.begin(e.clientX, e.clientY, e.timeStamp);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = drag.current.move(e.clientX, e.clientY, e.timeStamp);
            if (r) move(r.offset);
          }}
          onPointerUp={() => {
            const done = drag.current.end(card.current?.clientHeight ?? 400);
            move(null);
            if (done) onClose();
          }}
        >
          <div className="md-handle" />
        </div>
        {children}
      </div>
    </div>
  );
}

/** A full-screen dialog of the frame's own (a dialog on tablets): close, title, the confirming action. */
function FullDialog({
  shell,
  title,
  onClose,
  bar,
  children,
}: {
  shell: PhoneShell;
  title: string;
  onClose: () => void;
  /** The bar's Confirm and actions; its close icon closes the dialog. */
  bar?: Pick<NavBarProps, 'cancel' | 'confirm' | 'actions'>;
  children: ReactNode;
}) {
  const host = useMemo(() => ({ presentation: shell.tablet ? ('dialog' as const) : ('full-dialog' as const), close: onClose }), [shell.tablet, onClose]);
  return (
    <div className={`md-own-dialog${shell.tablet ? ' tablet' : ''}`}>
      <div className="md-scrim" />
      <div className="md-own-card" role="dialog" aria-modal="true" aria-label={title}>
        <header className="md-bar">
          <BarHostContext.Provider value={host}>
            <NavBar title={title} {...bar} />
          </BarHostContext.Provider>
        </header>
        {children}
      </div>
    </div>
  );
}

function Crumbs({ browser }: { browser: HostBrowser }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.scrollTo({ left: row.current.scrollWidth });
  }, [browser.path]);
  return (
    <div ref={row} className="md-crumbs ph-scroll">
      {browser.crumbs.map((c, i) => (
        <span key={c.path ?? ''} className="md-crumb-part">
          {i > 0 && <span className="md-crumb-sep">{ARROW_RIGHT}</span>}
          <button className={`md-crumb${i === browser.crumbs.length - 1 ? ' current' : ''}`} onClick={() => browser.go(c.path)}>
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function FileScreen({ controller, shell, dialog }: { controller: ShellController; shell: PhoneShell; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const [naming, setNaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onDevice = f.source === 'device';
  const noun = deviceNoun('android', shell.tablet);
  return (
    <FullDialog
      shell={shell}
      title={f.title}
      onClose={f.cancel}
      bar={{ confirm: onDevice && f.kind === 'open' ? undefined : { label: f.confirmLabel, disabled: !f.canConfirm, run: f.confirm } }}
    >
      {f.sources.length > 1 && (
        <div className="md-tabs" role="tablist">
          {(['device', 'computer'] as const).map((src) => (
            <button key={src} role="tab" aria-selected={f.source === src} className={`md-tab${f.source === src ? ' on' : ''}`} onClick={() => f.setSource(src)}>
              <span>{src === 'device' ? `This ${noun.toLowerCase()}` : 'Host computer'}</span>
            </button>
          ))}
        </div>
      )}
      {f.kind === 'save' && (
        <label className="md-field">
          <span className="md-field-label">File name</span>
          <input value={f.name} onChange={(e) => f.setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && f.confirm()} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
      )}
      {onDevice ? (
        f.kind === 'open' && (
          <div className="md-device-pick">
            <button className="md-filled-btn" disabled={!!f.busy} onClick={() => input.current?.click()}>
              {f.multi ? 'Choose files' : 'Choose file'}
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
            {f.busy && <div className="md-supporting">{f.busy}</div>}
          </div>
        )
      ) : (
        <>
          <Crumbs browser={f.browser} />
          <FileRows
            os="android"
            browser={f.browser}
            onFile={(entry) => {
              if (f.kind === 'save') f.setName(entry.name);
              else if (f.multi) f.browser.select(entry, { toggle: true });
              else f.activate(entry);
            }}
          />
          <button className="md-fab" disabled={f.browser.path === null} onClick={() => setNaming(true)}>
            {NEW_FOLDER}
            <span>New folder</span>
          </button>
        </>
      )}
      {naming && <NewFolderDialog browser={f.browser} onDone={() => setNaming(false)} />}
      <LocalDialog msg={f.message} />
    </FullDialog>
  );
}

function PathScreen({ controller, shell, req }: { controller: ShellController; shell: PhoneShell; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  if (p.view) {
    const steps = p.steps;
    return (
      <FullDialog
        shell={shell}
        title={steps ? `${steps.index + 1} of ${steps.count}` : p.name}
        onClose={p.close}
        bar={
          steps
            ? {
                actions: [
                  { id: 'previous', label: 'Previous', disabled: steps.index <= 0, run: () => steps.go(steps.index - 1) },
                  { id: 'next', label: 'Next', disabled: steps.index >= steps.count - 1, run: () => steps.go(steps.index + 1) },
                ],
              }
            : undefined
        }
      >
        <FileViewBody view={p.view} name={p.name} />
        <div className="md-bottom-actions">
          <button className="md-text-btn" onClick={p.view.toHost}>
            Download to host computer
          </button>
          <button className="md-text-btn" onClick={p.view.toDevice}>
            Download to this {deviceNoun('android', shell.tablet).toLowerCase()}
          </button>
        </div>
        <LocalDialog msg={p.message} />
      </FullDialog>
    );
  }
  if (!p.browser) return <LocalDialog msg={p.message} />;
  const browser = p.browser;
  return (
    <FullDialog shell={shell} title={p.name} onClose={p.close}>
      <Crumbs browser={browser} />
      <FileRows os="android" browser={browser} onFile={p.openFile} />
      <div className="md-bottom-actions">
        <button className="md-text-btn" onClick={p.openOnComputer}>
          Open on host computer
        </button>
      </div>
      <LocalDialog msg={p.message} />
    </FullDialog>
  );
}

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`md-switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="md-switch-handle">{on ? CHECK : null}</span>
    </button>
  );
}

/** Rename this device: a dialog with the name's field, as Android's own Settings rename the phone. */
function RenameDialog({ current, onRename, onDone }: { current: string; onRename: (name: string) => void; onDone: () => void }) {
  const [name, setName] = useState(current);
  return (
    <Dialog
      spec={{ message: 'Device name', buttons: ['Cancel', 'Rename'], cancelId: 0, defaultId: 1 }}
      input={{ value: name, onChange: setName }}
      onAnswer={(r) => {
        const next = name.trim();
        if (r === 1 && next && next !== current) onRename(next);
        onDone();
      }}
    />
  );
}

function DeviceSheet({ controller, onClose }: { controller: ShellController; onClose: () => void }) {
  const d = useThisDevice(controller);
  const usable = d.push === 'on' || d.push === 'off';
  const [renaming, setRenaming] = useState(false);
  return (
    <BottomSheet label="This device" onClose={onClose}>
      <h2 className="md-sheet-title">This device</h2>
      <div className="md-list">
        <button className="md-list-item tappable" disabled={d.busy || !d.name} onClick={() => setRenaming(true)}>
          <div className="md-list-text">
            <div className="md-list-headline">Device name</div>
            <div className="md-list-supporting">{d.name || ' '}</div>
          </div>
        </button>
        <div className="md-list-item">
          <div className="md-list-text">
            <div className="md-list-headline">Paired with</div>
            <div className="md-list-supporting">{d.computer || ' '}</div>
          </div>
        </div>
        <div className="md-list-item">
          <div className="md-list-text">
            <div className="md-list-headline">Notifications</div>
          </div>
          <Switch on={d.push === 'on'} disabled={!usable || d.busy} label="Notifications" onChange={d.setNotifications} />
        </div>
      </div>
      <div className="md-sheet-actions">
        <button className="md-text-btn error" onClick={d.unpair}>
          Unpair this device
        </button>
      </div>
      {renaming && <RenameDialog current={d.name} onRename={(name) => void d.rename(name)} onDone={() => setRenaming(false)} />}
      <LocalDialog msg={d.message} />
    </BottomSheet>
  );
}

// ---------- snackbar ----------

/** The newest toast as a snackbar above the bottom (and above the page's own tab bar). */
function Snackbar({ controller, toasts, ownsBottom }: { controller: ShellController; toasts: Toast[]; ownsBottom: boolean }) {
  const t = toasts[toasts.length - 1];
  if (!t) return null;
  return (
    <div className={`md-snackbar-area${ownsBottom ? ' above-tabs' : ''}`} aria-live="polite">
      <div key={t.id} className="md-snackbar" role="status">
        <button className="md-snackbar-text" onClick={() => controller.openToast(t)}>
          <span className="md-snackbar-title">{t.title}</span>
          {t.body && <span className="md-snackbar-body">{t.body}</span>}
        </button>
        {t.taskId && (
          <button className="md-snackbar-action" onClick={() => controller.openToast(t)}>
            Open
          </button>
        )}
        <button className="md-icon-btn md-snackbar-close" aria-label="Dismiss" onClick={() => controller.closeToast(t.id)}>
          {CLOSE}
        </button>
      </div>
    </div>
  );
}
