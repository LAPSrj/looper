/**
 * Remote Access: Looper's UI in a browser on another device. The contract
 * between the main process (src/main/remote-access, src/main/platform), the
 * provider helpers (src/tsnet) and the web client (src/renderer/src/web).
 *
 * A browser tab is one connection. Each Looper window it shows (the main
 * window, Settings, a task editor…) is a "remote window": the main process
 * treats it like a BrowserWindow, and the tab shows it in an iframe that loads
 * the same renderer route (`index.html#<hash>`) a desktop window would.
 */

import type { UiPlatform } from './ui-platform';

// ---------- providers ----------

/**
 * A source: a way other devices reach the server. Several can be on at once
 * (Remote Access's Sources setting); each is started and stopped on its own.
 */
export type RemoteAccessProviderId = 'tailscale' | 'local';

/** Every source, in the order the windows list them. */
export const REMOTE_ACCESS_SOURCES: readonly RemoteAccessProviderId[] = ['tailscale', 'local'];

/** A source's name in the windows, menus and status bar. */
export const SOURCE_NAMES: Record<RemoteAccessProviderId, string> = { tailscale: 'Tailscale', local: 'Local Browser' };

export type RemoteAccessPhase = 'off' | 'starting' | 'needs-login' | 'running' | 'error';

/** One source's status. */
export interface RemoteAccessSourceStatus {
  id: RemoteAccessProviderId;
  phase: RemoteAccessPhase;
  /** running: the address devices open through this source. */
  url?: string;
  /** needs-login: the page that signs this computer in (Tailscale's). */
  loginUrl?: string;
  /** running (tailscale): the account this computer is signed in as; only it may connect. */
  account?: string;
  /** error: what went wrong, for the user. */
  message?: string;
}

export interface RemoteAccessStatus {
  /**
   * The whole: off; error when the server itself can't start (`message`) or
   * every source failed; running while any source runs; else needs-login
   * while a source waits for a sign-in, else starting.
   */
  phase: RemoteAccessPhase;
  /** While on: each chosen source, in REMOTE_ACCESS_SOURCES order. */
  sources: RemoteAccessSourceStatus[];
  /** error: why the server itself couldn't start. */
  message?: string;
  /** The 127.0.0.1 port the server listens on, while it does. */
  port?: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  /** The source it was paired through; it connects only through that one. */
  provider: RemoteAccessProviderId;
  pairedAt: string;
  lastSeenAt?: string;
  /** Open connections right now. */
  connected: number;
}

/**
 * A pairing code shown on the computer; it works once, until `expiresAt`,
 * through any running source. Its QR code holds `<source url>/pair#<code>`.
 */
export interface PairingCode {
  code: string;
  expiresAt: number;
}

/** A source's status in a few words: its address while it runs. */
export function sourceStatusText(s: RemoteAccessSourceStatus): string {
  switch (s.phase) {
    case 'running':
      return s.url ?? 'On';
    case 'starting':
      return 'Starting…';
    case 'needs-login':
      return 'Waiting for sign-in';
    case 'error':
      return 'Not working';
    default:
      return 'Off';
  }
}

/** The status bar's Remote Access items: one per source ("Tailscale: https://…"), nothing while off. */
export function remoteAccessStatusItems(s: RemoteAccessStatus): string[] {
  if (s.phase === 'off') return [];
  if (!s.sources.length) return [s.phase === 'error' ? 'Remote Access: Not working' : 'Remote Access: Starting…'];
  return s.sources.map((x) => `${SOURCE_NAMES[x.id]}: ${sourceStatusText(x)}`);
}

