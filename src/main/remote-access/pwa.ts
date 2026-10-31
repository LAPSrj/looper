// The home-screen app: the head tags every served page gets, the manifest and the service worker.
import crypto from 'node:crypto';
import { PWA_ICONS, type PwaIconName } from '../../shared/remote-access';
import { STARTUP_SIZES, startupName } from './startup-bitmap';

/** The bars' color (Material 3 surface from Looper's blue), light and dark. */
export const THEME_LIGHT = '#f8f9ff';
export const THEME_DARK = '#111418';
/** What iOS paints behind the first screen: its grouped background. */
const IOS_GROUPED_LIGHT = '#f2f2f7';
const IOS_GROUPED_DARK = '#000';

const startupLinks = STARTUP_SIZES.flatMap((s) =>
  [false, true].map((dark) => {
    const media = `(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.ratio}) and (orientation: portrait) and (prefers-color-scheme: ${dark ? 'dark' : 'light'})`;
    return `<link rel="apple-touch-startup-image" media="${media}" href="/startup/${startupName(s, dark)}">`;
  }),
);

/** iOS 26+ blurs the page's top edge unless a fixed element over 10 px tall and 90% wide sits 4 px below it (WebKit's fixedContainerEdges); this strip is it, on top of everything and painting nothing. */
const TOP_EDGE = '<div class="ios-top-edge" aria-hidden="true"></div>';
const TOP_EDGE_STYLE =
  '.ios-top-edge{position:fixed;top:0;left:0;right:0;height:12px;z-index:2147483647;pointer-events:none;' +
  `background-color:${IOS_GROUPED_LIGHT};-webkit-background-clip:text;background-clip:text;transition:background-color .3s}`;

const MOBILE_HEAD = [
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="color-scheme" content="light dark">',
  // Before the stylesheet arrives an iPhone shows its own grouped background, not the desktop gray.
  `<style>.ios-top-edge{display:none}@supports (-webkit-touch-callout: none){html{background:${IOS_GROUPED_LIGHT}}${TOP_EDGE_STYLE}` +
    `@media (prefers-color-scheme: dark){html{background:${IOS_GROUPED_DARK}}.ios-top-edge{background-color:${IOS_GROUPED_DARK}}}}</style>`,
  `<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)">`,
  `<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)">`,
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  // No black-translucent: with it the page runs under the status bar, which the top edge's blur then covers.
  '<meta name="apple-mobile-web-app-title" content="Looper">',
  // The tab's icon: without it a desktop browser asks for /favicon.ico, which there isn't, and shows a blank one.
  '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  ...startupLinks,
  '<link rel="manifest" href="/manifest.webmanifest">',
].join('');

/** index.html as a phone gets it: the viewport and home-screen tags go at the top of <head>, the top edge strip at the top of <body>. The file on disk (Electron's) has neither. */
export function withMobileHead(html: string): string {
  if (/<meta\s+name="viewport"/i.test(html)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return html;
  const at = head.index + head[0].length;
  const out = html.slice(0, at) + MOBILE_HEAD + html.slice(at);
  const body = /<body[^>]*>/i.exec(out);
  if (!body) return out;
  const bodyAt = body.index + body[0].length;
  return out.slice(0, bodyAt) + TOP_EDGE + out.slice(bodyAt);
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
    background_color: IOS_GROUPED_LIGHT,
    icons,
  });
}

/** The cache's name changes with the files it holds and the page as served (`page`), so a new build makes a new sw.js. */
export const shellCacheName = (precache: string[], page = ''): string =>
  `looper-shell-${crypto.createHash('sha256').update(JSON.stringify(precache)).update(page).digest('hex').slice(0, 10)}`;

/**
 * The service worker. It keeps the app's shell (index.html, the built assets,
 * the icons and the manifest: `precache`) and serves pages and built assets from
 * it, so the installed app opens at once, with or without the computer, and
 * every window runs the same build. An update comes as a new sw.js (its cache
 * name changes with the build), which installs the new shell whole; the page
 * reloads into it when the computer reports another version. /api/ and sw.js
 * itself are never touched. It also shows push messages (and the app icon's
 * badge they carry) and opens what a tapped one points to.
 */
export function serviceWorker(precache: string[], page = ''): string {
  return `'use strict';
const CACHE = ${JSON.stringify(shellCacheName(precache, page))};
const PRECACHE = ${JSON.stringify(precache)};
// A new build waits until the page reloads into it (its 'looper-update' message): taking over at once would give
// windows opened meanwhile the new page under the running old one. The first install has no page to wait for.
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => {
  if (!self.registration.active) return self.skipWaiting();
})));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'looper-update') self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('looper-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));
const kept = (cache, request) => cache.match(request, { ignoreVary: true });
async function page(request) {
  const cache = await caches.open(CACHE);
  return (await kept(cache, '/index.html')) || fetch(request);
}
async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await kept(cache, request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}
async function revalidate(e) {
  const cache = await caches.open(CACHE);
  const hit = await kept(cache, e.request);
  const fresh = fetch(e.request).then((res) => {
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  });
  e.waitUntil(fresh.catch(() => undefined));
  return hit || fresh;
}
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') e.respondWith(page(request));
  else if (url.pathname.startsWith('/assets/')) e.respondWith(asset(request));
  else if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/startup/') || url.pathname === '/manifest.webmanifest') e.respondWith(revalidate(e));
});
// Safari (iOS above all) must show every push it gets, or it drops the subscription; there the server
// already skips devices that are looking. Elsewhere a tab on screen has shown the toast in the page.
const mustShow = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    if (typeof d.badge === 'number' && self.navigator.setAppBadge) {
      await (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => undefined);
    }
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
}
