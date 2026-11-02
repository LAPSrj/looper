import { Menu, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { convertWslPath, type HostKind } from '../engine/host';
import { errMsg } from '../engine/log';
import {
  ADDON_EXT,
  addonAdditions,
  addonPaneKey,
  commandOn,
  AddonLocalRunSchema,
  readAddonManifest,
  runCommand,
  sideName,
  usesAddonDir,
  withAddonDir,
  type AddonAction,
  type AddonEvent,
  type AddonEventSource,
  type AddonInfo,
  type AddonMenuBar,
  type AddonMenuItem,
  type AddonTool,
  type AddonUiEvent,
} from '../shared/addons';
import { REPORT_INPUT, issueLines } from '../shared/issues';
import type { View } from '../shared/types';
import type { AddonHost, AddonLaunch } from './addon-host';
import {
  allWindows,
  ipc,
  isRemote,
  popupMenu,
  setWindowMenu,
  showMessageBox,
  showOpenDialog,
  windowOf,
  WindowSlots,
  writeClipboard,
  type AppWindow,
} from './platform';

export interface AddonUiDeps {
  host: AddonHost;
  /** Where Looper itself runs, for converting picked paths to the addon's side. */
  hostKind: HostKind;
  mainWindow: () => AppWindow | null;
  /** Whether the window shows the main window's addon panes (a main window, or a Tasks window): a view window of another tab hasn't them. */
  hasPanes: (w: AppWindow) => boolean;
  /** openChildWindow: a hash route in its own window; a parent makes it modal. */
  openWindow: (
    hash: string,
    title: string,
    width: number,
    height: number,
    modalParent: AppWindow | null,
    opts: { minWidth: number; minHeight: number; contentSize: boolean },
  ) => AppWindow;
  view: () => View;
  updateView: (patch: Partial<View>) => void;
}

const menuText = (s: string): string => s.replace(/&/g, '&&');

/** Every window hears about addons: panes in the main window, screens in addon windows. */
export function sendAddonEvent(ev: AddonUiEvent, only?: AppWindow | null): void {
  for (const w of only ? [only] : allWindows()) {
    if (!w.isDestroyed()) w.webContents.send('addon:event', ev);
  }
}

async function messageBox(parent: AppWindow | null, opts: Electron.MessageBoxOptions): Promise<number> {
  const r = await showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, opts);
  return r.response;
}

const errorBox = (parent: AppWindow | null, message: string, detail?: string) =>
  messageBox(parent, { type: 'error', title: 'Looper', message, detail, buttons: ['OK'] });

async function ask(parent: AppWindow | null, message: string): Promise<boolean> {
  return (await messageBox(parent, { type: 'question', title: 'Looper', message, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1 })) === 0;
}

export function addonWindowHash(addonId: string, view: string, params: Record<string, unknown>, title: string): string {
  return ['addon', addonId, view, JSON.stringify(params), title].map(encodeURIComponent).join('/');
}

/** The window an addon window was opened from: a `select` from it goes there. */
const openers = new WeakMap<AppWindow, AppWindow>();
/** The open tool windows, one per tool and client. */
const toolWindows = new WindowSlots();
/** Every open window showing an addon's screens, by addon id: stopping the addon closes them. */
const addonWindows = new Map<string, Set<AppWindow>>();

function trackWindow(addonId: string, w: AppWindow): void {
  const set = addonWindows.get(addonId) ?? new Set<AppWindow>();
  set.add(w);
  addonWindows.set(addonId, set);
  w.on('closed', () => set.delete(w));
}

/** Tools → <tool>: its window, or the open one brought forward. */
function openTool(deps: AddonUiDeps, addon: AddonInfo, tool: AddonTool): void {
  const key = `${addon.id}/${tool.id}`;
  const open = toolWindows.get(key);
  if (open) {
    open.focus();
    return;
  }
  const width = tool.width ?? (tool.pane ? 900 : 520);
  const height = tool.height ?? (tool.pane ? 600 : 460);
  const hash = tool.pane
    ? ['addon-pane', addon.id, tool.pane, tool.label].map(encodeURIComponent).join('/')
    : addonWindowHash(addon.id, tool.view!, tool.params ?? {}, tool.label);
  const w = deps.openWindow(hash, tool.label, width, height, null, {
    minWidth: Math.min(width, 520),
    minHeight: Math.min(height, 420),
    contentSize: true,
  });
  toolWindows.set(w, key);
  trackWindow(addon.id, w);
}

/** The Tools menu: every addon's tools. Empty when no addon has one. */
export function addonToolsMenu(deps: AddonUiDeps, addons: AddonInfo[]): Electron.MenuItemConstructorOptions[] {
  return addons.filter((a) => a.enabled).flatMap((a) =>
    a.tools.map((t): Electron.MenuItemConstructorOptions => ({
      label: menuText(t.label),
      enabled: a.status === 'running',
      platforms: t.platforms,
      click: () => openTool(deps, a, t),
    })),
  );
}

