import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageHeadSize, jpegSize } from '../src/main/thumbnail-shrink';
import type { ThumbnailOut } from '../src/main/thumbnail-worker';

// An attached image's size, read as it's attached, so the message box draws its tile at its thumbnail's size before
// the thumbnail comes (ChatRows' ThumbButton). The worker reads it: main/thumbnails.ts keeps the worker's modules out.

/** 32 × 16, stored with EXIF orientation 6 (show it turned 90° clockwise): tests/thumbnails.test.ts's. */
const TURNED_JPEG = Buffer.from(
  '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4AAQSkZJRgABAQAAAQABAAD/2wCEAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgoBAgICAgICBQMDBQoHBgcKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCv/AABEIABAAIAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APi+v5TP9/AoA+Q6/wCqg/5rwoA+vK/5Vz/pQCgD5Dr/AKqD/mvCgD//2Q==',
  'base64',
);
/** The same photo without its EXIF segment. */
const PLAIN_JPEG = Buffer.concat([TURNED_JPEG.subarray(0, 2), TURNED_JPEG.subarray(38)]);

describe("an image's size from the start of its file", () => {
  it("reads a JPEG's frame header, turned as its EXIF says", () => {
    expect(jpegSize(PLAIN_JPEG)).toEqual({ width: 32, height: 16 });
    expect(jpegSize(TURNED_JPEG)).toEqual({ width: 16, height: 32 });
    // A start that ends before the frame header, and a file that isn't a JPEG.
    expect(jpegSize(TURNED_JPEG.subarray(0, 40))).toBeNull();
    expect(jpegSize(Buffer.from('GIF89a and more bytes than a header'))).toBeNull();
  });

  it('reads a PNG or a JPEG, and nothing else', () => {
    const png = PNG.sync.write(Object.assign(new PNG({ width: 1179, height: 2556 }), { data: Buffer.alloc(1179 * 2556 * 4) }));
    expect(imageHeadSize(png.subarray(0, 64))).toEqual({ width: 1179, height: 2556 });
    expect(imageHeadSize(TURNED_JPEG)).toEqual({ width: 16, height: 32 });
    expect(imageHeadSize(Buffer.from('RIFF....WEBPVP8 '))).toBeNull();
  });
});

describe('the thumbnail worker, asked for a size only', () => {
  let dir: string;
  let worker: Worker;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-size-'));
    const workerFile = path.join(dir, 'thumbnail-worker.js');
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
    worker = new Worker(workerFile);
  }, 60_000);
  afterAll(async () => {
    await worker?.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ask = (file: string, id: number) =>
    new Promise<ThumbnailOut>((resolve) => {
      const on = (msg: ThumbnailOut) => {
        if (msg.id !== id) return;
        worker.off('message', on);
        resolve(msg);
      };
      worker.on('message', on);
      worker.postMessage({ id, file, height: 160, sizeOnly: true });
    });

  it("answers with the size as it shows and no thumbnail, or null for a file it can't read", async () => {
    const turned = path.join(dir, 'photo.jpg');
    fs.writeFileSync(turned, TURNED_JPEG);
    const shot = path.join(dir, 'shot.png');
    fs.writeFileSync(shot, PNG.sync.write(Object.assign(new PNG({ width: 300, height: 650 }), { data: Buffer.alloc(300 * 650 * 4) })));
    expect(await ask(turned, 1)).toEqual({ id: 1, url: null, size: { width: 16, height: 32 } });
    expect(await ask(shot, 2)).toEqual({ id: 2, url: null, size: { width: 300, height: 650 } });
    expect(await ask(path.join(dir, 'gone.png'), 3)).toEqual({ id: 3, url: null, size: null });
  });
});

describe('the message box gets the size with the files it attaches', () => {
  it('in the attachments that chat:attach, chat:pickFiles, runs:attach and runs:pickFiles answer with, and that a draft keeps', () => {
    const ipc = fs.readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8');
    for (const channel of ['chat:attach', 'chat:pickFiles', 'runs:attach', 'runs:pickFiles']) {
      const handler = new RegExp(`ipc\\.handle\\('${channel}'[\\s\\S]*?\\n {2}\\}?\\);?\\n`).exec(ipc)?.[0] ?? '';
      expect(handler, channel).toMatch(/withImageSizes\(await engine\.attachTo(Chat|Run)\(/);
    }
    const take = /const takeAttachments[\s\S]*?\n {4}\}\);/.exec(ipc)?.[0] ?? '';
    expect(take).toMatch(/width && height \? \{ width, height \}/);
  });
});
