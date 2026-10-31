import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from '../src/engine/log';
import { readJson } from '../src/engine/store/fsutil';
import { DeviceStore, normalizeCode, Pairing, PAIRING_ALPHABET, PAIRING_TTL_MS } from '../src/main/remote-access/devices';
import { RemoteAccess, type AccessProvider, type ProviderStartOptions, type ProviderStatus } from '../src/main/remote-access';
import { LocalProvider, parseTsnetLine, TailscaleProvider } from '../src/main/remote-access/providers';
import { contentDisposition, sanitizeFileName } from '../src/main/remote-access/server';
import { IpcTable } from '../src/main/platform/ipc-table';
import {
  PROXY_LOGIN_HEADER,
  PROXY_SECRET_HEADER,
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
  remoteAccessStatusItems,
  type MeResponse,
  type RemoteAccessProviderId,
  type RemoteAccessState,
  type ServerMessage,
} from '../src/shared/remote-access';
import { RemoteAccessSettingsSchema, SettingsSchema, type RemoteAccessSettings } from '../src/shared/types';

const TS_HOST = 'looper.example.ts.net';
const TS_ACCOUNT = 'me@example.com';

const tmpDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-ra-'));
  tmpDirs.push(d);
  return d;
}

/** A Logger that keeps its lines. */
function memLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = (level: string, m: string) => lines.push(`[${level}] ${m}`);
  return {
    lines,
    log,
    debug: (m: string) => log('debug', m),
    info: (m: string) => log('info', m),
    warn: (m: string) => log('warn', m),
    error: (m: string) => log('error', m),
  } as unknown as Logger & { lines: string[] };
}

/** Stands in for the Tailscale helper: it reports running (or what the test emits). */
class FakeTailscale implements AccessProvider {
  readonly id = 'tailscale' as const;
  started: ProviderStartOptions | null = null;
  private cbs = new Set<(s: ProviderStatus) => void>();
  constructor(private readonly autoRun = true) {}
  start(opts: ProviderStartOptions): void {
    this.started = opts;
    this.emit({ phase: 'starting' });
    if (this.autoRun) this.emit({ phase: 'running', url: `https://${TS_HOST}`, account: TS_ACCOUNT });
  }
  async stop(): Promise<void> {
    this.emit({ phase: 'off' });
  }
  onStatus(cb: (s: ProviderStatus) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(s: ProviderStatus): void {
    for (const cb of this.cbs) cb(s);
  }
}

interface Setup {
  ra: RemoteAccess;
  port: number;
  dataDir: string;
  staticDir: string;
  log: ReturnType<typeof memLog>;
  clock: { t: number };
  fake: FakeTailscale;
  states: RemoteAccessState[];
  /** The settings RemoteAccess reads; tests may change them. */
  settings: RemoteAccessSettings;
}

async function setup(
  provider: RemoteAccessProviderId,
  opts: {
    autoRun?: boolean;
    beforeStart?: (dataDir: string) => void;
    ipc?: IpcTable;
    /** Every source to turn on (default: just `provider`). */
    sources?: RemoteAccessProviderId[];
    /** Another run on the same data: a restart. */
    root?: string;
    port?: number;
    savePort?: (port: number) => void;
  } = {},
): Promise<Setup> {
  const root = opts.root ?? tmp();
  const dataDir = path.join(root, 'data');
  const staticDir = path.join(root, 'static');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Looper</title>');
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  opts.beforeStart?.(dataDir);
  const log = memLog();
  const clock = { t: Date.parse('2026-10-29T12:00:00Z') };
  const fake = new FakeTailscale(opts.autoRun ?? true);
  const settings = RemoteAccessSettingsSchema.parse({ enabled: true, sources: opts.sources ?? [provider], port: opts.port ?? 0 });
  const states: RemoteAccessState[] = [];
  const ra = new RemoteAccess({
    dataDir,
    log,
    settings: () => settings,
    emit: (s) => states.push(s),
    version: '9.9.9',
    now: () => clock.t,
    staticDir,
    createProvider: (id) => (id === 'tailscale' ? fake : new LocalProvider()),
    ...(opts.ipc ? { ipc: opts.ipc } : {}),
    ...(opts.savePort ? { savePort: opts.savePort } : {}),
  });
  cleanups.push(() => ra.dispose());
  await ra.apply(settings);
  const port = ra.state().port!;
  expect(port).toBeGreaterThan(0);
  return { ra, port, dataDir, staticDir, log, clock, fake, states, settings };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Res> {
  return new Promise((resolve, reject) => {
    // No shared keep-alive agent: a test that restarts the server on the same port would reuse a dead socket.
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** The headers a local-mode browser sends. */
const localHeaders = (port: number, extra: Record<string, string> = {}) => ({ Host: `localhost:${port}`, [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...extra });

/** The headers the Tailscale helper's proxy adds. */
const tsHeaders = (s: Setup, extra: Record<string, string> = {}) => ({
  [PROXY_SECRET_HEADER]: s.fake!.started!.secret,
  [PROXY_LOGIN_HEADER]: TS_ACCOUNT,
  'X-Forwarded-Host': TS_HOST,
  'X-Forwarded-Proto': 'https',
  [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
  ...extra,
});

async function pair(s: Setup, headers: Record<string, string>, name = 'Phone'): Promise<{ cookie: string; res: Res }> {
  const { code } = s.ra.newPairingCode();
  const res = await request(s.port, {
    method: 'POST',
    path: '/api/pair',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  expect(res.status).toBe(200);
  const set = String(res.headers['set-cookie']);
  return { cookie: set.split(';')[0], res };
}

function openWs(port: number, headers: Record<string, string>): Promise<{ ws: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ws, status: res.statusCode });
      res.resume();
    });
    ws.once('error', () => resolve({ ws, status: -1 }));
  });
}

const nextMessage = (ws: WebSocket) =>
  new Promise<ServerMessage>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)) as ServerMessage)));

