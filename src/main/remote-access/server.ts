import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Logger } from '../../engine/log';
import {
  DEVICE_COOKIE,
  FRAME_PAGE,
  MAX_WS_MESSAGE_BYTES,
  PROXY_LOGIN_HEADER,
  PROXY_SECRET_HEADER,
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
  parseDeviceNotifications,
  type ClientMessage,
  type DeviceNotifications,
  PWA_ICONS,
  type MeResponse,
  type PushKeyResponse,
  type PushSubscribeRequest,
  type PwaIconName,
  type RemoteAccessProviderId,
  type RenameRequest,
  type ServerMessage,
  type UploadResponse,
} from '../../shared/remote-access';
import { cleanDeviceName, safeEqual, type Clock, type DeviceStore, type Pairing, type StoredDevice } from './devices';
import { manifest, serviceWorker, withMobileHead } from './pwa';
import { parseSubscription } from './push';
import { previewFrame, previewFrameHeaders } from '../preview-frames';
import { sendPayload, StaticCache } from './static-cache';

export const MAX_PAIR_BODY_BYTES = 4 * 1024;

/** A port nothing listens on at 127.0.0.1 right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
export const MAX_PUSH_BODY_BYTES = 8 * 1024;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60_000;
export const DOWNLOAD_TTL_MS = 10 * 60_000;
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const PING_INTERVAL_MS = 30_000;
/** Built assets the service worker keeps up front: code, styles and fonts. */
const PRECACHE_EXT = /\.(js|css|woff2?|ttf)$/i;
/** A WebSocket must say hello this soon after it opens. */
const HELLO_TIMEOUT_MS = 15_000;
/** Rejected requests logged per minute; the rest are counted. */
const REJECT_LOG_PER_MIN = 5;

/**
 * The WebSocket's own address, for connect-src: Chromium counts a same-origin
 * ws:/wss: URL as 'self', but Safari before 15.4 didn't. Null when the
 * address isn't a plain host[:port] (it goes into a header).
 */
const wsSources = (host: string | null): string => (host ? ` ws://${host} wss://${host}` : '');

const csp = (host: string | null): string =>
  // 'wasm-unsafe-eval' compiles WebAssembly (the PowerPoint preview's parser), not JavaScript from strings; a blob:
  // worker is the one that parser starts on Safari, where the deck is drawn on the page (PptxSlides), and blob: images and media are what
  // it decodes SVGs, audio and video through (URL.createObjectURL).
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; " +
  `connect-src 'self'${wsSources(host)}; frame-ancestors 'self'`;

/** index.html as served: its meta CSP (which the desktop app reads as it is) allows the WebSocket's address too. */
export function withConnectSrc(html: string, host: string | null): string {
  if (!host) return html;
  return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i, (_m, open: string, policy: string, close: string) => {
    const next = /(^|;)\s*connect-src\b/.test(policy)
      ? policy.replace(/((?:^|;)\s*connect-src)([^;]*)/, `$1$2${wsSources(host)}`)
      : `${policy.replace(/[;\s]*$/, '')}; connect-src 'self'${wsSources(host)}`;
    return open + next + close;
  });
}

const PLAIN_HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** The Tailscale helper's proxy: its per-start secret, and the account it may pass on (none until it reports one). */
export interface TailscaleAccess {
  secret: string;
  login: string | undefined;
}

/** The source a request came through, or why it may not come in. */
type Via = { source: RemoteAccessProviderId; refused?: undefined } | { source?: undefined; refused: string };

export type Platform = 'web' | 'ios' | 'android';

/** One browser tab's WebSocket, from its hello on. */
export interface RemoteConnection {
  readonly id: string;
  readonly device: { id: string; name: string };
  readonly platform: Platform;
  /** The clientId the hello asked to resume, if any. */
  readonly clientId?: string;
  /** The hello's per-page-load id, if any. */
  readonly pageId?: string;
  /** The hello's last page message, if any. */
  readonly seq?: number;
  /** The tab is on screen (its last hello or visibility message). */
  readonly visible: boolean;
  /** False when it wasn't sent: the socket is closed, or the message is too large. A string is a message already serialized. */
  send(msg: ServerMessage | string): boolean;
  onMessage(cb: (msg: ClientMessage) => void): () => void;
  onClose(cb: () => void): () => void;
  /** Cut the socket off at once (a new connection took this one's place); a dead one doesn't linger until the next ping. */
  close(): void;
}

