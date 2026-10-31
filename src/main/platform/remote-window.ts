import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DialogResult,
  FileDialogSpec,
  MenuItemSpec,
  MessageBoxSpec,
  RemoteWindowSpec,
  ServerMessage,
} from '../../shared/remote-access';
import { uiPlatformOf, type UiPlatform } from '../../shared/ui-platform';
import { encodeBytes } from './bytes';
import { runAs } from './context';
import { SaveDelivery } from './deliver';
import { pickItem, serializeMenu, type MenuItemLike, type MenuLike } from './menus';

/** The webContents part of a window the main process uses, desktop or remote. */
export interface AppWebContents {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
  getURL(): string;
  reload(): void;
  on(event: 'render-process-gone', listener: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void): this;
  once(event: 'did-finish-load', listener: () => void): this;
  once(event: 'did-navigate-in-page', listener: () => void): this;
  setWindowOpenHandler(handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse): void;
}

/** The part of BrowserWindow the main process uses; a BrowserWindow and a RemoteWindow both are one. */
export interface AppWindow {
  readonly id: number;
  readonly webContents: AppWebContents;
  isDestroyed(): boolean;
  close(): void;
  destroy(): void;
  focus(): void;
  show(): void;
  hide(): void;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  setTitle(title: string): void;
  getTitle(): string;
  getParentWindow(): AppWindow | null;
  setMenu(menu: Electron.Menu | null): void;
  removeMenu(): void;
  setMaximizable(maximizable: boolean): void;
  setResizable(resizable: boolean): void;
  setMinimumSize(width: number, height: number): void;
  setContentSize(width: number, height: number): void;
  center(): void;
  on(event: 'close', listener: (event: Electron.Event) => void): this;
  on(event: 'closed' | 'focus', listener: () => void): this;
  once(event: 'closed' | 'focus', listener: () => void): this;
  removeListener(event: 'focus' | 'closed', listener: (...args: any[]) => void): this;
}

/** Remote window ids start here, far above any Electron window or webContents id. */
const FIRST_REMOTE_ID = 1_000_000;
let nextId = FIRST_REMOTE_ID;

export class RemoteWebContents extends EventEmitter {
  constructor(private readonly win: RemoteWindow) {
    super();
  }

  get id(): number {
    return this.win.id;
  }

  /** The remote window this webContents belongs to (windowOf reads it). */
  get window(): RemoteWindow {
    return this.win;
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win.isDestroyed()) return;
    this.win.client.send({ t: 'event', w: this.win.w, channel, args: encodeBytes(args) as unknown[] });
  }

  isDestroyed(): boolean {
    return this.win.isDestroyed();
  }

  getURL(): string {
    return `looper-remote://${this.win.client.id}/index.html?w=${this.win.w}#${this.win.hash}`;
  }

  reload(): void {
    if (!this.win.isDestroyed()) this.win.client.send({ t: 'reload', w: this.win.w });
  }

  /** Links in a remote window open on the device; nothing to handle here. */
  setWindowOpenHandler(): void {}
}

export interface RemoteWindowInit {
  hash: string;
  title: string;
  width: number;
  height: number;
  resizable: boolean;
  modal: boolean;
  parent: RemoteWindow | null;
}

/**
 * A Looper window shown in a browser tab: the main process treats it like a
 * BrowserWindow, and the client shows its renderer route in an iframe.
 */
export class RemoteWindow extends EventEmitter implements AppWindow {
  readonly id = nextId++;
  readonly w = String(this.id);
  readonly webContents: RemoteWebContents;
  hash: string;
  private title: string;
  private width: number;
  private height: number;
  private resizable: boolean;
  readonly modal: boolean;
  readonly parent: RemoteWindow | null;
  private destroyed = false;
  private visible = true;
  private ready = false;
  /** The menu bar, as sent; its picks come with menuId = w. */
  menuBar: { items: MenuItemSpec[]; byId: Map<string, MenuItemLike> } | null = null;
  private menuSource: MenuLike | null = null;

  constructor(
    readonly client: RemoteClient,
    init: RemoteWindowInit,
  ) {
    super();
    this.webContents = new RemoteWebContents(this);
    this.hash = init.hash;
    this.title = init.title;
    this.width = init.width;
    this.height = init.height;
    this.resizable = init.resizable;
    this.modal = init.modal && !!init.parent;
    this.parent = init.parent;
  }

