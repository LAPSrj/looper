import { nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { HostKind } from '../engine/host';
import { errMsg } from '../engine/log';
import { ADDON_EXT } from '../shared/files';
import {
  addonAdditions,
  AddonLocalRunSchema,
  findAddonAction,
  runCommand,
  sideName,
  usesAddonDir,
  withAddonDir,
  type AddonAction,
  type AddonCommand,
  type AddonEntry,
  type AddonEvent,
  type AddonInfo,
  type AddonUiEvent,
  type AddonValue,
} from '../shared/addons';
import { REPORT_INPUT, issueLines } from '../shared/issues';
import { forAddonSide, type AddonHost } from './addon-host';
import { addonIconError } from './addon-icons';
import type { AddonRequestParams } from './addon-requests';
import { readAddonPackage, type ReadPackageResult } from './addon-package';
import { allWindows, ipc, showMessageBox, showOpenDialog, windowOf, WindowSlots, writeClipboard, type AppWindow, type MessageBoxOptions } from './platform';
import type { WindowRole } from '../shared/remote-access';

export interface AddonUiDeps {
  host: AddonHost;
  /** Where Looper itself runs, for converting picked paths to the addon's side. */
  hostKind: HostKind;
  mainWindow: () => AppWindow | null;
  /** Whether the window can show the addon's panes: a main window, or a window of its panes tab alone. */
  hasPanes: (w: AppWindow, addonId: string) => boolean;
  /** openChildWindow: a hash route in its own window; a parent makes it modal. */
  openWindow: (
    hash: string,
    title: string,
    width: number,
    height: number,
    modalParent: AppWindow | null,
    opts: { role: WindowRole; minWidth: number; minHeight: number; contentSize: boolean; resizable?: boolean },
  ) => AppWindow;
}

/** An addon window's role from the page size its manifest gives. */
export function addonWindowRole(width: number, height: number): WindowRole {
  if (width >= 900) return 'workspace';
  if (width <= 520 && height <= 360) return 'prompt';
  return width <= 560 && height <= 640 ? 'tool' : 'editor';
}

/** Every window hears about addons: panes in the main window, screens in addon windows. */
export function sendAddonEvent(ev: AddonUiEvent, only?: AppWindow | null): void {
  for (const w of only ? [only] : allWindows()) {
    if (!w.isDestroyed()) w.webContents.send('addon:event', ev);
  }
}

async function messageBox(parent: AppWindow | null, opts: MessageBoxOptions): Promise<number> {
  const r = await showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, opts);
  return r.response;
}

const errorBox = (parent: AppWindow | null, message: string, detail?: string) =>
  messageBox(parent, { type: 'error', title: 'Looper', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 });

async function ask(parent: AppWindow | null, message: string): Promise<boolean> {
  return (await messageBox(parent, { type: 'question', title: 'Looper', message, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1 })) === 0;
}

export function addonWindowHash(addonId: string, view: string, params: Record<string, unknown>, title: string): string {
  return ['addon', addonId, view, JSON.stringify(params), title].map(encodeURIComponent).join('/');
}

/** The window an addon window was opened from: a `select` from it goes there. */
const openers = new WeakMap<AppWindow, AppWindow>();
/** The windows commands opened, one per command and client. */
const commandWindows = new WindowSlots();
/** Every open window showing an addon's screens, by addon id: stopping the addon closes them. */
const addonWindows = new Map<string, Set<AppWindow>>();

function trackWindow(addonId: string, w: AppWindow): void {
  const set = addonWindows.get(addonId) ?? new Set<AppWindow>();
  set.add(w);
  addonWindows.set(addonId, set);
  w.on('closed', () => set.delete(w));
}

/** The windows an addon opened with `looper/openWindow`, by addon id: they wait for an answer, so the addon's process ending closes them. */
const requestedWindows = new Map<string, Set<AppWindow>>();

/** The addon's process stopped, restarted or crashed: its `looper/openWindow` windows have no one to answer, and close. */
export function closeRequestedWindows(addonId: string): void {
  for (const w of [...(requestedWindows.get(addonId) ?? [])]) if (!w.isDestroyed()) w.close();
}

/**
 * `looper/openWindow`: the addon's screen as a dialog over the window that
 * sent the event `p.request` (a phone's remote window opens it on the phone),
 * else over the main window, else as a window of its own. Resolves once it
 * has closed, however it closed.
 */
