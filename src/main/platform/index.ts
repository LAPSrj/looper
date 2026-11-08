/**
 * The main process's window, IPC, menu, dialog and shell calls, for the
 * desktop and for remote clients alike: a call made for a remote window, or
 * from code running as a remote caller (see context.ts), lands on that
 * client; everything else goes to Electron as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type Menu } from 'electron';
import type { FileDialogSpec, MessageBoxSpec, ServerMessage, WindowRole } from '../../shared/remote-access';
import type { RemoteClients } from './clients';
import { caller } from './context';
import { IpcTable, type IpcMainLike } from './ipc-table';
import { hideOffPlatform } from './menus';
import { RemoteWindow, RemoteWebContents, type AppWindow, type RemoteClient } from './remote-window';
import { createPlacedWindow } from './window-places';

export { caller, runAs, type CallContext } from './context';
export { IpcTable } from './ipc-table';
export { RemoteClients } from './clients';
export { RemoteWindow, type AppWindow, type AppWebContents } from './remote-window';
export { WindowSlots, clientKey, clientKeyOf, ofCaller, DESKTOP } from './slots';
export { useWindowPlaces, placeAs } from './window-places';

/** Every IPC handler and listener goes through this, so remote clients reach them too. */
export const ipc = new IpcTable(ipcMain as unknown as IpcMainLike);

// A BrowserWindow must stay usable wherever an AppWindow is asked for.
const _desktopIsAppWindow = (w: BrowserWindow): AppWindow => w;
void _desktopIsAppWindow;

let remote: RemoteClients | null = null;

/** Remote Access's clients, once it's up. */
export function useRemoteClients(clients: RemoteClients): void {
  remote = clients;
}

export function isRemote(w: AppWindow | null | undefined): w is RemoteWindow {
  return w instanceof RemoteWindow;
}

/** BrowserWindow.fromWebContents(e.sender), for desktop and remote senders. */
export function windowOf(e: { sender: unknown }): AppWindow | null {
  if (e.sender instanceof RemoteWebContents) return e.sender.window.isDestroyed() ? null : e.sender.window;
  return BrowserWindow.fromWebContents(e.sender as Electron.WebContents);
}

/** BrowserWindow.getAllWindows(), and every remote client's windows. */
export function allWindows(): AppWindow[] {
  return [...BrowserWindow.getAllWindows(), ...(remote?.windows() ?? [])];
}

/** Each remote client's main window. */
export function remoteMainWindows(): RemoteWindow[] {
  return (remote?.list() ?? []).flatMap((c) => (c.main && !c.main.isDestroyed() ? [c.main] : []));
}

/** The caller's main window: the remote client's own, or the desktop's (`desktop`). */
export function callerMainWindow<D extends AppWindow>(desktop: D | null): AppWindow | null {
  const ctx = caller();
  if (!ctx) return desktop;
  const m = ctx.client.main;
  return m && !m.isDestroyed() ? m : null;
}

export type WindowOptions = Omit<Electron.BrowserWindowConstructorOptions, 'parent'> & { parent?: AppWindow };

/**
 * new BrowserWindow(options) for the desktop. Running as a remote caller (or
 * with a remote parent) it opens on that client instead; a desktop parent
 * becomes the calling remote window. `desktop` keeps it on the computer.
 */
export function newWindow(options: WindowOptions, hash: string, opts: { role: WindowRole; desktop?: boolean }): AppWindow {
  const ctx = opts.desktop ? undefined : caller();
  const asked = options.parent;
  const remoteParent = asked instanceof RemoteWindow ? asked : undefined;
  const client = opts.desktop ? undefined : (ctx?.client ?? remoteParent?.client);
  if (!client || client.disposed) {
    return createPlacedWindow({ ...options, parent: asked as BrowserWindow | undefined } as Electron.BrowserWindowConstructorOptions, hash);
  }
  const alive = (w: RemoteWindow | null | undefined) => (w && !w.isDestroyed() && w.client === client ? w : null);
  const parent = asked ? (alive(remoteParent) ?? alive(ctx?.window) ?? alive(client.main)) : null;
  return client.openWindow({
    role: opts.role,
    hash,
    title: options.title ?? 'Looper',
    width: options.width ?? 800,
    height: options.height ?? 600,
    resizable: options.resizable ?? true,
    modal: !!options.modal && !!parent,
    parent,
  });
}