  spec(): RemoteWindowSpec {
    return {
      w: this.w,
      ...(this.parent ? { parent: this.parent.w } : {}),
      modal: this.modal,
      hash: this.hash,
      title: this.title,
      width: this.width,
      height: this.height,
      resizable: this.resizable,
    };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Emits a preventable 'close'; unless prevented, the window goes (destroy). */
  close(): void {
    if (this.destroyed) return;
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit('close', event);
    if (!event.defaultPrevented) this.destroy();
  }

  /** Gone at once, its child windows first: 'closed' and the client's window-close. */
  destroy(): void {
    if (this.destroyed) return;
    for (const child of this.client.windowList()) if (child.parent === this) child.destroy();
    this.destroyed = true;
    this.client.windowGone(this);
    this.emit('closed');
    this.webContents.emit('destroyed');
  }

  focus(): void {
    if (this.destroyed) return;
    this.visible = true;
    this.client.send({ t: 'window-focus', w: this.w });
    this.client.focusChanged(this);
  }

  show(): void {
    this.focus();
  }

  /** A browser tab has nothing to hide a window into: it only counts as hidden. */
  hide(): void {
    this.visible = false;
  }

  isFocused(): boolean {
    return !this.destroyed && this.client.connected && this.client.focused === this;
  }

  isVisible(): boolean {
    return !this.destroyed && this.visible;
  }

  isMinimized(): boolean {
    return false;
  }

  restore(): void {}

  setTitle(title: string): void {
    this.title = String(title);
    if (!this.destroyed) this.client.send({ t: 'window-title', w: this.w, title: this.title });
  }

  getTitle(): string {
    return this.title;
  }

  /** The page set document.title: like Electron, the window takes it. */
  pageTitle(title: string): void {
    this.title = title;
  }

  getParentWindow(): RemoteWindow | null {
    return this.parent && !this.parent.isDestroyed() ? this.parent : null;
  }

  setMenu(menu: MenuLike | null): void {
    if (!menu) return this.removeMenu();
    const next = serializeMenu(menu, this.client.uiPlatform);
    // The new items are the ones a pick runs, even when the client already has an identical bar.
    const same = JSON.stringify(next.items) === JSON.stringify(this.menuBar?.items);
    this.menuSource = menu;
    this.menuBar = next;
    if (!same && !this.destroyed) this.client.send({ t: 'window-menu', w: this.w, menu: next.items });
  }

  /** Send the menu bar again when its items changed in place (a checkmark the code set). */
  refreshMenu(): void {
    if (!this.menuSource || this.destroyed) return;
    const next = serializeMenu(this.menuSource, this.client.uiPlatform);
    if (JSON.stringify(next.items) === JSON.stringify(this.menuBar?.items)) return;
    this.menuBar = next;
    this.client.send({ t: 'window-menu', w: this.w, menu: next.items });
  }

  removeMenu(): void {
    const had = this.menuBar !== null;
    this.menuBar = null;
    this.menuSource = null;
    if (had && !this.destroyed) this.client.send({ t: 'window-menu', w: this.w, menu: null });
  }

  setMaximizable(): void {}

  setResizable(resizable: boolean): void {
    this.resizable = resizable;
  }

  setMinimumSize(): void {}

  setContentSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  center(): void {}

  /** Move the page to another route: a fresh load on the client, followed by its window-ready. */
  load(hash: string): void {
    if (this.destroyed || hash === this.hash) return;
    this.hash = hash;
    // Its size and resizability may have changed with its new role (setup window → builder): the client re-places it.
    this.client.send({ t: 'window-open', ...this.spec() });
    this.client.send({ t: 'window-load', w: this.w, hash });
  }

  /** The client says the page loaded. */
  pageReady(): void {
    if (this.destroyed) return;
    if (!this.ready) {
      this.ready = true;
      this.emit('ready-to-show');
    }
    this.webContents.emit('did-finish-load');
  }
}

export interface RemoteClientOptions {
  /** `<dataDir>/remote-access`: files saved to the device wait in its `outgoing` folder. */
  dir: string;
  /** A one-time download token for a file; onDone runs once it's downloaded or the token lapses. */
  offerDownload: (file: string, name: string, onDone: () => void) => string;
  log: { error(m: string): void; warn(m: string): void };
  /** Tests: shorter waits for a saved file. */
  deliveryQuietMs?: number;
}

interface PendingDialog {
  window: RemoteWindow;
  msg: Extract<ServerMessage, { t: 'dialog' }>;
  resolve: (r: DialogResult) => void;
}

type Send = (msg: ServerMessage) => boolean;

/**
 * One browser tab (kept across its reconnects): its windows, the menus and
 * dialogs it has open, and the files on their way to it.
 */
export class RemoteClient {
  private sendFn: Send | null = null;
  private readonly windows = new Map<string, RemoteWindow>();
  private readonly popups = new Map<string, { window: RemoteWindow; byId: Map<string, MenuItemLike> }>();
  private readonly dialogs = new Map<string, PendingDialog>();
  private readonly deliveries = new Set<SaveDelivery>();
  private seq = 0;
  main: RemoteWindow | null = null;
  focused: RemoteWindow | null = null;
  disposed = false;

