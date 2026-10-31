import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from '../src/engine/log';
import { RemoteAccess } from '../src/main/remote-access';
import { LocalProvider } from '../src/main/remote-access/providers';
import { etagMatches, negotiateEncoding } from '../src/main/remote-access/static-cache';
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from '../src/shared/remote-access';
import { RemoteAccessSettingsSchema } from '../src/shared/types';

const tmpDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, log: () => undefined } as unknown as Logger;

describe('negotiateEncoding', () => {
  it('prefers brotli, then gzip, and honors q=0', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip;q=0')).toBeNull();
    expect(negotiateEncoding('GZIP;q=0.5')).toBe('gzip');
    expect(negotiateEncoding('*')).toBe('br');
    expect(negotiateEncoding('identity')).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
  });
});

describe('etagMatches', () => {
  it('compares weakly, over a list, and takes *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });
});

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function request(port: number, o: { method?: string; path: string; headers?: Record<string, string> }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: { Host: `localhost:${port}`, [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const JS = `${'function hello(){return "hello world";}\n'.repeat(200)}`;
const PNG = Buffer.alloc(2000, 7);

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-static-'));
  tmpDirs.push(root);
  const staticDir = path.join(root, 'static');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), `<!doctype html><html><head><title>Looper</title></head><body>${'x'.repeat(600)}</body></html>`);
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), JS);
  fs.writeFileSync(path.join(staticDir, 'assets', 'logo.png'), PNG);
  const settings = RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'] });
  const ra = new RemoteAccess({
    dataDir: path.join(root, 'data'),
    log: quietLog,
    settings: () => settings,
    emit: () => undefined,
    version: '9.9.9',
    staticDir,
    createProvider: () => new LocalProvider(),
    icon: (name) => (name === 'icon-192' ? Buffer.from('PNG') : null),
  });
  cleanups.push(() => ra.dispose());
  await ra.apply(settings);
  return { ra, port: ra.state().port!, staticDir };
}

describe('static responses', () => {
  it('compress text by Accept-Encoding, brotli first, with Content-Encoding and Vary', async () => {
    const { port } = await setup();
    const br = await request(port, { path: '/assets/app.js', headers: { 'Accept-Encoding': 'gzip, br' } });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['vary']).toBe('Accept-Encoding');
    expect(br.headers['content-type']).toMatch(/^text\/javascript/);
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(JS.length);
    expect(zlib.brotliDecompressSync(br.body).toString('utf8')).toBe(JS);
    const gz = await request(port, { path: '/assets/app.js', headers: { 'Accept-Encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.body).toString('utf8')).toBe(JS);
    const plain = await request(port, { path: '/assets/app.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['vary']).toBe('Accept-Encoding');
    expect(plain.body.toString('utf8')).toBe(JS);
    const head = await request(port, { method: 'HEAD', path: '/assets/app.js', headers: { 'Accept-Encoding': 'br' } });
    expect(head.headers['content-encoding']).toBe('br');
    expect(head.headers['content-length']).toBe(String(br.body.length));
    expect(head.body.length).toBe(0);
  });

  it('compress index.html and the manifest, and leave images as they are', async () => {
    const { port } = await setup();
    const ae = { 'Accept-Encoding': 'gzip, br' };
    const page = await request(port, { path: '/', headers: ae });
    expect(page.headers['content-encoding']).toBe('br');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(zlib.brotliDecompressSync(page.body).toString('utf8')).toContain('viewport-fit=cover');
    const manifest = await request(port, { path: '/manifest.webmanifest', headers: ae });
    expect(manifest.headers['content-encoding']).toBe('br');
    expect(JSON.parse(zlib.brotliDecompressSync(manifest.body).toString('utf8'))).toMatchObject({ name: expect.any(String) });
    const png = await request(port, { path: '/assets/logo.png', headers: ae });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.headers['vary']).toBeUndefined();
    expect(png.body.equals(PNG)).toBe(true);
  });

  it('send an ETag per file and answer If-None-Match with 304', async () => {
    const { port } = await setup();
    for (const p of ['/assets/app.js', '/assets/logo.png', '/', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png']) {
      const first = await request(port, { path: p });
      expect(first.status, p).toBe(200);
      const etag = first.headers['etag'];
      expect(etag, p).toMatch(/^"[A-Za-z0-9_-]+"$/);
      const again = await request(port, { path: p, headers: { 'If-None-Match': etag! } });
      expect(again.status, p).toBe(304);
      expect(again.body.length, p).toBe(0);
      expect(again.headers['etag'], p).toBe(etag);
      expect(again.headers['cache-control'], p).toBe(first.headers['cache-control']);
      const other = await request(port, { path: p, headers: { 'If-None-Match': '"nope"' } });
      expect(other.status, p).toBe(200);
    }
  });

  it('give each encoding its own ETag, and a changed file a new one', async () => {
    const { port, staticDir } = await setup();
    const plain = await request(port, { path: '/assets/app.js' });
    const br = await request(port, { path: '/assets/app.js', headers: { 'Accept-Encoding': 'br' } });
    expect(br.headers['etag']).not.toBe(plain.headers['etag']);
    // The plain ETag doesn't validate the brotli representation.
    expect((await request(port, { path: '/assets/app.js', headers: { 'Accept-Encoding': 'br', 'If-None-Match': plain.headers['etag']! } })).status).toBe(200);
    expect((await request(port, { path: '/assets/app.js', headers: { 'Accept-Encoding': 'br', 'If-None-Match': br.headers['etag']! } })).status).toBe(304);
    fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), `${JS}// changed\n`);
    const next = await request(port, { path: '/assets/app.js' });
    expect(next.headers['etag']).not.toBe(plain.headers['etag']);
    expect(next.body.toString('utf8')).toBe(`${JS}// changed\n`);
  });

  it('negotiate permessage-deflate on the WebSocket', async () => {
    const { port, ra } = await setup();
    const { code } = ra.newPairingCode();
    const paired = await new Promise<Res>((resolve, reject) => {
      const body = JSON.stringify({ code, name: 'Phone' });
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/pair', headers: { Host: `localhost:${port}`, [REQUEST_HEADER]: REQUEST_HEADER_VALUE, 'Content-Type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    const cookie = String(paired.headers['set-cookie']).split(';')[0];
    const extensions = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, Cookie: cookie } });
      cleanups.push(() => ws.close());
      ws.once('open', () => resolve(ws.extensions));
      ws.once('error', reject);
    });
    expect(extensions).toContain('permessage-deflate');
  });
});
