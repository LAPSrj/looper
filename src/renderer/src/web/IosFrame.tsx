import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec, MessageBoxSpec } from '../../../shared/remote-access';
import { useConnection } from './connection';
import { IosField } from './IosField';
import { tabKeyTarget, tabStop } from '../components/tabs-model';
import { darkColor } from './nav-stack';
import type { ShellController } from './controller';
import { useThisDevice } from './device-flows';
import { OfflineBanner } from './OfflineBanner';
import { PUSH_HINTS } from './push-client';
import { HOST_COMPUTER, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser, type LocalMessage } from './file-flows';
import { AxisDrag } from './gestures';
import { CHECK, CHEVRON_RIGHT, FileRows, FileViewBody } from './phone-files';
import { phoneMenu } from './more-menu';
import {
  deviceNoun,
  menuGroups,
  actionMenu,
  moreFor,
  PhoneWindows,
  pickMore,
  usePhoneShell,
  useSubmenus,
  type BackLayer,
  type OpenMore,
  type PhoneShell,
  type Screen,
} from './phone-shell';
import type { PageNavTabs } from './page-nav';
import type { OpenDialog, OpenMenu, PathRequest, Toast } from './store';
import { barModel, dismissFor, plainLabel, type PageNavAction } from './nav-bar-model';
import { IosBarRow, IosBrowserBarRow, NavIcon } from './NavBarRow';
import { BarHostContext, NavBar, type NavBarProps } from '../components/NavBar';
import './ios.css';

const CHEVRON_LEFT = (
  <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true">
    <path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** iOS (iPhone and iPad), after the Human Interface Guidelines: windows as a navigation stack and sheets. */
export function IosFrame({ controller }: { controller: ShellController }) {
  const [more, setMore] = useState<OpenMore | null>(null);
  const [device, setDevice] = useState(false);
  const local: BackLayer[] = [];
  if (device) local.push(() => setDevice(false));
  if (more) local.push(() => setMore(null));
  const shell = usePhoneShell(controller, 'ios', local);
  const { s } = shell;

  // A field under 16 px would make Safari zoom the page when it gets the focus.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta && !/maximum-scale/.test(meta.content)) meta.content += ', maximum-scale=1';
  }, []);
  // iOS colors the status bar from the fixed element at the top (the served page's .ios-top-edge strip), not from
  // theme-color: the color of the topmost full screen's bar, or black while a phone's page sheet shrinks the screen behind it.
  const full = shell.screens.filter((x) => !x.leaving && (x.pres === 'root' || x.pres === 'push')).sort((a, b) => b.depth - a.depth)[0];
  const fullEdge = full ? shell.edges.get(full.win.w) : undefined;
  const statusBar = !full || (!shell.tablet && shell.top?.pres === 'page-sheet') ? '#000' : !fullEdge ? 'var(--ios-bg)' : fullEdge.scrolled ? 'var(--ios-bar)' : fullEdge.color;
  useEffect(() => {
    const edge = document.querySelector<HTMLElement>('.ios-top-edge');
    if (edge) edge.style.backgroundColor = statusBar;
  }, [statusBar]);
  const overlay = !!more || device;
  useEffect(() => {
    if (!overlay) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [overlay, controller]);

  // The More view's This Device row asks for the sheet.
  useEffect(() => {
    if (window.__looperFrame) window.__looperFrame.openDevice = () => setDevice(true);
  }, []);

  // A bar button's menu hangs from its group's trailing edge, whichever button of the group opened it.
  const anchorOf = (button: HTMLElement) => (button.closest('.ios-bar-group') ?? button).getBoundingClientRect();
  const openMore = (sc: Screen, button: HTMLElement) => setMore({ ...moreFor(sc), w: sc.win.w, anchor: anchorOf(button) });
  const openActionMenu = (sc: Screen, action: PageNavAction, button: HTMLElement) => setMore({ ...actionMenu(action), w: sc.win.w, anchor: anchorOf(button) });

  return (
    <div ref={shell.rootRef} className={`ph-root ios${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`} style={{ '--ios-status': statusBar } as React.CSSProperties}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <PhoneWindows
        shell={shell}
        controller={controller}
        renderBar={(sc) => <IosBar shell={shell} controller={controller} sc={sc} onMore={openMore} onActionMenu={openActionMenu} />}
        dragToDismiss={(p) => p === 'page-sheet' || p === 'form-sheet'}
      />
      {!s.connected && !s.everConnected && (
        <div className="ph-connection" role="status">
          Connecting…
        </div>
      )}
      {device && <DeviceSheet controller={controller} shell={shell} onClose={() => setDevice(false)} />}
      {s.paths.map((p) => (
        <PathSheet key={p.id} controller={controller} shell={shell} req={p} />
      ))}
      {s.dialogs.map((d) =>
        d.kind === 'message' ? (
          <Alert key={d.dialogId} spec={d.spec} onAnswer={(r, c) => controller.answer(d.dialogId, messageResult(r, c))} />
        ) : (
          <FileSheet key={d.dialogId} controller={controller} shell={shell} dialog={d} />
        ),
      )}
      {more && (
        <PullDown
          items={more.items}
          anchor={more.anchor}
          onClose={() => setMore(null)}
          onPick={(item) => {
            setMore(null);
            pickMore(controller, more, item);
          }}
        />
      )}
      {s.menus.map((m) => (
        <PopupMenu key={m.menuId} controller={controller} shell={shell} menu={m} />
      ))}
      <Banners controller={controller} toasts={s.toasts} />
    </div>
  );
}