export function openRequestedWindow(deps: AddonUiDeps, addonId: string, p: AddonRequestParams<'looper/openWindow'>): Promise<Record<string, never>> {
  const origin = p.request === undefined ? undefined : (deps.host.originOf(addonId, p.request) as AppWindow | undefined);
  const parent = [origin, deps.mainWindow()].find((w): w is AppWindow => !!w && !w.isDestroyed()) ?? null;
  const width = p.width ?? 520;
  const height = p.height ?? 460;
  return new Promise((resolve) => {
    const child = deps.openWindow(addonWindowHash(addonId, p.view, p.params ?? {}, p.title), p.title, width, height, parent, {
      role: addonWindowRole(width, height),
      minWidth: Math.min(width, 520),
      minHeight: Math.min(height, 420),
      contentSize: true,
      resizable: false,
    });
    if (parent) openers.set(child, openers.get(parent) ?? parent);
    trackWindow(addonId, child);
    const set = requestedWindows.get(addonId) ?? new Set<AppWindow>();
    set.add(child);
    requestedWindows.set(addonId, set);
    child.on('closed', () => {
      set.delete(child);
      resolve({});
    });
  });
}

/** A command's `opens`: the screen in a window of its own, titled as the command, or the open one brought forward. */
function openCommandWindow(deps: AddonUiDeps, addon: AddonInfo, command: AddonCommand | AddonEntry): void {
  const opens = command.opens;
  if (!opens || 'tab' in opens) return;
  const key = `${addon.id}/${command.id}`;
  const open = commandWindows.get(key);
  if (open) {
    open.focus();
    return;
  }
  const title = command.label.replace(/&(&?)/g, '$1').replace(/…$/, '');
  const width = opens.width ?? 520;
  const height = opens.height ?? 460;
  const w = deps.openWindow(addonWindowHash(addon.id, opens.view, opens.params ?? {}, title), title, width, height, null, {
    role: addonWindowRole(width, height),
    minWidth: Math.min(width, 520),
    minHeight: Math.min(height, 420),
    contentSize: true,
  });
  commandWindows.set(w, key);
  trackWindow(addon.id, w);
}

