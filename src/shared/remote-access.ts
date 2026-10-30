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

// ---------- providers ----------

export type RemoteAccessProviderId = 'tailscale' | 'local';

export type RemoteAccessPhase = 'off' | 'starting' | 'needs-login' | 'running' | 'error';

export interface RemoteAccessStatus {
  phase: RemoteAccessPhase;
  provider: RemoteAccessProviderId;
  /** running: the address other devices open. */
  url?: string;
  /** needs-login: the page that signs this computer in (Tailscale's). */
  loginUrl?: string;
  /** running (tailscale): the account this computer is signed in as; only it may connect. */
  account?: string;
  /** error: what went wrong, for the user. */
  message?: string;
  /** The 127.0.0.1 port the server listens on, while it does. */
  port?: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  /** The provider it was paired under; it connects only while that one is on. */
  provider: RemoteAccessProviderId;
  pairedAt: string;
  lastSeenAt?: string;
  /** Open connections right now. */
  connected: number;
}

/** A pairing code shown on the computer; it works once, until `expiresAt`. */
export interface PairingCode {
  code: string;
  /** What the QR code holds: the address with the code (`<url>/pair#<code>`). */
  link: string;
  expiresAt: number;
}

/** What the desktop windows show: the status, the paired devices, and whom the current code paired. */
export type RemoteAccessState = RemoteAccessStatus & {
  devices: PairedDevice[];
  /** The device the last pairing code paired, until a new code replaces it or pairing is canceled. */
  pairedWith?: { code: string; device: { id: string; name: string } };
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
 * The server accepts it only while the provider the device was paired under is active. */
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
 *   POST /api/upload?name=<n>   raw bytes → UploadResponse (a file on the computer, for open dialogs and attachments)
 *   GET  /api/download/<token>  a file the computer offered with a `download` message (works once)
 *   GET  /api/push/key          → PushKeyResponse
 *   POST /api/push/subscribe    PushSubscribeRequest → 204 (kept for this device)
 *   POST /api/push/unsubscribe  PushUnsubscribeRequest → 204
 *   GET  /api/ws                WebSocket upgrade; messages below
 *
 * The home-screen app (no cookie needed): GET /manifest.webmanifest, GET /sw.js
 * (the service worker, for installing and push; it caches nothing), and GET
 * /icons/<name>.png (PWA_ICONS). Every HTML page gets the mobile head tags
 * (viewport, theme-color, the manifest and touch icon links) as it's served.
 */
export interface MeResponse {
  paired: boolean;
  device?: { id: string; name: string };
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
  enabled: boolean;
  checked?: boolean;
  /** Electron accelerator ("CmdOrCtrl+N"); the desktop browser shows it and handles it. */
  accelerator?: string;
  /** false: show the accelerator only; the page handles that key itself (a terminal's Ctrl+W, F6). */
  registerAccelerator?: false;
  /** Edit roles the client carries out itself: copy, cut, paste, selectAll, undo, redo, reload. */
  role?: string;
  submenu?: MenuItemSpec[];
}

/** Electron's MessageBoxOptions, as data. */
export interface MessageBoxSpec {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
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

export interface RemoteWindowSpec {
  w: string;
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

export type ServerMessage =
  /**
   * `resumed`: the windows of `clientId` are still there and follow as
   * window-open messages (parents first), each with its window-menu, then
   * the dialogs still waiting for an answer. Popup menus don't come back.
   */
  | { t: 'welcome'; device: { id: string; name: string }; version: string; clientId: string; resumed: boolean }
  /** shell.openPath / showItemInFolder from this device: a folder opens in the computer's file browser, a file asks Open on Computer or Download. */
  | { t: 'show-path'; path: string; isDir: boolean }
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
  | { t: 'menu'; menuId: string; w: string; items: MenuItemSpec[]; x?: number; y?: number }
  | { t: 'dialog'; dialogId: string; w: string; kind: 'message'; spec: MessageBoxSpec }
  | { t: 'dialog'; dialogId: string; w: string; kind: 'open' | 'save'; spec: FileDialogSpec }
  | { t: 'clipboard'; text: string }
  | { t: 'open-url'; url: string }
  /** A file on the computer for the device to save: GET /api/download/<token>. */
  | { t: 'download'; token: string; name: string }
  /** A desktop notification, shown on the device too; tapping it opens the task's run. */
  | { t: 'notify'; title: string; body: string; taskId?: string; runId?: string }
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
  /** (taskId, runId | null) → void: a click on a `notify` toast opens what the desktop's toast opens, on this device. */
  openNotification: 'remote:openNotification',
  /** (sessionId) → void: a click on a "waiting for you" push opens the session in the Sessions window, on this device. */
  openSession: 'remote:openSession',
} as const;

export interface HostDirEntry {
  name: string;
  /** Full path in the requested flavor. */
  path: string;
  dir: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface HostDirListing {
  /** null: the starting places (drives, home, project folders, recent folders). */
  path: string | null;
  parent: string | null;
  entries: HostDirEntry[];
}

/** Largest WebSocket message either side sends; bigger files go through /api/upload. */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