const waitFor = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('pairing code', () => {
  it('is 8 characters from the alphabet, and a new one replaces the old', () => {
    const p = new Pairing(() => 0);
    const a = p.newCode();
    expect(a.code).toMatch(new RegExp(`^[${PAIRING_ALPHABET}]{8}$`));
    const b = p.newCode();
    if (a.code !== b.code) expect(p.check(a.code)).toBe('wrong');
    expect(p.check(b.code)).toBe('ok');
  });

  it('expires after 5 minutes', () => {
    let t = 1000;
    const p = new Pairing(() => t);
    const { code, expiresAt } = p.newCode();
    expect(expiresAt).toBe(1000 + PAIRING_TTL_MS);
    t = expiresAt;
    expect(p.check(code)).toBe('none');
  });

  it('works once', () => {
    const p = new Pairing(() => 0);
    const { code } = p.newCode();
    expect(p.check(code)).toBe('ok');
    expect(p.check(code)).toBe('none');
  });

  it('locks after 5 wrong tries in total, even for the right code', () => {
    const p = new Pairing(() => 0);
    const { code } = p.newCode();
    for (let i = 0; i < 5; i++) expect(p.check('WRONGONE')).toBe('wrong');
    expect(p.check(code)).toBe('locked');
    expect(p.active()).toBeNull();
  });

  it('tells when a wrong try locks the code, and a new code lifts the lock', () => {
    let locks = 0;
    const p = new Pairing(() => 0, () => locks++);
    const { code } = p.newCode();
    for (let i = 0; i < 4; i++) p.check('WRONGONE');
    expect(p.lockedCode()).toBeNull();
    expect(locks).toBe(0);
    p.check('WRONGONE');
    expect(p.lockedCode()).toBe(code);
    expect(locks).toBe(1);
    expect(p.check(code)).toBe('locked');
    expect(locks).toBe(1);
    p.newCode();
    expect(p.lockedCode()).toBeNull();
  });

  it('ignores case, spaces and dashes', () => {
    expect(normalizeCode(' ab cd-ef gh ')).toBe('ABCDEFGH');
    const p = new Pairing(() => 0);
    const { code } = p.newCode();
    expect(p.check(`${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`)).toBe('ok');
  });

  it('over HTTP: 401 wrong, 429 once locked, and pairedWith names the device', async () => {
    const s = await setup('local');
    const h = localHeaders(s.port, { 'Content-Type': 'application/json' });
    const { code } = s.ra.newPairingCode();
    for (let i = 0; i < 5; i++) {
      expect(s.ra.state().lockedCode).toBeUndefined();
      const r = await request(s.port, { method: 'POST', path: '/api/pair', headers: h, body: JSON.stringify({ code: 'ZZZZZZZZ', name: 'x' }) });
      expect(r.status).toBe(401);
    }
    // The state (and its event, for the Pair Device window) names the locked code.
    expect(s.ra.state().lockedCode).toBe(code);
    expect(s.states.at(-1)?.lockedCode).toBe(code);
    const locked = await request(s.port, { method: 'POST', path: '/api/pair', headers: h, body: JSON.stringify({ code, name: 'x' }) });
    expect(locked.status).toBe(429);
    // A new code lifts it, and the state says so.
    const next = s.ra.newPairingCode();
    expect(s.ra.state().lockedCode).toBeUndefined();
    expect(s.states.at(-1)?.lockedCode).toBeUndefined();
    expect(next.code).not.toBe(code);

    const { res } = await pair(s, localHeaders(s.port), 'My Phone');
    expect(JSON.parse(String(res.body))).toMatchObject({ paired: true, device: { name: 'My Phone' } });
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=31536000/);
    expect(set).not.toMatch(/Secure/);
    const st = s.ra.state();
    expect(st.devices.map((d) => d.name)).toEqual(['My Phone']);
    expect(st.pairedWith?.device.name).toBe('My Phone');
    expect(s.log.lines.some((l) => l.includes('paired My Phone'))).toBe(true);
  });

  it('caps the /api/pair body at 4 KB', async () => {
    const s = await setup('local');
    s.ra.newPairingCode();
    const r = await request(s.port, { method: 'POST', path: '/api/pair', headers: localHeaders(s.port), body: 'x'.repeat(5000) });
    expect(r.status).toBe(413);
  });

  it("can't be made while Remote Access is off", async () => {
    const s = await setup('local');
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: false }));
    expect(() => s.ra.newPairingCode()).toThrow(/isn't on/);
  });
});