  constructor(
    readonly id: string,
    readonly device: { id: string; name: string },
    public platform: string,
    private readonly opts: RemoteClientOptions,
  ) {}

  get connected(): boolean {
    return this.sendFn !== null;
  }

  /** Which menu and toolbar items it shows (shared/ui-platform). */
  get uiPlatform(): UiPlatform {
    return uiPlatformOf(this.platform);
  }

  /** Attach the tab's current connection, or null while it's away. */
  setConnection(send: Send | null): void {
    this.sendFn = send;
    if (!send) this.popups.clear();
  }

  /** False when it wasn't sent (no connection, or too large). */
  send(msg: ServerMessage): boolean {
    return this.sendFn?.(msg) ?? false;
  }

  window(w: string): RemoteWindow | undefined {
    return this.windows.get(w);
  }

  windowList(): RemoteWindow[] {
    return [...this.windows.values()];
  }

  openWindow(init: RemoteWindowInit): RemoteWindow {
    const win = new RemoteWindow(this, init);
    this.windows.set(win.w, win);
    this.send({ t: 'window-open', ...win.spec() });
    this.focusChanged(win);
    return win;
  }

  /** Called by RemoteWindow.destroy. */
  windowGone(win: RemoteWindow): void {
    this.windows.delete(win.w);
    for (const [id, p] of this.popups) if (p.window === win) this.popups.delete(id);
    for (const [id, d] of this.dialogs) if (d.window === win) this.cancelDialog(id);
    if (this.main === win) this.main = null;
    this.send({ t: 'window-close', w: win.w });
    // As on the desktop, the window it was over gets the focus back.
    if (this.focused === win) {
      this.focused = null;
      const next = win.parent && !win.parent.isDestroyed() ? win.parent : this.main;
      if (next && !this.disposed) this.focusChanged(next);
    }
  }

  focusChanged(win: RemoteWindow): void {
    if (this.focused === win) return;
    const was = this.focused;
    this.focused = win;
    if (was && !was.isDestroyed()) was.emit('blur');
    win.emit('focus');
  }

  /** Everything a reconnected tab needs to show again: its windows, their menus and the open dialogs. */
  resend(): void {
    for (const win of this.windows.values()) {
      this.send({ t: 'window-open', ...win.spec() });
      if (win.menuBar) this.send({ t: 'window-menu', w: win.w, menu: win.menuBar.items });
    }
    for (const d of this.dialogs.values()) this.send(d.msg);
  }

  // ---------- menus ----------

  popup(win: RemoteWindow, menu: MenuLike, x?: number, y?: number): void {
    const { items, byId } = serializeMenu(menu, this.uiPlatform);
    if (items.length === 0 || win.isDestroyed()) return;
    // One popup at a time, as on the desktop: a new one replaces the last.
    this.popups.clear();
    const menuId = `m${++this.seq}`;
    this.popups.set(menuId, { window: win, byId });
    this.send({ t: 'menu', menuId, w: win.w, items, ...(typeof x === 'number' ? { x } : {}), ...(typeof y === 'number' ? { y } : {}) });
  }

  /** A pick from a popup (its menuId) or from a window's menu bar (menuId = the window's w). */
  pick(menuId: string, itemId: string, checked: boolean | undefined): void {
    const bar = this.windows.get(menuId);
    let target: { window: RemoteWindow; byId: Map<string, MenuItemLike> } | undefined;
    if (bar?.menuBar) target = { window: bar, byId: bar.menuBar.byId };
    else {
      target = this.popups.get(menuId);
      this.popups.delete(menuId);
    }
    const item = target?.byId.get(itemId);
    if (!target || !item || target.window.isDestroyed()) return;
    const win = target.window;
    try {
      runAs({ client: this, window: win }, () => pickItem(item, win, win.webContents, checked));
    } finally {
      // The click may have set checkmarks of its own (a radio group, Filter…): the bar shows what's true.
      if (bar?.menuBar) bar.refreshMenu();
    }
  }

  dismiss(menuId: string): void {
    this.popups.delete(menuId);
  }

  // ---------- dialogs ----------