export interface RemoteServerOptions {
  /** `<dataDir>/remote-access`: uploads go in its `uploads` folder. */
  dir: string;
  /** The built renderer (out/renderer). */
  staticDir: string;
  devices: DeviceStore;
  pairing: Pairing;
  log: Logger;
  now: Clock;
  /** A device paired through /api/pair. */
  onPaired?: (device: StoredDevice) => void;
  /** A connection opened (after its hello) or closed. */
  onConnectionsChanged?: () => void;
  /** The push endpoints' store; without it they answer 404. */
  push?: PushEndpoints;
  /** A home-screen icon as PNG (made from the app's icon); null when it can't be made. */
  icon?: (name: PwaIconName) => Buffer | null;
  /** A launch screen (apple-touch-startup-image) as PNG for a screen of `width` x `height` pixels; null for a size no iPhone has. */
  startup?: (width: number, height: number, dark: boolean) => Buffer | null;
  /** A device unpaired itself (POST /api/unpair). */
  onUnpair?: (deviceId: string) => void;
  /** A device renamed itself (POST /api/rename) or chose its notifications (POST /api/notifications); stored by the time this runs. */
  onDeviceChanged?: (deviceId: string) => void;
  /** The computer's name, as paired devices show it. */
  computerName: () => string;
}