describe('device cookie', () => {
  it('verifies by hash and stores no secret', () => {
    const dir = tmp();
    const file = path.join(dir, 'devices.json');
    const store = new DeviceStore(file, () => 0);
    const { device, cookie } = store.add('Laptop', 'local');
    expect(store.verify(cookie, 'local')?.id).toBe(device.id);
    const [id, secret] = cookie.split('.');
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(store.verify(`${id}.${secret}x`, 'local')).toBeUndefined();
    expect(store.verify(`${id}.`, 'local')).toBeUndefined();
    expect(store.verify(`nope.${secret}`, 'local')).toBeUndefined();
    expect(store.verify(secret, 'local')).toBeUndefined();
    expect(store.verify(undefined, 'local')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).not.toContain(secret);
    expect(new DeviceStore(file, () => 0).verify(cookie, 'local')?.name).toBe('Laptop');
    fs.writeFileSync(file, '{ torn');
    expect(new DeviceStore(file, () => 0).list()).toEqual([]);
  });

  it('gates /api/me', async () => {
    const s = await setup('local');
    const h = localHeaders(s.port);
    expect(JSON.parse(String((await request(s.port, { path: '/api/me', headers: h })).body))).toEqual({ paired: false });
    const { cookie } = await pair(s, h);
    const me = await request(s.port, { path: '/api/me', headers: { ...h, Cookie: cookie } });
    expect(JSON.parse(String(me.body))).toMatchObject({ paired: true, device: { name: 'Phone' } });
    expect(me.headers['cache-control']).toBe('no-store');
    const forged = await request(s.port, { path: '/api/me', headers: { ...h, Cookie: `${cookie}x` } });
    expect(JSON.parse(String(forged.body))).toEqual({ paired: false });
  });

  it("names the computer: the Name setting, else the OS computer name", async () => {
    const s = await setup('local');
    const h = localHeaders(s.port);
    const { cookie } = await pair(s, h);
    const me = async () => JSON.parse(String((await request(s.port, { path: '/api/me', headers: { ...h, Cookie: cookie } })).body)) as MeResponse;
    expect((await me()).computer).toBe(os.hostname());
    expect(s.ra.state().defaultName).toBe(os.hostname());
    s.settings.name = '  Office PC ';
    expect((await me()).computer).toBe('Office PC');
  });

  it('tells connected tabs when the computer gets a new name', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
    cleanups.push(() => ws.terminate());
    const got: { t: string; name?: string }[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: 'hello', platform: 'web' }));
    await waitFor(() => s.ra.clients.list().length === 1);
    await s.ra.apply(s.settings);
    expect(got.some((m) => m.t === 'computer')).toBe(false);
    s.settings.name = 'Office PC';
    await s.ra.apply(s.settings);
    await waitFor(() => got.some((m) => m.t === 'computer'));
    expect(got.filter((m) => m.t === 'computer')).toEqual([{ t: 'computer', name: 'Office PC' }]);
  });

  it('a device renames itself, and the Paired Devices list follows', async () => {
    const s = await setup('local');
    const h = localHeaders(s.port, { 'Content-Type': 'application/json' });
    const { cookie } = await pair(s, h);
    const rename = (body: string, headers: Record<string, string> = { ...h, Cookie: cookie }) => request(s.port, { method: 'POST', path: '/api/rename', headers, body });
    const before = s.states.length;
    const res = await rename(JSON.stringify({ name: '  Work\nLaptop ' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toMatchObject({ paired: true, device: { name: 'Work Laptop' }, computer: os.hostname() });
    expect(s.ra.state().devices.map((d) => d.name)).toEqual(['Work Laptop']);
    expect(s.states.slice(before).at(-1)?.devices.map((d) => d.name)).toEqual(['Work Laptop']);
    expect((await rename(JSON.stringify({ name: '   ' }))).status).toBe(400);
    expect((await rename('{ torn')).status).toBe(400);
    expect((await rename('x'.repeat(5000))).status).toBe(413);
    expect((await rename(JSON.stringify({ name: 'Other' }), h)).status).toBe(401);
    expect((await request(s.port, { path: '/api/rename', headers: { ...h, Cookie: cookie } })).status).toBe(405);
    expect(s.ra.state().devices.map((d) => d.name)).toEqual(['Work Laptop']);
  });
});

describe('local mode', () => {
  it('takes localhost and 127.0.0.1 at its port only', async () => {
    const s = await setup('local');
    expect(s.ra.state()).toMatchObject({ phase: 'running', sources: [{ id: 'local', phase: 'running', url: `http://localhost:${s.port}` }] });
    for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`]) {
      expect((await request(s.port, { path: '/api/me', headers: { Host: host } })).status).toBe(200);
    }
    for (const host of ['evil.example', `evil.example:${s.port}`, 'localhost:1', `localhost.evil.example:${s.port}`]) {
      expect((await request(s.port, { path: '/', headers: { Host: host } })).status).toBe(403);
    }
  });

  it('logs refusals at a limited rate', async () => {
    const s = await setup('local');
    for (let i = 0; i < 20; i++) await request(s.port, { path: '/', headers: { Host: 'evil.example' } });
    expect(s.log.lines.filter((l) => l.includes('refused GET')).length).toBe(5);
    s.clock.t += 61_000;
    await request(s.port, { path: '/', headers: { Host: 'evil.example' } });
    expect(s.log.lines.some((l) => l.includes('refused 15 more requests'))).toBe(true);
  });

  it('suggests the port it listens on, and saving that port keeps it running', async () => {
    const s = await setup('local');
    expect(await s.ra.suggestPort()).toBe(s.port);
    const before = s.states.length;
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'], port: s.port }));
    expect(s.states.slice(before).map((st) => st.phase)).not.toContain('starting');
    expect(s.ra.state()).toMatchObject({ phase: 'running', port: s.port });
  });

  it('while off, suggests a port nothing listens on', async () => {
    const s = await setup('local');
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: false, sources: ['local'] }));
    const port = await s.ra.suggestPort();
    expect(port).toBeGreaterThan(0);
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve));
    await new Promise((r) => probe.close(r));
  });
});

describe('tailscale mode', () => {
  it('needs the proxy secret and the signed-in account', async () => {
    const s = await setup('tailscale');
    expect(s.fake!.started).toMatchObject({ hostname: 'looper', stateDir: path.join(s.dataDir, 'remote-access', 'tailscale'), port: s.port });
    expect(s.ra.state()).toMatchObject({ phase: 'running', sources: [{ id: 'tailscale', phase: 'running', url: `https://${TS_HOST}`, account: TS_ACCOUNT }] });
    const ok = tsHeaders(s);
    expect((await request(s.port, { path: '/api/me', headers: ok })).status).toBe(200);
    expect((await request(s.port, { path: '/', headers: { ...ok, [PROXY_SECRET_HEADER]: '' } })).status).toBe(403);
    expect((await request(s.port, { path: '/', headers: { ...ok, [PROXY_SECRET_HEADER]: 'wrong' } })).status).toBe(403);
    expect((await request(s.port, { path: '/', headers: { ...ok, [PROXY_LOGIN_HEADER]: 'someone@else.com' } })).status).toBe(403);
    // Local mode's own checks don't open the door here.
    expect((await request(s.port, { path: '/', headers: { Host: `localhost:${s.port}` } })).status).toBe(403);
  });

  it('refuses everything until the helper reports the account', async () => {
    const s = await setup('tailscale', { autoRun: false });
    expect(s.ra.state().phase).toBe('starting');
    expect((await request(s.port, { path: '/', headers: tsHeaders(s) })).status).toBe(403);
    s.fake!.emit({ phase: 'needs-login', loginUrl: 'https://login.tailscale.com/a/x' });
    expect(s.ra.state()).toMatchObject({ phase: 'needs-login', sources: [{ id: 'tailscale', phase: 'needs-login', loginUrl: 'https://login.tailscale.com/a/x' }] });
    expect((await request(s.port, { path: '/', headers: tsHeaders(s) })).status).toBe(403);
    s.fake!.emit({ phase: 'running', url: `https://${TS_HOST}`, account: TS_ACCOUNT });
    expect((await request(s.port, { path: '/', headers: tsHeaders(s) })).status).toBe(200);
  });

  it('sets a Secure cookie over HTTPS', async () => {
    const s = await setup('tailscale');
    const { res } = await pair(s, tsHeaders(s));
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
  });
});

describe('WebSocket', () => {
  it('local: refuses a bad Origin or cookie, and answers hello with welcome', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port), 'Tablet');
    const origin = `http://127.0.0.1:${s.port}`;

    const noCookie = await openWs(s.port, { Origin: origin });
    expect(noCookie.status).toBe(401);
    const badCookie = await openWs(s.port, { Origin: origin, Cookie: `${cookie}x` });
    expect(badCookie.status).toBe(401);
    const badOrigin = await openWs(s.port, { Origin: 'http://evil.example', Cookie: cookie });
    expect(badOrigin.status).toBe(403);
    const noOrigin = await openWs(s.port, { Cookie: cookie });
    expect(noOrigin.status).toBe(403);

    const { ws, status } = await openWs(s.port, { Origin: origin, Cookie: cookie });
    expect(status).toBeUndefined();
    cleanups.push(() => ws.terminate());
    // Malformed and unknown messages are dropped; the hello still works.
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'bogus' }));
    ws.send(JSON.stringify({ t: 'hello', platform: 'toaster' }));
    const got: ServerMessage[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMessage));
    ws.send(JSON.stringify({ t: 'hello', platform: 'web' }));
    await waitFor(() => got.length >= 2);
    const w = got[0];
    expect(w).toMatchObject({ t: 'welcome', device: { name: 'Tablet' }, version: '9.9.9', resumed: false });
    expect(w.t === 'welcome' && w.clientId.length).toBeGreaterThan(0);
    // The new client's main window follows.
    expect(got[1]).toMatchObject({ t: 'window-open', hash: '', title: 'Looper', modal: false });
    await waitFor(() => s.ra.state().devices[0].connected === 1);

    ws.send(JSON.stringify({ t: 'ping' }));
    await waitFor(() => got.some((m) => m.t === 'pong'));
  });

  it('tailscale: the Origin must be the forwarded host over https', async () => {
    const s = await setup('tailscale');
    const { cookie } = await pair(s, tsHeaders(s));
    const bad = await openWs(s.port, tsHeaders(s, { Cookie: cookie, Origin: `http://${TS_HOST}` }));
    expect(bad.status).toBe(403);
    const { ws, status } = await openWs(s.port, tsHeaders(s, { Cookie: cookie, Origin: `https://${TS_HOST}` }));
    expect(status).toBeUndefined();
    cleanups.push(() => ws.terminate());
    const welcome = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'hello', platform: 'ios', clientId: 'abc' }));
    // An id the server doesn't know gets a new client, with an id of the server's own.
    const w = await welcome;
    expect(w).toMatchObject({ t: 'welcome', resumed: false });
    expect(w.t === 'welcome' && w.clientId).not.toBe('abc');
  });

  it('removing a device closes its connections', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
    const welcome = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'hello', platform: 'android' }));
    await welcome;
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    s.ra.removeDevice(s.ra.state().devices[0].id);
    await closed;
    expect(s.ra.state().devices).toEqual([]);
    expect(s.log.lines.some((l) => l.includes('removed Phone'))).toBe(true);
    await waitFor(() => s.log.lines.some((l) => l.includes('Phone disconnected')));
  });

  it('removing a device closes its clients at once, without the grace period', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
    cleanups.push(() => ws.terminate());
    ws.send(JSON.stringify({ t: 'hello', platform: 'web' }));
    await waitFor(() => s.ra.clients.list().length === 1);
    const client = s.ra.clients.list()[0];
    const main = client.main!;
    s.ra.removeDevice(s.ra.state().devices[0].id);
    expect(client.disposed).toBe(true);
    expect(main.isDestroyed()).toBe(true);
    expect(s.ra.clients.list()).toEqual([]);
  });

  it('turning Remote Access off keeps the clients for their grace period, so on again resumes', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const hello = async (port: number, clientId?: string) => {
      const { ws } = await openWs(port, { Origin: `http://localhost:${port}`, Host: `localhost:${port}`, Cookie: cookie });
      cleanups.push(() => ws.terminate());
      const welcome = nextMessage(ws);
      ws.send(JSON.stringify({ t: 'hello', platform: 'web', ...(clientId ? { clientId } : {}) }));
      return (await welcome) as Extract<ServerMessage, { t: 'welcome' }>;
    };
    const first = await hello(s.port);
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: false, sources: ['local'] }));
    expect(s.ra.clients.list()).toHaveLength(1);
    expect(s.ra.clients.list()[0].connected).toBe(false);
    expect(s.ra.clients.list()[0].disposed).toBe(false);
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'] }));
    const again = await hello(s.ra.state().port!, first.clientId);
    expect(again).toMatchObject({ clientId: first.clientId, resumed: true });
  });

  it('two sockets with the same clientId and pageId: the second takes over and the first is closed', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const open = async () => {
      const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
      cleanups.push(() => ws.terminate());
      return ws;
    };
    const a = await open();
    const welcomeA = nextMessage(a);
    a.send(JSON.stringify({ t: 'hello', platform: 'web', pageId: 'p1' }));
    const wa = (await welcomeA) as Extract<ServerMessage, { t: 'welcome' }>;
    const closedA = new Promise<void>((r) => a.once('close', () => r()));
    const b = await open();
    const welcomeB = nextMessage(b);
    b.send(JSON.stringify({ t: 'hello', platform: 'web', clientId: wa.clientId, pageId: 'p1' }));
    expect(await welcomeB).toMatchObject({ t: 'welcome', clientId: wa.clientId, resumed: true });
    await closedA;
    expect(s.ra.clients.list()).toHaveLength(1);
    expect(s.ra.clients.list()[0].connected).toBe(true);
  });

  it('a removed device is cut off at once: nothing it sends after that runs', async () => {
    const ipc = new IpcTable();
    const calls: unknown[] = [];
    ipc.on('probe', (_e, n: unknown) => void calls.push(n));
    const s = await setup('local', { ipc });
    const { cookie } = await pair(s, localHeaders(s.port));
    const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    ws.send(JSON.stringify({ t: 'hello', platform: 'web' }));
    await waitFor(() => messages.some((m) => m.t === 'window-open'));
    const w = (messages.find((m) => m.t === 'window-open') as { w: string }).w;
    ws.send(JSON.stringify({ t: 'send', w, channel: 'probe', args: [1] }));
    await waitFor(() => calls.length === 1);
    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    s.ra.removeDevice(s.ra.state().devices[0].id);
    // Sent before this side hears of the close: a device that ignores the close frame keeps sending.
    ws.send(JSON.stringify({ t: 'send', w, channel: 'probe', args: [2] }));
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([1]);
  });
});

