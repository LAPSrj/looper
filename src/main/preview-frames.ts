import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { previewFrameCsp, previewHtmlDocument, type PreviewNetwork } from '../shared/preview';

/** An HTML file Preview shows, as its frame is served: the page and the policy it runs under. */
export interface PreviewFrame {
  html: string;
  csp: string;
  /** Issued to a remote device, which Remote Access serves it to. */
  device: boolean;
  /**
   * The real path of the folder the HTML file is in: the page loads the files in it and its subfolders by their
   * relative addresses. Unset when the file's folder isn't known: then the page is the only thing served.
   */
  folder?: string;
}

/** How long a page stays served, and how many are kept: a window reloading its frame gets it again. */
const TTL_MS = 30 * 60_000;
const MAX = 40;
const frames = new Map<string, PreviewFrame & { at: number }>();

function prune(now: number): void {
  for (const [token, f] of frames) if (now - f.at > TTL_MS) frames.delete(token);
  while (frames.size > MAX) frames.delete(frames.keys().next().value as string);
}

/**
 * Keeps an HTML file to serve to Preview's frame under an unguessable token: from looper-preview://<token>/ on
 * the computer, /preview-frame/<token> on Remote Access. `network`: 'ask' serves it with loads from the internet
 * blocked and tells the viewer when one was, for its bar. `device`: for a device's browser, whose popup blocker
 * lets a link open from the frame only on a tap; the computer's frame opens nothing, and Looper's preload sends
 * the links the user clicks in it to main (inPreviewPage). `folder`: the real path of the folder the file is in
 * (previewFolderOf), whose files the page then loads by relative address (previewFrameResource).
 */
export function addPreviewFrame(html: string, network: PreviewNetwork, device = false, folder?: string): string {
  const now = Date.now();
  prune(now);
  const token = randomBytes(16).toString('hex');
  frames.set(token, {
    html: previewHtmlDocument(html, { reportBlocked: network === 'ask' }),
    csp: previewFrameCsp(network === 'allow', device, !!folder),
    device,
    ...(folder ? { folder } : {}),
    at: now,
  });
  return token;
}

/**
 * The real path of the folder an HTML file at `file` (an absolute path on this computer) is in, for its page to
 * load the files next to it; undefined when it isn't a file this process can reach.
 */
export async function previewFolderOf(file: string): Promise<string | undefined> {
  if (!path.isAbsolute(file)) return undefined;
  try {
    if (!(await fs.promises.stat(file)).isFile()) return undefined;
    return await fs.promises.realpath(path.dirname(file));
  } catch {
    return undefined;
  }
}

/**
 * The names a page's address under its token is made of (`pathname`: a URL's path, still percent-encoded, after
 * the token), decoded; null when one isn't a plain name inside the folder: empty, . or .., or holding a slash, a
 * backslash, a NUL or a colon (a drive or an NTFS stream), encoded or not, or only dots and spaces, which Windows
 * reads as . or ...
 */
export function previewResourceNames(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null;
  const names: string[] = [];
  for (const raw of pathname.slice(1).split('/')) {
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!name || /[\/\\\0:]/.test(name) || /^[. ]+$/.test(name)) return null;
    names.push(name);
  }
  return names;
}

/** Whether `p` is inside the folder `root` (both absolute, in `api`'s flavor) and isn't the folder itself. */
export function insideFolder(root: string, p: string, api: path.PlatformPath = path): boolean {
  const rel = api.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel);
}

/**
 * The real path of the file a page names by `pathname` (previewResourceNames) inside `folder` (a real path), when
 * that file is in the folder or a subfolder of it once every link on the way is followed; null otherwise.
 */
export async function previewResourceFile(folder: string, pathname: string): Promise<string | null> {
  const names = previewResourceNames(pathname);
  if (!names) return null;
  const joined = path.join(folder, ...names);
  if (!insideFolder(folder, joined)) return null;
  let real: string;
  try {
    real = await fs.promises.realpath(joined);
  } catch {
    return null;
  }
  return insideFolder(folder, real) ? real : null;
}

