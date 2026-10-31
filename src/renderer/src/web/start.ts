import { platform } from '../platform';
import { routeFrameClipboard } from './clipboard';
import type { OfflineStore } from './offline-store';
import { Session, type SessionEnv, type SocketLike } from './session';

declare global {
  interface Window {
    /** The top frame's connection; the window iframes reach it through `window.top`. */
    __looperSession?: Session;
  }
}

/** `html[data-stale]` while the screens show what the phone kept, not what the computer says now. */
function markStale(session: Session): () => void {
  const mark = () => {
    if (session.isStale()) document.documentElement.dataset.stale = '';
    else delete document.documentElement.dataset.stale;
  };
  mark();
  return session.onConnection(mark);
}

const setAppBadge = (n: number): void => {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  const done = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.();
  done?.catch(() => undefined);
};

const within = (ms: number, p: Promise<unknown>): Promise<unknown> => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * The service worker serves the shell it installed, and a new one waits to take
 * over (see pwa.ts): get the new build's worker installed, let it take over, then reload.
 */
async function reloadIntoUpdate(): Promise<void> {
  const sw = navigator.serviceWorker;
  const reg = await sw?.getRegistration().catch(() => undefined);
  if (sw && reg) {
    await within(10_000, reg.update().catch(() => undefined));
    const next = reg.installing ?? reg.waiting;
    if (next?.state === 'installing') {
      await within(10_000, new Promise<void>((r) => next.addEventListener('statechange', () => next.state !== 'installing' && r())));
    }
    if (next && next.state !== 'redundant') {
      const taken = new Promise<void>((r) => sw.addEventListener('controllerchange', () => r(), { once: true }));
      next.postMessage({ type: 'looper-update' });
      await within(5000, taken);
    }
  }
  location.reload();
}

/** Opens this tab's connection (top frame only). `restored`: it starts from the windows of the last launch, which the computer hasn't answered yet. */
export function startSession(offline?: OfflineStore, restored = false): Session {
  if (platform === 'electron') throw new Error('The desktop app has no remote session.');
  const env: SessionEnv = {
    wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    // An installed phone app keeps its client id across launches, so the computer finds its windows again.
    storage: platform === 'web' ? sessionStorage : localStorage,
    sessionStorage,
    platform,
    fetch: (input, init) => window.fetch(input, init),
    visible: () => document.visibilityState === 'visible',
    version: __LOOPER_VERSION__,
    reload: () => void reloadIntoUpdate(),
    setBadge: setAppBadge,
    ...(offline ? { offline } : {}),
    restored,
  };
  const session = new Session(env);
  window.__looperSession = session;
  markStale(session);
  session.start();
  document.addEventListener('visibilitychange', () => session.setVisible(document.visibilityState === 'visible'));
  window.addEventListener('online', () => session.check());
  return session;
}

/** A link that would load another site into this window's iframe opens in a new tab, as the desktop opens it in the browser. */
function openLinksOutside(): void {
  const top = window.top as Window;
  window.open = ((url?: string | URL) => {
    if (url) top.open(new URL(String(url), location.href).href, '_blank', 'noopener');
    return null;
  }) as typeof window.open;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target || !/^(https?|mailto):/i.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    top.open(a.href, '_blank', 'noopener');
  });
}

/** Wires this iframe's `window.looper` and window behavior to the tab's connection. Returns once the first render may start. */
export function attachFrame(): { w: string; ready: () => void } {
  const w = new URLSearchParams(location.search).get('w') ?? '';
  const session = (window.top as Window).__looperSession;
  if (!session) throw new Error('This page must be opened inside Looper.');
  window.looper = session.apiFor(w);
  window.close = () => session.pageClosed(w);
  const unmarkStale = markStale(session);
  window.addEventListener('pagehide', () => {
    unmarkStale();
    session.releaseWindow(w);
  });
  routeFrameClipboard();
  openLinksOutside();
  const title = document.querySelector('title');
  if (title) {
    const report = () => session.setTitle(w, document.title);
    new MutationObserver(report).observe(title, { childList: true, characterData: true, subtree: true });
  }
  return { w, ready: () => session.windowReady(w) };
}