describe('cross-site requests', () => {
  const noHeader = (port: number, extra: Record<string, string> = {}) => ({ Host: `localhost:${port}`, ...extra });

  it('refuses a POST without X-Looper-Request, on every endpoint', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const h = noHeader(s.port, { Cookie: cookie, 'Content-Type': 'text/plain' });
    const sub = JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } });
    for (const p of ['/api/push/subscribe', '/api/push/unsubscribe', '/api/upload?name=a.txt', '/api/unpair', '/api/rename', '/api/pair']) {
      const r = await request(s.port, { method: 'POST', path: p, headers: h, body: p === '/api/rename' ? JSON.stringify({ name: 'Evil' }) : sub });
      expect(r.status, p).toBe(403);
    }
    expect(s.ra.state().devices.map((d) => d.name)).toEqual(['Phone']);
    expect(fs.existsSync(path.join(s.dataDir, 'remote-access', 'uploads'))).toBe(false);
    expect(s.log.lines.some((l) => l.includes('refused POST /api/upload') && l.includes('missing X-Looper-Request'))).toBe(true);
  });

  it('refuses Sec-Fetch-Site same-site or cross-site, even with the header', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    for (const site of ['same-site', 'cross-site']) {
      const h = localHeaders(s.port, { Cookie: cookie, 'Sec-Fetch-Site': site, Origin: 'http://localhost:3000' });
      expect((await request(s.port, { method: 'POST', path: '/api/upload?name=a.txt', headers: h, body: 'x' })).status, site).toBe(403);
      expect((await request(s.port, { method: 'POST', path: '/api/unpair', headers: h })).status, site).toBe(403);
    }
    expect(s.ra.state().devices).toHaveLength(1);
    expect(s.log.lines.some((l) => l.includes('Sec-Fetch-Site "same-site"'))).toBe(true);
  });

  it('accepts the header with same-origin, none, or no Sec-Fetch-Site; GETs need none of it', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    for (const site of ['same-origin', 'none', undefined]) {
      const h = localHeaders(s.port, { Cookie: cookie, ...(site ? { 'Sec-Fetch-Site': site } : {}) });
      const r = await request(s.port, { method: 'POST', path: '/api/upload?name=a.txt', headers: h, body: 'x' });
      expect(r.status, String(site)).toBe(200);
    }
    const get = await request(s.port, { path: '/api/me', headers: noHeader(s.port, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }) });
    expect(get.status).toBe(200);
  });
});