  dialog(win: RemoteWindow, kind: 'message', spec: MessageBoxSpec): Promise<Extract<DialogResult, { kind: 'message' }>>;
  dialog(win: RemoteWindow, kind: 'open', spec: FileDialogSpec): Promise<Extract<DialogResult, { kind: 'open' }>>;
  dialog(win: RemoteWindow, kind: 'save', spec: FileDialogSpec): Promise<Extract<DialogResult, { kind: 'save' }>>;
  dialog(win: RemoteWindow, kind: 'message' | 'open' | 'save', spec: MessageBoxSpec | FileDialogSpec): Promise<DialogResult> {
    const dialogId = `d${++this.seq}`;
    const msg = (kind === 'message'
      ? { t: 'dialog', dialogId, w: win.w, kind, spec }
      : { t: 'dialog', dialogId, w: win.w, kind, spec }) as Extract<ServerMessage, { t: 'dialog' }>;
    return new Promise((resolve) => {
      if (this.disposed || win.isDestroyed()) return resolve(cancelResult(msg));
      this.dialogs.set(dialogId, { window: win, msg, resolve });
      this.send(msg);
    });
  }

  /** The client's answer, checked against what was asked; a malformed one counts as a cancel. */
  answer(dialogId: string, result: DialogResult): void {
    const d = this.dialogs.get(dialogId);
    if (!d) return;
    this.dialogs.delete(dialogId);
    const r = result as Record<string, unknown>;
    const msg = d.msg;
    if (r?.kind !== msg.kind) return d.resolve(cancelResult(msg));
    if (msg.kind === 'message') {
      const n = r.response;
      const ok = Number.isInteger(n) && (n as number) >= 0 && (n as number) < msg.spec.buttons.length;
      return d.resolve(ok ? { kind: 'message', response: n as number, checkboxChecked: r.checkboxChecked === true } : cancelResult(msg));
    }
    const canceled = r.canceled !== false;
    if (msg.kind === 'open') {
      const paths = Array.isArray(r.filePaths) ? (r.filePaths as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '') : [];
      return d.resolve(canceled || paths.length === 0 ? cancelResult(msg) : { kind: 'open', canceled: false, filePaths: paths });
    }
    if (canceled) return d.resolve(cancelResult(msg));
    if (r.deliver === true) {
      const name = typeof r.filePath === 'string' ? r.filePath.trim() : '';
      return d.resolve({ kind: 'save', canceled: false, deliver: true, ...(name ? { filePath: name } : {}) });
    }
    return d.resolve(
      typeof r.filePath === 'string' && r.filePath ? { kind: 'save', canceled: false, filePath: r.filePath } : cancelResult(msg),
    );
  }

  private cancelDialog(id: string): void {
    const d = this.dialogs.get(id);
    if (!d) return;
    this.dialogs.delete(id);
    d.resolve(cancelResult(d.msg));
  }

  /**
   * "Save to This Device": a fresh path to write to. Once the file has been
   * written and is quiet, the device gets it as a download; the folder goes
   * after the download, or after an hour.
   */
  deliver(name: string): string {
    const dir = path.join(this.opts.dir, 'outgoing', crypto.randomBytes(12).toString('base64url'));
    const safe = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_') || 'download';
    const file = path.join(dir, safe);
    fs.mkdirSync(dir, { recursive: true });
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      fs.rm(dir, { recursive: true, force: true }, () => undefined);
    };
    const watch = new SaveDelivery({
      file,
      ...(this.opts.deliveryQuietMs !== undefined ? { quietMs: this.opts.deliveryQuietMs, pollMs: Math.max(5, this.opts.deliveryQuietMs / 5) } : {}),
      onReady: () => {
        this.deliveries.delete(watch);
        try {
          const token = this.opts.offerDownload(file, safe, remove);
          this.send({ t: 'download', token, name: safe });
        } catch (err) {
          this.opts.log.error(`remote access: can't offer ${safe} to ${this.device.name}: ${String(err)}`);
          remove();
          return;
        }
        setTimeout(remove, 60 * 60_000).unref?.();
      },
      onExpire: () => {
        this.deliveries.delete(watch);
        remove();
      },
    });
    this.deliveries.add(watch);
    return file;
  }

  /** The tab is gone for good: its dialogs are canceled and its windows close. */
  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.dialogs.keys()]) this.cancelDialog(id);
    this.disposed = true;
    for (const d of this.deliveries) d.stop();
    this.deliveries.clear();
    for (const win of this.windowList()) if (!win.parent) win.destroy();
    for (const win of this.windowList()) win.destroy();
    this.sendFn = null;
  }
}

/** What a dismissed dialog answers: a message box its cancelId (or last button), a file dialog canceled. */
export function cancelResult(msg: Extract<ServerMessage, { t: 'dialog' }>): DialogResult {
  if (msg.kind === 'message') {
    const spec = msg.spec;
    return { kind: 'message', response: spec.cancelId ?? Math.max(0, spec.buttons.length - 1), checkboxChecked: !!spec.checkboxChecked };
  }
  return msg.kind === 'open' ? { kind: 'open', canceled: true, filePaths: [] } : { kind: 'save', canceled: true };
}
