import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/engine/log';
import { RemoteAccess } from '../src/main/remote-access';
import { LocalProvider } from '../src/main/remote-access/providers';
import { addPreviewFrame, insideFolder, previewCorsType, previewDesktopLoad, previewDeviceLoad, previewFolderOf, previewFrameResource, previewResourceFile, previewResourceNames } from '../src/main/preview-frames';
import { PREVIEW_END, previewFrameCsp, previewHtmlDocument } from '../src/shared/preview';
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from '../src/shared/remote-access';
import { RemoteAccessSettingsSchema } from '../src/shared/types';

// An HTML file Preview shows loads the files next to it by relative address (img/a.png), from its own folder and
// its subfolders only: on the computer from looper-preview://<token>/, on a device from /preview-frame/<token>/.

const tmpDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A page's folder: index.html, img/a.png, a stylesheet, a font and a script; a secret beside the folder; links out of it. */
function site() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'looper-pv-')));
  tmpDirs.push(root);
  const page = path.join(root, 'page');
  fs.mkdirSync(path.join(page, 'img'), { recursive: true });
  fs.mkdirSync(path.join(page, 'deep', 'er'), { recursive: true });
  fs.writeFileSync(path.join(page, 'index.html'), '<img src="img/a.png">');
  fs.writeFileSync(path.join(page, 'img', 'a.png'), PNG);
  fs.writeFileSync(path.join(page, 'img', 'a b.png'), PNG);
  fs.writeFileSync(path.join(page, 's.css'), 'body{}');
  fs.writeFileSync(path.join(page, 'f.woff2'), 'font');
  fs.writeFileSync(path.join(page, 'm.js'), 'export {}');
  fs.writeFileSync(path.join(page, 'deep', 'er', 'x.txt'), 'deep');
  fs.writeFileSync(path.join(page, 'noext'), 'raw');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(page, 'link-out.txt'));
  fs.symlinkSync(root, path.join(page, 'up'));
  fs.symlinkSync(path.join(page, 'img', 'a.png'), path.join(page, 'link-in.png'));
  return { root, page, html: path.join(page, 'index.html') };
}

describe("the names in a page's address", () => {
  it('decodes plain names, subfolders and spaces', () => {
    expect(previewResourceNames('/img/a.png')).toEqual(['img', 'a.png']);
    expect(previewResourceNames('/img/a%20b.png')).toEqual(['img', 'a b.png']);
    expect(previewResourceNames('/deep/er/x.txt')).toEqual(['deep', 'er', 'x.txt']);
    expect(previewResourceNames('/..foo')).toEqual(['..foo']);
  });

  it('refuses .., ., empty names and separators, encoded or not', () => {
    for (const p of ['/../secret.txt', '/img/../../x', '/%2e%2e/secret.txt', '/%2E%2E', '/./a', '/a//b', '/', '/img/', 'img/a.png']) expect(previewResourceNames(p), p).toBeNull();
    for (const p of ['/..%2fsecret.txt', '/img%2F..%2F..%2Fsecret.txt', '/..%5csecret.txt', '/a%5C..%5C..%5Cb', '/a%00.png', '/C:%5Cx', '/a.png:stream', '/%E0%A4%A']) expect(previewResourceNames(p), p).toBeNull();
  });

  it("refuses names Windows reads as . or .. (trailing dots and spaces)", () => {
    for (const p of ['/...', '/.. ', '/. .', '/%2e%2e%20']) expect(previewResourceNames(p), p).toBeNull();
  });
});