describe('provider-bound devices', () => {
  it('drops a stored device without a provider', () => {
    const file = path.join(tmp(), 'devices.json');
    const store = new DeviceStore(file, () => 0);
    const keep = store.add('Keep', 'tailscale');
    const raw = readJson<{ devices: Record<string, unknown>[] }>(file, { devices: [] });
    raw.devices.push({ ...raw.devices[0], id: 'old', provider: undefined }, { ...raw.devices[0], id: 'odd', provider: 'carrier-pigeon' });
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(new DeviceStore(file, () => 0).list().map((d) => d.id)).toEqual([keep.device.id]);
  });

  it('a device works only while the provider it was paired under is active', async () => {
    const store = new DeviceStore(path.join(tmp(), 'devices.json'), () => 0);
    const { cookie } = store.add('Phone', 'local');
    expect(store.verify(cookie, 'local')?.provider).toBe('local');
    expect(store.verify(cookie, 'tailscale')).toBeUndefined();

    const s = await setup('tailscale');
    const { cookie: tsCookie } = await pair(s, tsHeaders(s));
    expect(s.ra.state().devices.map((d) => d.provider)).toEqual(['tailscale']);
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'] }));
    const port = s.ra.state().port!;
    const me = await request(port, { path: '/api/me', headers: localHeaders(port, { Cookie: tsCookie }) });
    expect(JSON.parse(String(me.body))).toEqual({ paired: false });
    const ws = await openWs(port, { Origin: `http://localhost:${port}`, Host: `localhost:${port}`, Cookie: tsCookie });
    expect(ws.status).toBe(401);
    // It stays in the list, and works again once Tailscale is back.
    expect(s.ra.state().devices.map((d) => d.provider)).toEqual(['tailscale']);
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['tailscale'] }));
    const back = await request(s.ra.state().port!, { path: '/api/me', headers: tsHeaders(s, { Cookie: tsCookie }) });
    expect(JSON.parse(String(back.body))).toMatchObject({ paired: true });
  });
});