/** The Content-Type a page's file is served with, by its extension. */
const RESOURCE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

/**
 * A page's files are served only for what the page shows or runs: images, styles, scripts, fonts and media, never for
 * what its scripts read (fetch, XHR, a beacon) or for a page of their own (a document, a frame), which could read the
 * folder in turn and, with internet access allowed, send it out. On a device, by Fetch Metadata's Sec-Fetch-Dest,
 * which a page's scripts can't set and the browser sends to every origin Remote Access has (localhost and https).
 */
const DEVICE_LOADS = new Set(['image', 'style', 'script', 'font', 'audio', 'video', 'track']);
/** The same loads on the computer, by Electron's webRequest resourceType (the scheme gets no Sec-Fetch-* headers). */
const DESKTOP_LOADS = new Set(['image', 'stylesheet', 'script', 'font', 'media']);

/** Whether Remote Access serves a page's file for a load with this Sec-Fetch-Dest; never without one. */
export function previewDeviceLoad(dest: string | undefined): boolean {
  return !!dest && DEVICE_LOADS.has(dest);
}

/**
 * Whether the computer lets a load from a looper-preview:// address through (session.webRequest): the page itself
 * only as a frame, and its files only as the loads above; anything else is another page's business.
 */
export function previewDesktopLoad(url: string, resourceType: string): boolean {
  if (!url.startsWith('looper-preview:')) return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return pathname === '/' ? resourceType === 'subFrame' || resourceType === 'mainFrame' : DESKTOP_LOADS.has(resourceType);
}

/**
 * A font or a module script loads in CORS mode from the page's own origin, which its sandbox makes opaque, so only
 * those get Access-Control-Allow-Origin, and only for that load: the page's scripts can show its files, never read them.
 */
export const previewCorsType = (type: string): boolean => /^(font\/|text\/javascript)/.test(type);

/** A file a previewed page loads by a relative address: open, with the headers it's served with. The reader closes `handle`. */
export interface PreviewResource {
  handle: FileHandle;
  size: number;
  headers: Record<string, string>;
}

/**
 * The file the page under `token` names by `pathname` (its address after the token), when the page's folder is
 * known and the file is inside it (previewResourceFile); null otherwise. It's served with the page's own
 * Content-Security-Policy, so an HTML or SVG file opened from it runs as sandboxed as the page. The caller has checked
 * the kind of load (previewDeviceLoad, previewDesktopLoad); `cors`: whether this load gets Access-Control-Allow-Origin.
 */
export async function previewFrameResource(token: string, pathname: string, cors: (type: string) => boolean): Promise<PreviewResource | null> {
  const f = previewFrame(token);
  if (!f?.folder) return null;
  const file = await previewResourceFile(f.folder, pathname);
  // Checked before opening it: opening a FIFO would wait for a writer.
  if (!file || !(await fs.promises.stat(file).catch(() => null))?.isFile()) return null;
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('not a file');
    const type = RESOURCE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return {
      handle,
      size: st.size,
      headers: {
        ...previewFrameHeaders(f),
        'Content-Type': type,
        'Content-Length': String(st.size),
        ...(cors(type) ? { 'Access-Control-Allow-Origin': '*' } : {}),
      },
    };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

/** A frame of a window as main sees it (Electron's WebFrameMain). */
export interface FrameLike {
  readonly url: string;
  readonly parent: FrameLike | null;
}

/**
 * Whether a frame is a page Preview shows on the computer, or a frame inside one, at any depth: it, or a frame
 * it's in, is served from looper-preview://. A link the user clicks in one opens in the browser.
 */
export function inPreviewPage(frame: FrameLike | null | undefined): boolean {
  for (let f = frame; f; f = f.parent) if (f.url.startsWith('looper-preview://')) return true;
  return false;
}

/** The page kept under `token`, or undefined once it's gone. */
export function previewFrame(token: string): PreviewFrame | undefined {
  prune(Date.now());
  return frames.get(token);
}

/** The headers a previewed page is served with, wherever it's served. */
export function previewFrameHeaders(f: PreviewFrame): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': f.csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
