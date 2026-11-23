import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NOTIFY_TOPICS, type MessageBoxSpec } from '../../../shared/remote-access';
import { Icon } from '../components/Icon';
import { ICONS } from '../components/icons';
import { Menu } from '../components/Menu';
import { Segmented } from '../components/phone/PhoneList';
import { ComputerMenu } from './ComputerMenu';
import { useConnection } from './connection';
import { IosField } from './IosField';
import type { ShellController } from './controller';
import { useDeviceForm } from './device-form';
import { DevicePick } from './DevicePick';
import { OfflineBanner } from './OfflineBanner';
import { HOST_COMPUTER, iosAlertButtons, messageResult } from './dialog-flows';
import { useFileDialog, usePathRequest, type HostBrowser } from './file-flows';
import { LocalMessageBox, NewFolderBox, useMessageAnswer, type MessageBoxProps } from './message-box';
import { Notifications } from './Notifications';
import { PathBar } from './PathBar';
import { CHECK, FileRows, FileViewBody, Switch } from './phone-files';
import { viewToggles, type ViewOptions } from './file-view';
import { deviceNoun, moreFor, PhoneWindows, pickMore, screenBars, usePhoneShell, type PhoneShell, type Screen, type TopEdge } from './phone-shell';
import { barLook, composite, paintTopEdge, withOpacity } from './top-bar';
import { slideCard, useDragToDismiss } from './sheet-drag';
import type { PageNavTabs } from './page-nav';
import type { OpenDialog, PathRequest } from './store';
import { noMnemonic } from '../../../shared/commands/command';
import type { PageNavAction } from './nav-bar-model';
import { installMotion } from './motion';
import { installStatusBarTap } from './status-bar-tap';
import { IosBarRow, IosBrowserBarRow } from './NavBarRow';
import { BarHostContext, NavBar, type NavBarProps } from '../components/NavBar';
import { ViewportContext } from './viewport-context';
import './ios.css';