describe('several sources at once', () => {
  it('serves this computer and Tailscale together, each device through its own source', async () => {
    const s = await setup('tailscale', { sources: ['local', 'tailscale'] });
    expect(s.ra.state()).toMatchObject({
      phase: 'running',
      port: s.port,
      sources: [
        { id: 'tailscale', phase: 'running', url: `https://${TS_HOST}`, account: TS_ACCOUNT },
        { id: 'local', phase: 'running', url: `http://localhost:${s.port}` },
      ],
    });
    expect(remoteAccessStatusItems(s.ra.state())).toEqual([`Tailscale: https://${TS_HOST}`, `Host Computer: http://localhost:${s.port}`]);

    const { cookie: local } = await pair(s, localHeaders(s.port), 'Laptop');
    const { cookie: ts, res } = await pair(s, tsHeaders(s), 'Phone');
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
    expect(s.ra.state().devices.map((d) => [d.name, d.provider])).toEqual([
      ['Laptop', 'local'],
      ['Phone', 'tailscale'],
    ]);
    const me = async (headers: Record<string, string>) => JSON.parse(String((await request(s.port, { path: '/api/me', headers })).body)) as MeResponse;
    expect(await me(localHeaders(s.port, { Cookie: local }))).toMatchObject({ paired: true, device: { name: 'Laptop' } });
    expect(await me(tsHeaders(s, { Cookie: ts }))).toMatchObject({ paired: true, device: { name: 'Phone' } });
    // A cookie works only through the source it was paired through.
    expect(await me(localHeaders(s.port, { Cookie: ts }))).toEqual({ paired: false });
    expect(await me(tsHeaders(s, { Cookie: local }))).toEqual({ paired: false });
    // A request carrying the proxy secret header is judged as Tailscale's alone, even from this computer.
    expect((await request(s.port, { path: '/api/me', headers: localHeaders(s.port, { [PROXY_SECRET_HEADER]: 'guess' }) })).status).toBe(403);

    const ws = await openWs(s.port, tsHeaders(s, { Cookie: ts, Origin: `https://${TS_HOST}` }));
    expect(ws.status).toBeUndefined();
    cleanups.push(() => ws.ws.terminate());
    const local401 = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: ts });
    expect(local401.status).toBe(401);
  });

  it('a pairing code works through every running source', async () => {
    const s = await setup('tailscale', { sources: ['local', 'tailscale'] });
    const c = s.ra.newPairingCode();
    // The Pair Device window offers each running source's address.
    expect(s.ra.state().sources.map((x) => [x.id, x.url])).toEqual([
      ['tailscale', `https://${TS_HOST}`],
      ['local', `http://localhost:${s.port}`],
    ]);
    // While Tailscale waits for a sign-in, the code still works through this computer.
    s.fake.emit({ phase: 'needs-login', loginUrl: 'https://login.tailscale.com/a/x' });
    expect(s.ra.state().phase).toBe('running');
    const r = await request(s.port, {
      method: 'POST',
      path: '/api/pair',
      headers: localHeaders(s.port, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code: c.code, name: 'Laptop' }),
    });
    expect(r.status).toBe(200);
    expect(s.ra.state().sources.filter((x) => x.phase === 'running').map((x) => x.id)).toEqual(['local']);
  });

  it('adds and removes a source without restarting the server or cutting the other source', async () => {
    const s = await setup('local');
    const { cookie } = await pair(s, localHeaders(s.port));
    const { ws } = await openWs(s.port, { Origin: `http://localhost:${s.port}`, Host: `localhost:${s.port}`, Cookie: cookie });
    cleanups.push(() => ws.terminate());
    ws.send(JSON.stringify({ t: 'hello', platform: 'web' }));
    await waitFor(() => s.ra.state().devices[0]?.connected === 1);

    s.settings.sources = ['tailscale', 'local'];
    await s.ra.apply(s.settings);
    expect(s.ra.state()).toMatchObject({ phase: 'running', port: s.port });
    expect(s.ra.state().sources.map((x) => [x.id, x.phase])).toEqual([
      ['tailscale', 'running'],
      ['local', 'running'],
    ]);
    expect(s.fake.started?.port).toBe(s.port);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    s.settings.sources = ['tailscale'];
    await s.ra.apply(s.settings);
    // This computer's browser is refused now, and its connection is cut.
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect((await request(s.port, { path: '/api/me', headers: localHeaders(s.port) })).status).toBe(403);
    expect((await request(s.port, { path: '/api/me', headers: tsHeaders(s) })).status).toBe(200);
    expect(s.ra.state().sources.map((x) => x.id)).toEqual(['tailscale']);
  });

  it('turned on with no source chosen stays off', async () => {
    const s = await setup('local');
    s.settings.sources = [];
    await s.ra.apply(s.settings);
    expect(s.ra.state()).toMatchObject({ phase: 'off', sources: [] });
    expect(remoteAccessStatusItems(s.ra.state())).toEqual([]);
  });
});