/** What the desktop windows show: the status, the paired devices, and whom the current code paired. */
export type RemoteAccessState = RemoteAccessStatus & {
  /** The OS computer name: what devices call this computer while the Name setting is empty. */
  defaultName: string;
  devices: PairedDevice[];
  /** The device the last pairing code paired, until a new code replaces it or pairing is canceled. */
  pairedWith?: { code: string; device: { id: string; name: string } };
  /** The current pairing code, once wrong tries have locked it (it takes no more tries): the Pair Device window replaces it. */
  lockedCode?: string;
  /** Set Up's Tailscale sign-in while Remote Access isn't running Tailscale itself (RemoteAccess.beginSignIn). */
  setup?: RemoteAccessSourceStatus;
};

/**
 * The tsnet helper's stdout: one JSON object per line. It exits when its
 * stdin closes. Flags: --dir <state folder> --hostname <name> --target
 * <http://127.0.0.1:port>; env LOOPER_PROXY_SECRET. `looper-tsnet logout
 * --dir <folder>` signs the node out and exits.
 */
export type TsnetMessage =
  | { type: 'status'; state: 'starting' }
  | { type: 'status'; state: 'needs-login'; loginUrl: string }
  | { type: 'status'; state: 'running'; url: string; dnsName: string; login: string }
  | { type: 'status'; state: 'error'; message: string }
  /** `logout` only. */
  | { type: 'status'; state: 'logged-out' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Headers the provider's proxy adds to every request it passes to Looper (and
 * strips from incoming ones). It also sets X-Forwarded-Host (the address the
 * browser used, for the WebSocket Origin check) and X-Forwarded-Proto (https,
 * for the cookie's Secure flag).
 */
export const PROXY_SECRET_HEADER = 'x-looper-proxy-secret';
export const PROXY_LOGIN_HEADER = 'x-looper-login';

// ---------- HTTP ----------

/** Paired devices carry this cookie (HttpOnly, SameSite=Strict, Secure over HTTPS): `<deviceId>.<secret>`.
 * The server accepts it only through the source the device was paired through. */
export const DEVICE_COOKIE = 'looper_device';

/**
 * Every non-GET /api request must carry `REQUEST_HEADER: REQUEST_HEADER_VALUE`: a
 * cross-origin page can't set it without a CORS preflight, which the server
 * never answers, so cookie-bearing posts from other pages (any localhost port,
 * any machine of the tailnet: they are all same-site) are refused with 403. A
 * request whose Sec-Fetch-Site is present must also say same-origin or none.
 */
export const REQUEST_HEADER = 'X-Looper-Request';
export const REQUEST_HEADER_VALUE = '1';

/**
 * Endpoints (all but GET /, the static files and POST /api/pair need the cookie):
 *   GET  /api/me                → MeResponse
 *   POST /api/pair              PairRequest → 200 MeResponse + cookie | 401 wrong or expired code | 429 too many tries
 *   POST /api/unpair            → 204 + the cookie cleared: this device unpairs itself (its push subscriptions go too)
 *   POST /api/rename            RenameRequest → 200 MeResponse | 400 no name: this device renames itself
 *   POST /api/upload?name=<n>   raw bytes → UploadResponse (a file on the computer, for open dialogs and attachments)
 *   GET  /api/download/<token>  a file the computer offered with a `download` message (works once)
 *   GET  /api/push/key          → PushKeyResponse
 *   POST /api/push/subscribe    PushSubscribeRequest → 204 (kept for this device)
 *   POST /api/push/unsubscribe  PushUnsubscribeRequest → 204
 *   GET  /api/ws                WebSocket upgrade; messages below
 *
 * The home-screen app (no cookie needed): GET /manifest.webmanifest, GET /sw.js
 * (the service worker, for installing, push and the app's shell kept for
 * opening offline; it never caches /api/), GET /icons/<name>.png (PWA_ICONS)
 * and GET /startup/<w>x<h>-<light|dark>.png (iOS launch images). Every HTML
 * page gets the mobile head tags (viewport, theme-color, color-scheme, the
 * manifest, touch icon and launch image links) as it's served.
 */
export interface MeResponse {
  paired: boolean;
  device?: { id: string; name: string };
  /** Paired: the computer's name (Remote Access's Name setting, or the OS computer name). */
  computer?: string;
}

export interface RenameRequest {
  name: string;
}

export interface PairRequest {
  code: string;
  /** The device's name in the paired-devices list (the web client guesses it from the browser). */
  name: string;
}

export interface UploadResponse {
  /** Where the file now is on the computer (host path). */
  path: string;
}

// ---------- push notifications ----------

/** The computer's VAPID public key (base64url), for PushManager.subscribe's applicationServerKey. */
export interface PushKeyResponse {
  publicKey: string;
}

/** PushSubscription.toJSON(). */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

/** What a notification click opens on the device: a task's toast target, or a session waiting for the user. */
export type OpenTarget = { kind: 'task'; taskId: string; runId?: string } | { kind: 'session'; id: string };

/** A push message's JSON payload, which the service worker shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** A later notification with the same tag replaces it. */
  tag: string;
  open?: OpenTarget;
}