// ---------- menus ----------

/** menu.popup(...) for the window it's for: a remote one gets the menu as data. */
export function popupMenu(menu: Menu, options: Omit<Electron.PopupOptions, 'window'> & { window: AppWindow }): void {
  const w = options.window;
  if (w instanceof RemoteWindow) {
    if (!w.isDestroyed()) w.client.popup(w, menu, options.x, options.y);
    return;
  }
  hideOffPlatform(menu, 'desktop');
  menu.popup(options as unknown as Electron.PopupOptions);
}

/**
 * w.setMenu(menu), or w.removeMenu() for null. The menu is the window's own:
 * the items its platform doesn't show are hidden in it.
 */
export function setWindowMenu(w: AppWindow, menu: Menu | null): void {
  if (!menu) return w.removeMenu();
  hideOffPlatform(menu, w instanceof RemoteWindow ? w.client.uiPlatform : 'desktop');
  w.setMenu(menu);
}

// ---------- dialogs ----------

/** The remote window a dialog shows over; 'gone' when its client has nowhere left to show it. */
function dialogTarget(win: AppWindow | null | undefined): RemoteWindow | 'gone' | undefined {
  let client: RemoteClient;
  let w: RemoteWindow | undefined;
  if (win instanceof RemoteWindow) {
    client = win.client;
    w = win;
  } else if (!win) {
    const ctx = caller();
    if (!ctx) return undefined;
    client = ctx.client;
    w = ctx.window;
  } else return undefined;
  if (client.disposed) return 'gone';
  if (w.isDestroyed()) w = client.main && !client.main.isDestroyed() ? client.main : client.windowList()[0];
  return w ?? 'gone';
}

/**
 * Electron's MessageBoxOptions with the buttons' roles said, not guessed:
 * `cancelId` is what Esc and the window's × answer (the button that
 * abandons), `defaultId` the one Enter runs (the safest), and `destructiveId`
 * the one a phone draws red (a destructive action the user didn't choose:
 * Don't Save, Replace).
 */
export type MessageBoxOptions = Electron.MessageBoxOptions & { cancelId: number; defaultId: number; destructiveId?: number };

export function messageBoxSpec(o: MessageBoxOptions): MessageBoxSpec {
  const buttons = o.buttons?.length ? [...o.buttons] : ['OK'];
  return {
    ...(o.type ? { type: o.type as MessageBoxSpec['type'] } : {}),
    ...(o.title ? { title: o.title } : {}),
    message: o.message,
    ...(o.detail ? { detail: o.detail } : {}),
    buttons,
    defaultId: o.defaultId,
    cancelId: o.cancelId,
    ...(o.destructiveId !== undefined ? { destructiveId: o.destructiveId } : {}),
    ...(o.checkboxLabel ? { checkboxLabel: o.checkboxLabel, checkboxChecked: !!o.checkboxChecked } : {}),
  };
}

const OPEN_PROPERTIES = new Set(['openFile', 'openDirectory', 'multiSelections']);

function fileDialogSpec(o: Electron.OpenDialogOptions | Electron.SaveDialogOptions): FileDialogSpec {
  const props = 'properties' in o ? (o.properties ?? []).filter((p) => OPEN_PROPERTIES.has(p)) : [];
  return {
    ...(o.title ? { title: o.title } : {}),
    ...(o.defaultPath ? { defaultPath: o.defaultPath } : {}),
    ...(o.filters?.length ? { filters: o.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) } : {}),
    ...(props.length ? { properties: props } : {}),
    ...(o.buttonLabel ? { buttonLabel: o.buttonLabel } : {}),
  };
}