describe('restarts and updates', () => {
  it('saves the port it picked, so the address stays the same', async () => {
    const saved: number[] = [];
    const s = await setup('local', { savePort: (p) => saved.push(p) });
    expect(saved).toEqual([s.port]);
    const before = s.states.length;
    s.settings.port = s.port;
    await s.ra.apply(s.settings);
    expect(s.states.slice(before).map((st) => st.phase)).not.toContain('starting');
  });

  it('a device paired before a restart still works after it, at the same address', async () => {
    const first = await setup('local');
    const root = path.dirname(first.dataDir);
    const { cookie } = await pair(first, localHeaders(first.port), 'Laptop');
    const port = first.port;
    await first.ra.dispose();
    // Looper starts again (an update installs and relaunches it): same data, the port the first start saved.
    const again = await setup('local', { root, port });
    expect(again.port).toBe(port);
    const me = await request(port, { path: '/api/me', headers: localHeaders(port, { Cookie: cookie }) });
    expect(JSON.parse(String(me.body))).toMatchObject({ paired: true, device: { name: 'Laptop' } });
    const ws = await openWs(port, { Origin: `http://localhost:${port}`, Host: `localhost:${port}`, Cookie: cookie });
    expect(ws.status).toBeUndefined();
    cleanups.push(() => ws.ws.terminate());
  });

  it('keeps settings an older Looper wrote: its provider field is dropped, not the whole settings', () => {
    const old = SettingsSchema.safeParse({ remoteAccess: { enabled: true, provider: 'tailscale', name: 'PC', hostname: 'pc-looper', port: 60123 } });
    expect(old.success).toBe(true);
    expect(old.data?.remoteAccess).toEqual({ enabled: true, sources: [], name: 'PC', hostname: 'pc-looper', port: 60123 });
    expect(RemoteAccessSettingsSchema.safeParse({ sources: ['local', 'local'] }).success).toBe(false);
  });
});

describe('Set Up sign-in', () => {
  it('runs Tailscale alone until Remote Access runs it, and stops on endSignIn', async () => {
    const s = await setup('local');
    await s.ra.beginSignIn('my-pc');
    expect(s.fake.started).toMatchObject({ hostname: 'my-pc', stateDir: path.join(s.dataDir, 'remote-access', 'tailscale') });
    expect(s.fake.started?.port).not.toBe(s.port);
    expect(s.ra.state().setup).toMatchObject({ id: 'tailscale', phase: 'running', account: TS_ACCOUNT });
    // Remote Access's own state doesn't count it as a source.
    expect(s.ra.state().sources.map((x) => x.id)).toEqual(['local']);
    await s.ra.endSignIn();
    expect(s.ra.state().setup).toBeUndefined();

    await s.ra.beginSignIn('my-pc');
    s.settings.sources = ['tailscale', 'local'];
    s.settings.hostname = 'my-pc';
    await s.ra.apply(s.settings);
    // Tailscale as a source takes the helper's place.
    expect(s.ra.state().setup).toBeUndefined();
    expect(s.fake.started?.port).toBe(s.port);
  });
});

describe('files', () => {
  it('uploads into its own folder, then downloads once', async () => {
    const s = await setup('local');
    const h = localHeaders(s.port);
    expect((await request(s.port, { method: 'POST', path: '/api/upload?name=a.txt', headers: h, body: 'x' })).status).toBe(401);
    const { cookie } = await pair(s, h);
    const auth = { ...h, Cookie: cookie };
    const up = await request(s.port, {
      method: 'POST',
      path: `/api/upload?name=${encodeURIComponent('..\\..\\evil:name?.txt')}`,
      headers: auth,
      body: 'hello upload',
    });
    expect(up.status).toBe(200);
    const file = (JSON.parse(String(up.body)) as { path: string }).path;
    const uploads = path.join(s.dataDir, 'remote-access', 'uploads');
    expect(path.dirname(path.dirname(file))).toBe(uploads);
    expect(path.basename(file)).toBe('evil_name_.txt');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello upload');

    const token = s.ra.offerDownload(file, "résumé (1)'s.txt");
    expect((await request(s.port, { path: `/api/download/${token}`, headers: h })).status).toBe(401);
    const down = await request(s.port, { path: `/api/download/${token}`, headers: auth });
    expect(down.status).toBe(200);
    expect(String(down.body)).toBe('hello upload');
    expect(down.headers['content-disposition']).toBe(contentDisposition("résumé (1)'s.txt"));
    expect(down.headers['content-disposition']).toBe(`attachment; filename="r_sum_ (1)'s.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29%27s.txt`);
    expect((await request(s.port, { path: `/api/download/${token}`, headers: auth })).status).toBe(404);

    const late = s.ra.offerDownload(file, 'a.txt');
    s.clock.t += 10 * 60_000;
    expect((await request(s.port, { path: `/api/download/${late}`, headers: auth })).status).toBe(404);
  });

  it('deletes uploads older than a day at start', async () => {
    let old = '';
    let fresh = '';
    await setup('local', {
      beforeStart: (dataDir) => {
        const uploads = path.join(dataDir, 'remote-access', 'uploads');
        old = path.join(uploads, 'old');
        fresh = path.join(uploads, 'fresh');
        fs.mkdirSync(old, { recursive: true });
        fs.mkdirSync(fresh, { recursive: true });
        const t = new Date(Date.parse('2026-10-28T11:00:00Z'));
        fs.utimesSync(old, t, t);
        const f = new Date(Date.parse('2026-10-29T11:00:00Z'));
        fs.utimesSync(fresh, f, f);
      },
    });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('a/b/c.txt')).toBe('c.txt');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('...')).toBe('upload');
    expect(sanitizeFileName('name. ')).toBe('name');
  });
});

