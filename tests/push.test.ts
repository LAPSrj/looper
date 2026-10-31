import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from '../src/engine/log';
import { RemoteAccess } from '../src/main/remote-access';
import { LocalProvider } from '../src/main/remote-access/providers';
import { parseSubscription, PushSender, PushStore, WaitWatcher, type PushSend } from '../src/main/remote-access/push';
import { manifest, serviceWorker, shellCacheName, withMobileHead } from '../src/main/remote-access/pwa';
import { REQUEST_HEADER, REQUEST_HEADER_VALUE, type PushPayload, PushSubscribeRequest, ServerMessage } from '../src/shared/remote-access';
import type { SessionSummary } from '../src/shared/sessions';
import { RemoteAccessSettingsSchema } from '../src/shared/types';

const tmpDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-push-'));
  tmpDirs.push(d);
  return d;
}
const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, log: () => undefined } as unknown as Logger;

const sub = (n: number): PushSubscribeRequest => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: `BKey${n}`, auth: `auth${n}` } });
const keys = () => ({ publicKey: 'PUBLIC', privateKey: 'PRIVATE' });

describe('push subscriptions', () => {
  it('are kept per device in push.json, with the VAPID keys made once', () => {
    const file = path.join(tmp(), 'push.json');
    let made = 0;
    const store = new PushStore(file, () => 0, () => (made++, keys()));
    expect(store.vapid().publicKey).toBe('PUBLIC');
    store.vapid();
    expect(made).toBe(1);
    store.subscribe('phone', sub(1));
    store.subscribe('phone', sub(2));
    store.subscribe('laptop', sub(3));
    const again = new PushStore(file, () => 0, () => (made++, keys()));
    expect(made).toBe(1);
    expect(again.forDevices(['phone']).map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(again.removeDevice('phone')).toBe(2);
    expect(new PushStore(file, () => 0).list().map((s) => s.deviceId)).toEqual(['laptop']);
  });

  it("a device can drop only its own; an endpoint that comes back moves to the device that sent it", () => {
    const store = new PushStore(path.join(tmp(), 'push.json'), () => 0, keys);
    store.vapid();
    store.subscribe('a', sub(1));
    expect(store.unsubscribe('b', sub(1).endpoint)).toBe(false);
    store.subscribe('b', sub(1));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].deviceId).toBe('b');
    expect(store.unsubscribe('b', sub(1).endpoint)).toBe(true);
  });

  it('only HTTPS push services with well-formed keys are taken', () => {
    expect(parseSubscription(sub(1))).toEqual(sub(1));
    expect(parseSubscription({ ...sub(1), endpoint: 'http://192.168.1.1/admin' })).toBeNull();
    expect(parseSubscription({ ...sub(1), endpoint: 'not a url' })).toBeNull();
    expect(parseSubscription({ endpoint: sub(1).endpoint, keys: { p256dh: 'a b', auth: 'x' } })).toBeNull();
    expect(parseSubscription({ endpoint: sub(1).endpoint })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });

  it('drops the subscriptions the push service answers 404 or 410 for, and keeps the rest', async () => {
    const store = new PushStore(path.join(tmp(), 'push.json'), () => 0, keys);
    for (const n of [1, 2, 3, 4]) store.subscribe('phone', sub(n));
    const sent: string[] = [];
    const send: PushSend = async (s, body, o) => {
      expect(o.vapid.publicKey).toBe('PUBLIC');
      expect(o.subject).toBe('mailto:test@example.com');
      const status = { [sub(2).endpoint]: 404, [sub(3).endpoint]: 410, [sub(4).endpoint]: 500 }[s.endpoint];
      if (status) throw Object.assign(new Error('refused'), { statusCode: status });
      sent.push(body);
    };
    const pusher = new PushSender(store, send, quietLog, () => 'mailto:test@example.com');
    const payload: PushPayload = { title: 'T', body: 'B', tag: 't' };
    expect(await pusher.push(['phone'], payload, { urgency: 'normal', ttlSeconds: 60 })).toEqual({ sent: 1, dropped: 2 });
    expect(JSON.parse(sent[0])).toEqual(payload);
    expect(store.list().map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(4).endpoint]);
  });
});

