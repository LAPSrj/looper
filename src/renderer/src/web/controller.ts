import { useMemo } from 'react';
import { isLooperFileName } from '../../../shared/files';
import { OPEN_PARAM, REMOTE_CHANNELS, type DialogResult, type HostFileView, type MeResponse, type MenuItemSpec, type MessageBoxSpec, type OpenTarget } from '../../../shared/remote-access';
import { ClipboardBridge } from './clipboard';
import { fileType } from './dialog-flows';
import { runEditRole } from './edit-roles';
import { findAccelerator, pickChecked } from './menu-model';
import { isIos, pushOnHere, registerServiceWorker } from './push-client';
import type { Session } from './session';
import { frontWindow, isBlocked, mainWindow, ShellStore, type OpenMenu, type ShellState, type Toast } from './store';

const TOAST_MS = 8000;
const PAIRED_CHECK_MS = 5000;

export interface Point {
  x: number;
  y: number;
}

/**
 * The shell's behavior, apart from how it looks: the windows' iframes and
 * their focus, menus and their accelerators, dialogs, the clipboard, toasts,
 * downloads and the connection. A frame (DesktopFrame; later the phone ones)
 * draws the store's state and calls these methods; it owns only layout.
 */
export class ShellController {
  readonly store: ShellStore;
  readonly clipboard: ClipboardBridge;
  readonly isMac: boolean;
  private readonly frames = new Map<string, HTMLIFrameElement>();
  private readonly frameRefs = new Map<string, (el: HTMLIFrameElement | null) => void>();
  /** The last pointer position in each window's iframe, in its own coordinates. */
  private readonly pointers = new Map<string, Point>();
  /** Open shell overlays the store doesn't know about (a menu bar's menu). */
  private localOverlays = 0;
  private lastFront: string | undefined;
  private lastOverlay = false;
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pairedTimer: ReturnType<typeof setInterval> | null = null;
  /** The computer's name, for the page title ('' until known). */
  private computer = '';
  /** A notification tapped while this tab wasn't open: opened once connected. */
  private pendingOpen: OpenTarget | null = takeOpenParam();
  /** Message boxes the shell asked itself, by dialog id: what each answer does. */
  private readonly localDialogs = new Map<string, (response: number) => void>();
  private localDialogSeq = 0;
  /** A window that should flash: a click hit what its modal window blocks. */
  onFlash: ((w: string) => void) | null = null;