async function runAction(deps: AddonUiDeps, sender: AppWindow | null, addonId: string, a: AddonAction): Promise<void> {
  switch (a.type) {
    case 'openWindow': {
      const width = a.width ?? 520;
      const height = a.height ?? 460;
      // A modal window is a dialog: fixed, so it opens at the addon's size every time instead of a saved one.
      const child = deps.openWindow(addonWindowHash(addonId, a.view, a.params ?? {}, a.title), a.title, width, height, a.modal ? sender : null, {
        role: addonWindowRole(width, height),
        minWidth: Math.min(width, 520),
        minHeight: Math.min(height, 420),
        contentSize: true,
        resizable: !a.modal,
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
      // The title names the feature the message comes from (Win32: error messages' titles).
      await messageBox(sender, { type: a.kind, title: deps.host.get(addonId)?.name ?? 'Looper', message: a.message, detail: a.detail, buttons: ['OK'], defaultId: 0, cancelId: 0 });
      return;
    case 'copy':
      writeClipboard(a.text);
      return;
    case 'select': {
      const from = (sender && openers.get(sender)) ?? sender;
      // A window of another tab alone has no panes: the main window shows the item.
      const target = from && deps.hasPanes(from, addonId) ? from : deps.mainWindow();
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
): Promise<{ value?: string; values?: Record<string, AddonValue>; errors?: Record<string, string> }> {
  if (confirm && !(await ask(sender, confirm))) return {};
  let result;
  try {
    result = await deps.host.event(addonId, ev, sender ?? undefined);
  } catch (e) {
    await errorBox(sender, errMsg(e));
    return {};
  }
  for (const a of result.actions ?? []) await runAction(deps, sender, addonId, a);
  if (ev.kind === 'copy') {
    if (result.value !== undefined) writeClipboard(result.value);
    return { values: result.values };
  }
  return { value: result.value, values: result.values, errors: result.errors };
}

/** Read a .looperaddon package (a zip, read and unpacked off the main process's thread), ask, and install it. */
export async function installAddonFile(deps: AddonUiDeps, file: string, parent: AppWindow | null): Promise<void> {
  let r: ReadPackageResult;
  try {
    r = await readAddonPackage(await fs.promises.readFile(file));
  } catch (e) {
    await errorBox(parent, 'Could not read the file.', errMsg(e));
    return;
  }
  if (!r.ok) {
    if (r.reason === 'newer') await errorBox(parent, 'This addon needs a newer version of Looper.', 'Update Looper to install it.');
    else if (r.reason === 'older') await errorBox(parent, 'This addon was made for an older version of Looper.', 'It needs an update from its author before it can be installed.');
    else if (r.reason === 'invalid') await errorBox(parent, 'The addon file has errors.', r.error);
    else await errorBox(parent, 'Could not install the file.', 'The file does not contain a Looper addon.');
    return;
  }
  const iconError = addonIconError(r.manifest);
  if (iconError) {
    await errorBox(parent, 'The addon file has errors.', iconError);
    return;
  }
  const m = r.manifest;
  const existing = deps.host.get(m.id);
  const changed = deps.host.runOf(m.id) !== undefined;
  const launch = deps.host.launchOf(m);
  const { environment } = launch;
  // ${addonDir} as the addon gets it: the folder it's installed in.
  const run = usesAddonDir(launch.run) ? withAddonDir(launch.run, await forAddonSide(launch, deps.hostKind, deps.host.folder(m.id))) : launch.run;
  const adds = addonAdditions(m);
  const where =
    run.on === 'looper'
      ? `${m.name} is a program that Looper runs with its own Node, and it can do anything you can do on this computer:\n${runCommand(run)}`
      : environment
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
    // Installing over another version, which the user didn't ask for by opening the file.
    ...(verb === 'Replace' ? { destructiveId: 0 } : {}),
    noLink: true,
  });
  if (response !== 0) return;
  try {
    await deps.host.install(r);
  } catch (e) {
    await errorBox(parent, 'Could not install the addon.', errMsg(e));
  }
}

export function registerAddonIpc(deps: AddonUiDeps): void {
  const { host } = deps;
  ipc.handle('addons:list', () => host.list());
  ipc.handle('addons:pane', (_e, id: string, pane: string) => host.pane(id, pane));
  ipc.handle('addons:render', (_e, id: string, view: string, params: Record<string, unknown>) => host.render(id, view, params));
  ipc.handle('addons:projectTab', (_e, id: string, tab: string, projectId: string) => host.projectTab(String(id), String(tab), String(projectId)));
  ipc.on('addons:slowDraw', (_e, id: string, view: string, ms: number) => host.logSlowDraw(id, view, ms));
  ipc.on('addons:overflow', (_e, id: string, view: string, tab: string, height: number) => host.logOverflow(id, view, tab, height));
  ipc.handle('addons:event', (e, id: string, ev: AddonEvent, confirm?: string) =>
    runEvent(deps, windowOf(e), id, ev, confirm),
  );
  ipc.handle('addons:restart', (_e, id: string) => host.restart(id));
  ipc.handle('addons:edit', (e, id: string) => {
    const addon = host.get(id);
    if (!addon) return;
    deps.openWindow(`addon-edit/${encodeURIComponent(id)}`, 'Edit Addon', 560, 440, windowOf(e), {
      role: 'tool',
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
  ipc.handle('addons:pickPath', async (e, id: string, input: 'file' | 'folder', accept?: { label: string; extensions: string[] }[]) => {
    const sender = windowOf(e);
    const opts: Electron.OpenDialogOptions =
      input === 'folder'
        ? { properties: ['openDirectory'] }
        : {
            properties: ['openFile'],
            filters: [...(accept ?? []).map((a) => ({ name: a.label, extensions: a.extensions })), { name: 'All files', extensions: ['*'] }],
          };
    const r = await showOpenDialog(sender, opts);
    const picked = r.canceled ? undefined : r.filePaths[0];
    return picked ? addonPath(deps, id, picked) : null;
  });
  ipc.handle('addons:setEnabled', (_e, id: string, enabled: boolean) => {
    host.setEnabled(id, enabled);
    if (enabled) return;
    for (const w of addonWindows.get(id) ?? []) if (!w.isDestroyed()) w.close();
  });
  ipc.handle('addons:open', (_e, id: string, commandId: string) => {
    const addon = host.list().find((a) => a.id === id);
    const command = addon && findAddonAction(addon.commands, commandId);
    if (addon && command) openCommandWindow(deps, addon, command);
  });
  ipc.handle('addons:remove', async (e, id: string) => {
    const m = host.get(id);
    if (!m) return;
    const sender = windowOf(e);
    const response = await messageBox(sender, {
      type: 'question',
      title: 'Looper',
      message: `Remove the addon "${m.name}"?`,
      detail: m.tabs.length || m.projectTabs.length || m.panes.length || m.commands.length ? 'What it added to Looper’s tabs, menus and toolbars goes with it.' : undefined,
      buttons: ['Remove', 'Cancel'],
      noLink: true,
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await host.remove(id, true);
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
}

/**
 * A path the user picked, as the addon sees it: a Windows path becomes a
 * /mnt/c/... one for an addon in WSL, and a WSL path a Windows one for an
 * addon on Windows. Unchanged when both are on the same side, or when wslpath
 * can't convert it.
 */
async function addonPath(deps: AddonUiDeps, addonId: string, file: string): Promise<string> {
  const m = deps.host.get(addonId);
  return m ? forAddonSide(deps.host.launchOf(m), deps.hostKind, file) : file;
}
