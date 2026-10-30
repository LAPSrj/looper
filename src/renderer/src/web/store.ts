import { useSyncExternalStore } from 'react';
import type { MenuItemSpec, MessageBoxSpec, FileDialogSpec, RemoteWindowSpec } from '../../../shared/remote-access';
import type { Session, ShellMessage } from './session';

export interface WebWindow extends RemoteWindowSpec {
  menu: MenuItemSpec[] | null;
  /** Changes when the iframe must load afresh (reload, a new route, a resumed connection). */
  nonce: number;
}

export interface OpenMenu {
  menuId: string;
  w: string;
  items: MenuItemSpec[];
  x?: number;
  y?: number;
}

export type OpenDialog =
  | { dialogId: string; w: string; kind: 'message'; spec: MessageBoxSpec }
  | { dialogId: string; w: string; kind: 'open' | 'save'; spec: FileDialogSpec };

export interface Toast {
  id: number;
  title: string;
  body: string;
  taskId?: string;
  runId?: string;
}

/** A show-path the user hasn't closed yet: a folder to browse, or a file to open or download. */
export interface PathRequest {
  id: number;
  path: string;
  isDir: boolean;
}

export interface ShellState {
  windows: WebWindow[];
  /** Window ids, back to front. */
  order: string[];
  /** The window the server or the user last focused. */
  focused: string | null;
  menus: OpenMenu[];
  dialogs: OpenDialog[];
  toasts: Toast[];
  paths: PathRequest[];
  connected: boolean;
  /** Connected at least once: a drop is a reconnect, not the first connection. */
  everConnected: boolean;
  /** Ids for toasts and path requests. */
  seq: number;
}

export type ShellAction =
  | ShellMessage
  | { t: 'connected'; connected: boolean }
  | { t: 'menu-done'; menuId: string }
  | { t: 'dialog-done'; dialogId: string }
  | { t: 'toast-done'; id: number }
  | { t: 'path-done'; id: number };

export const initialShellState: ShellState = {
  windows: [],
  order: [],
  focused: null,
  menus: [],
  dialogs: [],
  toasts: [],
  paths: [],
  connected: false,
  everConnected: false,
  seq: 0,
};

/** The iframe address of a window: the same bundle, its route in the hash. */
export const windowSrc = (win: RemoteWindowSpec): string => `/index.html?w=${encodeURIComponent(win.w)}${win.hash ? `#${win.hash}` : ''}`;

const patch = (windows: WebWindow[], w: string, p: Partial<WebWindow>): WebWindow[] => windows.map((x) => (x.w === w ? { ...x, ...p } : x));
const toFront = (order: string[], w: string): string[] => [...order.filter((x) => x !== w), w];