// ---------- the navigation bar ----------

function IosBar({
  shell,
  controller,
  sc,
  onMore,
  onActionMenu,
}: {
  shell: PhoneShell;
  controller: ShellController;
  sc: Screen;
  onMore: (sc: Screen, button: HTMLElement) => void;
  onActionMenu: (sc: Screen, action: PageNavAction, button: HTMLElement) => void;
}) {
  const actionMenuHere = (action: PageNavAction, button: HTMLElement) => onActionMenu(sc, action, button);
  const nav = sc.nav;
  const showTitle = !nav?.largeTitle || shell.scrolledPast.has(sc.win.w);
  const more = moreFor(sc).items.length > 0 ? (button: HTMLElement) => onMore(sc, button) : undefined;
  const goBack = () => shell.goBack();
  const back = nav?.back ? goBack : undefined;
  // The bar has no fill of its own: it's the page's top color, with the hard scroll edge once the page scrolls.
  const edge = shell.edges.get(sc.win.w);
  const connection = useConnection(controller);
  const split = shell.tablet ? nav?.split : undefined;
  if (split) {
    // iPad's split view: the tab bar near the top, then a bar over each column. The list's bar has the
    // window's own Back; the detail's has the page's (a deeper screen in that column).
    const list = barModel({ title: split.title, actions: split.actions, dismiss: sc.pres === 'push' ? { kind: 'back', run: () => controller.close(sc.win.w) } : null });
    const detail = barModel({ title: nav?.title ?? '', subtitle: nav?.subtitle, back, cancel: nav?.cancel, confirm: nav?.confirm, actions: nav?.actions, dismiss: null });
    return (
      <header className="ios-bar split" style={{ background: !edge ? undefined : edge.scrolled ? 'var(--ios-bar)' : edge.color }}>
        {nav?.tabs && <IosTabBar tabs={nav.tabs} />}
        <div className="ios-bar-split">
          <IosBarRow
            model={list}
            onActionMenu={actionMenuHere}
            className={`ios-bar-list${edge?.scrolled ? ' edge' : ''}`}
            style={{ width: split.width }}
            titleAs="h2"
            titleFaded={!!split.largeTitle && !shell.scrolledPast.has(sc.win.w)}
          />
          <IosBarRow
            model={detail}
            onMore={more}
            onActionMenu={actionMenuHere}
            className={`ios-bar-detail${edge?.detail?.scrolled ? ' edge' : ''}${edge?.detail && !edge.detail.scrolled && darkColor(edge.detail.color) ? ' on-dark' : ''}`}
            style={edge?.detail ? { background: edge.detail.scrolled ? 'var(--ios-bar)' : edge.detail.color } : undefined}
          />
          {split.inspector && (
            <IosBarRow model={barModel({ title: split.inspector.title, dismiss: null })} className="ios-bar-inspector" style={{ width: split.inspector.width }} titleAs="h2" />
          )}
        </div>
        <OfflineBanner connection={connection} />
      </header>
    );
  }
  const model = barModel({
    title: nav?.title ?? sc.win.title,
    subtitle: nav?.subtitle,
    back,
    cancel: nav?.cancel,
    confirm: nav?.confirm,
    actions: nav?.actions,
    dismiss: dismissFor(sc.pres, { back: goBack, close: () => controller.close(sc.win.w) }),
  });
  return (
    <header
      className={`ios-bar${edge?.scrolled ? ' edge' : ''}${edge && !edge.scrolled && darkColor(edge.color) ? ' on-dark' : ''}`}
      style={edge && !edge.scrolled ? { background: edge.color } : undefined}
    >
      {sc.pres === 'page-sheet' && !shell.tablet && <div className="ios-grabber" aria-hidden="true" />}
      {shell.tablet && nav?.tabs && <IosTabBar tabs={nav.tabs} />}
      <IosBarRow model={model} onMore={more} onActionMenu={actionMenuHere} titleFaded={!showTitle} />
      <OfflineBanner connection={connection} />
    </header>
  );
}

