// Relative imports: the unit tests (node tsconfig) load this file, and it has no `@shared` alias.
import { createLooperApi, type AttachmentInputItem, type LooperTransport } from '../../../shared/api-client';
import type { LooperApi } from '../../../shared/api';
import {
  MAX_WS_MESSAGE_BYTES,
  type ClientMessage,
  type DialogResult,
  type EncodedBytes,
  type EncodedUndefined,
  type ServerMessage,
  type UploadResponse,
} from '../../../shared/remote-access';
import { requestHeaders } from './request';

/** Files up to this size travel inside the WebSocket; bigger ones are uploaded. */
export const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024;
export const NOT_CONNECTED = 'Not connected to Looper.';
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const PING_MS = 25_000;
const CLIENT_ID_KEY = 'looper.clientId';

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
  private everConnected = false;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Map<string, Set<(...args: any[]) => void>>>();
  private readonly shellListeners = new Set<(m: ShellMessage) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly env: SessionEnv) {
    this.platform = env.platform;
    this.clientId = env.storage.getItem(CLIENT_ID_KEY);
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
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
    if (!this.connected) return Promise.reject(new Error(NOT_CONNECTED));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.post({ t: 'invoke', id, w, channel, args: encodeBytes(args) as unknown[] })) {
        reject(new Error(`The request to Looper is too large (${channel}).`));
        return;
      }
      this.pending.set(id, { resolve, reject });
    });
  }

  send(w: string, channel: string, args: unknown[]): void {
    if (this.connected) this.post({ t: 'send', w, channel, args: encodeBytes(args) as unknown[] });
  }

  on(w: string, channel: string, cb: (...args: any[]) => void): () => void {
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
    this.post({ t: 'menu-pick', menuId, itemId, ...(checked === undefined ? {} : { checked }) });
  }
  dismiss(menuId: string): void {
    this.post({ t: 'menu-dismiss', menuId });
  }
  dialogResult(dialogId: string, result: DialogResult): void {
    this.post({ t: 'dialog-result', dialogId, result });
  }
  closeWindow(w: string): void {
    this.post({ t: 'window-close', w });
  }
  focusWindow(w: string): void {
    this.post({ t: 'window-focus', w });
  }
  windowReady(w: string): void {
    this.post({ t: 'window-ready', w });
  }
  /** The tab was hidden or shown: the computer sends push notifications only to devices not looking. */
  setVisible(visible: boolean): void {
    this.post({ t: 'visibility', visible });
  }
  pageClosed(w: string): void {
    this.post({ t: 'window-closed-by-page', w });
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
    if (!res.ok) throw new Error(`Couldn't send ${name} to the computer (${res.status}).`);
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
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const visible = this.env.visible?.();
      this.post({ t: 'hello', platform: this.platform, ...(this.clientId ? { clientId: this.clientId } : {}), pageId: this.pageId, ...(visible === undefined ? {} : { visible }) });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.handle(ev.data);
    };
    const closed = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropped();
    };
    socket.onclose = closed;
    socket.onerror = closed;
  }

  private dropped(): void {
    const was = this.connected;
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const p of this.pending.values()) p.reject(new Error(NOT_CONNECTED));
    this.pending.clear();
    if (was) for (const cb of this.connectionListeners) cb(false);
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handle(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(decodeBytes(msg.value));
        else p.reject(new Error(msg.error));
        return;
      }
      case 'event': {
        const args = (msg.args as unknown[]).map(decodeBytes);
        for (const cb of [...(this.listeners.get(msg.w)?.get(msg.channel) ?? [])]) cb(...args);
        return;
      }
      case 'pong':
        return;
      case 'welcome': {
        this.clientId = msg.clientId;
        this.env.storage.setItem(CLIENT_ID_KEY, msg.clientId);
        const reconnect = this.everConnected;
        this.everConnected = true;
        this.connected = true;
        this.attempt = 0;
        this.pingTimer = setInterval(() => this.post({ t: 'ping' }), PING_MS);
        for (const cb of this.connectionListeners) cb(true);
        this.emit(msg);
        if (reconnect) this.emit({ t: msg.resumed ? 'resumed' : 'reset' });
        return;
      }
      default:
        this.emit(msg);
    }
  }

  private emit(m: ShellMessage): void {
    for (const cb of [...this.shellListeners]) cb(m);
  }
}
