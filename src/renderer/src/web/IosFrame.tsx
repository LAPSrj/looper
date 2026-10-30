import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec, MessageBoxSpec } from '../../../shared/remote-access';
import type { ShellController } from './controller';
import { useThisDevice } from './device-flows';
import { messageCancelId, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser, type LocalMessage } from './file-flows';
import { AxisDrag } from './gestures';
import { CHECK, CHEVRON_RIGHT, FileRows } from './phone-files';
import {
  deviceNoun,
  isLongMenu,
  menuGroups,
  NavIcon,
  PhoneWindows,
  plainLabel,
  rootMoreItems,
  THIS_DEVICE_ITEM,
  usePhoneShell,
  useSubmenus,
  type BackLayer,
  type PhoneShell,
  type Screen,
} from './phone-shell';
import type { OpenDialog, OpenMenu, PathRequest, Toast } from './store';
import './ios.css';

const CHEVRON_LEFT = (
  <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true">
    <path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const BACK = (
  <svg width="11" height="19" viewBox="0 0 11 19" aria-hidden="true">
    <path d="M9 1.5L1.5 9.5 9 17.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ELLIPSIS = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.9" fill="currentColor" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.9" fill="currentColor" />
  </svg>
);
const XMARK = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 2l12 12M14 2L2 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const CHECKMARK = (
  <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
    <path d="M2 8.5l5.5 5.5L18 2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const NEW_FOLDER = (
  <svg width="26" height="22" viewBox="0 0 26 22" aria-hidden="true">
    <path d="M2 5.5A2 2 0 0 1 4 3.5h5l2 2h9a2 2 0 0 1 2 2V9M2 5.5V17a2 2 0 0 0 2 2h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 12v8M16 16h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** iOS (iPhone and iPad), after the Human Interface Guidelines: windows as a navigation stack and sheets. */
export function IosFrame({ controller }: { controller: ShellController }) {
  const [more, setMore] = useState<{ w: string; items: MenuItemSpec[]; anchor: DOMRect } | null>(null);
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
  // iOS colors the status bar from the fixed element under it (the root), not from theme-color: the color of
  // the topmost full screen's bar, or black while a phone's page sheet shrinks the screen behind it.
  const full = shell.screens.filter((x) => !x.leaving && (x.pres === 'root' || x.pres === 'push')).sort((a, b) => b.depth - a.depth)[0];
  const fullEdge = full ? shell.edges.get(full.win.w) : undefined;
  const statusBar = !full || (!shell.tablet && shell.top?.pres === 'page-sheet') ? '#000' : !fullEdge ? 'var(--ios-bg)' : fullEdge.scrolled ? 'var(--ios-bar)' : fullEdge.color;
  const overlay = !!more || device;
  useEffect(() => {
    if (!overlay) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [overlay, controller]);

  const openMore = (sc: Screen, button: HTMLElement) => {
    const items = sc.pres === 'root' ? rootMoreItems(sc.win.menu, 'This Device') : (sc.win.menu ?? []);
    setMore({ w: sc.win.w, items, anchor: button.getBoundingClientRect() });
  };

  return (
    <div ref={shell.rootRef} className={`ph-root ios${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`} style={{ '--ios-status': statusBar } as React.CSSProperties}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <PhoneWindows
        shell={shell}
        controller={controller}
        renderBar={(sc) => <IosBar shell={shell} controller={controller} sc={sc} onMore={openMore} />}
        dragToDismiss={(p) => p === 'page-sheet' || p === 'form-sheet'}
      />
      {!s.connected && (
        <div className="ph-connection" role="status">
          {s.everConnected ? 'Reconnecting…' : 'Connecting…'}
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
            if (item.id === THIS_DEVICE_ITEM) setDevice(true);
            else controller.pick(more.w, more.w, item);
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

function IosBar({ shell, controller, sc, onMore }: { shell: PhoneShell; controller: ShellController; sc: Screen; onMore: (sc: Screen, button: HTMLElement) => void }) {
  const nav = sc.nav;
  const title = plainLabel(nav?.title ?? sc.win.title);
  const sheet = sc.pres === 'page-sheet' || sc.pres === 'form-sheet';
  const showTitle = !nav?.largeTitle || shell.scrolledPast.has(sc.win.w);
  const hasMore = sc.pres === 'root' || !!sc.win.menu?.length;
  // The bar has no fill of its own: it's the page's top color, with the hard scroll edge once the page scrolls.
  const edge = shell.edges.get(sc.win.w);
  return (
    <header className={`ios-bar${edge?.scrolled ? ' edge' : ''}`} style={edge && !edge.scrolled ? { background: edge.color } : undefined}>
      {sc.pres === 'page-sheet' && !shell.tablet && <div className="ios-grabber" aria-hidden="true" />}
      <div className="ios-bar-row">
        <div className="ios-bar-lead">
          {nav?.back || sc.pres === 'push' ? (
            <button className="ios-back" aria-label="Back" onClick={() => shell.goBack()}>
              {BACK}
            </button>
          ) : sheet ? (
            <button className="ios-icon-btn" aria-label="Close" onClick={() => controller.close(sc.win.w)}>
              {XMARK}
            </button>
          ) : null}
        </div>
        <h1 className={`ios-bar-title${showTitle ? '' : ' faded'}`}>{title}</h1>
        <div className="ios-bar-trail">
          {nav?.actions?.map((a) => (
            <button key={a.id} className={a.icon ? 'ios-icon-btn' : 'ios-text-btn'} aria-label={a.label} disabled={a.disabled} onClick={() => a.run()}>
              {a.icon ? <NavIcon name={a.icon} /> : a.label}
            </button>
          ))}
          {hasMore && (
            <button className="ios-icon-btn" aria-label="More" aria-haspopup="menu" onClick={(e) => onMore(sc, e.currentTarget)}>
              {ELLIPSIS}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------- menus ----------

const isChoice = (it: MenuItemSpec) => it.type === 'checkbox' || it.type === 'radio';

/** One level of a menu as iOS draws it: groups split by a thick gap, a check before chosen items, a chevron on submenus. */
function MenuLevel({ items, title, onUp, onItem }: { items: MenuItemSpec[]; title: string | null; onUp: () => void; onItem: (it: MenuItemSpec) => void }) {
  const checks = items.some(isChoice);
  return (
    <div className="ios-menu-scroll ph-scroll" role="menu">
      {title !== null && (
        <button className="ios-menu-item ios-menu-up" onClick={onUp}>
          <span className="ios-menu-check">{CHEVRON_LEFT}</span>
          <span className="ios-menu-label">{title}</span>
        </button>
      )}
      {menuGroups(items).map((group, gi) => (
        <div key={gi} className="ios-menu-group">
          {group.map((it) => (
            <button
              key={it.id}
              role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
              aria-checked={isChoice(it) ? !!it.checked : undefined}
              aria-haspopup={it.type === 'submenu' || undefined}
              className="ios-menu-item"
              disabled={!it.enabled}
              onClick={() => onItem(it)}
            >
              {checks && <span className="ios-menu-check">{it.checked ? CHECK : null}</span>}
              <span className="ios-menu-label">{plainLabel(it.label)}</span>
              {it.type === 'submenu' && <span className="ios-menu-sub">{CHEVRON_RIGHT}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Where a menu of `width` × about its height goes so it stays on screen, below or above `y`. */
function placeMenu(x: number, y: number, width: number, height: number, vw: number, vh: number): React.CSSProperties {
  const left = Math.max(8, Math.min(x, vw - width - 8));
  const below = y + height + 8 <= vh;
  return below ? { left, top: Math.max(8, y), width } : { left, bottom: Math.max(8, vh - y), width };
}

/** The More button's pull-down menu, under the button. */
function PullDown({ items, anchor, onPick, onClose }: { items: MenuItemSpec[]; anchor: DOMRect; onPick: (it: MenuItemSpec) => void; onClose: () => void }) {
  const sub = useSubmenus(items);
  const width = 250;
  return (
    <div className="ios-menu-layer" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ios-menu" style={{ right: Math.max(8, window.innerWidth - anchor.right), top: anchor.bottom + 6, width }}>
        <MenuLevel items={sub.level} title={sub.title} onUp={sub.up} onItem={(it) => (it.type === 'submenu' ? sub.open(it) : onPick(it))} />
      </div>
    </div>
  );
}

/** A menu the computer popped up (a long press): a context menu by the finger, or an action sheet when long. */
function PopupMenu({ controller, shell, menu: m }: { controller: ShellController; shell: PhoneShell; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const sub = useSubmenus(m.items);
  // An iPad shows an action sheet as a popover by the finger, which the menu list already is.
  const long = !shell.tablet && isLongMenu(sub.level, shell.vp.height);
  const pick = (it: MenuItemSpec) => (it.type === 'submenu' ? sub.open(it) : controller.pick(m.menuId, m.w, it));
  const dismiss = () => controller.dismissMenu(m.menuId);
  if (long) {
    return (
      <div className="ios-sheet-layer" onPointerDown={(e) => e.target === e.currentTarget && dismiss()}>
        <div className="ios-action-sheet">
          <div className="ios-action-group">
            <MenuLevel items={sub.level} title={sub.title} onUp={sub.up} onItem={pick} />
          </div>
          <button className="ios-action-cancel" onClick={dismiss}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
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

const DESTRUCTIVE = /^(delete|remove|discard|don.t save|unpair|end|stop|clear|overwrite|replace|move to recycle bin)\b/i;

/**
 * UIAlertController's look: the message as the bold title, the detail under
 * it; two buttons side by side with Cancel on the left, more stacked with
 * Cancel last. The default button, when it isn't Cancel, is the tinted one.
 */
export function Alert({ spec, onAnswer, input }: { spec: MessageBoxSpec; onAnswer: (response: number, checked: boolean) => void; input?: { value: string; onChange: (v: string) => void } }) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  const cancel = messageCancelId(spec);
  const preferred = spec.defaultId !== undefined && spec.defaultId !== cancel ? spec.defaultId : cancel;
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
            <button key={i} className={`ios-alert-btn${i === preferred && (i !== cancel || spec.buttons.length === 1) ? ' bold' : ''}${DESTRUCTIVE.test(spec.buttons[i]) && i !== cancel ? ' destructive' : ''}`} onClick={() => onAnswer(i, checked)}>
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
  lead,
  trail,
  onClose,
  small,
  children,
}: {
  shell: PhoneShell;
  label: string;
  lead: ReactNode;
  trail?: ReactNode;
  onClose: () => void;
  small?: boolean;
  children: ReactNode;
}) {
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
          <div className="ios-bar-row">
            <div className="ios-bar-lead">{lead}</div>
            <h1 className="ios-bar-title">{label}</h1>
            <div className="ios-bar-trail">{trail}</div>
          </div>
        </header>
        <div className="ios-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** The folder level inside a file sheet: back to the parent, the folder's name, New Folder. */
function FolderBar({ browser, onNewFolder }: { browser: HostBrowser; onNewFolder?: () => void }) {
  const crumbs = browser.crumbs;
  const here = crumbs[crumbs.length - 1];
  const parent = crumbs[crumbs.length - 2];
  return (
    <div className="ios-folder-bar">
      <div className="ios-bar-lead">
        {parent && (
          <button className="ios-back" aria-label={`Back to ${parent.label}`} onClick={browser.up}>
            {BACK}
          </button>
        )}
      </div>
      <div className="ios-folder-title">{here.label}</div>
      <div className="ios-bar-trail">
        {onNewFolder && (
          <button className="ios-icon-btn" aria-label="New Folder" disabled={browser.path === null} onClick={onNewFolder}>
            {NEW_FOLDER}
          </button>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="ios-segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
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
  return (
    <Sheet
      shell={shell}
      label={f.title}
      onClose={f.cancel}
      lead={
        <button className="ios-icon-btn" aria-label="Cancel" onClick={f.cancel}>
          {XMARK}
        </button>
      }
      trail={
        showConfirm && (
          <button className="ios-text-btn bold" disabled={!f.canConfirm} onClick={f.confirm}>
            {plainLabel(f.confirmLabel)}
          </button>
        )
      }
    >
      {f.sources.length > 1 && (
        <Segmented
          value={f.source}
          options={[
            { value: 'device', label: `This ${noun}` },
            { value: 'computer', label: 'This Computer' },
          ]}
          onChange={f.setSource}
        />
      )}
      {f.kind === 'save' && (
        <div className="ios-group">
          <label className="ios-cell ios-field">
            <span className="ios-cell-label">Name</span>
            <input value={f.name} onChange={(e) => f.setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && f.confirm()} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
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
          <FolderBar browser={f.browser} onNewFolder={() => setNaming(true)} />
          <FileRows
            os="ios"
            browser={f.browser}
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

/** A folder or file on the computer the user asked to see. */
function PathSheet({ controller, shell, req }: { controller: ShellController; shell: PhoneShell; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  if (!p.browser) return <LocalAlert msg={p.message} />;
  const browser = p.browser;
  return (
    <Sheet
      shell={shell}
      label={p.name}
      onClose={p.close}
      lead={
        <button className="ios-icon-btn" aria-label="Close" onClick={p.close}>
          {XMARK}
        </button>
      }
    >
      <FolderBar browser={browser} />
      <FileRows os="ios" browser={browser} onFile={(entry) => browser.select(entry)} />
      <div className="ios-toolbar">
        <button className="ios-text-btn" onClick={p.openOnComputer}>
          Open on Computer
        </button>
        <button className="ios-text-btn" disabled={!p.canDownload} onClick={p.download}>
          Download
        </button>
      </div>
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
      lead={null}
      trail={
        <button className="ios-icon-btn prominent" aria-label="Done" onClick={onClose}>
          {CHECKMARK}
        </button>
      }
    >
      <div className="ios-grouped ph-scroll">
        <div className="ios-group">
          <label className="ios-cell ios-field">
            <span className="ios-cell-label">Name</span>
            <input
              value={draft ?? d.name}
              disabled={d.busy}
              enterKeyHint="done"
              autoCorrect="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={commit}
            />
          </label>
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
        {d.push === 'home-screen' && <div className="ios-group-footer">Add Looper to the Home Screen to get notifications.</div>}
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
