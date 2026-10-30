import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItemSpec, MessageBoxSpec } from '../../../shared/remote-access';
import type { ShellController } from './controller';
import { useThisDevice } from './device-flows';
import { messageCancelId, messageDefaultId, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser, type LocalMessage } from './file-flows';
import { AxisDrag } from './gestures';
import { CHECK, FileRows } from './phone-files';
import {
  deviceNoun,
  isLongMenu,
  NavIcon,
  PhoneWindows,
  plainLabel,
  Scrim,
  rootMoreItems,
  THIS_DEVICE_ITEM,
  usePhoneShell,
  useSubmenus,
  type BackLayer,
  type PhoneShell,
  type Screen,
} from './phone-shell';
import type { OpenDialog, OpenMenu, PathRequest, Toast } from './store';
import './android.css';

const ARROW_BACK = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" fill="currentColor" />
  </svg>
);
const CLOSE = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor" />
  </svg>
);
const MORE_VERT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="5.5" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="2" fill="currentColor" />
  </svg>
);
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
  const [more, setMore] = useState<{ w: string; items: MenuItemSpec[]; anchor: DOMRect } | null>(null);
  const [device, setDevice] = useState(false);
  const local: BackLayer[] = [];
  if (device) local.push(() => setDevice(false));
  if (more) local.push(() => setMore(null));
  const shell = usePhoneShell(controller, 'android', local);
  const { s } = shell;
  const overlay = !!more || device;
  useEffect(() => {
    if (!overlay) return;
    controller.setOverlay(true);
    return () => controller.setOverlay(false);
  }, [overlay, controller]);

  const openMore = (sc: Screen, button: HTMLElement) => {
    const items = sc.pres === 'root' ? rootMoreItems(sc.win.menu, 'This device') : (sc.win.menu ?? []);
    setMore({ w: sc.win.w, items, anchor: button.getBoundingClientRect() });
  };

  return (
    <div ref={shell.rootRef} className={`ph-root android${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <PhoneWindows
        shell={shell}
        controller={controller}
        renderBar={(sc) => <TopBar shell={shell} controller={controller} sc={sc} onMore={openMore} />}
        dragToDismiss={(p) => p === 'bottom-sheet'}
      />
      {!s.connected && (
        <div className="ph-connection" role="status">
          {s.everConnected ? 'Reconnecting…' : 'Connecting…'}
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
            if (item.id === THIS_DEVICE_ITEM) setDevice(true);
            else controller.pick(more.w, more.w, item);
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

function TopBar({ shell, controller, sc, onMore }: { shell: PhoneShell; controller: ShellController; sc: Screen; onMore: (sc: Screen, button: HTMLElement) => void }) {
  const nav = sc.nav;
  const title = plainLabel(nav?.title ?? sc.win.title);
  const hasMore = sc.pres === 'root' || !!sc.win.menu?.length;
  const dialogLike = sc.pres === 'full-dialog' || sc.pres === 'dialog';
  const lead =
    nav?.back || sc.pres === 'push' ? (
      <button className="md-icon-btn" aria-label="Back" onClick={() => shell.goBack()}>
        {ARROW_BACK}
      </button>
    ) : dialogLike ? (
      <button className="md-icon-btn" aria-label="Close" onClick={() => controller.close(sc.win.w)}>
        {CLOSE}
      </button>
    ) : null;
  return (
    <header className={`md-bar${sc.pres === 'bottom-sheet' ? ' sheet' : ''}`}>
      {sc.pres === 'bottom-sheet' && <div className="md-handle" aria-hidden="true" />}
      <div className="md-bar-row">
        {lead}
        <h1 className={`md-bar-title${lead ? '' : ' no-lead'}`}>{title}</h1>
        {nav?.actions?.map((a) =>
          a.icon && !dialogLike ? (
            <button key={a.id} className="md-icon-btn" aria-label={a.label} title={a.label} disabled={a.disabled} onClick={() => a.run()}>
              <NavIcon name={a.icon} size={24} />
            </button>
          ) : (
            <button key={a.id} className="md-text-btn" disabled={a.disabled} onClick={() => a.run()}>
              {a.label}
            </button>
          ),
        )}
        {hasMore && (
          <button className="md-icon-btn" aria-label="More options" aria-haspopup="menu" onClick={(e) => onMore(sc, e.currentTarget)}>
            {MORE_VERT}
          </button>
        )}
      </div>
    </header>
  );
}

// ---------- menus ----------

const isChoice = (it: MenuItemSpec) => it.type === 'checkbox' || it.type === 'radio';

function MenuItems({ items, title, onUp, onItem }: { items: MenuItemSpec[]; title: string | null; onUp: () => void; onItem: (it: MenuItemSpec) => void }) {
  const checks = items.some(isChoice);
  return (
    <div className="md-menu-list ph-scroll" role="menu">
      {title !== null && (
        <button className="md-menu-item md-menu-up" onClick={onUp}>
          <span className="md-menu-lead">{ARROW_BACK}</span>
          <span className="md-menu-label">{title}</span>
        </button>
      )}
      {items.map((it) =>
        it.type === 'separator' ? (
          <div key={it.id} className="md-divider" role="separator" />
        ) : (
          <button
            key={it.id}
            role={it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem'}
            aria-checked={isChoice(it) ? !!it.checked : undefined}
            aria-haspopup={it.type === 'submenu' || undefined}
            className="md-menu-item"
            disabled={!it.enabled}
            onClick={() => onItem(it)}
          >
            {checks && <span className="md-menu-lead">{it.checked ? (it.type === 'radio' ? <span className="md-radio-dot" /> : CHECK) : null}</span>}
            <span className="md-menu-label">{plainLabel(it.label)}</span>
            {it.type === 'submenu' && <span className="md-menu-trail">{ARROW_RIGHT}</span>}
          </button>
        ),
      )}
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

/** A menu the computer popped up (a long press): at the finger, or a bottom sheet when it's long. */
function PopupMenu({ controller, shell, menu: m }: { controller: ShellController; shell: PhoneShell; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const sub = useSubmenus(m.items);
  const pick = (it: MenuItemSpec) => (it.type === 'submenu' ? sub.open(it) : controller.pick(m.menuId, m.w, it));
  const dismiss = () => controller.dismissMenu(m.menuId);
  if (isLongMenu(sub.level, shell.vp.height)) {
    return (
      <BottomSheet onClose={dismiss} label="Menu">
        <MenuItems items={sub.level} title={sub.title} onUp={sub.up} onItem={pick} />
      </BottomSheet>
    );
  }
  const width = 220;
  const height = sub.level.length * 48 + 16;
  const left = Math.max(8, Math.min(at.x, shell.vp.width - width - 8));
  const top = at.y + height + 8 <= shell.vp.height ? at.y : Math.max(8, at.y - height);
  return <Menu items={m.items} style={{ left, top, minWidth: width }} onPick={(it) => controller.pick(m.menuId, m.w, it)} onClose={dismiss} />;
}

// ---------- dialogs ----------

/**
 * A Material 3 dialog: headline, supporting text, text buttons at the right
 * end with the dismissing one to the left of the confirming one (the
 * default), stacked when there are more than fit.
 */
export function Dialog({ spec, onAnswer, input }: { spec: MessageBoxSpec; onAnswer: (response: number, checked: boolean) => void; input?: { value: string; onChange: (v: string) => void } }) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  const cancel = messageCancelId(spec);
  const def = messageDefaultId(spec);
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
function FullDialog({ shell, title, onClose, action, children }: { shell: PhoneShell; title: string; onClose: () => void; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={`md-own-dialog${shell.tablet ? ' tablet' : ''}`}>
      <div className="md-scrim" />
      <div className="md-own-card" role="dialog" aria-modal="true" aria-label={title}>
        <header className="md-bar">
          <div className="md-bar-row">
            <button className="md-icon-btn" aria-label="Close" onClick={onClose}>
              {CLOSE}
            </button>
            <h1 className="md-bar-title">{title}</h1>
            {action}
          </div>
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
      action={
        !(onDevice && f.kind === 'open') && (
          <button className="md-text-btn" disabled={!f.canConfirm} onClick={f.confirm}>
            {plainLabel(f.confirmLabel)}
          </button>
        )
      }
    >
      {f.sources.length > 1 && (
        <div className="md-tabs" role="tablist">
          {(['device', 'computer'] as const).map((src) => (
            <button key={src} role="tab" aria-selected={f.source === src} className={`md-tab${f.source === src ? ' on' : ''}`} onClick={() => f.setSource(src)}>
              <span>{src === 'device' ? `This ${noun.toLowerCase()}` : 'This computer'}</span>
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
  if (!p.browser) return <LocalDialog msg={p.message} />;
  const browser = p.browser;
  return (
    <FullDialog
      shell={shell}
      title={p.name}
      onClose={p.close}
      action={
        <button className="md-text-btn" disabled={!p.canDownload} onClick={p.download}>
          Download
        </button>
      }
    >
      <Crumbs browser={browser} />
      <FileRows os="android" browser={browser} onFile={(entry) => browser.select(entry)} />
      <div className="md-bottom-actions">
        <button className="md-text-btn" onClick={p.openOnComputer}>
          Open on computer
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

function DeviceSheet({ controller, onClose }: { controller: ShellController; onClose: () => void }) {
  const d = useThisDevice(controller);
  const usable = d.push === 'on' || d.push === 'off';
  return (
    <BottomSheet label="This device" onClose={onClose}>
      <h2 className="md-sheet-title">This device</h2>
      <div className="md-list">
        <div className="md-list-item">
          <div className="md-list-text">
            <div className="md-list-headline">{d.name || ' '}</div>
            <div className="md-list-supporting">Paired with {d.computer}</div>
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
