import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NOTIFY_TOPICS, type MessageBoxSpec } from '../../../shared/remote-access';
import { Menu } from '../components/Menu';
import { CheckboxField } from '../components/ui';
import { BottomSheet } from './BottomSheet';
import { ComputerMenu } from './ComputerMenu';
import { useConnection } from './connection';
import type { ShellController } from './controller';
import { OfflineBanner } from './OfflineBanner';
import { useDeviceForm, type DeviceForm } from './device-form';
import { DevicePick } from './DevicePick';
import { materialDialogButtons, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest } from './file-flows';
import { LocalMessageBox, NewFolderBox, useMessageAnswer, type MessageBoxProps } from './message-box';
import { Notifications } from './Notifications';
import { PathBar } from './PathBar';
import { FileRows, FileViewBody, Switch } from './phone-files';
import { viewToggles, type ViewOptions } from './file-view';
import { deviceNoun, moreFor, PhoneWindows, pickMore, Scrim, screenBars, usePhoneShell, type PhoneShell, type Screen } from './phone-shell';
import type { OpenDialog, PathRequest } from './store';
import { noMnemonic } from '../../../shared/commands/command';
import type { PageNavAction } from './nav-bar-model';
import { MdBarRow } from './NavBarRow';
import { installMotion } from './motion';
import { BarHostContext, NavBar, type NavBarProps } from '../components/NavBar';
import { ViewportContext } from './viewport-context';
import './android.css';

const NEW_FOLDER = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 6h-8l-2-2H4c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z" fill="currentColor" />
  </svg>
);