describe('static files', () => {
  it('serves the renderer with its headers and nothing outside it', async () => {
    const s = await setup('local');
    const h = localHeaders(s.port);
    for (const p of ['/', '/pair']) {
      const r = await request(s.port, { path: p, headers: h });
      expect(r.status).toBe(200);
      expect(String(r.body)).toContain('<title>Looper</title>');
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.headers['content-security-policy']).toContain(`connect-src 'self' ws://localhost:${s.port} wss://localhost:${s.port};`);
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
    const js = await request(s.port, { path: '/assets/app.js', headers: h });
    expect(js.headers['content-type']).toMatch(/javascript/);
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%2e%2e/secret.txt', '/assets/%00', '/assets']) {
      const r = await request(s.port, { path: p, headers: h });
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(String(r.body), p).not.toContain('TOP SECRET');
    }
  });
});

describe('providers', () => {
  it('reads the helper protocol', () => {
    expect(parseTsnetLine('{"type":"status","state":"running","url":"https://a","dnsName":"a","login":"me"}')).toMatchObject({ state: 'running' });
    expect(parseTsnetLine('{"type":"status","state":"needs-login"}')).toBeNull();
    // Running with no account would make the server refuse every request.
    expect(parseTsnetLine('{"type":"status","state":"running","url":"https://a","dnsName":"a","login":""}')).toBeNull();
    expect(parseTsnetLine('{"type":"log","level":"info","message":"hi"}')).toMatchObject({ type: 'log' });
    expect(parseTsnetLine('garbage')).toBeNull();
  });

  it('a missing helper is an error status', () => {
    const p = new TailscaleProvider(memLog(), path.join(tmp(), 'looper-tsnet'));
    const seen: ProviderStatus[] = [];
    p.onStatus((s) => seen.push(s));
    p.start({ port: 1, secret: 's', hostname: 'looper', stateDir: tmp() });
    expect(seen).toEqual([{ phase: 'error', message: expect.stringMatching(/helper is missing/) }]);
  });

  /** A stand-in helper: a node script with the helper's name. */
  function fakeHelper(body: string): string {
    const file = path.join(tmp(), 'looper-tsnet');
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it.skipIf(process.platform === 'win32')('runs the helper with its flags and secret, and stops it by closing stdin', async () => {
    const helper = fakeHelper(`
      const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
      out({ type: 'log', level: 'info', message: 'args ' + process.argv.slice(2).join(' ') + ' secret ' + process.env.LOOPER_PROXY_SECRET });
      out({ type: 'status', state: 'running', url: 'https://looper.example.ts.net/', dnsName: 'looper.example.ts.net', login: 'me@example.com' });
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    const log = memLog();
    const p = new TailscaleProvider(log, helper);
    const seen: ProviderStatus[] = [];
    p.onStatus((s) => seen.push(s));
    p.start({ port: 4321, secret: 'sekrit', hostname: 'box', stateDir: '/state' });
    await waitFor(() => seen.some((s) => s.phase === 'running'));
    expect(seen.at(-1)).toEqual({ phase: 'running', url: 'https://looper.example.ts.net', account: 'me@example.com' });
    expect(log.lines).toContain('[info] remote access: tailscale: args --dir /state --hostname box --target http://127.0.0.1:4321 secret sekrit');
    const t0 = Date.now();
    await p.stop();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(seen.at(-1)).toEqual({ phase: 'off' });
  });

  it.skipIf(process.platform === 'win32')('restarts a crashing helper, then shows the error after 3 quick failures', async () => {
    const helper = fakeHelper(`process.stderr.write('boom\\n'); process.exit(3);`);
    const p = new TailscaleProvider(memLog(), helper);
    const seen: ProviderStatus[] = [];
    p.onStatus((s) => seen.push(s));
    p.start({ port: 1, secret: 's', hostname: 'h', stateDir: tmp() });
    await waitFor(() => seen.some((s) => s.phase === 'error'), 8000);
    expect(seen.filter((s) => s.phase === 'starting')).toHaveLength(3);
    expect(seen.at(-1)).toEqual({ phase: 'error', message: 'boom' });
  }, 10_000);

  it.skipIf(process.platform === 'win32')('logs each line the helper writes to stderr while it runs', async () => {
    const helper = fakeHelper(`
      process.stderr.write('netcheck: report\\n\\nmagicsock: new contact\\n');
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    const log = memLog();
    const p = new TailscaleProvider(log, helper);
    p.start({ port: 1, secret: 's', hostname: 'h', stateDir: tmp() });
    await waitFor(() => log.lines.includes('[debug] remote access: tailscale helper: magicsock: new contact'));
    expect(log.lines.filter((l) => l.includes('tailscale helper:'))).toEqual([
      '[debug] remote access: tailscale helper: netcheck: report',
      '[debug] remote access: tailscale helper: magicsock: new contact',
    ]);
    await p.stop();
  });

  it('turning off stops the server and says so', async () => {
    const s = await setup('local');
    await s.ra.apply(RemoteAccessSettingsSchema.parse({ enabled: false, sources: ['local'] }));
    expect(s.ra.state().phase).toBe('off');
    expect(s.states.at(-1)?.phase).toBe('off');
    await expect(request(s.port, { path: '/', headers: localHeaders(s.port) })).rejects.toThrow();
    expect(s.log.lines.some((l) => l.includes('turned off'))).toBe(true);
  });
});