async function runAction(deps: AddonUiDeps, sender: AppWindow | null, addonId: string, a: AddonAction): Promise<void> {
  switch (a.type) {
    case 'openWindow': {
      const width = a.width ?? 520;
      const height = a.height ?? 460;
      const child = deps.openWindow(addonWindowHash(addonId, a.view, a.params ?? {}, a.title), a.title, width, height, a.modal ? sender : null, {
        minWidth: Math.min(width, 520),
        minHeight: Math.min(height, 420),
        contentSize: true,
      });
      if (sender) openers.set(child, openers.get(sender) ?? sender);
      trackWindow(addonId, child);
      return;
    }
    case 'closeWindow':
      if (sender && !sender.isDestroyed() && sender !== deps.mainWindow()) sender.close();
      return;
    case 'refresh':
      sendAddonEvent({ type: 'refresh', addonId });
      return;
    case 'message':
      await messageBox(sender, { type: a.kind, title: 'Looper', message: a.message, detail: a.detail, buttons: ['OK'] });
      return;
    case 'copy':
      writeClipboard(a.text);
      return;
    case 'select': {
      const from = (sender && openers.get(sender)) ?? sender;
      // A Dashboard, Projects or addon tab's own window has no panes: the main window shows the item.
      const target = from && deps.hasPanes(from) ? from : deps.mainWindow();
      if (!target || target.isDestroyed()) return;
      sendAddonEvent({ type: 'select', addonId, pane: a.pane, item: a.item }, target);
      if (target !== from) target.focus();
      return;
    }
  }
}

/**
 * Send an event to the addon and carry out what it answers. A copied secret
 * goes straight to the clipboard; only a revealed one and new field values
 * go back to the screen.
 */
async function runEvent(
  deps: AddonUiDeps,
  sender: AppWindow | null,
  addonId: string,
  ev: AddonEvent,
  confirm?: string,
): Promise<{ value?: string; values?: Record<string, string | number | boolean> }> {
  if (confirm && !(await ask(sender, confirm))) return {};
  let result;
  try {
    result = await deps.host.event(addonId, ev);
  } catch (e) {
    await errorBox(sender, errMsg(e));
    return {};
  }
  for (const a of result.actions ?? []) await runAction(deps, sender, addonId, a);
  if (ev.kind === 'copy') {
    if (result.value !== undefined) writeClipboard(result.value);
    return { values: result.values };
  }
  return { value: result.value, values: result.values };
}