/** iPadOS's tab bar: the tabs' names in a glass capsule centered near the top of the screen (HIG: Tab bars). */
function IosTabBar({ tabs }: { tabs: PageNavTabs }) {
  return (
    <div className="ios-tabbar-row">
      <nav className="ios-tabbar" aria-label="Looper">
        {tabs.items.map(([id, label]) => (
          <button key={id} className={`ios-tab${id === tabs.value ? ' active' : ''}`} aria-current={id === tabs.value ? 'page' : undefined} onClick={() => tabs.select(id)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------- menus ----------

const isChoice = (it: MenuItemSpec) => it.type === 'checkbox' || it.type === 'radio';

/**
 * One level of a menu as iOS draws it: groups split by a thick gap, a check
 * before chosen items, the item's symbol before its label (a chevron at the
 * end of a submenu), destructive items in red. A group shows symbols only when
 * every item in it has one (HIG: Menus, "icons for all menu items in a group,
 * or none of them").
 */
function MenuLevel({ items, title, onUp, onItem }: { items: MenuItemSpec[]; title: string | null; onUp: () => void; onItem: (it: MenuItemSpec) => void }) {
  const checks = items.some(isChoice);
  const iconOf = (it: MenuItemSpec) => (it.type !== 'submenu' ? it.icon : undefined);
  return (
    <div className="ios-menu-scroll ph-scroll" role="menu">
      {title !== null && (
        <button className="ios-menu-item ios-menu-up" onClick={onUp}>
          <span className="ios-menu-check">{CHEVRON_LEFT}</span>
          <span className="ios-menu-label">{title}</span>
        </button>
      )}
      {menuGroups(items).map((group, gi) => {
        const icons = group.every((it) => iconOf(it));
        return (
        <div key={gi} className="ios-menu-group">
          {group.map((it) => (
            <button
              key={it.id}
              role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
              aria-checked={isChoice(it) ? !!it.checked : undefined}
              aria-haspopup={it.type === 'submenu' || undefined}
              className={`ios-menu-item${it.type !== 'submenu' && it.destructive ? ' destructive' : ''}`}
              disabled={!it.enabled}
              onClick={() => onItem(it)}
            >
              {checks && <span className="ios-menu-check">{it.checked ? CHECK : null}</span>}
              {icons && (
                <span className="ios-menu-icon">
                  <NavIcon name={iconOf(it)!} size={20} />
                </span>
              )}
              <span className="ios-menu-label">{plainLabel(it.label)}</span>
              {it.type === 'submenu' && <span className="ios-menu-sub">{CHEVRON_RIGHT}</span>}
            </button>
          ))}
        </div>
        );
      })}
    </div>
  );
}

/** Where a menu of `width` × about its height goes so it stays on screen: below `y` when it fits, else on the roomier side, capped to that room (it scrolls). */
function placeMenu(x: number, y: number, width: number, height: number, vw: number, vh: number): React.CSSProperties {
  const left = Math.max(8, Math.min(x, vw - width - 8));
  const top = Math.max(8, y);
  const bottom = Math.max(8, vh - y);
  const below = top + height + 8 <= vh || vh - top >= vh - bottom;
  return below ? { left, top, width, maxHeight: vh - top - 8 } : { left, bottom, width, maxHeight: vh - bottom - 8 };
}

/**
 * A bar button's pull-down menu, under its group and as wide as its longest
 * item. A tap outside only closes it: the layer takes the whole tap, so a tap
 * on the button that opened it doesn't open it again.
 */
function PullDown({
  items,
  anchor,
  align = 'end',
  onPick,
  onClose,
}: {
  items: MenuItemSpec[];
  anchor: DOMRect;
  /** Where the menu lines up: a bar button's trailing edge, or centered under a title (kept on the screen). */
  align?: 'center' | 'end';
  onPick: (it: MenuItemSpec) => void;
  onClose: () => void;
}) {
  const sub = useSubmenus(items);
  const box = useRef<HTMLDivElement>(null);
  // Centered once its width is known, which depends on its longest item.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || align !== 'center') return;
    const width = el.offsetWidth;
    el.style.left = `${Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
  }, [align, anchor, sub.level]);
  const side = align === 'center' ? { left: 8 } : { right: Math.max(8, window.innerWidth - anchor.right) };
  return (
    <div className="ios-menu-layer" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="ios-menu ios-pull-down" style={{ ...side, top: anchor.bottom + 6 }}>
        <MenuLevel items={sub.level} title={sub.title} onUp={sub.up} onItem={(it) => (it.type === 'submenu' ? sub.open(it) : onPick(it))} />
      </div>
    </div>
  );
}

/**
 * A menu the computer popped up (a long press): a context menu by the finger,
 * scrolling when it's long (HIG: Action sheets shouldn't scroll, so a long menu
 * isn't one), with what can't be done now hidden and destructive items last.
 */
function PopupMenu({ controller, shell, menu: m }: { controller: ShellController; shell: PhoneShell; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const items = useMemo(() => phoneMenu(m.items), [m.items]);
  const sub = useSubmenus(items);
  const pick = (it: MenuItemSpec) => (it.type === 'submenu' ? sub.open(it) : controller.pick(m.menuId, m.w, it));
  const dismiss = () => controller.dismissMenu(m.menuId);
  const rows = sub.level.length + (sub.title ? 1 : 0);
  return (
    <div className="ios-menu-layer dim" onPointerDown={(e) => e.target === e.currentTarget && dismiss()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ios-menu" style={placeMenu(at.x - 20, at.y + 12, 250, rows * 44 + 24, shell.vp.width, shell.vp.height)}>
        <MenuLevel items={sub.level} title={sub.title} onUp={sub.up} onItem={pick} />
      </div>
    </div>
  );
}

// ---------- alerts ----------

/**
 * UIAlertController's look: the message as the bold title, the detail under
 * it; two buttons side by side with Cancel on the left, more stacked with
 * Cancel last. The default button, when it isn't Cancel, is the tinted one.
 */
export function Alert({ spec, onAnswer, input }: { spec: MessageBoxSpec; onAnswer: (response: number, checked: boolean) => void; input?: { value: string; onChange: (v: string) => void } }) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  const cancel = spec.cancelId;
  const preferred = spec.defaultId;
  const idx = spec.buttons.map((_, i) => i);
  // Two capsules share a row while both labels fit in half the alert's width.
  const row = spec.buttons.length === 2 && spec.buttons.every((b) => plainLabel(b).length <= 11);
  const order = row ? [cancel, ...idx.filter((i) => i !== cancel)] : [...idx.filter((i) => i !== cancel), ...(spec.buttons.length > cancel ? [cancel] : [])];
  // On <body>: an alert inside a sheet would otherwise be caught in the sheet's moving card.
  return createPortal(
    <div className="ios-alert-layer">
      <div className="ios-alert" role="alertdialog" aria-modal="true" aria-label={spec.message}>
        <div className="ios-alert-text">
          <div className="ios-alert-title">{spec.message}</div>
          {spec.detail && <div className="ios-alert-message">{spec.detail}</div>}
          {input && (
            <input
              className="ios-alert-input"
              value={input.value}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => input.onChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAnswer(preferred, checked)}
            />
          )}
          {spec.checkboxLabel && (
            <button className="ios-alert-check" role="checkbox" aria-checked={checked} onClick={() => setChecked(!checked)}>
              <span className={`ios-checkcircle${checked ? ' on' : ''}`}>{checked ? CHECK : null}</span>
              {spec.checkboxLabel}
            </button>
          )}
        </div>
        <div className={`ios-alert-buttons${row ? ' row' : ''}`}>
          {order.map((i) => (
            <button key={i} className={`ios-alert-btn${i === preferred && (i !== cancel || spec.buttons.length === 1) ? ' bold' : ''}${i === spec.destructiveId ? ' destructive' : ''}`} onClick={() => onAnswer(i, checked)}>
              {plainLabel(spec.buttons[i])}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function LocalAlert({ msg }: { msg: LocalMessage | null }) {
  return msg ? <Alert spec={msg.spec} onAnswer={(r) => msg.onAnswer(r)} /> : null;
}

/** New Folder: an alert with a text field. */
function NewFolderAlert({ browser, onDone }: { browser: HostBrowser; onDone: () => void }) {
  const [name, setName] = useState('New folder');
  return (
    <Alert
      spec={{ message: 'New Folder', detail: 'Enter a name for this folder.', buttons: ['Cancel', 'Create'], cancelId: 0, defaultId: 1 }}
      input={{ value: name, onChange: setName }}
      onAnswer={(r) => {
        if (r === 1) void browser.makeDir(name).then((made) => made && onDone());
        else onDone();
      }}
    />
  );
}

// ---------- sheets of the shell's own ----------

/** A sheet the frame draws itself (file dialogs, This Device): a page sheet on iPhone, a form sheet on iPad; drag its bar down to close. */
function Sheet({
  shell,
  label,
  bar,
  header,
  onClose,
  small,
  children,
}: {
  shell: PhoneShell;
  label: string;
  /** The bar's Back, Cancel, Confirm and actions; without a Back or a Cancel, its xmark closes the sheet. */
  bar?: Pick<NavBarProps, 'back' | 'cancel' | 'confirm' | 'actions'>;
  /** A bar of its own in place of the NavBar one (the file browser's). */
  header?: ReactNode;
  onClose: () => void;
  small?: boolean;
  children: ReactNode;
}) {
  const host = useMemo(() => ({ presentation: shell.tablet ? ('form-sheet' as const) : ('page-sheet' as const), close: onClose }), [shell.tablet, onClose]);
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef(new AxisDrag('y'));
  const move = (offset: number | null) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = offset === null ? '' : 'none';
    el.style.transform = offset === null ? '' : `translateY(${offset}px)`;
  };
  return (
    <div className={`ios-own-sheet${shell.tablet ? ' tablet-sheet' : ''}${small ? ' small' : ''}`}>
      <div className="ph-scrim" />
      <div ref={card} className="ph-card" role="dialog" aria-modal="true" aria-label={label}>
        <header
          className="ios-bar"
          onPointerDown={(e) => {
            if ((e.target as Element).closest('button, input')) return;
            drag.current.begin(e.clientX, e.clientY, e.timeStamp);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = drag.current.move(e.clientX, e.clientY, e.timeStamp);
            if (r) move(r.offset);
          }}
          onPointerUp={() => {
            const done = drag.current.end(card.current?.clientHeight ?? 600);
            move(null);
            if (done) onClose();
          }}
          onPointerCancel={() => {
            drag.current.end(0);
            move(null);
          }}
        >
          {!shell.tablet && <div className="ios-grabber" aria-hidden="true" />}
          {header ?? (
            <BarHostContext.Provider value={host}>
              <NavBar title={label} {...bar} />
            </BarHostContext.Provider>
          )}
        </header>
        <div className="ios-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** The file browser's bar (IosBrowserBarRow) on a HostBrowser, and its title's menu of the folders above, nearest first. */
function FilesBar({
  shell,
  browser,
  actions,
  confirm,
  onClose,
}: {
  shell: PhoneShell;
  browser: HostBrowser;
  actions: { id: string; label: string; icon: string; run: () => void }[];
  confirm?: { label: string; disabled: boolean; run: () => void };
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const crumbs = browser.crumbs;
  const above = crumbs.slice(0, -1).reverse();
  const root = shell.rootRef.current;
  return (
    <>
      <IosBrowserBarRow
        title={crumbs[crumbs.length - 1].label}
        canBack={browser.canBack}
        canForward={browser.canForward}
        onBack={browser.back}
        onForward={browser.forward}
        onTitleMenu={above.length > 0 ? (button) => setMenu(button.getBoundingClientRect()) : undefined}
        actions={actions}
        confirm={confirm}
        onClose={onClose}
      />
      {menu &&
        root &&
        createPortal(
          <PullDown
            items={above.map((c, i) => ({ id: String(i), type: 'normal', label: c.label, enabled: true, icon: 'openFolder' }))}
            anchor={menu}
            align="center"
            onClose={() => setMenu(null)}
            onPick={(it) => {
              setMenu(null);
              browser.go(above[Number(it.id)].path);
            }}
          />,
          root,
        )}
    </>
  );
}

/** The search field under the file browser's bar: it narrows the folder's list as you type. */
function FilesSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="ios-files-search">
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.3 10.3 3.2 3.2" />
      </svg>
      <input type="search" enterKeyHint="search" placeholder="Search" aria-label="Search" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** A file browser's search text, emptied when it moves to another folder. */
function useFolderSearch(path: string | null): [string, (value: string) => void] {
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [path]);
  return [query, setQuery];
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const ids = options.map((o) => o.value);
  return (
    <div
      className="ios-segmented"
      role="tablist"
      // The ARIA tabs pattern as in Tabs.tsx: one Tab stop, the arrow keys, Home and End move to a segment and select it.
      onKeyDown={(e) => {
        const to = tabKeyTarget(ids, value, e);
        if (to === null) return;
        e.preventDefault();
        onChange(to as T);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(to as T)]?.focus();
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          tabIndex={tabStop(ids, value) === o.value ? 0 : -1}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FileSheet({ controller, shell, dialog }: { controller: ShellController; shell: PhoneShell; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const [naming, setNaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onDevice = f.source === 'device';
  const noun = deviceNoun('ios', shell.tablet);
  const showConfirm = !(onDevice && f.kind === 'open');
  const confirm = showConfirm ? { label: f.confirmLabel, disabled: !f.canConfirm, run: f.confirm } : undefined;
  const [query, setQuery] = useFolderSearch(f.browser.path);
  return (
    <Sheet
      shell={shell}
      label={f.title}
      onClose={f.cancel}
      // This device's files are the system's own picker: only Cancel and Confirm here.
      bar={{ cancel: { run: f.cancel }, confirm }}
      header={
        onDevice ? undefined : (
          <FilesBar
            shell={shell}
            browser={f.browser}
            actions={f.browser.path !== null ? [{ id: 'new-folder', label: 'New Folder', icon: 'newProject', run: () => setNaming(true) }] : []}
            confirm={confirm}
            onClose={f.cancel}
          />
        )
      }
    >
      {f.sources.length > 1 && (
        <Segmented
          value={f.source}
          options={[
            { value: 'device', label: `This ${noun}` },
            { value: 'computer', label: HOST_COMPUTER },
          ]}
          onChange={f.setSource}
        />
      )}
      {f.kind === 'save' && (
        <div className="ios-group">
          <IosField label="Name">
            <input value={f.name} onChange={(e) => f.setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && f.confirm()} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </IosField>
        </div>
      )}
      {onDevice ? (
        f.kind === 'open' && (
          <div className="ios-device-pick">
            <button className="ios-filled-btn" disabled={!!f.busy} onClick={() => input.current?.click()}>
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
            {f.busy && <div className="ios-footnote">{f.busy}</div>}
          </div>
        )
      ) : (
        <>
          <FilesSearch value={query} onChange={setQuery} />
          <FileRows
            os="ios"
            browser={f.browser}
            query={query}
            onFile={(entry) => {
              if (f.kind === 'save') f.setName(entry.name);
              else if (f.multi) f.browser.select(entry, { toggle: true });
              else f.activate(entry);
            }}
          />
        </>
      )}
      {naming && <NewFolderAlert browser={f.browser} onDone={() => setNaming(false)} />}
      <LocalAlert msg={f.message} />
    </Sheet>
  );
}

/** A folder or file on the host computer the user asked to see: a folder to browse, an image or text file to look at. */
function PathSheet({ controller, shell, req }: { controller: ShellController; shell: PhoneShell; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  const [query, setQuery] = useFolderSearch(p.browser?.path ?? null);
  if (p.view) {
    const view = p.view;
    const steps = p.steps;
    return (
      <Sheet
        shell={shell}
        label={steps ? `${steps.index + 1} of ${steps.count}` : p.name}
        onClose={p.close}
        bar={{
          actions: [
            ...(steps
              ? [
                  { id: 'previous', label: 'Previous Image', icon: 'previous', disabled: steps.index <= 0, run: () => steps.go(steps.index - 1) },
                  { id: 'next', label: 'Next Image', icon: 'next', disabled: steps.index >= steps.count - 1, run: () => steps.go(steps.index + 1) },
                ]
              : []),
            { id: 'download', label: 'Download', icon: 'download', run: () => view.askDownload(`This ${deviceNoun('ios', shell.tablet)}`) },
          ],
        }}
      >
        <FileViewBody view={view} name={p.name} />
        <LocalAlert msg={p.message} />
      </Sheet>
    );
  }
  if (!p.browser) return <LocalAlert msg={p.message} />;
  const browser = p.browser;
  return (
    <Sheet
      shell={shell}
      label={browser.crumbs[browser.crumbs.length - 1].label}
      onClose={p.close}
      header={<FilesBar shell={shell} browser={browser} actions={[{ id: 'open-on-host', label: `Open on ${HOST_COMPUTER}`, icon: 'openFolder', run: p.openOnComputer }]} onClose={p.close} />}
    >
      <FilesSearch value={query} onChange={setQuery} />
      <FileRows os="ios" browser={browser} query={query} onFile={p.openFile} />
      <LocalAlert msg={p.message} />
    </Sheet>
  );
}

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`ios-switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="ios-switch-knob" />
    </button>
  );
}

/** This Device: its name (edited in place, saved on Return or when the field is left), the computer it's paired with, notifications, and Unpair. */
function DeviceSheet({ controller, shell, onClose }: { controller: ShellController; shell: PhoneShell; onClose: () => void }) {
  const d = useThisDevice(controller);
  const usable = d.push === 'on' || d.push === 'off';
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    // The typed name stays in the field until the computer answers; a failure puts the old one back.
    if (next && next !== d.name) void d.rename(next).then(() => setDraft(null));
    else setDraft(null);
  };
  return (
    <Sheet
      shell={shell}
      label="This Device"
      small
      onClose={onClose}
    >
      <div className="ios-grouped ph-scroll">
        <div className="ios-group">
          <IosField label="Name">
            <input
              value={draft ?? d.name}
              disabled={d.busy}
              enterKeyHint="done"
              autoCorrect="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={commit}
            />
          </IosField>
          <div className="ios-cell">
            <span className="ios-cell-label">Paired with</span>
            <span className="ios-cell-value">{d.computer}</span>
          </div>
        </div>
        <div className="ios-group">
          <div className="ios-cell">
            <span className="ios-cell-label">Notifications</span>
            <Switch on={d.push === 'on'} disabled={!usable || d.busy} label="Notifications" onChange={d.setNotifications} />
          </div>
        </div>
        {d.push && PUSH_HINTS[d.push] && <div className="ios-group-footer">{PUSH_HINTS[d.push]}</div>}
        <div className="ios-group">
          <button className="ios-cell ios-cell-button destructive" onClick={d.unpair}>
            Unpair This Device
          </button>
        </div>
      </div>
      <LocalAlert msg={d.message} />
    </Sheet>
  );
}

// ---------- notification banners ----------

function Banners({ controller, toasts }: { controller: ShellController; toasts: Toast[] }) {
  const start = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    for (const id of [...start.current.keys()]) if (!toasts.some((t) => t.id === id)) start.current.delete(id);
  }, [toasts]);
  if (!toasts.length) return null;
  return (
    <div className="ios-banners" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="ios-banner"
          role="status"
          onPointerDown={(e) => start.current.set(t.id, e.clientY)}
          onPointerUp={(e) => {
            const y0 = start.current.get(t.id);
            start.current.delete(t.id);
            // Flicked up: away; a tap opens it.
            if (y0 !== undefined && y0 - e.clientY > 24) controller.closeToast(t.id);
            else controller.openToast(t);
          }}
        >
          <img className="ios-banner-icon" src="/icons/icon-192.png" alt="" />
          <div className="ios-banner-text">
            <div className="ios-banner-title">{t.title}</div>
            {t.body && <div className="ios-banner-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