describe('insideFolder', () => {
  it('on POSIX', () => {
    const p = path.posix;
    expect(insideFolder('/a/b', '/a/b/c', p)).toBe(true);
    expect(insideFolder('/a/b', '/a/b/c/d.png', p)).toBe(true);
    expect(insideFolder('/a/b', '/a/b', p)).toBe(false);
    expect(insideFolder('/a/b', '/a/bc/d', p)).toBe(false);
    expect(insideFolder('/a/b', '/a/c', p)).toBe(false);
    expect(insideFolder('/a/b', '/etc/passwd', p)).toBe(false);
    expect(insideFolder('/a/b', '/a/b/..x', p)).toBe(true);
  });

  it('on Windows: another drive, another share, any case', () => {
    const w = path.win32;
    expect(insideFolder('C:\\Users\\me\\site', 'C:\\Users\\me\\site\\img\\a.png', w)).toBe(true);
    expect(insideFolder('C:\\Users\\me\\site', 'c:\\users\\ME\\Site\\a.png', w)).toBe(true);
    expect(insideFolder('C:\\Users\\me\\site', 'D:\\Users\\me\\site\\a.png', w)).toBe(false);
    expect(insideFolder('C:\\Users\\me\\site', 'C:\\Users\\me\\secret.txt', w)).toBe(false);
    expect(insideFolder('\\\\wsl.localhost\\Ubuntu\\home\\me\\site', '\\\\wsl.localhost\\Ubuntu\\home\\me\\site\\img\\a.png', w)).toBe(true);
    expect(insideFolder('\\\\wsl.localhost\\Ubuntu\\home\\me\\site', '\\\\wsl.localhost\\Ubuntu\\etc\\passwd', w)).toBe(false);
  });
});

describe('previewResourceFile', () => {
  it('finds files in the folder and its subfolders, and links that stay in it', async () => {
    const s = site();
    expect(await previewResourceFile(s.page, '/img/a.png')).toBe(path.join(s.page, 'img', 'a.png'));
    expect(await previewResourceFile(s.page, '/img/a%20b.png')).toBe(path.join(s.page, 'img', 'a b.png'));
    expect(await previewResourceFile(s.page, '/deep/er/x.txt')).toBe(path.join(s.page, 'deep', 'er', 'x.txt'));
    expect(await previewResourceFile(s.page, '/link-in.png')).toBe(path.join(s.page, 'img', 'a.png'));
  });

  it('refuses a link that leads out of the folder, and anything that climbs out', async () => {
    const s = site();
    expect(await previewResourceFile(s.page, '/link-out.txt')).toBeNull();
    expect(await previewResourceFile(s.page, '/up/secret.txt')).toBeNull();
    // Out through a link and back in: its real path is in the folder.
    expect(await previewResourceFile(s.page, '/up/page/img/a.png')).toBe(path.join(s.page, 'img', 'a.png'));
    expect(await previewResourceFile(s.page, '/..%2fsecret.txt')).toBeNull();
    expect(await previewResourceFile(s.page, '/%2e%2e/secret.txt')).toBeNull();
    expect(await previewResourceFile(s.page, '/missing.png')).toBeNull();
  });
});

describe('previewFolderOf', () => {
  it("is the real path of a file's folder, and nothing for a folder, a missing file or a relative path", async () => {
    const s = site();
    expect(await previewFolderOf(s.html)).toBe(s.page);
    expect(await previewFolderOf(path.join(s.page, 'link-out.txt'))).toBe(s.page);
    expect(await previewFolderOf(s.page)).toBeUndefined();
    expect(await previewFolderOf(path.join(s.page, 'nope.html'))).toBeUndefined();
    expect(await previewFolderOf('page/index.html')).toBeUndefined();
  });
});