/** The home-screen icons the server makes from assets/icon.png: /icons/<name>.png. */
export const PWA_ICONS = {
  'icon-192': { size: 192, maskable: false },
  'icon-512': { size: 512, maskable: false },
  'maskable-192': { size: 192, maskable: true },
  'maskable-512': { size: 512, maskable: true },
  /** iOS fills transparency with black: this one has a background. */
  'apple-touch-icon': { size: 180, maskable: true },
} as const;

export type PwaIconName = keyof typeof PWA_ICONS;

/** The query parameter a notification click opens the app with when no window of it is open: JSON OpenTarget. */
export const OPEN_PARAM = 'open';

// ---------- menus and dialogs as data ----------

/** An Electron menu template item as data; clicks stay in the main process, by `id`. */
export interface MenuItemSpec {
  id: string;
  type: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu';
  label?: string;
  /** Where in `label` its access key is (the letter `&` marked): the desktop app's menu bar underlines it and takes Alt+it. */
  access?: number;
  enabled: boolean;
  checked?: boolean;
  /** Electron accelerator ("CmdOrCtrl+N"); the desktop browser shows it and handles it. */
  accelerator?: string;
  /** false: show the accelerator only; the page handles that key itself (a terminal's Ctrl+W, F6). */
  registerAccelerator?: false;
  /** Edit roles the client carries out itself: copy, cut, paste, selectAll, undo, redo, reload. */
  role?: string;
  submenu?: MenuItemSpec[];
  /** The template's own id (Electron's `id`), by which a page's designed More menu names it. */
  key?: string;
  /** An ICONS key (components/icons.tsx) the phone's menus draw before the label. */
  icon?: string;
  /** It destroys or cuts something off (Delete, Stop, Close): a phone draws it red, last. */
  destructive?: true;
  /** Where it shows (unset: everywhere); the server leaves out what the client's platform doesn't show. */
  platforms?: UiPlatform[];
}

