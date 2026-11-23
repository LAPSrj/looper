import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { nativeImage } from 'electron';
import type { Attachment } from '../shared/chat';
import type { ThumbnailIn, ThumbnailOut } from './thumbnail-worker';

/**
 * Thumbnails of image files, for every window and phone. Decoding an image on the main process's thread froze the
 * whole app, because on Windows that thread also takes every window's input: 20-50 ms for one phone screenshot,
 * and a Files tab of screenshots asked again for all of them on each chat switch. So PNGs and JPEGs are decoded in
 * a worker thread (Electron's nativeImage isn't there or in a utility process; pngjs and libjpeg-turbo built to
 * WebAssembly are), other formats by nativeImage one image at a time with input let in between, and each
 * thumbnail is kept by the file's path, size and modified time.
 */

/** A thumbnail's height in CSS px. The worker gets it with each request: importing its modules here would put them in a chunk inside app.asar, where the worker can't load them. */
const THUMBNAIL_HEIGHT = 160;
const CACHE_MAX = 300;
/** The worker and the decoded images' memory (40 MB after a Files tab of screenshots) go back soon after. */
const WORKER_IDLE_MS = 5_000;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** A thumbnail data URL of the image at `file` (a path the computer opens); null when it's gone or can't be drawn. */
export async function thumbnail(file: string): Promise<string | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  if (cache.has(key)) {
    const url = cache.get(key)!;
    cache.delete(key);
    cache.set(key, url);
    return url;
  }
  let made = pending.get(key);
  if (!made) {
    made = make(file)
      .catch(() => null)
      .then((url) => {
        pending.delete(key);
        cache.set(key, url);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
        return url;
      });
    pending.set(key, made);
  }
  return made;
}

/**
 * Attached files with each PNG's and JPEG's size as it shows, which the worker reads from the start of the file: a
 * message box draws the image's tile at its thumbnail's size before the thumbnail comes. (The worker's modules stay
 * out of this one, as for the thumbnail's height.)
 */
export const withImageSizes = (attachments: Attachment[]): Promise<Attachment[]> =>
  Promise.all(
    attachments.map(async (a) => {
      if (!a.image || a.width || !/\.(png|jpe?g)$/i.test(a.path)) return a;
      const size = (await ask({ file: a.path, height: THUMBNAIL_HEIGHT, sizeOnly: true }))?.size;
      return size ? { ...a, ...size } : a;
    }),
  );

function make(file: string): Promise<string | null> {
  return /\.(png|jpe?g)$/i.test(file) ? inWorker(file) : withNativeImage(file);
}

// ---------- PNG and JPEG: the worker ----------

let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const waiting = new Map<number, (msg: ThumbnailOut | null) => void>();

/** In a packaged app __dirname is inside app.asar, which a Worker can't load from; asarUnpack puts a copy beside it. */
function workerFile(): string {
  const file = path.join(__dirname, 'thumbnail-worker.js');
  return file.includes('app.asar') && !file.includes('app.asar.unpacked') ? file.replace('app.asar', 'app.asar.unpacked') : file;
}

function startWorker(): Worker {
  const w = new Worker(workerFile());
  const gone = () => {
    if (worker === w) worker = null;
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  w.on('message', (msg: ThumbnailOut) => {
    const done = waiting.get(msg.id);
    waiting.delete(msg.id);
    done?.(msg);
    if (waiting.size === 0) idle = setTimeout(stopWorker, WORKER_IDLE_MS);
  });
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

/** The worker is a V8 of its own (about 8.5 MB): it ends once nothing has asked for a while. */
function stopWorker(): void {
  idle = null;
  if (worker && waiting.size === 0) void worker.terminate();
}

/** A request to the worker, and its answer; null when the worker went away first. */
function ask(req: Omit<ThumbnailIn, 'id'>): Promise<ThumbnailOut | null> {
  if (idle) clearTimeout(idle);
  idle = null;
  worker ??= startWorker();
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ id, ...req } satisfies ThumbnailIn);
  });
}

const inWorker = (file: string): Promise<string | null> => ask({ file, height: THUMBNAIL_HEIGHT }).then((msg) => msg?.url ?? null);

// ---------- other images: nativeImage, one at a time ----------

let queue: Promise<unknown> = Promise.resolve();

function withNativeImage(file: string): Promise<string | null> {
  const run = queue.then(async () => {
    const bytes = await fs.promises.readFile(file);
    // Input that came in while the file was read goes first.
    await new Promise((r) => setImmediate(r));
    const img = nativeImage.createFromBuffer(bytes);
    if (img.isEmpty()) return null;
    const { height } = img.getSize();
    return (height > THUMBNAIL_HEIGHT ? img.resize({ height: THUMBNAIL_HEIGHT }) : img).toDataURL();
  });
  queue = run.catch(() => undefined);
  return run;
}