/** iOS (iPhone and iPad), after the Human Interface Guidelines: windows as a navigation stack and sheets. */
export function IosFrame({ controller }: { controller: ShellController }) {
  const moreSeq = useRef(0);
  // A bar button's menu lines up with its group's trailing edge, whichever button of the group opened it, and grows out of that button.
  const shell = usePhoneShell(controller, 'ios', (button) => ({
    anchor: (button.closest('.ios-bar-group') ?? button).getBoundingClientRect(),
    from: button.getBoundingClientRect(),
    seq: ++moreSeq.current,
  }));
  const { s, more, setMore } = shell;

  // A field under 16 px would make Safari zoom the page when it gets the focus.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta && !/maximum-scale/.test(meta.content)) meta.content += ', maximum-scale=1';
    installMotion(document);
  }, []);
  // A tap on the status bar scrolls the top screen's list to its top (status-bar-tap.ts).
  const topW = useRef(shell.top?.win.w);
  topW.current = shell.top?.win.w;
  useEffect(() => installStatusBarTap(document, () => (topW.current ? controller.frameOf(topW.current)?.contentDocument : null)), [controller]);
  // Safari fills the area behind the status bar with the color of the fixed strip at the top of the served page (pwa.ts)
  // and blurs it without one (top-bar.ts, paintTopEdge): the strip takes what the screen shows there, the page under its
  // bar, the scroll edge effect, a sheet's dimming and the dark theme, read once each change has settled.
  const edgesNow = useRef(shell.edges);
  edgesNow.current = shell.edges;
  const screensNow = useRef(shell.screens);
  screensNow.current = shell.screens;
  const paintQueued = useRef(0);
  const paintTop = useRef(() => {});
  paintTop.current = () => {
    if (paintQueued.current) return;
    paintQueued.current = requestAnimationFrame(() => {
      paintQueued.current = 0;
      const root = shell.rootRef.current;
      if (!root) return;
      const color = screenTopColor(root, edgesNow.current, screensNow.current);
      paintTopEdge(document, color);
      root.style.setProperty('--ios-status', color);
    });
  };
  useEffect(() => paintTop.current());
  useEffect(() => {
    const paint = () => paintTop.current();
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    document.addEventListener('transitionend', paint, true);
    document.addEventListener('animationend', paint, true);
    scheme.addEventListener('change', paint);
    return () => {
      document.removeEventListener('transitionend', paint, true);
      document.removeEventListener('animationend', paint, true);
      scheme.removeEventListener('change', paint);
      cancelAnimationFrame(paintQueued.current);
    };
  }, []);

  return (
    <div ref={shell.rootRef} className={`ph-root ios${shell.tablet ? ' tablet' : ''}${shell.vp.keyboard ? ' kb' : ''}`}>
      <div ref={shell.probeRef} className="ph-probe" aria-hidden="true" />
      <ViewportContext.Provider value={shell.vp}>
        <PhoneWindows
          shell={shell}
          controller={controller}
          renderBar={(sc) => <IosBar shell={shell} controller={controller} sc={sc} onMore={shell.openMore} onActionMenu={shell.openActionMenu} />}
          dragToDismiss={(p) => p === 'page-sheet' || p === 'form-sheet'}
        />
        {shell.device && <DeviceSheet controller={controller} shell={shell} onClose={() => shell.setDevice(false)} />}
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
          <Menu
            key={more.seq}
            items={more.items}
            row={more.row}
            place={{ kind: 'control', rect: more.anchor, from: more.from }}
            onClose={() => setMore((m) => (m?.seq === more.seq ? null : m))}
            onPick={(item) => pickMore(controller, more, item)}
          />
        )}
        {s.menus.map((m) => (
          <ComputerMenu key={m.menuId} controller={controller} menu={m} />
        ))}
        <Notifications controller={controller} toasts={s.toasts} />
      </ViewportContext.Provider>
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
  const more = moreFor(sc).items.length > 0 ? (button: HTMLElement) => onMore(sc, button) : undefined;
  const close = () => controller.close(sc.win.w);
  // iPad's split view: the tab bar near the top, then a bar over each column. The list's bar has the
  // window's own Back; the detail's has the page's (a deeper screen in that column).
  const bars = screenBars(sc, shell.tablet, { goBack: () => shell.goBack(), listBack: close, close });
  // The bar has no fill of its own: transparent over a page that runs under it, with the hard scroll edge effect once
  // the page scrolls there; over a page that starts below it, the page's top color (top-bar.ts, barLook).
  const edge = shell.edges.get(sc.win.w);
  const connection = useConnection(controller);
  if (bars.kind === 'split') {
    const { split, list, detail } = bars;
    const listLook = barLook(edge, !!split.largeTitle);
    const detailLook = barLook(edge?.detail && { ...edge.detail, under: edge.under }, false);
    return (
      <header
        className={`ios-bar split${listLook.under ? ' under' : ''}`}
        style={
          {
            background: edge && !edge.under ? edge.color : undefined,
            // Where each column's scroll edge effect runs across the bar (ios.css).
            '--ios-split-lead': `${split.width}px`,
            '--ios-split-inspector': `${bars.inspector && split.inspector ? split.inspector.width : 0}px`,
          } as React.CSSProperties
        }
      >
        {nav?.tabs && <IosTabBar tabs={nav.tabs} />}
        <div className="ios-bar-split">
          <IosBarRow
            model={list}
            onActionMenu={actionMenuHere}
            className={`ios-bar-list${listLook.edge ? ' edge' : ''}`}
            style={{ width: split.width }}
            titleAs="h2"
            titleFaded={listLook.titleFaded}
          />
          <IosBarRow
            model={detail}
            onMore={more}
            onActionMenu={actionMenuHere}
            className={`ios-bar-detail${detailLook.edge ? ' edge' : ''}${detailLook.onDark ? ' on-dark' : ''}`}
            style={detailLook.background ? { background: detailLook.background } : undefined}
          />
          {bars.inspector && split.inspector && (
            <IosBarRow model={bars.inspector} className="ios-bar-inspector" style={{ width: split.inspector.width }} titleAs="h2" />
          )}
        </div>
        <OfflineBanner connection={connection} />
      </header>
    );
  }
  const model = bars.bar;
  const look = barLook(edge, !!nav?.largeTitle);
  return (
    <header
      className={`ios-bar${look.edge ? ' edge' : ''}${look.under ? ' under' : ''}${look.onDark ? ' on-dark' : ''}`}
      style={look.background ? { background: look.background } : undefined}
    >
      {shell.tablet && nav?.tabs && <IosTabBar tabs={nav.tabs} />}
      <IosBarRow model={model} onMore={more} onActionMenu={actionMenuHere} titleFaded={look.titleFaded} />
      <OfflineBanner connection={connection} />
    </header>
  );
}

/**
 * What the screen shows at the point where WebKit samples the top of the page (the middle of its top edge, 4 px down:
 * LocalFrameView::fixedContainerEdges, PageColorSampler::fixedContainerSampleRectMargin), as one opaque color: the
 * screens drawn there bottom first (a sheet's scrim, its card, the page under the bar, the bar and its scroll edge
 * effect, a page sheet's own backdrop), then the frame's own sheets, a dimmed menu and an alert. Screens under the top
 * one are inert, which hit testing skips, so each layer is found by its place rather than by elementsFromPoint.
 */
