import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isJpeg, jpegOrientation, pngSize, shrink, upright } from '../src/main/thumbnail-shrink';

let dir: string;
let workerFile: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnails-'));
  workerFile = path.join(dir, 'thumbnail-worker.js');
  const esbuild = await import('esbuild');
  // Vite's ?inline, which the app's build uses for the WebAssembly: the file as a data URL.
  const inline = {
    name: 'inline',
    setup(b: import('esbuild').PluginBuild) {
      b.onResolve({ filter: /\?inline$/ }, (a) => ({ path: createRequire(import.meta.url).resolve(a.path.replace(/\?inline$/, '')), namespace: 'inline' }));
      b.onLoad({ filter: /.*/, namespace: 'inline' }, (a) => ({ contents: `export default ${JSON.stringify(`data:application/wasm;base64,${fs.readFileSync(a.path).toString('base64')}`)}`, loader: 'js' }));
    },
  };
  await esbuild.build({ entryPoints: [path.join(process.cwd(), 'src/main/thumbnail-worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: workerFile, plugins: [inline], logLevel: 'silent' });
}, 60_000);

/** 32 × 16, left half red and right half blue, stored with EXIF orientation 6 (show it turned 90° clockwise). */
const TURNED_JPEG = Buffer.from(
  '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4AAQSkZJRgABAQAAAQABAAD/2wCEAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgoBAgICAgICBQMDBQoHBgcKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCv/AABEIABAAIAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APi+v5TP9/AoA+Q6/wCqg/5rwoA+vK/5Vz/pQCgD5Dr/AKqD/mvCgD//2Q==',
  'base64',
);
/** The same photo without its EXIF segment (36 bytes after the start marker). */
const PLAIN_JPEG = Buffer.concat([TURNED_JPEG.subarray(0, 2), TURNED_JPEG.subarray(38)]);

const isRed = (px: ArrayLike<number>, at: number) => px[at] > 200 && px[at + 2] < 60;
const isBlue = (px: ArrayLike<number>, at: number) => px[at + 2] > 200 && px[at] < 60;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A PNG file `width` × `height`: the top half opaque red, the bottom half transparent. */
function writePng(name: string, width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = 255;
      png.data[i + 3] = y < height / 2 ? 255 : 0;
    }
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

function inWorker(file: string, height: number): Promise<string | null> {
  const w = new Worker(workerFile);
  return new Promise<string | null>((resolve, reject) => {
    w.once('message', (m: { url: string | null }) => resolve(m.url));
    w.once('error', reject);
    w.postMessage({ id: 1, file, height });
  }).finally(() => void w.terminate());
}

const decode = (url: string) => PNG.sync.read(Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));

describe('thumbnails', () => {
  it('reads a PNG size from its header, and nothing from another file', () => {
    expect(pngSize(fs.readFileSync(writePng('size.png', 7, 9)))).toEqual({ width: 7, height: 9 });
    expect(pngSize(Buffer.from('GIF89a and more bytes than a header'))).toBeNull();
  });

  it('averages each block, weighing colour by alpha', () => {
    // Opaque red, two transparent blues that count for nothing, opaque blue: half the alpha, red and blue mixed.
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255]);
    const out = shrink({ width: 2, height: 2, data }, 1);
    expect([...out.data]).toEqual([128, 0, 128, 128]);
    expect(out.width).toBe(1);
    const tall = { width: 1, height: 1, data: new Uint8Array(4) };
    expect(shrink(tall, 160)).toBe(tall);
  });

  it('the worker shrinks a tall PNG to the height asked, and keeps a short one as its file', async () => {
    const tall = decode((await inWorker(writePng('tall.png', 40, 400), 160))!);
    expect([tall.width, tall.height]).toEqual([16, 160]);
    expect([...tall.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(tall.data[(159 * 16 + 15) * 4 + 3]).toBe(0);
    const shortFile = writePng('short.png', 10, 20);
    expect(await inWorker(shortFile, 160)).toBe(`data:image/png;base64,${fs.readFileSync(shortFile).toString('base64')}`);
    expect(await inWorker(path.join(dir, 'gone.png'), 160)).toBeNull();
  }, 30_000);

  it('reads a JPEG’s EXIF orientation, and 1 when it has none or isn’t a JPEG', () => {
    expect(jpegOrientation(TURNED_JPEG)).toBe(6);
    expect(jpegOrientation(PLAIN_JPEG)).toBe(1);
    expect(jpegOrientation(TURNED_JPEG.subarray(0, 20))).toBe(1);
    expect(isJpeg(PLAIN_JPEG)).toBe(true);
    expect(isJpeg(Buffer.from('GIF89a and more'))).toBe(false);
  });

  it('turns pixels upright for each EXIF orientation', () => {
    // 2 × 1: pixel 1 then pixel 2. Each orientation's width, height and pixels, row by row.
    const src = { width: 2, height: 1, data: new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]) };
    const shown = (o: number) => {
      const out = upright(src, o);
      return [out.width, out.height, ...Array.from({ length: out.width * out.height }, (_, i) => out.data[i * 4])];
    };
    expect(shown(1)).toEqual([2, 1, 1, 2]);
    expect(shown(2)).toEqual([2, 1, 2, 1]);
    expect(shown(3)).toEqual([2, 1, 2, 1]);
    expect(shown(4)).toEqual([2, 1, 1, 2]);
    expect(shown(5)).toEqual([1, 2, 1, 2]);
    expect(shown(6)).toEqual([1, 2, 1, 2]);
    expect(shown(7)).toEqual([1, 2, 2, 1]);
    expect(shown(8)).toEqual([1, 2, 2, 1]);
  });

  it('the worker makes an upright thumbnail of a JPEG a phone stored sideways', async () => {
    const turned = path.join(dir, 'turned.jpg');
    fs.writeFileSync(turned, TURNED_JPEG);
    // Upright it's 16 × 32 with red on top: decoded at 1/4 (8 × 4 stored), then turned to 4 × 8.
    const thumb = decode((await inWorker(turned, 8))!);
    expect([thumb.width, thumb.height]).toEqual([4, 8]);
    expect(isRed(thumb.data, 0)).toBe(true);
    expect(isBlue(thumb.data, (7 * 4 + 3) * 4)).toBe(true);
    const plain = path.join(dir, 'plain.jpg');
    fs.writeFileSync(plain, PLAIN_JPEG);
    const flat = decode((await inWorker(plain, 8))!);
    expect([flat.width, flat.height]).toEqual([16, 8]);
    expect(isRed(flat.data, 0)).toBe(true);
    expect(isBlue(flat.data, 15 * 4)).toBe(true);
  }, 30_000);

  it('the worker gives no thumbnail for a broken JPEG, and still decodes the next one', async () => {
    const broken = path.join(dir, 'broken.jpg');
    fs.writeFileSync(broken, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 7)]));
    const plain = path.join(dir, 'plain-again.jpg');
    fs.writeFileSync(plain, PLAIN_JPEG);
    const w = new Worker(workerFile);
    const urls = new Map<number, string | null>();
    try {
      await new Promise<void>((resolve, reject) => {
        w.on('message', (m: { id: number; url: string | null }) => {
          urls.set(m.id, m.url);
          if (urls.size === 2) resolve();
        });
        w.once('error', reject);
        w.postMessage({ id: 1, file: broken, height: 8 });
        w.postMessage({ id: 2, file: plain, height: 8 });
      });
    } finally {
      void w.terminate();
    }
    expect(urls.get(1)).toBeNull();
    expect(urls.get(2)).toMatch(/^data:image\/png;base64,/);
  }, 30_000);

  it("the main process imports the worker's modules only as types, so they stay out of the chunks inside app.asar", () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/thumbnails.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /from '\.\/thumbnail-/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});