/** Android, after Material 3: windows as screens with a top app bar, dialogs, and bottom sheets. */
export function AndroidFrame({ controller }: { controller: ShellController }) {
  const shell = usePhoneShell(controller, 'android');
  const { s, more } = shell;
  // Windows pushed and popped move as Material's shared axis (web/motion.ts).
  useEffect(() => installMotion(document), []);

  return (
    <div ref={shell.rootRef} className={`ph-root android${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <ViewportContext.Provider value={shell.vp}>
        <PhoneWindows
          shell={shell}
          controller={controller}
          renderBar={(sc) => <TopBar shell={shell} controller={controller} sc={sc} onMore={shell.openMore} onActionMenu={shell.openActionMenu} />}
          dragToDismiss={(p) => p === 'bottom-sheet'}
        />
        {shell.device && <DeviceSheet controller={controller} onClose={() => shell.setDevice(false)} />}
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
        {more && <Menu items={more.items} place={{ kind: 'control', rect: more.anchor }} onClose={() => shell.setMore(null)} onPick={(item) => pickMore(controller, more, item)} />}
        {s.menus.map((m) => (
          <ComputerMenu key={m.menuId} controller={controller} menu={m} />
        ))}
        <Notifications controller={controller} toasts={s.toasts} ownsBottom={!!shell.top?.nav?.ownsBottom} />
      </ViewportContext.Provider>
    </div>
  );
}

// ---------- the top app bar ----------

function TopBar({
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
  const goBack = () => shell.goBack();
  const actionMenuHere = (action: PageNavAction, button: HTMLElement) => onActionMenu(sc, action, button);
  // Two panes (Material: List-detail): a bar over each. The list's has the window's own Back, the detail's the page's.
  const bars = screenBars(sc, shell.tablet, { goBack, listBack: goBack, close: () => controller.close(sc.win.w) });
  const more = moreFor(sc).items.length > 0 ? (button: HTMLElement) => onMore(sc, button) : undefined;
  const connection = useConnection(controller);
  if (bars.kind === 'split') {
    return (
      <header className="md-bar">
        <div className="md-bar-split">
          <div className="md-bar-pane" style={{ width: bars.split.width }}>
            <MdBarRow model={bars.list} onActionMenu={actionMenuHere} />
          </div>
          <div className="md-bar-pane main">
            <MdBarRow model={bars.detail} onMore={more} onActionMenu={actionMenuHere} />
          </div>
          {bars.inspector && bars.split.inspector && (
            <div className="md-bar-pane" style={{ width: bars.split.inspector.width }}>
              <MdBarRow model={bars.inspector} />
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
      <MdBarRow model={bars.bar} onMore={more} onActionMenu={actionMenuHere} dialogLike={sc.pres === 'full-dialog' || sc.pres === 'dialog'} />
      <OfflineBanner connection={connection} />
    </header>
  );
}

// ---------- dialogs ----------

/**
 * A Material 3 dialog: headline, supporting text, text buttons at the right
 * end with the dismissing one to the left of the confirming one (the
 * default), stacked when there are more than fit.
 */
function Dialog({ spec, onAnswer, input }: MessageBoxProps) {
  const { checked, setChecked, answer } = useMessageAnswer(spec, onAnswer);
  const { order, stacked, confirm } = materialDialogButtons(spec);
  // On <body>: a dialog inside a sheet would otherwise be caught in the sheet's moving card.
  return createPortal(
    <div className="md-dialog-layer">
      <Scrim className="md-scrim" onTap={() => answer(spec.cancelId)} />
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
            onKeyDown={(e) => e.key === 'Enter' && confirm !== undefined && answer(confirm)}
          />
        )}
        {spec.checkboxLabel && <CheckboxField className="md-check-row" label={spec.checkboxLabel} checked={checked} onChange={setChecked} />}
        <div className={`md-dialog-actions${stacked ? ' stacked' : ''}`}>
          {order.map((i) => (
            <button key={i} className="md-text-btn" onClick={() => answer(i)}>
              {noMnemonic(spec.buttons[i])}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const NEW_FOLDER_SPEC: MessageBoxSpec = { message: 'New folder', buttons: ['Cancel', 'Create'], cancelId: 0, defaultId: 1 };

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

function FileScreen({ controller, shell, dialog }: { controller: ShellController; shell: PhoneShell; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const [naming, setNaming] = useState(false);
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
          <DevicePick f={f} filters={dialog.spec.filters} label={['Choose file', 'Choose files']} className="md-device-pick" buttonClass="md-filled-btn" busyClass="md-supporting" />
        )
      ) : (
        <>
          <PathBar browser={f.browser} />
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
      {naming && <NewFolderBox browser={f.browser} spec={NEW_FOLDER_SPEC} box={Dialog} onDone={() => setNaming(false)} />}
      <LocalMessageBox msg={f.message} box={Dialog} />
    </FullDialog>
  );
}

function PathScreen({ controller, shell, req }: { controller: ShellController; shell: PhoneShell; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  const [options, setOptions] = useState<ViewOptions>({});
  if (p.view) {
    const steps = p.steps;
    const actions = [
      ...(steps
        ? [
            { id: 'previous', label: 'Previous', disabled: steps.index <= 0, run: () => steps.go(steps.index - 1) },
            { id: 'next', label: 'Next', disabled: steps.index >= steps.count - 1, run: () => steps.go(steps.index + 1) },
          ]
        : []),
      ...viewToggles(p.view.kind, options, setOptions),
    ];
    return (
      <FullDialog shell={shell} title={steps ? `${steps.index + 1} of ${steps.count}` : p.name} onClose={p.close} bar={actions.length ? { actions } : undefined}>
        <FileViewBody view={p.view} name={p.name} steps={steps} options={options} />
        <div className="md-bottom-actions">
          <button className="md-text-btn" onClick={p.view.toHost}>
            Download to host computer
          </button>
          <button className="md-text-btn" onClick={p.view.toDevice}>
            Download to this {deviceNoun('android', shell.tablet).toLowerCase()}
          </button>
        </div>
        <LocalMessageBox msg={p.message} box={Dialog} />
      </FullDialog>
    );
  }
  if (!p.browser) return <LocalMessageBox msg={p.message} box={Dialog} />;
  const browser = p.browser;
  return (
    <FullDialog shell={shell} title={p.name} onClose={p.close}>
      <PathBar browser={browser} />
      <FileRows os="android" browser={browser} onFile={p.openFile} />
      <div className="md-bottom-actions">
        <button className="md-text-btn" onClick={p.openOnComputer}>
          Open on host computer
        </button>
      </div>
      <LocalMessageBox msg={p.message} box={Dialog} />
    </FullDialog>
  );
}

/** Rename this device: a dialog with the name's field, as Android's own Settings rename the phone. */
function RenameDialog({ form, onDone }: { form: DeviceForm; onDone: () => void }) {
  return (
    <Dialog
      spec={{ message: 'Device name', buttons: ['Cancel', 'Rename'], cancelId: 0, defaultId: 1 }}
      input={{ value: form.nameText, onChange: form.setNameText }}
      onAnswer={(r) => {
        const next = form.newName();
        if (r === 1 && next) void form.rename(next);
        form.resetName();
        onDone();
      }}
    />
  );
}

function DeviceSheet({ controller, onClose }: { controller: ShellController; onClose: () => void }) {
  const d = useDeviceForm(controller);
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
      </div>
      <h3 className="md-list-title">Notifications</h3>
      <div className="md-list">
        <div className="md-list-item">
          <div className="md-list-text">
            <div className="md-list-headline">Allow notifications</div>
            {d.hint && <div className="md-list-supporting wrap">{d.hint}</div>}
          </div>
          <Switch os="android" on={d.push === 'on'} disabled={!d.usable || d.busy} label="Allow notifications" onChange={d.setNotifications} />
        </div>
        {NOTIFY_TOPICS.map((t) => (
          <div key={t.id} className="md-list-item">
            <div className="md-list-text">
              <div className="md-list-headline wrap">{t.label}</div>
            </div>
            <Switch os="android" on={!!d.notify?.[t.id]} disabled={!d.notify} label={t.label} onChange={(on) => void d.setTopic(t.id, on)} />
          </div>
        ))}
      </div>
      <div className="md-sheet-actions">
        <button className="md-text-btn error" onClick={d.unpair}>
          Unpair this device
        </button>
      </div>
      {renaming && <RenameDialog form={d} onDone={() => setRenaming(false)} />}
      <LocalMessageBox msg={d.message} box={Dialog} />
    </BottomSheet>
  );
}
