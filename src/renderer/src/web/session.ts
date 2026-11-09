// Relative imports: the unit tests (node tsconfig) load this file, and it has no `@shared` alias.
import { createLooperApi, type AttachmentInputItem, type LooperTransport } from '../../../shared/api-client';
import type { LooperApi } from '../../../shared/api';
import {
  MAX_WS_MESSAGE_BYTES,
  type ClientMessage,
  type DialogResult,
  type EncodedBytes,
  type EncodedUndefined,
  type MessageBoxSpec,
  type ServerMessage,
  type UploadResponse,
} from '../../../shared/remote-access';
import { waitingOf, type SessionSummary } from '../../../shared/sessions';
import type { EngineEvent } from '../../../shared/types';
import type { OfflineStore, StoredShell } from './offline-store';
import { requestHeaders } from './request';

/** Files up to this size travel inside the WebSocket; bigger ones are uploaded. */
export const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024;
export const NOT_CONNECTED = 'Not connected to Looper.';
/** While the page is on screen the computer is tried again soon; hidden, the phone isn't kept busy. */
const RECONNECT_VISIBLE_MS = [500, 1000, 2000, 3000];
const RECONNECT_HIDDEN_MS = [1000, 2000, 5000, 10000];
const PING_MS = 25_000;
/** How long a ping may stay unanswered before the socket counts as dead: the regular one, and one asked for on return to the app. */
const PONG_TIMEOUT_MS = 10_000;
const CHECK_PONG_MS = 3000;
/** The newest data heard is stored for "Updated 14:32" this often at most. */
const LIVE_STAMP_MS = 5000;
const CLIENT_ID_KEY = 'looper.clientId';
const RELOADED_KEY = 'looper.reloadedFor';
const NOT_CONNECTED_ALERT: MessageBoxSpec = {
  type: 'warning',
  title: 'Looper',
  message: 'Not connected to the host computer.',
  detail: 'Looper keeps trying to reconnect.',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0,
};
/** Sends a page makes on its own, which fail quietly while disconnected; every other send is the user's action and gets the alert. */
const QUIET_SENDS = new Set([
  'chat:draft',
  'sessions:seen',
  'sessions:cards',
  'builder:resize',
  'terminalSession:resize',
  'addons:slowDraw',
  'perf:report',
  'commands:menuBar',
  'messages:filter-state',
]);

// ---------- bytes ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const isPlain = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Uint8Array → `{ $bytes }` anywhere in the value, undefined → `{ $undefined }` in an array. */
export function encodeBytes(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: bytesToBase64(v) } satisfies EncodedBytes;
  // Array.from, not map: map skips holes, which JSON would also turn into null.
  if (Array.isArray(v)) return Array.from(v, (x: unknown) => (x === undefined ? ({ $undefined: true } satisfies EncodedUndefined) : encodeBytes(x)));
  if (v && typeof v === 'object' && isPlain(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeBytes(x)]));
  }
  return v;
}

/** `{ $bytes }` → Uint8Array and `{ $undefined }` → undefined, anywhere in the value. */
export function decodeBytes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeBytes);
  if (v && typeof v === 'object' && isPlain(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$bytes' && typeof o.$bytes === 'string') return base64ToBytes(o.$bytes);
    if (keys.length === 1 && keys[0] === '$undefined' && o.$undefined === true) return undefined;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeBytes(x)]));
  }
  return v;
}

// ---------- session ----------

/** The part of a WebSocket the session uses (a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SessionEnv {
  wsUrl: string;
  createSocket(url: string): SocketLike;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  platform: 'web' | 'ios' | 'android';
  fetch: typeof fetch;
  /** Whether the tab is on screen; the hello reports it (setVisible reports changes). */
  visible?: () => boolean;
  /** What the phone keeps of the computer's answers, shown while the computer can't be reached. */
  offline?: OfflineStore;
  /** This build's version: a welcome from a server of another version reloads the page once. */
  version?: string;
  reload?: () => void;
  /** Sets the app icon's badge to the number of sessions waiting for the user. */
  setBadge?: (n: number) => void;
  /** Per-tab storage for the reload guard (`storage` may outlive the tab). */
  sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  /** Started from the windows of the last launch, not from a welcome: the first welcome counts as a reconnect. */
  restored?: boolean;
  /** Called as a message from the computer arrives; what it returns is called with the message's name once it's handled. */
  onMessage?: () => ((name: string) => void) | undefined;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  w: string;
  channel: string;
  args: unknown[];
}

/** What the shell hears: server messages about windows, menus and dialogs, plus the two reconnect outcomes. */
export type ShellMessage =
  | Exclude<ServerMessage, { t: 'result' } | { t: 'event' } | { t: 'pong' }>
  /** Reconnected, but the server no longer has this client's windows: start over. */
  | { t: 'reset' }
  /** Reconnected and the windows are still there: reload each iframe so it reads fresh state. */
  | { t: 'resumed' };