const session = (id: string, waiting?: SessionSummary['waiting']): SessionSummary => ({
  id,
  kind: 'chat',
  taskId: 't',
  groupName: 'Project',
  title: 'Fix the build',
  harnessKind: 'claude-code',
  harnessName: 'Claude Code',
  status: 'ready',
  ...(waiting ? { waiting } : {}),
  startedAt: 0,
  background: 0,
});

describe('waiting sessions', () => {
  it('push once when a session starts to wait on a question or a finished turn', () => {
    const w = new WaitWatcher();
    expect(w.next([session('a', { reason: 'turn', text: 'Finished its turn', since: 1 })])).toEqual([]);
    expect(w.next([session('a', { reason: 'turn', text: 'Finished its turn', since: 1 })])).toEqual([]);
    const asked = session('a', { reason: 'permission', text: 'Bash: npm test', since: 5 });
    expect(w.next([asked])).toEqual([asked]);
    expect(w.next([asked])).toEqual([]);
    expect(w.next([session('a')])).toEqual([]);
    const done = session('a', { reason: 'turn', text: 'Finished its turn', since: 9 });
    expect(w.next([done])).toEqual([done]);
    expect(w.next([session('b', { reason: 'error', text: 'The session ended.', since: 10 })])).toEqual([]);
  });
});