export function reduceShell(s: ShellState, a: ShellAction): ShellState {
  switch (a.t) {
    case 'connected':
      // Popup menus don't survive a reconnect: the server forgot them.
      return { ...s, connected: a.connected, everConnected: s.everConnected || a.connected, menus: a.connected ? s.menus : [] };
    case 'window-open': {
      const { t: _t, ...spec } = a;
      const old = s.windows.find((x) => x.w === a.w);
      const win: WebWindow = { ...spec, menu: old?.menu ?? null, nonce: old?.nonce ?? 0 };
      return { ...s, windows: old ? s.windows.map((x) => (x.w === a.w ? win : x)) : [...s.windows, win], order: toFront(s.order, a.w), focused: a.w };
    }
    case 'window-close':
      return {
        ...s,
        windows: s.windows.filter((x) => x.w !== a.w),
        order: s.order.filter((x) => x !== a.w),
        menus: s.menus.filter((m) => m.w !== a.w),
        dialogs: s.dialogs.filter((d) => d.w !== a.w),
        focused: s.focused === a.w ? null : s.focused,
      };
    case 'window-title':
      return { ...s, windows: patch(s.windows, a.w, { title: a.title }) };
    case 'window-menu':
      return { ...s, windows: patch(s.windows, a.w, { menu: a.menu }) };
    case 'window-focus':
      return s.windows.some((x) => x.w === a.w) ? { ...s, focused: a.w, order: toFront(s.order, a.w) } : s;
    case 'window-load': {
      const win = s.windows.find((x) => x.w === a.w);
      return win ? { ...s, windows: patch(s.windows, a.w, { hash: a.hash, nonce: win.nonce + 1 }) } : s;
    }
    case 'reload': {
      const win = s.windows.find((x) => x.w === a.w);
      return win ? { ...s, windows: patch(s.windows, a.w, { nonce: win.nonce + 1 }) } : s;
    }
    case 'reset':
      return { ...s, windows: [], order: [], focused: null, menus: [], dialogs: [], paths: [] };
    case 'resumed':
      return { ...s, windows: s.windows.map((x) => ({ ...x, nonce: x.nonce + 1 })) };
    case 'menu': {
      const { t: _t, ...menu } = a;
      // One popup at a time, as the server keeps it.
      return { ...s, menus: [menu] };
    }
    case 'menu-done':
      return { ...s, menus: s.menus.filter((m) => m.menuId !== a.menuId) };
    case 'dialog': {
      const { t: _t, ...dialog } = a;
      return { ...s, dialogs: [...s.dialogs.filter((d) => d.dialogId !== a.dialogId), dialog as OpenDialog] };
    }
    case 'dialog-done':
      return { ...s, dialogs: s.dialogs.filter((d) => d.dialogId !== a.dialogId) };
    case 'notify': {
      const id = s.seq + 1;
      const toast: Toast = { id, title: a.title, body: a.body, ...(a.taskId ? { taskId: a.taskId } : {}), ...(a.runId ? { runId: a.runId } : {}) };
      // A few at a time: the oldest go first.
      return { ...s, seq: id, toasts: [...s.toasts, toast].slice(-4) };
    }
    case 'toast-done':
      return { ...s, toasts: s.toasts.filter((x) => x.id !== a.id) };
    case 'show-path': {
      const id = s.seq + 1;
      return { ...s, seq: id, paths: [...s.paths, { id, path: a.path, isDir: a.isDir }] };
    }
    case 'path-done':
      return { ...s, paths: s.paths.filter((p) => p.id !== a.id) };
    default:
      return s;
  }
}

/** The shell's state, kept in step with the session's messages. */
export class ShellStore {
  private state = initialShellState;
  private readonly listeners = new Set<() => void>();

  constructor(readonly session: Session) {
    session.onShell((m) => this.dispatch(m));
    session.onConnection((connected) => this.dispatch({ t: 'connected', connected }));
    if (session.isConnected()) this.dispatch({ t: 'connected', connected: true });
  }

  dispatch(a: ShellAction): void {
    const next = reduceShell(this.state, a);
    if (next === this.state) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  getState = (): ShellState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export function useShellState(store: ShellStore): ShellState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

// ---------- the window stack ----------

/** The main window: the one without a route. */
export const mainWindow = (s: ShellState): WebWindow | undefined => s.windows.find((x) => x.hash === '' && !x.parent);

/** The windows over the main window, back to front; modal ones always above the rest. */
export function childStack(s: ShellState): WebWindow[] {
  const main = mainWindow(s);
  const byId = new Map(s.windows.map((x) => [x.w, x]));
  const ordered = s.order.map((w) => byId.get(w)).filter((x): x is WebWindow => !!x && x !== main);
  // Windows the order doesn't know yet go last (it lists every window it was told about).
  for (const x of s.windows) if (x !== main && !ordered.includes(x)) ordered.push(x);
  return [...ordered.filter((x) => !x.modal), ...ordered.filter((x) => x.modal)];
}

/** The modal window in front, which blocks every window behind it. */
export const topModal = (s: ShellState): WebWindow | undefined => childStack(s).filter((x) => x.modal).pop();

/** The window keyboard input and accelerators go to. */
export function frontWindow(s: ShellState): WebWindow | undefined {
  const modal = topModal(s);
  if (modal) return modal;
  const focused = s.windows.find((x) => x.w === s.focused);
  return focused ?? childStack(s).pop() ?? mainWindow(s);
}

/** Whether the window takes input now: nothing modal is in front of it. */
export function isBlocked(s: ShellState, w: string): boolean {
  const modal = topModal(s);
  return !!modal && modal.w !== w;
}