describe('previewFrameResource', () => {
  const read = async (token: string, p: string) => {
    const r = await previewFrameResource(token, p, previewCorsType);
    if (!r) return null;
    const body = await r.handle.readFile();
    await r.handle.close();
    return { headers: r.headers, body };
  };

  it("serves a page's files with their type, nosniff and the page's own policy", async () => {
    const s = site();
    const token = addPreviewFrame('<img src="img/a.png">', 'deny', false, await previewFolderOf(s.html));
    const png = await read(token, '/img/a.png');
    expect(png?.body.equals(PNG)).toBe(true);
    expect(png?.headers['Content-Type']).toBe('image/png');
    expect(png?.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(png?.headers['Content-Length']).toBe(String(PNG.length));
    expect(png?.headers['Content-Security-Policy']).toBe(previewFrameCsp(false, false, true));
    expect(png?.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect((await read(token, '/s.css'))?.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect((await read(token, '/noext'))?.headers['Content-Type']).toBe('application/octet-stream');
    // A font and a module script load in CORS mode from the page's opaque origin.
    expect((await read(token, '/f.woff2'))?.headers['Access-Control-Allow-Origin']).toBe('*');
    expect((await read(token, '/m.js'))?.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('serves nothing outside the folder, nothing that is not a file, and nothing for a page whose folder is unknown', async () => {
    const s = site();
    const token = addPreviewFrame('', 'deny', false, await previewFolderOf(s.html));
    expect(await read(token, '/link-out.txt')).toBeNull();
    expect(await read(token, '/up/secret.txt')).toBeNull();
    expect(await read(token, '/img')).toBeNull();
    expect(await read(token, '/..%2Fsecret.txt')).toBeNull();
    expect(await read('0'.repeat(32), '/img/a.png')).toBeNull();
    const without = addPreviewFrame('', 'deny');
    expect(await read(without, '/img/a.png')).toBeNull();
  });
});

describe("a phone sheet's bottom edge", () => {
  const block = (css: string, selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at) + 1);
  };

  it("pads no sheet of the shell's own by the safe area, which showed a band under Preview's page", () => {
    const ios = fs.readFileSync('src/renderer/src/web/ios.css', 'utf8');
    const android = fs.readFileSync('src/renderer/src/web/android.css', 'utf8');
    expect(block(ios, '.ios-sheet-body')).not.toMatch(/padding/);
    expect(block(android, '.md-own-card')).not.toMatch(/padding/);
    expect(block(ios, '.ios-own-sheet:not(.tablet-sheet) .ios-sheet-body')).toContain('--viewer-end: env(safe-area-inset-bottom)');
    expect(block(android, '.md-own-dialog:not(.tablet) .md-own-card')).toContain('--viewer-end: env(safe-area-inset-bottom)');
    // Android's bottom actions take the inset themselves, edge to edge.
    expect(block(android, '.md-own-dialog:not(.tablet) .md-own-card > .md-bottom-actions')).toContain('env(safe-area-inset-bottom)');
  });

  it("pads the viewer's scrollers' ends instead", () => {
    const phone = fs.readFileSync('src/renderer/src/web/phone.css', 'utf8');
    expect(block(phone, '.ph-viewer')).toContain('var(--viewer-end, 0px)');
    expect(block(phone, '.ph-viewer.code')).toContain('var(--viewer-end, 0px)');
    for (const f of ['src/renderer/src/web/PdfPages.tsx', 'src/renderer/src/components/preview/PptxSlides.tsx', 'src/renderer/src/components/preview/SheetTable.tsx', 'src/renderer/src/components/preview/XlsxSheets.tsx', 'src/renderer/src/components/preview/HtmlFrame.tsx'])
      expect(fs.readFileSync(f, 'utf8'), f).toContain('var(--viewer-end, 0px)');
  });

  it("gives an HTML page room after its end only when its viewer asks, from the frame's parent", () => {
    const doc = previewHtmlDocument('<p>x</p>');
    expect(doc).toContain(`e.data['${PREVIEW_END}']`);
    expect(doc).toContain('e.source!==parent');
    expect(doc).toContain('html::after');
    expect(doc).toContain('Math.min(n,400)');
    expect(doc.indexOf(PREVIEW_END)).toBeLessThan(doc.indexOf('<p>x</p>'));
  });
});

describe("previewFrameCsp with the page's folder", () => {
  const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.slice(d.indexOf(' ') + 1)]));

  it("loads scripts, styles, images, fonts and media from the page's own address, and keeps the network setting for the rest", () => {
    for (const remote of [true, false]) {
      const d = directives(previewFrameCsp(remote, false, true));
      for (const k of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) expect(d[k].split(' '), k).toContain("'self'");
      expect(d['connect-src'].split(' ')).not.toContain("'self'");
      expect(d['frame-src'].split(' ')).not.toContain("'self'");
      expect(d.sandbox).toBe('allow-scripts');
      expect(d['default-src']).toBe(remote ? "* 'unsafe-inline' 'unsafe-eval' data: blob:" : "'none'");
      expect(d['connect-src']).toBe(remote ? '* data: blob:' : "'none'");
    }
    const deny = directives(previewFrameCsp(false, false, true));
    expect(deny['img-src']).toBe("'self' data: blob:");
    for (const k of ['script-src', 'img-src', 'style-src', 'font-src', 'media-src']) expect(deny[k].split(' '), k).not.toContain('*');
    // Without a folder nothing changes.
    expect(previewFrameCsp(false)).not.toContain("'self'");
    expect(previewFrameCsp(true, true)).not.toContain("'self'");
  });
});

describe('the loads a page gets its files for', () => {
  it('on a device: by Sec-Fetch-Dest, and never without it', () => {
    for (const d of ['image', 'style', 'script', 'font', 'audio', 'video', 'track']) expect(previewDeviceLoad(d), d).toBe(true);
    for (const d of [undefined, '', 'empty', 'document', 'iframe', 'frame', 'object', 'embed', 'worker', 'sharedworker', 'serviceworker', 'manifest', 'report', 'json', 'webidentity'])
      expect(previewDeviceLoad(d), String(d)).toBe(false);
  });

  it('on the computer: by webRequest resourceType, the page itself only as a frame', () => {
    const page = 'looper-preview://0123abcd/';
    expect(previewDesktopLoad(page, 'subFrame')).toBe(true);
    expect(previewDesktopLoad(page, 'xhr')).toBe(false);
    for (const t of ['image', 'stylesheet', 'script', 'font', 'media']) expect(previewDesktopLoad(page + 'img/a.png', t), t).toBe(true);
    for (const t of ['xhr', 'subFrame', 'mainFrame', 'object', 'ping', 'cspReport', 'webSocket', 'other']) expect(previewDesktopLoad(page + 'notes.txt', t), t).toBe(false);
    // Other addresses are none of this listener's business.
    expect(previewDesktopLoad('file:///C:/Looper/index.html', 'xhr')).toBe(true);
  });
});

describe('Remote Access: /preview-frame/<token>/', () => {
  const IMG = { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' };
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, log() {} } as unknown as Logger;

  async function server() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-pvra-'));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, 'static'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'static', 'index.html'), '<!doctype html><title>Looper</title>');
    const settings = RemoteAccessSettingsSchema.parse({ enabled: true, sources: ['local'], port: 0 });
    const ra = new RemoteAccess({
      dataDir: path.join(root, 'data'),
      log: quiet,
      settings: () => settings,
      emit: () => undefined,
      version: '9.9.9',
      now: () => Date.now(),
      staticDir: path.join(root, 'static'),
      createProvider: () => new LocalProvider(),
    });
    cleanups.push(() => ra.dispose());
    await ra.apply(settings);
    const port = ra.state().port!;
    const get = (p: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: `localhost:${port}`, ...headers }, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
    const { code } = ra.newPairingCode();
    const paired = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/pair', headers: { Host: `localhost:${port}`, [REQUEST_HEADER]: REQUEST_HEADER_VALUE, 'Content-Type': 'application/json' }, agent: false },
        (res) => {
          res.resume();
          res.on('end', () => resolve(String(res.headers['set-cookie']).split(';')[0]));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ code, name: 'Phone' }));
    });
    return { get, cookie: paired };
  }

  it("serves the page to the paired device, and its folder's files by the token the device was given", async () => {
    const s = site();
    const { get, cookie } = await server();
    const token = addPreviewFrame('<img src="img/a.png">', 'deny', true, await previewFolderOf(s.html));
    expect((await get(`/preview-frame/${token}/`)).status).toBe(401);
    const page = await get(`/preview-frame/${token}/`, { Cookie: cookie });
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain('<img src="img/a.png">');
    expect((await get(`/preview-frame/${token}`, { Cookie: cookie })).status).toBe(200);
    // A sandboxed page's loads come without the SameSite=Strict cookie in Chromium.
    const png = await get(`/preview-frame/${token}/img/a.png`, IMG);
    expect(png.status).toBe(200);
    expect(png.body.equals(PNG)).toBe(true);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect(png.headers['content-security-policy']).toBe(previewFrameCsp(false, true, true));
    expect((await get(`/preview-frame/${token}/deep/er/x.txt`, { 'Sec-Fetch-Dest': 'style', 'Sec-Fetch-Mode': 'no-cors' })).body.toString()).toBe('deep');
  });

  it("refuses what's outside the folder, an unknown token and a page the computer's window was given", async () => {
    const s = site();
    const { get } = await server();
    const token = addPreviewFrame('', 'deny', true, await previewFolderOf(s.html));
    for (const p of ['..%2Fsecret.txt', '..%2fsecret.txt', '%2e%2e%2fsecret.txt', 'img%2F..%2F..%2Fsecret.txt', '..%5Csecret.txt', 'link-out.txt', 'up/secret.txt', 'img', 'a%00.png']) {
      const r = await get(`/preview-frame/${token}/${p}`, IMG);
      expect(r.status, p).toBe(404);
      expect(String(r.body), p).not.toContain('TOP SECRET');
    }
    // Dot segments the URL parser resolves stay under the token, or leave the route.
    expect(String((await get(`/preview-frame/${token}/../../secret.txt`, IMG)).body)).not.toContain('TOP SECRET');
    expect((await get(`/preview-frame/${'0'.repeat(32)}/img/a.png`, IMG)).status).toBe(404);
    const desktop = addPreviewFrame('', 'deny', false, await previewFolderOf(s.html));
    expect((await get(`/preview-frame/${desktop}/img/a.png`, IMG)).status).toBe(404);
  });

  it("serves a page's files only for what the page shows or runs, never for its scripts to read or as a page", async () => {
    const s = site();
    fs.writeFileSync(path.join(s.page, 'notes.txt'), 'PRIVATE NOTES');
    const { get } = await server();
    const token = addPreviewFrame('', 'allow', true, await previewFolderOf(s.html));
    const at = (p: string) => `/preview-frame/${token}/${p}`;
    // fetch() and XHR (empty, in either mode), a page or a frame of a file, and a request without Fetch Metadata.
    for (const h of [{} as Record<string, string>, { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'no-cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-Dest': 'frame' }, { 'Sec-Fetch-Dest': 'object' }] as Record<string, string>[]) {
      const r = await get(at('notes.txt'), h);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(String(r.body)).not.toContain('PRIVATE');
      expect((await get(at('m.js'), h)).status, JSON.stringify(h)).toBe(403);
    }
    // What the page shows or runs loads; only a CORS-mode font or module script gets Access-Control-Allow-Origin.
    const img = await get(at('img/a.png'), { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' });
    expect(img.status).toBe(200);
    expect(img.headers['access-control-allow-origin']).toBeUndefined();
    expect((await get(at('s.css'), { 'Sec-Fetch-Dest': 'style', 'Sec-Fetch-Mode': 'no-cors' })).status).toBe(200);
    const classic = await get(at('m.js'), { 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors' });
    expect(classic.status).toBe(200);
    expect(classic.headers['access-control-allow-origin']).toBeUndefined();
    expect((await get(at('m.js'), { 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'cors' })).headers['access-control-allow-origin']).toBe('*');
    const font = await get(at('f.woff2'), { 'Sec-Fetch-Dest': 'font', 'Sec-Fetch-Mode': 'cors' });
    expect(font.status).toBe(200);
    expect(font.headers['access-control-allow-origin']).toBe('*');
  });
});