const SOCKET_OPEN = 1;

const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

export class Session {
  readonly platform: SessionEnv['platform'];
  private socket: SocketLike | null = null;
  private clientId: string | null;
  /** New with every page load, never stored: a duplicated tab copies the clientId but not this. */
  private readonly pageId = randomId();
  private connected = false;
  private everConnected: boolean;
  private stopped = false;
  private attempt = 0;
  private visible: boolean;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private socketAt = 0;
  /** Counts the messages heard, which show the socket alive. */
  private heard = 0;
  /** When data last came from the computer (stamped every few seconds), or when the stored data was last live. */
  private liveAt: number | null;
  private nextId = 1;
  private nextLocal = 1;
  private localDialog: string | null = null;
  /** The window the user is working in, which a local alert belongs to. */
  private lastW = '';
  private readonly openWindows = new Set<string>();
  private readonly closedOffline = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Map<string, Set<(...args: any[]) => void>>>();
  private readonly shellListeners = new Set<(m: ShellMessage) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly env: SessionEnv) {
    this.platform = env.platform;
    this.clientId = env.storage.getItem(CLIENT_ID_KEY);
    this.everConnected = !!env.restored;
    this.visible = env.visible?.() ?? true;
    this.liveAt = env.offline?.lastLive() ?? null;
    env.offline?.setRefresher((w, channel, args) => {
      if (this.connected && this.openWindows.has(w)) void this.invoke(w, channel, args).catch(() => undefined);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** The screens show what the phone kept, not what the computer says now: it was connected before, or started from the last launch, and isn't now. */
  isStale(): boolean {
    return !this.connected && this.everConnected;
  }

  /** When the data on screen was last known to be live (null: never known). */
  lastLive(): number | null {
    return this.liveAt;
  }

  /** The windows of the last launch, when this session started from them. */
  restoredShell(): StoredShell | null {
    return this.env.restored ? (this.env.offline?.shell() ?? null) : null;
  }

  saveShell(shell: StoredShell): void {
    this.env.offline?.setShell(shell);
  }

  start(): void {
    this.stopped = false;
    const stored = this.env.offline?.get('sessions:state', []);
    if (stored) this.updateBadge((stored.value as { sessions: SessionSummary[] }).sessions);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
  }

  onShell(cb: (m: ShellMessage) => void): () => void {
    this.shellListeners.add(cb);
    return () => this.shellListeners.delete(cb);
  }

  /** Called with false when the connection drops and with true once the server has welcomed it. */
  onConnection(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  // ----- window-scoped calls -----

  invoke(w: string, channel: string, args: unknown[]): Promise<any> {
    this.openWindows.add(w);
    this.lastW = w;
    if (!this.connected) return this.invokeOffline(w, channel, args);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.post({ t: 'invoke', id, w, channel, args: encodeBytes(args) as unknown[] })) {
        reject(new Error(`The request to Looper is too large (${channel}).`));
        return;
      }
      this.pending.set(id, { resolve, reject, w, channel, args });
    });
  }

  /**
   * Without the computer: a read the phone kept answers from what it kept; any
   * other call fails, and the user is told here, since the screen that made it
   * may swallow the error (Run Now does: on the desktop the main process shows its own dialog).
   */
  private invokeOffline(w: string, channel: string, args: unknown[]): Promise<any> {
    const offline = this.env.offline;
    if (offline?.reads(channel)) {
      const hit = offline.get(channel, args, w);
      return hit ? Promise.resolve(hit.value) : Promise.reject(new Error(NOT_CONNECTED));
    }
    if (channel === 'dialog:error') {
      this.alert(w, { ...NOT_CONNECTED_ALERT, type: 'error', message: String(args[0] ?? ''), detail: args[1] === undefined ? undefined : String(args[1]) });
      return Promise.resolve(undefined);
    }
    this.alert(w);
    if (channel === 'dialog:confirm') return Promise.resolve(false);
    return Promise.reject(new Error(NOT_CONNECTED));
  }

  /** A message box drawn by the shell itself, which needs no connection. One at a time. */
  private alert(w: string, spec: MessageBoxSpec = NOT_CONNECTED_ALERT): void {
    if (this.localDialog) return;
    const dialogId = `local-${this.nextLocal++}`;
    this.localDialog = dialogId;
    this.emit({ t: 'dialog', dialogId, w, kind: 'message', spec });
  }

  send(w: string, channel: string, args: unknown[]): void {
    if (this.connected) this.post({ t: 'send', w, channel, args: encodeBytes(args) as unknown[] });
    else if (!QUIET_SENDS.has(channel)) this.alert(w);
  }

  on(w: string, channel: string, cb: (...args: any[]) => void): () => void {
    this.openWindows.add(w);
    let channels = this.listeners.get(w);
    if (!channels) this.listeners.set(w, (channels = new Map()));
    let set = channels.get(channel);
    if (!set) channels.set(channel, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Forget a window's listeners (its page is gone). */
  releaseWindow(w: string): void {
    this.listeners.delete(w);
    this.openWindows.delete(w);
  }

  transportFor(w: string): LooperTransport {
    return {
      invoke: (channel, ...args) => this.invoke(w, channel, args),
      send: (channel, ...args) => this.send(w, channel, args),
      on: (channel, cb) => this.on(w, channel, cb),
      files: (files) => Promise.all(files.map((f) => this.fileInput(f))),
      filePath: async (file) => (await this.upload(file)).path,
    };
  }

  apiFor(w: string): LooperApi {
    return createLooperApi(this.transportFor(w));
  }

  // ----- shell calls -----

  pick(menuId: string, itemId: string, checked?: boolean): void {
    if (!this.connected) return this.alert(this.lastW);
    this.post({ t: 'menu-pick', menuId, itemId, ...(checked === undefined ? {} : { checked }) });
  }
  dismiss(menuId: string): void {
    this.post({ t: 'menu-dismiss', menuId });
  }
  dialogResult(dialogId: string, result: DialogResult): void {
    if (dialogId.startsWith('local-')) {
      if (dialogId === this.localDialog) this.localDialog = null;
      return;
    }
    this.post({ t: 'dialog-result', dialogId, result });
  }
  closeWindow(w: string): void {
    if (this.connected) this.post({ t: 'window-close', w });
    else this.closeOffline(w);
  }

  /** Back and Close work without the computer: the window goes now, and the computer hears of it on reconnect. */
  private closeOffline(w: string): void {
    this.closedOffline.add(w);
    this.openWindows.delete(w);
    this.emit({ t: 'window-close', w });
  }
  focusWindow(w: string): void {
    this.lastW = w;
    this.post({ t: 'window-focus', w });
  }
  windowReady(w: string): void {
    this.openWindows.add(w);
    this.post({ t: 'window-ready', w });
  }
  /** The tab was hidden or shown: the computer sends push notifications only to devices not looking. Coming back checks the connection. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.post({ t: 'visibility', visible });
    if (visible) this.check();
  }

  /**
   * Is the connection alive? With no socket, connect now. With one, ask for a
   * pong and drop the socket when none comes soon: a socket iOS left half-open
   * while the app was away looks open until TCP gives up. Called on return to
   * the app and when the network comes back.
   */
  check(): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket) return this.reconnectNow();
    if (!this.connected) {
      // Still connecting after a few seconds: it won't.
      if (Date.now() - this.socketAt > CHECK_PONG_MS) this.abandon(socket);
      return;
    }
    this.probe(socket, CHECK_PONG_MS);
  }

  /** The banner's Try Now. */
  retryNow(): void {
    this.check();
  }
  pageClosed(w: string): void {
    if (this.connected) this.post({ t: 'window-closed-by-page', w });
    else this.closeOffline(w);
  }
  /** The page set document.title: the server records it, and the window's title bar here shows it, as Electron's does. */
  setTitle(w: string, title: string): void {
    this.post({ t: 'window-title', w, title });
    this.emit({ t: 'window-title', w, title });
  }

  /** A file from this device, put on the computer; `path` is where. */
  async upload(file: File): Promise<{ name: string; path: string }> {
    const name = file.name || 'upload';
    const res = await this.env.fetch(`/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: requestHeaders(), body: file });
    if (!res.ok) throw new Error(`Couldn't send ${name} to the host computer (${res.status}).`);
    const { path } = (await res.json()) as UploadResponse;
    return { name, path };
  }

  // ----- internals -----

  private async fileInput(f: File): Promise<AttachmentInputItem> {
    if (f.size <= MAX_INLINE_FILE_BYTES) return { name: f.name || 'pasted-image.png', data: new Uint8Array(await f.arrayBuffer()) };
    return this.upload(f);
  }

  /** False when the message is over the size limit and wasn't sent. */
  private post(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    const text = JSON.stringify(msg);
    // Base64 and JSON are ASCII-heavy; the length is a close enough byte count.
    if (text.length > MAX_WS_MESSAGE_BYTES) return false;
    socket.send(text);
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = this.env.createSocket(this.env.wsUrl);
    this.socket = socket;
    this.socketAt = Date.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const visible = this.env.visible?.();
      this.post({ t: 'hello', platform: this.platform, ...(this.clientId ? { clientId: this.clientId } : {}), pageId: this.pageId, ...(visible === undefined ? {} : { visible }) });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.heard++;
      this.handle(ev.data);
    };
    const closed = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropped();
    };
    socket.onclose = closed;
    socket.onerror = closed;
  }

  /** Ask for a pong; the socket is dropped when nothing at all is heard within `waitMs`. */
  private probe(socket: SocketLike, waitMs: number): void {
    const before = this.heard;
    this.post({ t: 'ping' });
    setTimeout(() => {
      if (this.socket === socket && this.heard === before) this.abandon(socket);
    }, waitMs);
  }

  /** Give up on a socket that may be half-open, without waiting for its close handshake, and connect again at once. */
  private abandon(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    this.dropped();
    this.reconnectNow();
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private dropped(): void {
    const was = this.connected;
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (was) this.env.offline?.disconnected(this.liveAt ?? Date.now());
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      const hit = this.env.offline?.reads(p.channel) ? this.env.offline.get(p.channel, p.args, p.w) : undefined;
      if (hit) p.resolve(hit.value);
      else p.reject(new Error(NOT_CONNECTED));
    }
    if (was) for (const cb of this.connectionListeners) cb(false);
    if (this.stopped) return;
    const delays = this.visible ? RECONNECT_VISIBLE_MS : RECONNECT_HIDDEN_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Data from the computer is live: remembered, now and then, as when the stored data was last current. */
  private stampLive(): void {
    const now = Date.now();
    if (this.liveAt !== null && now - this.liveAt < LIVE_STAMP_MS) return;
    this.liveAt = now;
    this.env.offline?.setLastLive(now);
  }

  /** The app icon's badge: the sessions waiting for the user. */
  private updateBadge(sessions: SessionSummary[]): void {
    this.env.setBadge?.(waitingOf(sessions).length);
  }

  /** A welcome from a server of another version: this page is old, so it loads the new one. Once per server version, so a cached old page can't loop. */
  private reloadForVersion(version: string): boolean {
    const store = this.env.sessionStorage ?? this.env.storage;
    if (!this.env.reload || store.getItem(RELOADED_KEY) === version) return false;
    store.setItem(RELOADED_KEY, version);
    this.env.reload();
    return true;
  }

  private handle(data: unknown): void {
    const done = this.env.onMessage?.();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    const name = msg.t === 'event' ? `receive ${msg.channel}` : msg.t === 'result' ? `result ${this.pending.get(msg.id)?.channel ?? ''}` : msg.t;
    this.dispatch(msg);
    done?.(name);
  }

  private dispatch(msg: ServerMessage): void {
    if (this.connected) this.stampLive();
    switch (msg.t) {
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) {
          const value = decodeBytes(msg.value);
          if (this.env.offline?.reads(p.channel)) {
            this.env.offline.put(p.channel, p.args, value, p.w);
            if (p.channel === 'sessions:state') this.updateBadge((value as { sessions: SessionSummary[] }).sessions);
          }
          p.resolve(value);
        } else p.reject(new Error(msg.error));
        return;
      }
      case 'event': {
        const args = (msg.args as unknown[]).map(decodeBytes);
        if (msg.channel === 'engine:event') {
          const ev = args[0] as EngineEvent;
          this.env.offline?.applyEvent(ev);
          if (ev.type === 'sessions') this.updateBadge(ev.state.sessions);
        }
        for (const cb of [...(this.listeners.get(msg.w)?.get(msg.channel) ?? [])]) cb(...args);
        return;
      }
      case 'pong':
        return;
      case 'welcome': {
        if (this.env.version && msg.version !== this.env.version && this.reloadForVersion(msg.version)) return;
        this.clientId = msg.clientId;
        this.env.storage.setItem(CLIENT_ID_KEY, msg.clientId);
        const reconnect = this.everConnected;
        this.everConnected = true;
        this.connected = true;
        this.attempt = 0;
        this.localDialog = null;
        this.stampLive();
        this.env.offline?.welcome(msg.device.id);
        this.pingTimer = setInterval(() => {
          if (this.socket) this.probe(this.socket, PONG_TIMEOUT_MS);
        }, PING_MS);
        for (const cb of this.connectionListeners) cb(true);
        this.emit(msg);
        if (reconnect) this.emit({ t: msg.resumed ? 'resumed' : 'reset' });
        for (const w of this.closedOffline) this.post({ t: 'window-close', w });
        this.closedOffline.clear();
        return;
      }
      case 'window-close':
        this.openWindows.delete(msg.w);
        this.emit(msg);
        return;
      default:
        this.emit(msg);
    }
  }

  private emit(m: ShellMessage): void {
    for (const cb of [...this.shellListeners]) cb(m);
  }
}
