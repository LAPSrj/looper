import { platform } from '../platform';
import { routeFrameClipboard } from './clipboard';
import { Session, type SessionEnv, type SocketLike } from './session';

declare global {
  interface Window {
    /** The top frame's connection; the window iframes reach it through `window.top`. */
    __looperSession?: Session;
  }
}

/** Opens this tab's connection (top frame only). */
export function startSession(): Session {
  if (platform === 'electron') throw new Error('The desktop app has no remote session.');
  const env: SessionEnv = {
    wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    storage: sessionStorage,
    platform,
    fetch: (input, init) => window.fetch(input, init),
    visible: () => document.visibilityState === 'visible',
  };
  const session = new Session(env);
  window.__looperSession = session;
  session.start();
  document.addEventListener('visibilitychange', () => session.setVisible(document.visibilityState === 'visible'));
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
  window.addEventListener('pagehide', () => session.releaseWindow(w));
  routeFrameClipboard();
  openLinksOutside();
  const title = document.querySelector('title');
  if (title) {
    const report = () => session.setTitle(w, document.title);
    new MutationObserver(report).observe(title, { childList: true, characterData: true, subtree: true });
  }
  return { w, ready: () => session.windowReady(w) };
}