describe('home-screen app', () => {
  it('index.html gets the viewport and home-screen tags once, at the top of its head', () => {
    const html = '<!doctype html><html><head><meta charset="UTF-8" /><title>Looper</title></head><body></body></html>';
    const out = withMobileHead(html);
    expect(out).toContain('<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    for (const tag of [
      'name="theme-color"',
      'apple-mobile-web-app-capable',
      'rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png"',
      'rel="apple-touch-icon" href="/icons/apple-touch-icon.png"',
      'rel="manifest" href="/manifest.webmanifest"',
    ]) {
      expect(out).toContain(tag);
    }
    expect(withMobileHead(out)).toBe(out);
  });

  it('the page starts with the iOS top edge strip, sized for WebKit to find and hidden elsewhere', () => {
    const out = withMobileHead('<!doctype html><html><head></head><body class="x"><div id="root"></div></body></html>');
    expect(out).toContain('<body class="x"><div class="ios-top-edge" aria-hidden="true"></div><div id="root">');
    expect(out.match(/class="ios-top-edge"/g)).toHaveLength(1);
    const ios = /@supports \(-webkit-touch-callout: none\)\{(.*)<\/style>/.exec(out)?.[1] ?? '';
    expect(ios).toMatch(/\.ios-top-edge\{position:fixed;top:0;left:0;right:0;height:12px;z-index:2147483647;pointer-events:none;/);
    expect(ios).toMatch(/background-clip:text/);
    expect(out).toMatch(/<style>\.ios-top-edge\{display:none\}@supports/);
  });

  it('the manifest installs Looper standalone with its icons', () => {
    const m = JSON.parse(manifest()) as { name: string; display: string; start_url: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; purpose: string }[] };
    expect(m).toMatchObject({ name: 'Looper', display: 'standalone', start_url: '/' });
    expect(m.theme_color).toMatch(/^#/);
    expect(m.background_color).toMatch(/^#/);
    expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(['192x192 any', '192x192 maskable', '512x512 any', '512x512 maskable']);
  });

  it('the service worker keeps the files it is given, and still handles push and notification clicks', () => {
    const list = ['/index.html', '/manifest.webmanifest', '/assets/index-abc.js'];
    const sw = serviceWorker(list);
    expect(sw).toContain(`const PRECACHE = ${JSON.stringify(list)};`);
    expect(sw).toMatch(/addEventListener\('fetch'/);
    expect(sw).toMatch(/addEventListener\('push'/);
    expect(sw).toMatch(/addEventListener\('notificationclick'/);
    // It parses, and a tab on screen means no system notification (except on Safari, which must show each one).
    expect(() => new Function(sw)).not.toThrow();
    expect(sw).toMatch(/visibilityState === 'visible'/);
    // A different list (a new build) is a different cache, so a different sw.js.
    expect(shellCacheName(list)).toMatch(/^looper-shell-[0-9a-f]{10}$/);
    expect(shellCacheName(list)).not.toBe(shellCacheName([...list, '/assets/index-def.css']));
    // So is a change to the page as served (its head tags), with the same assets.
    expect(shellCacheName(list, '<head>a</head>')).not.toBe(shellCacheName(list, '<head>b</head>'));
    expect(serviceWorker(list)).toBe(sw);
  });
});

// ---------- over HTTP ----------

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function request(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: { Host: `localhost:${port}`, [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

async function setup() {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  const staticDir = path.join(root, 'static');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-abc.js'), 'js');
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-def.css'), 'css');
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><html><head><title>Looper</title></head><body></body></html>');
  const settings = RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'] });
  const pushes: { endpoint: string; body: PushPayload }[] = [];
  const ra = new RemoteAccess({
    dataDir,
    log: quietLog,
    settings: () => settings,
    emit: () => undefined,
    version: '9.9.9',
    staticDir,
    createProvider: () => new LocalProvider(),
    icon: (name) => (name === 'icon-192' ? Buffer.from('PNG') : null),
    startup: (width, height, dark) => (width === 1170 && height === 2532 ? Buffer.from(dark ? 'DARK' : 'LIGHT') : null),
    pushSend: async (s, body) => void pushes.push({ endpoint: s.endpoint, body: JSON.parse(body) as PushPayload }),
  });
  cleanups.push(() => ra.dispose());
  await ra.apply(settings);
  const port = ra.state().port!;
  const pair = async (name: string) => {
    const { code } = ra.newPairingCode();
    const res = await request(port, { method: 'POST', path: '/api/pair', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    return { cookie: String(res.headers['set-cookie']).split(';')[0], id: (JSON.parse(res.body) as { device: { id: string } }).device.id };
  };
  return { ra, port, dataDir, pushes, pair };
}

function connect(port: number, cookie: string, visible: boolean): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, Cookie: cookie } });
    ws.once('open', () => {
      ws.once('message', (d) => {
        expect((JSON.parse(String(d)) as ServerMessage).t).toBe('welcome');
        resolve(ws);
      });
      ws.send(JSON.stringify({ t: 'hello', platform: 'ios', visible }));
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('push endpoints', () => {
  it('need a paired device; subscribe and unsubscribe keep push.json in step', async () => {
    const s = await setup();
    expect((await request(s.port, { path: '/api/push/key' })).status).toBe(401);
    const { cookie } = await s.pair('Phone');
    const key = await request(s.port, { path: '/api/push/key', headers: { Cookie: cookie } });
    expect(key.status).toBe(200);
    expect(key.headers['cache-control']).toBe('no-store');
    expect((JSON.parse(key.body) as { publicKey: string }).publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const bad = await request(s.port, { method: 'POST', path: '/api/push/subscribe', headers: { Cookie: cookie }, body: JSON.stringify({ ...sub(1), endpoint: 'http://x/' }) });
    expect(bad.status).toBe(400);
    const ok = await request(s.port, { method: 'POST', path: '/api/push/subscribe', headers: { Cookie: cookie }, body: JSON.stringify(sub(1)) });
    expect(ok.status).toBe(204);
    const file = path.join(s.dataDir, 'remote-access', 'push.json');
    expect(fs.readFileSync(file, 'utf8')).toContain(sub(1).endpoint);
    const off = await request(s.port, { method: 'POST', path: '/api/push/unsubscribe', headers: { Cookie: cookie }, body: JSON.stringify({ endpoint: sub(1).endpoint }) });
    expect(off.status).toBe(204);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(sub(1).endpoint);
  });

  it('pushes a toast only to devices without a visible tab, and follows visibility changes', async () => {
    const s = await setup();
    const phone = await s.pair('Phone');
    const laptop = await s.pair('Laptop');
    for (const [d, n] of [
      [phone, 1],
      [laptop, 2],
    ] as const) {
      await request(s.port, { method: 'POST', path: '/api/push/subscribe', headers: { Cookie: d.cookie }, body: JSON.stringify(sub(n)) });
    }
    const ws = await connect(s.port, phone.cookie, true);
    cleanups.push(() => ws.close());
    await s.ra.pushToast({ title: 'Nightly', body: 'Succeeded', taskId: 't1', runId: 'r1' });
    expect(s.pushes).toEqual([{ endpoint: sub(2).endpoint, body: { title: 'Nightly', body: 'Succeeded', tag: 'task:t1:r1', open: { kind: 'task', taskId: 't1', runId: 'r1' } } }]);
    ws.send(JSON.stringify({ t: 'visibility', visible: false }));
    await settle();
    s.pushes.length = 0;
    await s.ra.pushToast({ title: 'Nightly', body: 'Failed' });
    expect(s.pushes.map((p) => p.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
  });

  it('pushes a newly waiting session, unless notifications are off', async () => {
    const s = await setup();
    const phone = await s.pair('Phone');
    await request(s.port, { method: 'POST', path: '/api/push/subscribe', headers: { Cookie: phone.cookie }, body: JSON.stringify(sub(1)) });
    await s.ra.sessionsChanged([session('a')], true);
    await s.ra.sessionsChanged([session('a', { reason: 'permission', text: 'Bash: rm -rf out', since: 2 })], false);
    expect(s.pushes).toEqual([]);
    await s.ra.sessionsChanged([session('a', { reason: 'turn', text: 'Finished its turn', since: 3 })], true);
    expect(s.pushes).toEqual([{ endpoint: sub(1).endpoint, body: { title: 'Project: Fix the build', body: 'Finished its turn', tag: 'session:a', open: { kind: 'session', id: 'a' }, badge: 1 } }]);
  });

  it('a device that unpairs itself loses its cookie and its subscriptions', async () => {
    const s = await setup();
    const phone = await s.pair('Phone');
    await request(s.port, { method: 'POST', path: '/api/push/subscribe', headers: { Cookie: phone.cookie }, body: JSON.stringify(sub(1)) });
    const res = await request(s.port, { method: 'POST', path: '/api/unpair', headers: { Cookie: phone.cookie } });
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(s.ra.state().devices).toEqual([]);
    expect(fs.readFileSync(path.join(s.dataDir, 'remote-access', 'push.json'), 'utf8')).not.toContain(sub(1).endpoint);
    expect((await request(s.port, { path: '/api/me', headers: { Cookie: phone.cookie } })).body).toContain('"paired":false');
  });

  it('serves the manifest, the service worker and the icons fresh, and pages with the mobile head', async () => {
    const s = await setup();
    const m = await request(s.port, { path: '/manifest.webmanifest' });
    expect(m.status).toBe(200);
    expect(m.headers['content-type']).toMatch(/^application\/manifest\+json/);
    const sw = await request(s.port, { path: '/sw.js' });
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toMatch(/^text\/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    // The service worker keeps the page, the manifest, the icons that exist and every built asset.
    expect(sw.body).toContain('const PRECACHE = ["/index.html","/manifest.webmanifest","/icons/icon-192.png","/assets/index-abc.js","/assets/index-def.css"];');
    expect((await request(s.port, { path: '/icons/icon-192.png' })).body).toBe('PNG');
    const launch = await request(s.port, { path: '/startup/1170x2532-dark.png' });
    expect([launch.status, launch.body, launch.headers['cache-control']]).toEqual([200, 'DARK', 'public, max-age=86400']);
    expect((await request(s.port, { path: '/startup/1170x2532-light.png' })).body).toBe('LIGHT');
    expect((await request(s.port, { path: '/startup/100x100-light.png' })).status).toBe(404);
    expect((await request(s.port, { path: '/icons/maskable-512.png' })).status).toBe(404);
    expect((await request(s.port, { path: '/icons/nope.png' })).status).toBe(404);
    const page = await request(s.port, { path: '/' });
    expect(page.body).toContain('viewport-fit=cover');
    expect(page.body).toContain('/manifest.webmanifest');
  });
});