/** What /api/push/* reach. */
export interface PushEndpoints {
  publicKey(): string;
  subscribe(deviceId: string, sub: PushSubscribeRequest): void;
  unsubscribe(deviceId: string, endpoint: string): void;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const PLATFORMS = new Set<unknown>(['web', 'ios', 'android']);
const DIALOG_KINDS = new Set<unknown>(['message', 'open', 'save']);

/** A client message, checked field by field; null for anything else. */
export function parseClientMessage(data: RawData, isBinary: boolean): ClientMessage | null {
  if (isBinary) return null;
  let m: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(data as Buffer[]).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.t) {
    case 'hello':
      return PLATFORMS.has(m.platform) &&
        (m.clientId === undefined || isStr(m.clientId)) &&
        (m.pageId === undefined || isStr(m.pageId)) &&
        (m.visible === undefined || typeof m.visible === 'boolean') &&
        (m.seq === undefined || (Number.isSafeInteger(m.seq) && (m.seq as number) >= 0))
        ? (m as ClientMessage)
        : null;
    case 'visibility':
      return typeof m.visible === 'boolean' ? { t: 'visibility', visible: m.visible } : null;
    case 'window-ready':
    case 'window-close':
    case 'window-focus':
    case 'window-closed-by-page':
      return isStr(m.w) ? (m as ClientMessage) : null;
    case 'window-title':
      return isStr(m.w) && isStr(m.title) ? (m as ClientMessage) : null;
    case 'invoke':
      return Number.isSafeInteger(m.id) && isStr(m.w) && isStr(m.channel) && Array.isArray(m.args) ? (m as ClientMessage) : null;
    case 'send':
      return isStr(m.w) && isStr(m.channel) && Array.isArray(m.args) ? (m as ClientMessage) : null;
    case 'menu-pick':
      return isStr(m.menuId) && isStr(m.itemId) && (m.checked === undefined || typeof m.checked === 'boolean') ? (m as ClientMessage) : null;
    case 'menu-dismiss':
      return isStr(m.menuId) ? (m as ClientMessage) : null;
    case 'dialog-result': {
      const r = m.result as Record<string, unknown> | null;
      return isStr(m.dialogId) && !!r && typeof r === 'object' && DIALOG_KINDS.has(r.kind) ? (m as ClientMessage) : null;
    }
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

/** A file name safe on every platform: no folders, reserved characters or Windows device names. */
export function sanitizeFileName(name: string): string {
  let s = name.split(/[\\/]/).pop() ?? '';
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s || 'upload';
}

/** `Content-Disposition: attachment` with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const isLoopback = (addr: string | undefined): boolean => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

class Connection implements RemoteConnection {
  readonly id = crypto.randomBytes(6).toString('base64url');
  private readonly messageCbs = new Set<(msg: ClientMessage) => void>();
  private readonly closeCbs = new Set<() => void>();

  constructor(
    private readonly ws: WebSocket,
    readonly device: { id: string; name: string },
    readonly platform: Platform,
    readonly clientId: string | undefined,
    readonly pageId: string | undefined,
    readonly seq: number | undefined,
    private readonly log: Logger,
    public visible: boolean,
  ) {}

  send(msg: ServerMessage | string): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    const kind = typeof msg === 'string' ? 'page' : msg.t;
    let text: string;
    try {
      text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    } catch (err) {
      this.log.warn(`remote access: can't send a ${kind} message to ${this.device.name}: ${String(err)}`);
      return false;
    }
    if (Buffer.byteLength(text) > MAX_WS_MESSAGE_BYTES) {
      this.log.warn(`remote access: dropped a ${kind} message to ${this.device.name}: larger than ${MAX_WS_MESSAGE_BYTES} bytes`);
      return false;
    }
    this.ws.send(text);
    return true;
  }

  onMessage(cb: (msg: ClientMessage) => void): () => void {
    this.messageCbs.add(cb);
    return () => this.messageCbs.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close(): void {
    this.ws.terminate();
  }

  deliver(msg: ClientMessage): void {
    for (const cb of this.messageCbs) {
      try {
        cb(msg);
      } catch (err) {
        this.log.error(`remote access: message handler failed: ${String(err)}`);
      }
    }
  }

  closed(): void {
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch (err) {
        this.log.error(`remote access: close handler failed: ${String(err)}`);
      }
    }
    this.closeCbs.clear();
    this.messageCbs.clear();
  }
}

/**
 * Looper's UI for other devices: HTTP and a WebSocket on 127.0.0.1 only. Every
 * request passes the access check first, which also tells which source it came
 * through (the Tailscale helper's proxy, or this computer's browser; both may
 * be on at once); everything past pairing needs the cookie of a device paired
 * through that source.
 */
export class RemoteServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  /** This computer's browser may come in (the local source is on). */
  private local = false;
  private tailscale: TailscaleAccess | null = null;
  private readonly conns = new Set<Connection>();
  /** Open sockets: whether each answered since the last ping, its device, and whether that device was removed. */
  private readonly sockets = new Map<WebSocket, { alive: boolean; deviceId: string; cut: boolean }>();
  private readonly connectionCbs = new Set<(c: RemoteConnection) => void>();
  private readonly downloads = new Map<string, { file: string; name: string; expiresAt: number; onDone?: () => void }>();
  private timers: NodeJS.Timeout[] = [];
  private rejectWindow = { start: 0, logged: 0, dropped: 0 };
  private readonly cache = new StaticCache();
  /** The files the service worker keeps, listed again when the assets folder changes. */
  private assetList: { mtimeMs: number; names: string[] } | null = null;

  constructor(private readonly opts: RemoteServerOptions) {}

  private get uploadsDir(): string {
    return path.join(this.opts.dir, 'uploads');
  }

  /** Listen on 127.0.0.1:port (0 = a free one); resolves the port. */
  async listen(port: number): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    // permessage-deflate for the JSON traffic; small messages (pings, acks) aren't worth compressing.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: { threshold: 1024 } });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head, wss));
    server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.opts.log.error(`remote access: server error: ${String(err)}`));
    this.server = server;
    this.wss = wss;
    this.port = (server.address() as AddressInfo).port;
    this.cleanUploads();
    const ping = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    const clean = setInterval(() => this.cleanUploads(), 60 * 60_000);
    ping.unref();
    clean.unref();
    this.timers = [ping, clean];
    return this.port;
  }

  /** Let this computer's browser in, or not. */
  setLocalAccess(on: boolean): void {
    this.local = on;
  }

  /** Let the Tailscale helper's proxy in; null: refuse it (Tailscale is off). */
  setTailscaleAccess(access: TailscaleAccess | null): void {
    this.tailscale = access;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const ws of this.sockets.keys()) ws.terminate();
    this.sockets.clear();
    this.wss?.close();
    const server = this.server;
    this.server = null;
    this.wss = null;
    this.local = false;
    this.tailscale = null;
    for (const d of this.downloads.values()) this.done(d);
    this.downloads.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  onConnection(cb: (c: RemoteConnection) => void): () => void {
    this.connectionCbs.add(cb);
    return () => this.connectionCbs.delete(cb);
  }

  connections(): RemoteConnection[] {
    return [...this.conns];
  }

  connectedCount(deviceId: string): number {
    let n = 0;
    for (const c of this.conns) if (c.device.id === deviceId) n++;
    return n;
  }

  /** The devices with a tab on screen now: they need no push notification. */
  visibleDevices(): Set<string> {
    const out = new Set<string>();
    for (const c of this.conns) if (c.visible) out.add(c.device.id);
    return out;
  }

  /**
   * Cut the device's sockets off (it was removed): at once, not with a close
   * handshake, during which whatever the device still sends would be handled.
   */
  closeDevice(deviceId: string): void {
    for (const [ws, s] of this.sockets) {
      if (s.deviceId !== deviceId) continue;
      s.cut = true;
      ws.terminate();
    }
  }

  /** A one-time token for GET /api/download/<token>, good for 10 minutes; onDone runs once it's downloaded or lapses. */
  offerDownload(filePath: string, name: string, onDone?: () => void): string {
    this.pruneDownloads();
    const token = crypto.randomBytes(24).toString('base64url');
    this.downloads.set(token, { file: filePath, name: sanitizeFileName(name), expiresAt: this.opts.now() + DOWNLOAD_TTL_MS, onDone });
    return token;
  }

  private done(d: { onDone?: () => void }): void {
    try {
      d.onDone?.();
    } catch (err) {
      this.opts.log.error(`remote access: download cleanup failed: ${String(err)}`);
    }
  }

  // ---------- access ----------

  /**
   * The source the request came through, or why it may not come in. Only the
   * Tailscale helper's proxy sets the proxy secret (it strips one a caller
   * sends), so a request carrying it is judged as Tailscale's alone; any
   * other is this computer's browser, which must use the server's own address.
   */
  private via(req: http.IncomingMessage): Via {
    const secret = header(req, PROXY_SECRET_HEADER);
    if (secret !== undefined) {
      const t = this.tailscale;
      if (!t || !safeEqual(secret, t.secret)) return { refused: 'missing or wrong proxy secret' };
      const login = header(req, PROXY_LOGIN_HEADER);
      if (!t.login || login !== t.login) return { refused: `login ${JSON.stringify(login ?? '')}` };
      return { source: 'tailscale' };
    }
    if (!this.local) return { refused: this.tailscale ? 'missing or wrong proxy secret' : 'not accepting connections' };
    if (!isLoopback(req.socket.remoteAddress)) return { refused: `remote address ${req.socket.remoteAddress}` };
    const host = header(req, 'host');
    if (host !== `localhost:${this.port}` && host !== `127.0.0.1:${this.port}`) return { refused: `host ${JSON.stringify(host ?? '')}` };
    return { source: 'local' };
  }

  /** The page's own origin, as its WebSocket's Origin must be. */
  private ownOrigin(req: http.IncomingMessage, source: RemoteAccessProviderId): string | null {
    if (source === 'tailscale') {
      const host = header(req, 'x-forwarded-host');
      return host ? `https://${host}` : null;
    }
    return `http://${header(req, 'host')}`;
  }

  /** The host[:port] the browser loaded the page from, when it's a plain one. */
  private pageHost(req: http.IncomingMessage, source: RemoteAccessProviderId | undefined): string | null {
    const host = source === 'tailscale' ? header(req, 'x-forwarded-host') : header(req, 'host');
    return host && PLAIN_HOST.test(host) ? host : null;
  }

  /** Over HTTPS: only the Tailscale proxy says so. */
  private secure(req: http.IncomingMessage, source: RemoteAccessProviderId): boolean {
    return source === 'tailscale' && header(req, 'x-forwarded-proto') === 'https';
  }

  /** The device whose cookie the request carries, when it was paired through the source the request came through. */
  private device(req: http.IncomingMessage, source: RemoteAccessProviderId): StoredDevice | undefined {
    return this.opts.devices.verify(readCookie(header(req, 'cookie'), DEVICE_COOKIE), source);
  }

  /**
   * Why a state-changing request isn't from Looper's own page, or null. The
   * cookie is SameSite=Strict, yet still goes to same-site pages (other
   * localhost ports, other machines of the tailnet). The header can't be set
   * cross-origin without a preflight, which is never answered. Not an Origin
   * check: Referrer-Policy: no-referrer can make same-origin posts say null.
   */
  private crossSite(req: http.IncomingMessage): string | null {
    if (header(req, REQUEST_HEADER.toLowerCase()) !== REQUEST_HEADER_VALUE) return `missing ${REQUEST_HEADER}`;
    const site = header(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return `Sec-Fetch-Site ${JSON.stringify(site.slice(0, 30))}`;
    return null;
  }

  /** Log a refused request, at most REJECT_LOG_PER_MIN a minute. */
  private logRejected(req: http.IncomingMessage, why: string): void {
    const now = this.opts.now();
    const w = this.rejectWindow;
    if (now - w.start >= 60_000) {
      if (w.dropped) this.opts.log.warn(`remote access: refused ${w.dropped} more requests`);
      this.rejectWindow = { start: now, logged: 0, dropped: 0 };
    }
    if (this.rejectWindow.logged < REJECT_LOG_PER_MIN) {
      this.rejectWindow.logged++;
      this.opts.log.warn(`remote access: refused ${req.method} ${(req.url ?? '').slice(0, 100)}: ${why}`);
    } else {
      this.rejectWindow.dropped++;
    }
  }

  // ---------- HTTP ----------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const via = this.via(req);
    res.setHeader('Content-Security-Policy', csp(this.pageHost(req, via.source)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (via.refused !== undefined) {
        this.logRejected(req, via.refused);
        return this.text(res, 403, 'Forbidden');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        return await this.api(req, res, url, via.source);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.text(res, 405, 'Method Not Allowed');
      const frame = /^\/preview-frame\/([0-9a-f]{32})$/.exec(url.pathname);
      if (frame) return this.previewPage(req, res, frame[1], via.source);
      return await this.serveStatic(req, res, url.pathname, via.source);
    } catch (err) {
      // The browser went away mid-response (a closed tab, a canceled download): nothing went wrong here.
      const gone = (err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE' || req.destroyed || res.destroyed;
      if (!gone) this.opts.log.error(`remote access: ${req.method} ${req.url} failed: ${String(err)}`);
      if (!res.headersSent && !res.destroyed) this.text(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  }

  /**
   * An HTML file Preview shows, for the paired device that asked (its page loads the frame, so its cookie comes
   * along). The page's own Content-Security-Policy sandboxes it: an origin of its own, even opened outside the frame.
   */
  private previewPage(req: http.IncomingMessage, res: http.ServerResponse, token: string, source: RemoteAccessProviderId): void {
    if (!this.device(req, source)) return this.text(res, 401, 'Unauthorized');
    const f = previewFrame(token);
    if (!f) return this.text(res, 404, 'Not Found');
    res.writeHead(200, previewFrameHeaders(f));
    res.end(req.method === 'HEAD' ? undefined : f.html);
  }

  private text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, source: RemoteAccessProviderId): Promise<void> {
    const p = url.pathname;
    if (req.method !== 'GET') {
      const why = this.crossSite(req);
      if (why) {
        this.logRejected(req, why);
        return this.text(res, 403, 'Forbidden');
      }
    }
    if (p === '/api/pair') {
      if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
      return this.pair(req, res, source);
    }
    if (p === '/api/ws') return this.text(res, 426, 'Upgrade Required');
    const known =
      p === '/api/me' ||
      p === '/api/upload' ||
      p === '/api/unpair' ||
      p === '/api/rename' ||
      p === '/api/notifications' ||
      p.startsWith('/api/download/') ||
      (!!this.opts.push && p.startsWith('/api/push/'));
    if (!known) return this.text(res, 404, 'Not Found');

    const device = this.device(req, source);
    if (p === '/api/me') {
      if (req.method !== 'GET') return this.text(res, 405, 'Method Not Allowed');
      if (device) this.opts.devices.touch(device.id);
      return this.json(res, 200, device ? this.me(device) : { paired: false });
    }
    if (!device) return this.text(res, 401, 'Unauthorized');
    this.opts.devices.touch(device.id);
    if (p === '/api/upload') {
      if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
      return this.upload(req, res, url.searchParams.get('name') ?? '');
    }
    if (p === '/api/unpair') {
      if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
      res.writeHead(204, { 'Set-Cookie': `${DEVICE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secure(req, source) ? '; Secure' : ''}` });
      res.end();
      this.opts.onUnpair?.(device.id);
      return;
    }
    if (p === '/api/rename') {
      if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
      return this.rename(req, res, device);
    }
    if (p === '/api/notifications') {
      if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
      return this.setNotifications(req, res, device);
    }
    if (p.startsWith('/api/push/') && this.opts.push) return this.pushApi(req, res, p, device, this.opts.push);
    if (req.method !== 'GET') return this.text(res, 405, 'Method Not Allowed');
    return this.download(res, p.slice('/api/download/'.length));
  }

  private async pushApi(req: http.IncomingMessage, res: http.ServerResponse, p: string, device: StoredDevice, push: PushEndpoints): Promise<void> {
    if (p === '/api/push/key') {
      if (req.method !== 'GET') return this.text(res, 405, 'Method Not Allowed');
      const body: PushKeyResponse = { publicKey: push.publicKey() };
      return this.json(res, 200, body);
    }
    if (p !== '/api/push/subscribe' && p !== '/api/push/unsubscribe') return this.text(res, 404, 'Not Found');
    if (req.method !== 'POST') return this.text(res, 405, 'Method Not Allowed');
    const raw = await this.readBody(req, MAX_PUSH_BODY_BYTES);
    if (!raw) return this.text(res, 413, 'Payload Too Large');
    let input: unknown;
    try {
      input = JSON.parse(raw.toString('utf8'));
    } catch {
      return this.text(res, 400, 'Bad Request');
    }
    if (p === '/api/push/subscribe') {
      const sub = parseSubscription(input);
      if (!sub) return this.text(res, 400, 'Bad Request');
      push.subscribe(device.id, sub);
    } else {
      const endpoint = (input as { endpoint?: unknown } | null)?.endpoint;
      if (typeof endpoint !== 'string') return this.text(res, 400, 'Bad Request');
      push.unsubscribe(device.id, endpoint);
    }
    res.writeHead(204);
    res.end();
  }

  /** The request body, or null when it's bigger than `max`. */
  private readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      if (Number(header(req, 'content-length') ?? 0) > max) {
        req.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) {
          req.removeAllListeners('data');
          req.resume();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /** Pair a device through the source the request came through: its cookie works there only. */
  private async pair(req: http.IncomingMessage, res: http.ServerResponse, source: RemoteAccessProviderId): Promise<void> {
    const body = await this.readBody(req, MAX_PAIR_BODY_BYTES);
    if (!body) return this.text(res, 413, 'Payload Too Large');
    let input: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(body.toString('utf8'));
      if (!v || typeof v !== 'object') throw new Error('not an object');
      input = v as Record<string, unknown>;
    } catch {
      return this.text(res, 400, 'Bad Request');
    }
    if (typeof input.code !== 'string') return this.text(res, 400, 'Bad Request');
    const result = this.opts.pairing.check(input.code);
    if (result === 'locked') return this.text(res, 429, 'Too many wrong codes. Make a new code on the host computer.');
    if (result !== 'ok') return this.text(res, 401, 'Wrong or expired code.');
    const { device, cookie } = this.opts.devices.add(cleanDeviceName(input.name), source);
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${this.secure(req, source) ? '; Secure' : ''}`;
    this.json(res, 200, this.me(device), { 'Set-Cookie': `${DEVICE_COOKIE}=${cookie}; ${flags}` });
    this.opts.onPaired?.(device);
  }

  private me(device: StoredDevice): MeResponse {
    return { paired: true, device: { id: device.id, name: device.name, notify: { ...device.notify } }, computer: this.opts.computerName() };
  }

  /** The device chooses what it's notified of (This Device's switches). */
  private async setNotifications(req: http.IncomingMessage, res: http.ServerResponse, device: StoredDevice): Promise<void> {
    const body = await this.readBody(req, MAX_PAIR_BODY_BYTES);
    if (!body) return this.text(res, 413, 'Payload Too Large');
    let notify: DeviceNotifications | null;
    try {
      notify = parseDeviceNotifications(JSON.parse(body.toString('utf8')));
    } catch {
      notify = null;
    }
    if (!notify) return this.text(res, 400, 'Bad Request');
    this.opts.devices.setNotifications(device.id, notify);
    this.opts.onDeviceChanged?.(device.id);
    return this.json(res, 200, this.me(this.opts.devices.get(device.id) ?? device));
  }

  /** The device renames itself (This Device's Name). */
  private async rename(req: http.IncomingMessage, res: http.ServerResponse, device: StoredDevice): Promise<void> {
    const body = await this.readBody(req, MAX_PAIR_BODY_BYTES);
    if (!body) return this.text(res, 413, 'Payload Too Large');
    let name: unknown;
    try {
      name = (JSON.parse(body.toString('utf8')) as Partial<RenameRequest> | null)?.name;
    } catch {
      return this.text(res, 400, 'Bad Request');
    }
    if (typeof name !== 'string' || !name.trim()) return this.text(res, 400, 'Type a name for this device.');
    this.opts.devices.rename(device.id, name);
    this.opts.onDeviceChanged?.(device.id);
    return this.json(res, 200, this.me(this.opts.devices.get(device.id) ?? device));
  }

  private async upload(req: http.IncomingMessage, res: http.ServerResponse, name: string): Promise<void> {
    if (Number(header(req, 'content-length') ?? 0) > MAX_UPLOAD_BYTES) {
      req.resume();
      return this.text(res, 413, 'Payload Too Large');
    }
    const dir = path.join(this.uploadsDir, crypto.randomBytes(12).toString('base64url'));
    const file = path.join(dir, sanitizeFileName(name));
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    let tooBig = false;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          tooBig = true;
          cb(new Error('too big'));
        } else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file, { flags: 'wx' }));
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (tooBig) {
        res.setHeader('Connection', 'close');
        return this.text(res, 413, 'Payload Too Large');
      }
      throw err;
    }
    const body: UploadResponse = { path: file };
    this.json(res, 200, body);
  }

  private async download(res: http.ServerResponse, token: string): Promise<void> {
    this.pruneDownloads();
    const offer = this.downloads.get(token);
    if (!offer) return this.text(res, 404, 'Not Found');
    this.downloads.delete(token);
    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(offer.file);
        if (!stat.isFile()) throw new Error('not a file');
      } catch {
        return this.text(res, 404, 'Not Found');
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': contentDisposition(offer.name),
      });
      await pipeline(fs.createReadStream(offer.file), res);
    } finally {
      this.done(offer);
    }
  }

  private pruneDownloads(): void {
    const now = this.opts.now();
    for (const [token, d] of this.downloads) {
      if (now < d.expiresAt) continue;
      this.downloads.delete(token);
      this.done(d);
    }
  }

  /** Delete upload folders older than a day. */
  private cleanUploads(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.uploadsDir);
    } catch {
      return;
    }
    const cutoff = this.opts.now() - UPLOAD_MAX_AGE_MS;
    for (const n of names) {
      const p = path.join(this.uploadsDir, n);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch (err) {
        this.opts.log.warn(`remote access: can't delete old upload ${p}: ${String(err)}`);
      }
    }
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, source: RemoteAccessProviderId): Promise<void> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return this.text(res, 400, 'Bad Request');
    }
    if (rel === '/manifest.webmanifest') return this.generated(req, res, 'application/manifest+json; charset=utf-8', manifest());
    if (rel === '/sw.js') return this.generated(req, res, MIME['.js'], serviceWorker(this.precacheList(), await this.servedPage(req, source)));
    const icon = /^\/icons\/([a-z0-9-]+)\.png$/.exec(rel);
    if (icon) {
      const name = icon[1] as PwaIconName;
      const png = Object.hasOwn(PWA_ICONS, name) ? this.opts.icon?.(name) : null;
      if (!png) return this.text(res, 404, 'Not Found');
      return sendPayload(req, res, this.cache.intern('image/png', png), 'public, max-age=86400');
    }
    const startup = /^\/startup\/(\d+)x(\d+)-(light|dark)\.png$/.exec(rel);
    if (startup) {
      const png = this.opts.startup?.(Number(startup[1]), Number(startup[2]), startup[3] === 'dark');
      if (!png) return this.text(res, 404, 'Not Found');
      return sendPayload(req, res, this.cache.intern('image/png', png), 'public, max-age=86400');
    }
    // A window's frame gets index.html without the home-screen tags (pwa.ts FRAME_PAGE).
    const frame = rel === FRAME_PAGE;
    if (rel === '/' || rel === '/pair' || frame) rel = '/index.html';
    const root = path.resolve(this.opts.staticDir);
    const file = path.resolve(root, '.' + path.posix.normalize(rel.replace(/\\/g, '/')));
    if (rel.includes('\0') || (file !== root && !file.startsWith(root + path.sep))) return this.text(res, 404, 'Not Found');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return this.text(res, 404, 'Not Found');
    }
    if (!stat.isFile()) return this.text(res, 404, 'Not Found');
    // The page itself must always be fresh; built assets carry a content hash.
    if (path.extname(file).toLowerCase() === '.html') {
      const body = Buffer.from(withMobileHead(withConnectSrc(await fs.promises.readFile(file, 'utf8'), this.pageHost(req, source)), frame), 'utf8');
      return sendPayload(req, res, this.cache.intern(MIME['.html'] as string, body), 'no-cache');
    }
    return this.cache.sendFile(req, res, file, stat, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'public, max-age=31536000, immutable');
  }

  /** index.html as this host serves it ('' without one), which the service worker keeps: a change to it is a new shell. */
  private async servedPage(req: http.IncomingMessage, source: RemoteAccessProviderId): Promise<string> {
    try {
      return withMobileHead(withConnectSrc(await fs.promises.readFile(path.join(path.resolve(this.opts.staticDir), 'index.html'), 'utf8'), this.pageHost(req, source)));
    } catch {
      return '';
    }
  }

  /** What the service worker keeps for the app to open offline: the page and its windows' (FRAME_PAGE), the manifest, the icons that exist and the built code, styles and fonts. Images (the docs' screenshots among them) are kept once a screen shows them. */
  private precacheList(): string[] {
    const dir = path.join(path.resolve(this.opts.staticDir), 'assets');
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      // No assets folder (a test's static dir): only the page.
    }
    let assets = this.assetList;
    if (!assets || assets.mtimeMs !== mtimeMs) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && PRECACHE_EXT.test(e.name)).map((e) => e.name).sort();
      } catch {
        // As above.
      }
      assets = this.assetList = { mtimeMs, names };
    }
    const icons = (Object.keys(PWA_ICONS) as PwaIconName[]).filter((name) => this.opts.icon?.(name)).map((name) => `/icons/${name}.png`);
    return ['/index.html', FRAME_PAGE, '/manifest.webmanifest', ...icons, ...assets.names.map((n) => `/assets/${n}`)];
  }

  /** A file the server makes itself; always checked again (a 304 when unchanged), so an update shows at once. */
  private generated(req: http.IncomingMessage, res: http.ServerResponse, type: string, text: string): Promise<void> {
    return sendPayload(req, res, this.cache.intern(type, Buffer.from(text, 'utf8')), 'no-cache');
  }

  // ---------- WebSocket ----------

  private refuseUpgrade(socket: Socket, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroySoon?.();
  }

  private upgrade(req: http.IncomingMessage, socket: Socket, head: Buffer, wss: WebSocketServer): void {
    socket.on('error', () => socket.destroy());
    const via = this.via(req);
    if (via.refused !== undefined) {
      this.logRejected(req, via.refused);
      return this.refuseUpgrade(socket, 403, 'Forbidden');
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/ws') return this.refuseUpgrade(socket, 404, 'Not Found');
    const device = this.device(req, via.source);
    if (!device) {
      this.logRejected(req, 'WebSocket without a paired device');
      return this.refuseUpgrade(socket, 401, 'Unauthorized');
    }
    const origin = header(req, 'origin');
    const own = this.ownOrigin(req, via.source);
    if (!origin || !own || origin !== own) {
      this.logRejected(req, `WebSocket origin ${JSON.stringify(origin ?? '')}`);
      return this.refuseUpgrade(socket, 403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, device));
  }

  /** A new WebSocket: it becomes a connection once it says hello. */
  private accept(ws: WebSocket, device: StoredDevice): void {
    const live = { alive: true, deviceId: device.id, cut: false };
    this.sockets.set(ws, live);
    ws.on('pong', () => (live.alive = true));
    ws.on('error', () => ws.terminate());
    let conn: Connection | null = null;
    const helloTimer = setTimeout(() => ws.close(1008, 'hello expected'), HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      // Frames already read in the same chunk still arrive after terminate().
      if (live.cut) return;
      live.alive = true;
      const msg = parseClientMessage(data, isBinary);
      if (!msg) return;
      if (msg.t === 'ping') {
        conn?.send({ t: 'pong' });
        return;
      }
      if (!conn) {
        if (msg.t !== 'hello') return;
        clearTimeout(helloTimer);
        // The device may have been renamed or removed since the upgrade.
        const current = this.opts.devices.get(device.id);
        if (!current) return ws.close(1008, 'device removed');
        conn = new Connection(ws, { id: current.id, name: current.name }, msg.platform, msg.clientId, msg.pageId, msg.seq, this.opts.log, msg.visible ?? true);
        this.conns.add(conn);
        this.opts.devices.touch(device.id, true);
        for (const cb of this.connectionCbs) {
          try {
            cb(conn);
          } catch (err) {
            this.opts.log.error(`remote access: connection handler failed: ${String(err)}`);
          }
        }
        this.opts.onConnectionsChanged?.();
        return;
      }
      if (msg.t === 'visibility') {
        conn.visible = msg.visible;
        return;
      }
      conn.deliver(msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(ws);
      if (!conn) return;
      this.conns.delete(conn);
      this.opts.devices.touch(conn.device.id, true);
      conn.closed();
      this.opts.onConnectionsChanged?.();
    });
  }

  /** Ping every socket; one that didn't answer the last ping is dropped. */
  private pingAll(): void {
    for (const [ws, live] of this.sockets) {
      if (!live.alive) {
        ws.terminate();
        continue;
      }
      live.alive = false;
      ws.ping();
    }
  }
}