/** Electron's MessageBoxOptions, as data. */
export interface MessageBoxSpec {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  /** The button Enter runs and the focus starts on. */
  defaultId: number;
  /** The button Esc and the window's × answer. */
  cancelId: number;
  /** The button a phone draws red: a destructive action the user didn't choose (Don't Save, Replace). */
  destructiveId?: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

export interface FileFilterSpec {
  name: string;
  extensions: string[];
}

/** Electron's OpenDialogOptions / SaveDialogOptions, as data. */
export interface FileDialogSpec {
  title?: string;
  defaultPath?: string;
  filters?: FileFilterSpec[];
  /** open: openFile, openDirectory, multiSelections. */
  properties?: string[];
  buttonLabel?: string;
}

/** A device-chosen file is uploaded first (POST /api/upload) and answered with its computer path. */
export type DialogResult =
  | { kind: 'message'; response: number; checkboxChecked: boolean }
  | { kind: 'open'; canceled: boolean; filePaths: string[] }
  /** deliver: the user chose This Device; the computer writes the file, then sends it as a download named filePath (a bare name). */
  | { kind: 'save'; canceled: boolean; filePath?: string; deliver?: boolean };

// ---------- WebSocket ----------

/**
 * How a window shows on a phone or tablet, declared by the window:
 * prompt = a small question or name field; tool = a compact form or picker;
 * editor = a full editing window; workspace = a window made for most of a desktop;
 * detail = one row of a list looked at closely (a task's run), a sheet over the list.
 */
export type WindowRole = 'prompt' | 'editor' | 'tool' | 'workspace' | 'detail';

export interface RemoteWindowSpec {
  w: string;
  role: WindowRole;
  /** The window it opened over; a modal one blocks it. */
  parent?: string;
  modal: boolean;
  /** The renderer route ('' = the main window). */
  hash: string;
  title: string;
  width: number;
  height: number;
  resizable: boolean;
}

/**
 * A Uint8Array anywhere in invoke/send args, results or event args travels as
 * `{ $bytes: <base64> }`; both sides convert it back.
 */
export interface EncodedBytes {
  $bytes: string;
}

/**
 * An `undefined` in an array (an argument left out, as in `runs.list(id)`)
 * travels as `{ $undefined: true }`, because JSON would turn it into null and
 * a handler's default parameter would then not apply. Electron's IPC keeps
 * undefined, so both sides convert it back.
 */
export interface EncodedUndefined {
  $undefined: true;
}

export type ClientMessage =
  /**
   * First message: the client's platform, for its menus and layout. With the
   * `clientId` of an earlier connection (kept by the tab), the server gives
   * back that client's windows if it still has them; otherwise it answers
   * with a new client and its main window.
   *
   * `pageId` is random per page load (in memory, not storage), which tells a
   * duplicated tab (it copies the clientId) from the same page reconnecting.
   * Same clientId and pageId while the old socket still looks open (a dead
   * one is noticed only by pings, a minute later): the new socket takes the
   * client over and the old one is closed. Same clientId, different pageId,
   * old socket open: a duplicated tab, which gets a client of its own. Old
   * socket gone: resume, whatever the pageId (a reloaded page).
   */
  | { t: 'hello'; platform: 'web' | 'ios' | 'android'; clientId?: string; pageId?: string; visible?: boolean }
  /** The tab became visible or hidden (document.visibilityState): push notifications go only to devices not looking. */
  | { t: 'visibility'; visible: boolean }
  /** The window's page loaded: the server emits ready-to-show / did-finish-load for it. */
  | { t: 'window-ready'; w: string }
  | { t: 'invoke'; id: number; w: string; channel: string; args: unknown[] }
  | { t: 'send'; w: string; channel: string; args: unknown[] }
  | { t: 'menu-pick'; menuId: string; itemId: string; checked?: boolean }
  | { t: 'menu-dismiss'; menuId: string }
  | { t: 'dialog-result'; dialogId: string; result: DialogResult }
  /** The user closed the window; the server may refuse (a 'close' handler prevented it) and keep it open. */
  | { t: 'window-close'; w: string }
  | { t: 'window-focus'; w: string }
  /** The window's page called window.close() or set document.title. */
  | { t: 'window-closed-by-page'; w: string }
  | { t: 'window-title'; w: string; title: string }
  | { t: 'ping' };

/** A pop-up button's box in its window, which its menu opens out of on a phone. */
export interface PopupButton {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ServerMessage =
  /**
   * `resumed`: the windows of `clientId` are still there and follow as
   * window-open messages (parents first), each with its window-menu, then
   * the dialogs still waiting for an answer. Popup menus don't come back.
   */
  | { t: 'welcome'; device: { id: string; name: string }; version: string; clientId: string; resumed: boolean }
  /** shell.openPath / showItemInFolder from this device: a folder opens in the host computer's file browser, an image or text file in the viewer, any other file asks Open on Host Computer or Download. */
  | { t: 'show-path'; path: string; isDir: boolean; siblings?: string[] }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | ({ t: 'window-open' } & RemoteWindowSpec)
  | { t: 'window-close'; w: string }
  | { t: 'window-title'; w: string; title: string }
  | { t: 'window-focus'; w: string }
  /** The window's menu bar; null = none. Its picks and dismissals use menuId = w. */
  | { t: 'window-menu'; w: string; menu: MenuItemSpec[] | null }
  /** The window's page moves to another route (the setup window becoming its builder): load index.html#<hash> afresh; a window-ready follows. */
  | { t: 'window-load'; w: string; hash: string }
  /** webContents.send to that window. */
  | { t: 'event'; w: string; channel: string; args: unknown[] }
  | { t: 'menu'; menuId: string; w: string; items: MenuItemSpec[]; x?: number; y?: number; button?: PopupButton }
  | { t: 'dialog'; dialogId: string; w: string; kind: 'message'; spec: MessageBoxSpec }
  | { t: 'dialog'; dialogId: string; w: string; kind: 'open' | 'save'; spec: FileDialogSpec }
  | { t: 'clipboard'; text: string }
  | { t: 'open-url'; url: string }
  /** A file on the computer for the device to save: GET /api/download/<token>. */
  | { t: 'download'; token: string; name: string }
  /** A desktop notification, shown on the device too; tapping it opens the task's run. */
  | { t: 'notify'; title: string; body: string; taskId?: string; runId?: string }
  /** The computer's name changed (Remote Access's Name setting); a new connection reads it from /api/me. */
  | { t: 'computer'; name: string }
  | { t: 'reload'; w: string }
  | { t: 'pong' };

/**
 * Invoke channels only remote clients use (the host side of their file
 * browser and of show-path), registered with the other IPC handlers.
 */
export const REMOTE_CHANNELS = {
  /** (path?, flavor?, distro?) → HostDirListing; no path = the starting places. */
  listDir: 'remote:listDir',
  /** (path) → void: open it with its default app on the computer. */
  openOnHost: 'remote:openOnHost',
  /** (path) → void: the server answers with a `download` message. */
  download: 'remote:download',
  /** (folder, name, flavor?, distro?) → the new folder's path: New Folder in the file browser. A name with \ or / is refused. */
  makeDir: 'remote:makeDir',
  /** (path, maxBytes) → HostFileView: a file for the device to show (an image or text it opens); a token only when it's no bigger than maxBytes. */
  view: 'remote:view',
  /** (path) → the copy's path: Download to Host Computer, a copy in the host user's Downloads folder. */
  saveOnHost: 'remote:saveOnHost',
  /** (taskId, runId | null) → void: a click on a `notify` toast opens what the desktop's toast opens, on this device. */
  openNotification: 'remote:openNotification',
  /** (sessionId) → void: a click on a "waiting for you" push opens the session in the Sessions window, on this device. */
  openSession: 'remote:openSession',
} as const;

/** What a starting place is, for its icon and its group (Folders, Drives, Linux, Projects). */
export type HostPlace = 'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos' | 'drive' | 'linux' | 'project';

export interface HostDirEntry {
  name: string;
  /** Full path in the requested flavor. */
  path: string;
  dir: boolean;
  size?: number;
  modifiedAt?: number;
  /** Only in the starting places. */
  place?: HostPlace;
}

export interface HostDirListing {
  /** null: the starting places (Host Computer): home and its well-known folders, drives, WSL distros, project folders. */
  path: string | null;
  parent: string | null;
  entries: HostDirEntry[];
  /** The host user's home folder in the requested flavor (the Home button), or null when that side can't reach it. */
  home: string | null;
}

/** REMOTE_CHANNELS.view's answer: GET /api/download/<token> reads the file, when it isn't too big to show. */
export interface HostFileView {
  name: string;
  size: number;
  /** Unset: bigger than the asked maxBytes. */
  token?: string;
}

/** Largest WebSocket message either side sends; bigger files go through /api/upload. */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