/** dialog.showMessageBox(win?, opts), or the same box on the remote client. */
export async function showMessageBox(win: AppWindow | null | undefined, opts: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const t = dialogTarget(win);
  if (t === undefined) {
    const { destructiveId: _red, ...electron } = opts;
    return win ? dialog.showMessageBox(win as BrowserWindow, electron) : dialog.showMessageBox(electron);
  }
  const spec = messageBoxSpec(opts);
  if (t === 'gone') return { response: spec.cancelId, checkboxChecked: !!spec.checkboxChecked };
  const r = await t.client.dialog(t, 'message', spec);
  return { response: r.response, checkboxChecked: r.checkboxChecked };
}

/** dialog.showOpenDialog(win?, opts); a remote client picks host paths (or uploads the device's files). */
export async function showOpenDialog(win: AppWindow | null | undefined, opts: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const t = dialogTarget(win);
  if (t === undefined) return win ? dialog.showOpenDialog(win as BrowserWindow, opts) : dialog.showOpenDialog(opts);
  if (t === 'gone') return { canceled: true, filePaths: [] };
  const r = await t.client.dialog(t, 'open', fileDialogSpec(opts));
  return { canceled: r.canceled, filePaths: r.filePaths };
}

/**
 * dialog.showSaveDialog(win?, opts). A remote client that picks This Device
 * gets a fresh path to write to; the file goes to the device once written.
 */
export async function showSaveDialog(win: AppWindow | null | undefined, opts: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  const t = dialogTarget(win);
  if (t === undefined) return win ? dialog.showSaveDialog(win as BrowserWindow, opts) : dialog.showSaveDialog(opts);
  if (t === 'gone') return { canceled: true, filePath: '' };
  const r = await t.client.dialog(t, 'save', fileDialogSpec(opts));
  if (r.canceled) return { canceled: true, filePath: '' };
  if (r.deliver) {
    // The name the user typed on the device, else the one the dialog suggested; deliver() keeps only a safe base name.
    const name = path.basename((r.filePath || opts.defaultPath || '').replace(/\\/g, '/'));
    return { canceled: false, filePath: t.client.deliver(name || 'download') };
  }
  return { canceled: false, filePath: r.filePath ?? '' };
}

// ---------- clipboard, shell, notifications ----------

/** clipboard.writeText; a remote caller's goes to the device's clipboard. */
export function writeClipboard(text: string): void {
  const ctx = caller();
  if (ctx) ctx.client.send({ t: 'clipboard', text });
  else clipboard.writeText(text);
}

/** shell.openExternal; a remote caller's opens on the device. */
export async function openExternal(url: string): Promise<void> {
  const ctx = caller();
  if (ctx) ctx.client.send({ t: 'open-url', url });
  else await shell.openExternal(url);
}

function showPath(client: RemoteClient, p: string, asParent: boolean, siblings?: string[]): string {
  let isDir: boolean;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    return `${p} doesn't exist.`;
  }
  client.send(asParent ? { t: 'show-path', path: path.dirname(p), isDir: true } : { t: 'show-path', path: p, isDir, ...(siblings ? { siblings } : {}) });
  return '';
}

/**
 * shell.openPath (the error message, or ''); a remote caller's shows the path on the device.
 * `siblings`: the files that device's viewer steps through with this one (this one included).
 */
export async function openPath(p: string, siblings?: string[]): Promise<string> {
  const ctx = caller();
  return ctx ? showPath(ctx.client, p, false, siblings) : shell.openPath(p);
}

/** shell.showItemInFolder; a remote caller gets the folder it's in. */
export function showItemInFolder(p: string): void {
  const ctx = caller();
  if (ctx) showPath(ctx.client, p, true);
  else shell.showItemInFolder(p);
}

/** Open a path with its default app on the computer, whoever asks. */
export function openOnHost(p: string): Promise<string> {
  return shell.openPath(p);
}

/** A desktop toast, shown on every connected device too. */
export function notifyClients(n: Omit<Extract<ServerMessage, { t: 'notify' }>, 't'>): void {
  remote?.broadcast({ t: 'notify', ...n });
}