  constructor(readonly session: Session) {
    this.store = new ShellStore(session);
    this.isMac = /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent);
    this.clipboard = new ClipboardBridge((text) => this.frameOf(this.front()?.w)?.contentWindow?.navigator.clipboard.writeText(text) ?? Promise.reject());
  }

  get state(): ShellState {
    return this.store.getState();
  }

  front() {
    return frontWindow(this.state);
  }

  /** Effects that act on this device, and the listeners on the top document. Returns the cleanup. */
  start(): () => void {
    window.__looperClipboard = this.clipboard;
    const offShell = this.session.onShell((m) => {
      switch (m.t) {
        case 'clipboard':
          this.clipboard.write(m.text);
          break;
        case 'download':
          void this.saveDownload(`/api/download/${encodeURIComponent(m.token)}`, m.name);
          break;
        case 'open-url':
          window.open(m.url, '_blank', 'noopener');
          break;
        case 'notify':
          // With push on, the computer sends a hidden tab's notification itself.
          if (document.hidden && !pushOnHere() && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(m.title, { body: m.body });
          break;
        case 'computer':
          this.computer = m.name;
          this.stateChanged();
          break;
      }
    });
    const offConn = this.session.onConnection((connected) => {
      this.watchPairing(!connected);
      if (connected) this.loadComputer();
      if (connected && this.pendingOpen) {
        const open = this.pendingOpen;
        this.pendingOpen = null;
        // The main window comes with (or just after) the welcome.
        setTimeout(() => this.openTarget(open), 500);
      }
    });
    void registerServiceWorker();
    const onWorkerMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; open?: OpenTarget } | null;
      if (d?.type === 'looper-open' && d.open) this.openTarget(d.open);
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    const offStore = this.store.subscribe(() => this.stateChanged());
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => this.onDrop(e);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    this.stateChanged();
    return () => {
      offShell();
      offConn();
      offStore();
      this.watchPairing(false);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      for (const t of this.toastTimers.values()) clearTimeout(t);
    };
  }

  // ---------- windows ----------

  /** The ref callback for a window's iframe (the same function each render, per window). */
  frameRef(w: string): (el: HTMLIFrameElement | null) => void {
    let ref = this.frameRefs.get(w);
    if (!ref) {
      ref = (el) => {
        if (!el) return;
        this.frames.set(w, el);
        el.addEventListener('load', () => this.frameLoaded(w, el));
      };
      this.frameRefs.set(w, ref);
    }
    return ref;
  }

  frameOf(w: string | undefined): HTMLIFrameElement | undefined {
    const el = w ? this.frames.get(w) : undefined;
    return el?.isConnected ? el : undefined;
  }

  /** The window was clicked or got the focus: it comes to the front, unless a modal window blocks it. */
  activate(w: string): void {
    const s = this.state;
    if (isBlocked(s, w)) return this.flashFront();
    if (s.focused === w && s.order[s.order.length - 1] === w) return;
    this.store.dispatch({ t: 'window-focus', w });
    this.session.focusWindow(w);
  }

  /** A click on what a modal window blocks: the modal one flashes and keeps the focus, as on Windows. */
  flashFront(): void {
    const front = this.front();
    if (front) this.onFlash?.(front.w);
    this.focusFront();
  }

  /** The × of a window: the server closes it, or keeps it (it asks about unsaved changes first). */
  close(w: string): void {
    this.session.closeWindow(w);
  }

  /** Put the keyboard focus in the front window's page, unless the shell itself has something open. */
  focusFront(): void {
    if (!this.overlayOpen()) this.frameOf(this.front()?.w)?.contentWindow?.focus();
  }

  overlayOpen(): boolean {
    const s = this.state;
    return this.localOverlays > 0 || s.menus.length > 0 || s.dialogs.length > 0 || s.paths.length > 0;
  }

  /** A frame's own overlay (a menu bar's menu) opened or closed. */
  setOverlay(open: boolean): void {
    this.localOverlays = Math.max(0, this.localOverlays + (open ? 1 : -1));
    if (!open) queueMicrotask(() => this.focusFront());
  }

  private frameLoaded(w: string, el: HTMLIFrameElement): void {
    const win = el.contentWindow;
    if (!win) return;
    const track = (e: MouseEvent) => this.pointers.set(w, { x: e.clientX, y: e.clientY });
    win.addEventListener('pointerdown', (e) => {
      track(e);
      this.activate(w);
    }, true);
    win.addEventListener('contextmenu', track, true);
    win.addEventListener('focus', () => this.activate(w));
    win.addEventListener('keydown', (e) => {
      // The shell's own menus and sheets close on Escape in the top document, wherever the focus is.
      if (e.key === 'Escape' && this.overlayOpen()) {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return;
      }
      this.onKey(e);
    });
    if (this.front()?.w === w) this.focusFront();
  }

  private stateChanged(): void {
    const s = this.state;
    const front = this.front();
    const title = front?.title || 'Looper';
    document.title = this.computer ? `${title} – ${this.computer}` : title;
    const overlay = this.overlayOpen();
    if (front?.w !== this.lastFront || (this.lastOverlay && !overlay)) requestAnimationFrame(() => this.focusFront());
    this.lastFront = front?.w;
    this.lastOverlay = overlay;
    for (const t of s.toasts) {
      if (this.toastTimers.has(t.id)) continue;
      this.toastTimers.set(t.id, setTimeout(() => this.closeToast(t.id), TOAST_MS));
    }
  }

  // ---------- menus ----------

  /** Where a popup menu opens, in page coordinates: its x/y in the window, or the last pointer position there. */
  popupPoint(menu: OpenMenu): Point {
    const rect = this.frameOf(menu.w)?.getBoundingClientRect();
    const p = menu.x !== undefined && menu.y !== undefined ? { x: menu.x, y: menu.y } : (this.pointers.get(menu.w) ?? { x: 40, y: 40 });
    return { x: (rect?.left ?? 0) + p.x, y: (rect?.top ?? 0) + p.y };
  }

  /** The pop-up button a menu belongs to, in page coordinates; null for a menu at a point. */
  popupButton(menu: OpenMenu): DOMRect | null {
    const b = menu.button;
    if (!b) return null;
    const rect = this.frameOf(menu.w)?.getBoundingClientRect();
    return new DOMRect((rect?.left ?? 0) + b.x, (rect?.top ?? 0) + b.y, b.width, b.height);
  }

  /** A menu item was picked (in a click or key press: the clipboard may be used now). menuId: a popup's, or the window's for its menu bar. */
  pick(menuId: string, w: string, item: MenuItemSpec): void {
    const popup = this.state.menus.some((m) => m.menuId === menuId);
    if (item.role) this.runRole(item.role, w);
    else {
      this.clipboard.armWrite();
      // A terminal's Paste asks for the clipboard after the click is over, where Safari no longer allows it.
      if (/^paste$/i.test(item.label ?? '')) this.clipboard.armRead();
      this.session.pick(menuId, item.id, pickChecked(item));
    }
    if (popup) this.store.dispatch({ t: 'menu-done', menuId });
  }

  dismissMenu(menuId: string): void {
    this.session.dismiss(menuId);
    this.store.dispatch({ t: 'menu-done', menuId });
  }

  private runRole(role: string, w: string): void {
    const r = role.toLowerCase();
    if (r === 'reload' || r === 'forcereload') this.store.dispatch({ t: 'reload', w });
    else if (r === 'close') this.close(w);
    else runEditRole(role, this.frameOf(w), this.clipboard);
  }

  /** A key in the top document or any window's page: the front window's menu accelerators. */
  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.repeat || this.overlayOpen()) return;
    const front = this.front();
    if (!front?.menu) return;
    const item = findAccelerator(front.menu, e, this.isMac);
    if (!item) return;
    // A disabled item still keeps the key: F5 mustn't reload the tab because no task is selected.
    e.preventDefault();
    if (item.enabled) this.pick(front.w, front.w, item);
  }

  // ---------- dialogs ----------

  answer(dialogId: string, result: DialogResult): void {
    const local = this.localDialogs.get(dialogId);
    this.localDialogs.delete(dialogId);
    if (local) local(result.kind === 'message' ? result.response : -1);
    else this.session.dialogResult(dialogId, result);
    this.store.dispatch({ t: 'dialog-done', dialogId });
  }

  /** A main-process call on behalf of window `w` (the host file browser's channels). */
  invoke<T>(w: string, channel: string, ...args: unknown[]): Promise<T> {
    return this.session.invoke(w, channel, args) as Promise<T>;
  }

  /** A window to make calls for when the request isn't a window's own (show-path). */
  anyWindow(): string | undefined {
    return (this.front() ?? mainWindow(this.state))?.w;
  }

  upload(file: File): Promise<{ name: string; path: string }> {
    return this.session.upload(file);
  }

  closePath(id: number): void {
    this.store.dispatch({ t: 'path-done', id });
  }

  /** A file the device's own file browser opens: as the computer's show-path would. */
  showPath(path: string): void {
    this.store.dispatch({ t: 'show-path', path, isDir: false });
  }

  /** Download a file on the computer to this device. */
  downloadHostFile(path: string): Promise<void> {
    const w = this.anyWindow();
    return w ? this.invoke(w, REMOTE_CHANNELS.download, path) : Promise.reject(new Error('Not connected to Looper.'));
  }

  openOnHost(path: string): Promise<void> {
    const w = this.anyWindow();
    return w ? this.invoke(w, REMOTE_CHANNELS.openOnHost, path) : Promise.reject(new Error('Not connected to Looper.'));
  }

  /** Download to Host Computer: a copy in the host user's Downloads folder; resolves its path. */
  saveOnHost(path: string): Promise<string> {
    const w = this.anyWindow();
    return w ? this.invoke(w, REMOTE_CHANNELS.saveOnHost, path) : Promise.reject(new Error('Not connected to Looper.'));
  }

  /** A file on the host computer read into this page (the file viewer); null when it's bigger than maxBytes. */
  async readHostFile(path: string, maxBytes: number): Promise<Blob | null> {
    const w = this.anyWindow();
    if (!w) throw new Error('Not connected to Looper.');
    const v = await this.invoke<HostFileView>(w, REMOTE_CHANNELS.view, path, maxBytes);
    if (!v.token) return null;
    const r = await fetch(`/api/download/${encodeURIComponent(v.token)}`);
    if (!r.ok) throw new Error(`The host computer didn't send ${v.name}.`);
    return r.blob();
  }

  // ---------- toasts, downloads, drops ----------

  closeToast(id: number): void {
    clearTimeout(this.toastTimers.get(id));
    this.toastTimers.delete(id);
    this.store.dispatch({ t: 'toast-done', id });
  }

  /** A click on a toast opens what the desktop's toast opens: the task's run. */
  openToast(t: Toast): void {
    this.closeToast(t.id);
    if (t.taskId) this.openTarget({ kind: 'task', taskId: t.taskId, ...(t.runId ? { runId: t.runId } : {}) });
  }

  /** What a tapped notification points to: a task's run, or a session waiting for the user. */
  openTarget(open: OpenTarget): void {
    const main = mainWindow(this.state);
    if (!main) {
      this.pendingOpen = open;
      return;
    }
    const call =
      open.kind === 'task'
        ? this.invoke(main.w, REMOTE_CHANNELS.openNotification, open.taskId, open.runId ?? null)
        : this.invoke(main.w, REMOTE_CHANNELS.openSession, open.id);
    void call.catch(() => undefined);
  }

  /**
   * A file the computer sent this device. iOS opens a download link as a page of its own,
   * which a Home Screen app has no way back from, so there the file goes to the share sheet
   * (Save Image, Save to Files). The share sheet needs a tap: when the one that asked for
   * the download is too long ago, a message box asks for it.
   */
  private async saveDownload(href: string, name: string): Promise<void> {
    if (!isIos()) return this.download(href, name);
    let file: File;
    try {
      const r = await fetch(href);
      if (!r.ok) throw new Error(`The host computer didn't send ${name}.`);
      file = new File([await r.blob()], name, { type: fileType(name) });
    } catch (err) {
      return this.askLocal({ type: 'error', title: 'Looper', message: err instanceof Error ? err.message : String(err), buttons: ['OK'], defaultId: 0, cancelId: 0 }, () => undefined);
    }
    if (!navigator.canShare?.({ files: [file] })) return this.download(href, name);
    const share = () => navigator.share({ files: [file] });
    try {
      await share();
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') return;
      this.askLocal({ type: 'none', title: 'Looper', message: `${name} is ready.`, buttons: ['Save…', 'Cancel'], defaultId: 0, cancelId: 1 }, (response) => {
        if (response === 0) void share().catch(() => undefined);
      });
    }
  }

  /** A message box the shell asks itself, drawn like the computer's; `onAnswer` runs inside the tap, so it may open the share sheet. */
  private askLocal(spec: MessageBoxSpec, onAnswer: (response: number) => void): void {
    const w = this.anyWindow();
    if (!w) return;
    const dialogId = `local-${++this.localDialogSeq}`;
    this.localDialogs.set(dialogId, onAnswer);
    this.store.dispatch({ t: 'dialog', dialogId, w, kind: 'message', spec });
  }

  private download(href: string, name: string): void {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** A Looper document dropped on the shell itself (a title bar, the window list) opens as on a window. */
  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    const w = this.anyWindow();
    if (file && w && isLooperFileName(file.name)) void this.session.apiFor(w).openLooperFile(file).catch(() => undefined);
  }

  /** The computer's name, asked again on every connection (it may have changed meanwhile). */
  private loadComputer(): void {
    void fetch('/api/me')
      .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
      .then((me) => {
        if (!me?.computer || me.computer === this.computer) return;
        this.computer = me.computer;
        this.stateChanged();
      })
      .catch(() => undefined);
  }

  /** While disconnected: when the computer says this device isn't paired any more, the pairing page. */
  private watchPairing(on: boolean): void {
    if (this.pairedTimer) clearInterval(this.pairedTimer);
    this.pairedTimer = null;
    if (!on) return;
    this.pairedTimer = setInterval(() => {
      void fetch('/api/me')
        .then((r) => (r.ok ? r.json() : null))
        .then((me: { paired?: boolean } | null) => {
          if (me && me.paired === false) {
            this.session.stop();
            location.replace('/');
          }
        })
        .catch(() => undefined);
    }, PAIRED_CHECK_MS);
  }
}

/** The ?open= a notification click started this tab with (dropped from the address). */
function takeOpenParam(): OpenTarget | null {
  const url = new URL(location.href);
  const raw = url.searchParams.get(OPEN_PARAM);
  if (raw === null) return null;
  url.searchParams.delete(OPEN_PARAM);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  try {
    const v = JSON.parse(raw) as OpenTarget;
    if (v?.kind === 'task' && typeof v.taskId === 'string') return v;
    if (v?.kind === 'session' && typeof v.id === 'string') return v;
  } catch {
    /* not ours */
  }
  return null;
}

/** One controller per session, for the frame's lifetime. */
export function useShellController(session: Session): ShellController {
  return useMemo(() => new ShellController(session), [session]);
}