function screenTopColor(root: HTMLElement, edges: Map<string, TopEdge>, screens: Screen[]): string {
  const x = root.clientWidth / 2;
  const y = 4;
  const at = (el: Element | null | undefined): el is Element => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  };
  const fill = (el: Element, pseudo?: string) => {
    const cs = getComputedStyle(el, pseudo);
    return withOpacity(cs.backgroundColor, cs.opacity);
  };
  const layers: string[] = [];
  const sheetLayers = (host: Element) => {
    const scrim = host.querySelector(':scope > .ph-scrim');
    if (at(scrim)) layers.push(fill(scrim));
    const card = host.querySelector(':scope > .ph-card');
    if (!at(card)) return null;
    layers.push(fill(card));
    return card;
  };
  const wins = [...root.querySelectorAll<HTMLElement>(':scope > .ph-win')]
    .filter((el) => getComputedStyle(el).visibility !== 'hidden')
    .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
  for (const win of wins) {
    const card = sheetLayers(win);
    if (!card) continue;
    const w = win.dataset.w ?? '';
    const edge = edges.get(w);
    const body = card.querySelector('.ph-body');
    if (edge && at(body)) {
      // An iPad's split page: the middle of the screen is over its detail column.
      const lead = screens.find((sc) => sc.win.w === w)?.nav?.split?.width ?? 0;
      layers.push(edge.detail && x - body.getBoundingClientRect().left > lead ? edge.detail.color : edge.color);
    }
    const header = card.querySelector('.ph-bar-slot > header');
    if (at(header)) {
      layers.push(fill(header));
      // The scroll edge effect is the bar's ::before, the bar's height; on a split bar each column's, across its column.
      if (getComputedStyle(header, '::before').content !== 'none') layers.push(fill(header, '::before'));
      for (const row of header.querySelectorAll('.ios-bar-split > .ios-bar-row')) {
        const r = row.getBoundingClientRect();
        if (x < r.left || x >= r.right) continue;
        if (at(row)) layers.push(fill(row));
        if (getComputedStyle(row, '::before').content !== 'none') layers.push(fill(row, '::before'));
      }
    }
    const modal = card.querySelector('.ph-bar-slot.page-modal');
    if (at(modal)) layers.push(fill(modal, '::after'));
  }
  for (const sheet of root.querySelectorAll(':scope > .ios-own-sheet')) {
    const card = sheetLayers(sheet);
    const header = card?.querySelector(':scope > header');
    if (at(header)) layers.push(fill(header));
  }
  const menu = document.querySelector('.ios-menu-layer.dim');
  if (at(menu)) layers.push(fill(menu));
  for (const alert of document.querySelectorAll('.ios-alert-layer')) if (at(alert)) layers.push(fill(alert));
  return composite(layers, getComputedStyle(root).getPropertyValue('--ios-bg') || '#fff');
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

// ---------- alerts ----------

/**
 * UIAlertController's look: the message as the bold title, the detail under
 * it; two buttons side by side with Cancel on the left, more stacked with
 * Cancel last. The default button, when it isn't Cancel, is the tinted one.
 */
