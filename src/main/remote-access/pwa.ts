// The home-screen app: the head tags every served page gets, the manifest and the service worker.
import { PWA_ICONS, type PwaIconName } from '../../shared/remote-access';

/** The bars' color (Material 3 surface from Looper's blue), light and dark. */
export const THEME_LIGHT = '#f8f9ff';
export const THEME_DARK = '#111418';

const MOBILE_HEAD = [
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)">`,
  `<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)">`,
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  // No black-translucent: under it, iOS 26+ blurs the top ~110 px of a Home Screen app, the bar's title and buttons included.
  '<meta name="apple-mobile-web-app-title" content="Looper">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  '<link rel="manifest" href="/manifest.webmanifest">',
].join('');

/** index.html as a phone gets it: the viewport and home-screen tags go at the top of <head>. The file on disk (Electron's) has none. */
export function withMobileHead(html: string): string {
  if (/<meta\s+name="viewport"/i.test(html)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + MOBILE_HEAD + html.slice(at);
}

export function manifest(): string {
  const icons = (Object.entries(PWA_ICONS) as [PwaIconName, (typeof PWA_ICONS)[PwaIconName]][])
    .filter(([name]) => name !== 'apple-touch-icon')
    .map(([name, i]) => ({ src: `/icons/${name}.png`, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: i.maskable ? 'maskable' : 'any' }));
  return JSON.stringify({
    name: 'Looper',
    short_name: 'Looper',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: THEME_LIGHT,
    background_color: THEME_LIGHT,
    icons,
  });
}

/**
 * The service worker. It has no fetch handler, so every request (the app, and
 * /api/ above all) goes to the network as if it weren't there: nothing is
 * cached, and an update shows on the next load. It shows push messages and
 * opens what a tapped one points to.
 */
export const SERVICE_WORKER = `'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Safari (iOS above all) must show every push it gets, or it drops the subscription; there the server
// already skips devices that are looking. Elsewhere a tab on screen has shown the toast in the page.
const mustShow = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    if (!mustShow) {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (tabs.some((c) => c.frameType !== 'nested' && c.visibilityState === 'visible')) return;
    }
    await self.registration.showNotification(d.title || 'Looper', {
      body: d.body || '',
      tag: d.tag || undefined,
      data: { open: d.open || null },
      icon: '/icons/icon-192.png',
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = (e.notification.data && e.notification.data.open) || null;
  e.waitUntil((async () => {
    // The windows' iframes are clients too; only a tab's top frame can take the message.
    const tabs = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => c.frameType !== 'nested');
    const tab = tabs.find((c) => c.focused) || tabs[0];
    if (tab) {
      await tab.focus();
      if (open) tab.postMessage({ type: 'looper-open', open });
      return;
    }
    await self.clients.openWindow(open ? '/?open=' + encodeURIComponent(JSON.stringify(open)) : '/');
  })());
});
`;