/** Read a .looperaddon file, ask, and install it. */
export async function installAddonFile(deps: AddonUiDeps, file: string, parent: AppWindow | null): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    await errorBox(parent, 'Could not read the file.', errMsg(e));
    return;
  }
  const r = readAddonManifest(input);
  if (!r.ok) {
    if (r.reason === 'newer') await errorBox(parent, 'This addon needs a newer version of Looper.', 'Update Looper to install it.');
    else if (r.reason === 'invalid') await errorBox(parent, 'The addon file has errors.', r.error);
    else await errorBox(parent, 'Could not install the file.', 'The file does not contain a Looper addon.');
    return;
  }
  // ${addonDir} becomes the folder the file is installed from, so the addon runs wherever its program is.
  const m = usesAddonDir(r.manifest.run)
    ? {
        ...r.manifest,
        run: withAddonDir(r.manifest.run, await forAddonSide(deps.host.launchOf(r.manifest), deps.hostKind, path.dirname(file))),
      }
    : r.manifest;
  const existing = deps.host.get(m.id);
  const changed = deps.host.runOf(m.id) !== undefined;
  const { run, environment } = deps.host.launchOf(m);
  const adds = addonAdditions(m);
  const where = environment
    ? `${m.name} is a program that Looper starts in your "${environment.name}" environment, and it can do anything you can do on this computer:\n${runCommand(run)}`
    : `${m.name} is a ${sideName(run.on)} program, and no environment in Settings → Environments runs ${sideName(run.on)} programs yet, so it won’t start until you add one. It runs:\n${runCommand(run)}`;
  const detail = [
    m.description ?? '',
    adds.length ? `It adds:\n${adds.map((a) => `•  ${a}`).join('\n')}` : '',
    where,
    changed ? 'This is how you set it to run in Advanced → Addons → Edit…, which installing doesn’t change.' : '',
    'Install it only if you trust where it came from.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const [message, verb] = !existing
    ? [`Install ${m.name} ${m.version}?`, 'Install']
    : existing.version === m.version
      ? [`Reinstall ${m.name} ${m.version}?`, 'Reinstall']
      : [`Replace ${existing.name} ${existing.version} with version ${m.version}?`, 'Replace'];
  const response = await messageBox(parent, {
    // A routine question gets no standard icon; the addon file icon shows what is being installed.
    type: 'none',
    icon: nativeImage.createFromPath(path.join(__dirname, '../../assets/looperaddon.ico')),
    title: 'Looper',
    message,
    detail,
    buttons: [verb, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;
  try {
    deps.host.install(m);
  } catch (e) {
    await errorBox(parent, 'Could not install the addon.', errMsg(e));
  }
}

function paneTitle(addons: AddonInfo[], addon: AddonInfo, pane: { title: string }): string {
  const clash = addons.some((a) => a !== addon && a.panes.some((p) => p.title === pane.title));
  return clash ? `${pane.title} (${addon.name})` : pane.title;
}

/** View > Addon Panes: a Show checkbox per pane. Empty when no addon has a pane. */
export function addonPanesMenu(addons: AddonInfo[], view: View, update: (patch: Partial<View>) => void): Electron.MenuItemConstructorOptions[] {
  return addons.filter((a) => a.enabled).flatMap((a) =>
    a.panes.map((p): Electron.MenuItemConstructorOptions => {
      const key = addonPaneKey(a.id, p.id);
      const state = view.addonPanes[key] ?? { visible: true, collapsed: false, weight: 1 };
      return {
        label: menuText(paneTitle(addons, a, p)),
        type: 'checkbox',
        checked: state.visible,
        click: (item) => update({ addonPanes: { ...view.addonPanes, [key]: { ...state, visible: item.checked } } }),
      };
    }),
  );
}

/** "<Addon> Toolbar" in the View menu and the main toolbar's right-click menu: whether each addon's buttons show there. */
export function addonToolbarsMenu(addons: AddonInfo[], view: View, update: (patch: Partial<View>) => void): Electron.MenuItemConstructorOptions[] {
  return addons.filter((a) => a.enabled).map((a) => ({
    label: `${menuText(a.toolbarName ?? a.name)} Toolbar`,
    type: 'checkbox',
    checked: !view.hiddenAddonToolbars.includes(a.id),
    click: (item) =>
      update({
        hiddenAddonToolbars: item.checked
          ? view.hiddenAddonToolbars.filter((id) => id !== a.id)
          : [...view.hiddenAddonToolbars, a.id],
      }),
  }));
}

export function registerAddonIpc(deps: AddonUiDeps): void {
  const { host } = deps;
  ipc.handle('addons:list', () => host.list());
  ipc.handle('addons:pane', (_e, id: string, pane: string) => host.pane(id, pane));
  ipc.handle('addons:render', (_e, id: string, view: string, params: Record<string, unknown>) => host.render(id, view, params));
  ipc.on('addons:slowDraw', (_e, id: string, view: string, ms: number) => host.logSlowDraw(id, view, ms));
  ipc.handle('addons:event', (e, id: string, ev: AddonEvent, confirm?: string) =>
    runEvent(deps, windowOf(e), id, ev, confirm),
  );
  ipc.handle('addons:restart', (_e, id: string) => host.restart(id));
  ipc.handle('addons:edit', (e, id: string) => {
    const addon = host.get(id);
    if (!addon) return;
    deps.openWindow(`addon-edit/${encodeURIComponent(id)}`, 'Edit Addon', 560, 440, windowOf(e), {
      minWidth: 460,
      minHeight: 400,
      contentSize: true,
    });
  });
  // null goes back to how the addon's own file runs it.
  ipc.handle('addons:setRun', (_e, id: string, run: unknown) => {
    if (run === null) return host.setRun(id, undefined);
    const parsed = AddonLocalRunSchema.safeParse(run, REPORT_INPUT);
    if (!parsed.success) throw new Error(issueLines(parsed.error));
    host.setRun(id, parsed.data);
  });
  ipc.handle('addons:pickFile', async (e, id: string, accept?: { label: string; extensions: string[] }[]) => {
    const sender = windowOf(e);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [...(accept ?? []).map((a) => ({ name: a.label, extensions: a.extensions })), { name: 'All files', extensions: ['*'] }],
    };
    const r = await showOpenDialog(sender, opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    return file ? addonPath(deps, id, file) : null;
  });
  ipc.handle('addons:setEnabled', (_e, id: string, enabled: boolean) => {
    host.setEnabled(id, enabled);
    if (enabled) return;
    for (const w of addonWindows.get(id) ?? []) if (!w.isDestroyed()) w.close();
  });
  ipc.on('addons:toolbarMenu', (e) => {
    const sender = windowOf(e);
    const items = addonToolbarsMenu(host.list(), deps.view(), deps.updateView);
    if (sender && items.length) popupMenu(Menu.buildFromTemplate(items), { window: sender });
  });
  ipc.handle('addons:openTool', (_e, id: string, toolId: string) => {
    const addon = host.list().find((a) => a.id === id);
    const tool = addon?.tools.find((t) => t.id === toolId);
    if (addon && tool) openTool(deps, addon, tool);
  });
  ipc.handle('addons:remove', async (e, id: string) => {
    const m = host.get(id);
    if (!m) return;
    const sender = windowOf(e);
    const response = await messageBox(sender, {
      type: 'question',
      title: 'Looper',
      message: `Remove the addon "${m.name}"?`,
      detail: m.panes.length ? 'Its panes leave the sidebar.' : undefined,
      buttons: ['Remove', 'Cancel'],
      noLink: true,
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) host.remove(id);
  });
  ipc.handle('addons:install', async (e) => {
    const sender = windowOf(e);
    const opts: Electron.OpenDialogOptions = {
      title: 'Install Addon',
      filters: [{ name: 'Looper Addon', extensions: [ADDON_EXT] }],
      properties: ['openFile'],
    };
    const r = await showOpenDialog(sender, opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (file) await installAddonFile(deps, file, sender);
  });

  /**
   * A pane item's or a pane header's right-click menu: the addon's items,
   * then (header) Hide Pane. A pick goes to the addon as a `menu` event.
   */
  ipc.on(
    'addons:menu',
    (e, id: string, pane: string, menu: AddonMenuItem[], opts: { item?: string; header?: boolean }) => {
      const sender = windowOf(e);
      if (!sender) return;
      const items = menuItems(deps, sender, id, { pane }, menu, opts.item ? { id: opts.item } : undefined);
      if (opts.header) {
        const key = addonPaneKey(id, pane);
        if (items.length) items.push({ type: 'separator' });
        items.push({
          label: 'Hide Pane',
          click: () => {
            const view = deps.view();
            const state = view.addonPanes[key] ?? { visible: true, collapsed: false, weight: 1 };
            deps.updateView({ addonPanes: { ...view.addonPanes, [key]: { ...state, visible: false } } });
          },
        });
      }
      if (items.length) popupMenu(Menu.buildFromTemplate(items), { window: sender });
    },
  );

  /**
   * An addon window's menu bar, sent again whenever the screen or the
   * selected item changes; null takes it away. The main window keeps its own.
   */
  ipc.on(
    'addons:menuBar',
    (e, id: string, source: AddonEventSource, menuBar: AddonMenuBar | null, item?: { id: string; menu?: AddonMenuItem[] }) => {
      const sender = windowOf(e);
      // macOS has one global menu bar, but a remote window shows its own.
      if (!sender || sender === deps.mainWindow() || (process.platform === 'darwin' && !isRemote(sender))) return;
      setWindowMenu(
        sender,
        menuBar?.length
          ? Menu.buildFromTemplate(menuBar.map((m) => ({ label: m.label, platforms: m.platforms, submenu: menuItems(deps, sender, id, source, m.items, item) })))
          : null,
      );
    },
  );
}

/**
 * A path the user picked, as the addon sees it: a Windows path becomes a
 * /mnt/c/... one for an addon in WSL, and a WSL path a Windows one for an
 * addon on Windows. Unchanged when both are on the same side, or when wslpath
 * can't convert it.
 */
/** A path on Looper's side, in the form the addon's side uses (in its environment's distro). */
async function forAddonSide(launch: AddonLaunch, hostKind: HostKind, p: string): Promise<string> {
  if (launch.run.on === 'wsl' && hostKind === 'windows') return (await convertWslPath(p, 'posix', launch.environment?.distro || undefined)) ?? p;
  if (launch.run.on === 'windows' && hostKind === 'wsl') return (await convertWslPath(p, 'windows')) ?? p;
  return p;
}

async function addonPath(deps: AddonUiDeps, addonId: string, file: string): Promise<string> {
  const m = deps.host.get(addonId);
  return m ? forAddonSide(deps.host.launchOf(m), deps.hostKind, file) : file;
}

/** An addon's menu items as Electron's; a pick goes to the addon as a `menu` event. `&` marks an access key. */
function menuItems(
  deps: AddonUiDeps,
  sender: AppWindow,
  addonId: string,
  source: AddonEventSource,
  menu: AddonMenuItem[],
  item: { id: string; menu?: AddonMenuItem[] } | undefined,
): Electron.MenuItemConstructorOptions[] {
  return menu.map((m) =>
    'separator' in m
      ? { type: 'separator' }
      : {
          // The addon's id names the item in a designed phone More menu (mobileMore).
          id: m.id,
          label: m.label,
          platforms: m.platforms,
          ...(m.checked !== undefined ? { type: m.radio ? 'radio' : 'checkbox', checked: m.checked } : {}),
          enabled: (m.enabled ?? true) && commandOn(m, item),
          click: () => void runEvent(deps, sender, addonId, { source, kind: 'menu', id: m.id, item: item?.id }, m.confirm),
        },
  );
}