function Alert({ spec, onAnswer, input }: MessageBoxProps) {
  const { checked, setChecked, answer } = useMessageAnswer(spec, onAnswer);
  const { order, row, bold } = iosAlertButtons(spec);
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
              onKeyDown={(e) => e.key === 'Enter' && answer(spec.defaultId)}
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
            <button key={i} className={`ios-alert-btn${i === bold ? ' bold' : ''}${i === spec.destructiveId ? ' destructive' : ''}`} onClick={() => answer(i)}>
              {noMnemonic(spec.buttons[i])}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** New Folder: an alert with a text field. */
const NEW_FOLDER_SPEC: MessageBoxSpec = { message: 'New Folder', detail: 'Enter a name for this folder.', buttons: ['Cancel', 'Create'], cancelId: 0, defaultId: 1 };

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
  const drag = useDragToDismiss({ skip: 'button, input', extent: () => card.current?.clientHeight ?? 600, onMove: (offset) => slideCard(card.current, offset), onDismiss: onClose });
  return (
    <div className={`ios-own-sheet${shell.tablet ? ' tablet-sheet' : ''}${small ? ' small' : ''}`}>
      <div className="ph-scrim" />
      <div ref={card} className="ph-card" role="dialog" aria-modal="true" aria-label={label}>
        <header className="ios-bar" {...drag}>
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

/** The file browser's bar (IosBrowserBarRow) on a HostBrowser, its path (PathBar) as the title. */
function FilesBar({
  browser,
  actions,
  confirm,
  onClose,
}: {
  browser: HostBrowser;
  actions: { id: string; label: string; icon: string; run: () => void }[];
  confirm?: { label: string; disabled: boolean; run: () => void };
  onClose: () => void;
}) {
  return (
    <IosBrowserBarRow
      title={<PathBar browser={browser} />}
      canBack={browser.canBack}
      onBack={browser.back}
      actions={actions}
      confirm={confirm}
      onClose={onClose}
    />
  );
}

/** The search field under the file browser's bar: it narrows the folder's list as you type. */
function FilesSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="ios-files-search">
      <Icon size={17}>{ICONS.search}</Icon>
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

function FileSheet({ controller, shell, dialog }: { controller: ShellController; shell: PhoneShell; dialog: Extract<OpenDialog, { kind: 'open' | 'save' }> }) {
  const f = useFileDialog(controller, dialog);
  const [naming, setNaming] = useState(false);
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
          className="ios-segmented"
          activeClass="on"
          label="Location"
          value={f.source}
          items={[
            ['device', `This ${noun}`],
            ['computer', HOST_COMPUTER],
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
          <DevicePick f={f} filters={dialog.spec.filters} label={['Choose File…', 'Choose Files…']} className="ios-device-pick" buttonClass="ios-filled-btn" busyClass="ios-footnote" />
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
      {naming && <NewFolderBox browser={f.browser} spec={NEW_FOLDER_SPEC} box={Alert} onDone={() => setNaming(false)} />}
      <LocalMessageBox msg={f.message} box={Alert} />
    </Sheet>
  );
}

/** A folder or file on the host computer the user asked to see: a folder to browse, an image or text file to look at. */
function PathSheet({ controller, shell, req }: { controller: ShellController; shell: PhoneShell; req: PathRequest }) {
  const p = usePathRequest(controller, req);
  const [query, setQuery] = useFolderSearch(p.browser?.path ?? null);
  const [options, setOptions] = useState<ViewOptions>({});
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
            ...viewToggles(view.kind, options, setOptions),
            { id: 'download', label: 'Download', icon: 'download', run: () => view.askDownload(`This ${deviceNoun('ios', shell.tablet)}`) },
          ],
        }}
      >
        <FileViewBody view={view} name={p.name} steps={steps} options={options} />
        <LocalMessageBox msg={p.message} box={Alert} />
      </Sheet>
    );
  }
  if (!p.browser) return <LocalMessageBox msg={p.message} box={Alert} />;
  const browser = p.browser;
  return (
    <Sheet
      shell={shell}
      label={browser.crumbs[browser.crumbs.length - 1].label}
      onClose={p.close}
      header={<FilesBar browser={browser} actions={[{ id: 'open-on-host', label: `Open on ${HOST_COMPUTER}`, icon: 'openFolder', run: p.openOnComputer }]} onClose={p.close} />}
    >
      <FilesSearch value={query} onChange={setQuery} />
      <FileRows os="ios" browser={browser} query={query} onFile={p.openFile} />
      <LocalMessageBox msg={p.message} box={Alert} />
    </Sheet>
  );
}

/** This Device: its name (edited in place, saved on Return or when the field is left), the computer it's paired with, notifications, and Unpair. */
function DeviceSheet({ controller, shell, onClose }: { controller: ShellController; shell: PhoneShell; onClose: () => void }) {
  const d = useDeviceForm(controller);
  const commit = () => {
    const next = d.newName();
    // The typed name stays in the field until the computer answers; a failure puts the old one back.
    if (next) void d.rename(next).then(d.resetName);
    else d.resetName();
  };
  return (
    <Sheet shell={shell} label="This Device" onClose={onClose}>
      <div className="ios-grouped ph-scroll">
        <div className="ios-group">
          <IosField label="Name">
            <input
              value={d.nameText}
              disabled={d.busy}
              enterKeyHint="done"
              autoCorrect="off"
              onChange={(e) => d.setNameText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={commit}
            />
          </IosField>
          <div className="ios-cell">
            <span className="ios-cell-label">Paired with</span>
            <span className="ios-cell-value">{d.computer}</span>
          </div>
        </div>
        <div className="ios-group-title">Notifications</div>
        <div className="ios-group ios-group-titled">
          <div className="ios-cell">
            <span className="ios-cell-label">Allow notifications</span>
            <Switch os="ios" on={d.push === 'on'} disabled={!d.usable || d.busy} label="Allow notifications" onChange={d.setNotifications} />
          </div>
          {NOTIFY_TOPICS.map((t) => (
            <div key={t.id} className="ios-cell">
              <span className="ios-cell-label wrap">{t.label}</span>
              <Switch os="ios" on={!!d.notify?.[t.id]} disabled={!d.notify} label={t.label} onChange={(on) => void d.setTopic(t.id, on)} />
            </div>
          ))}
        </div>
        {d.hint && <div className="ios-group-footer">{d.hint}</div>}
        <div className="ios-group">
          <button className="ios-cell ios-cell-button destructive" onClick={d.unpair}>
            Unpair This Device
          </button>
        </div>
      </div>
      <LocalMessageBox msg={d.message} box={Alert} />
    </Sheet>
  );
}
