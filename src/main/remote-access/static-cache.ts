import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/**
 * Static responses: an ETag per file (a content hash, computed once) with 304 on
 * If-None-Match, and brotli or gzip by Accept-Encoding for text. Assets are
 * immutable, so each is compressed once, on its first request, and kept in
 * memory (a build-time pass would need its own step, and brotli at its top
 * quality takes seconds on the 1.5 MB bundle; quality 9 takes a fraction of a
 * second and is about 9% larger).
 */

export type Encoding = 'br' | 'gzip';

/** Below this a response isn't worth compressing. */
const MIN_COMPRESS_BYTES = 256;
/** Bodies made in memory (index.html per host, icons) that are kept; the oldest goes first. */
const MAX_BODIES = 64;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** The coding to answer an Accept-Encoding header with: brotli, else gzip, else none. */
export function negotiateEncoding(acceptEncoding: string | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    q.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const allowed = (coding: string): boolean => (q.get(coding) ?? q.get('*') ?? 0) > 0;
  if (allowed('br')) return 'br';
  if (allowed('gzip') || allowed('x-gzip')) return 'gzip';
  return null;
}

/** Whether an If-None-Match header matches this ETag (weak comparison, as for 304). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string): string => t.trim().replace(/^W\//, '');
  const mine = bare(etag);
  return ifNoneMatch.split(',').some((t) => bare(t) === '*' || bare(t) === mine);
}

const compressibleType = (type: string): boolean => /^text\/|json|javascript|xml|svg/i.test(type);

const hashOf = (data: crypto.BinaryLike): string => crypto.createHash('sha256').update(data).digest('base64url').slice(0, 22);

/** A body held in memory with its ETag and the compressed forms made so far. */
export interface Payload {
  type: string;
  body: Buffer;
  /** Strong ETag of the uncompressed body. */
  etag: string;
  encoded: Map<Encoding, Promise<Buffer>>;
}

export function makePayload(type: string, body: Buffer): Payload {
  return { type, body, etag: `"${hashOf(body)}"`, encoded: new Map() };
}

const compresses = (p: Payload): boolean => compressibleType(p.type) && p.body.length >= MIN_COMPRESS_BYTES;

/** Each coding is a different representation, so it gets its own ETag. */
const variantTag = (etag: string, enc: Encoding | null): string => (enc ? `${etag.slice(0, -1)}-${enc}"` : etag);

function encode(p: Payload, enc: Encoding): Promise<Buffer> {
  let done = p.encoded.get(enc);
  if (!done) {
    done =
      enc === 'br'
        ? brotli(p.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: p.body.length } })
        : gzip(p.body, { level: 9 });
    p.encoded.set(enc, done);
    // A failed attempt isn't kept, so the next request tries again.
    done.catch(() => p.encoded.delete(enc));
  }
  return done;
}

/** Answer 304 and return true when the request's If-None-Match matches. */
function answerNotModified(req: http.IncomingMessage, res: http.ServerResponse, etag: string, headers: http.OutgoingHttpHeaders): boolean {
  if (!etagMatches(req.headers['if-none-match'], etag)) return false;
  res.writeHead(304, headers);
  res.end();
  return true;
}

/** Send a body held in memory: ETag, 304, and brotli or gzip when the client accepts one. */
export async function sendPayload(req: http.IncomingMessage, res: http.ServerResponse, p: Payload, cacheControl: string): Promise<void> {
  const zip = compresses(p);
  const enc = zip ? negotiateEncoding(req.headers['accept-encoding']) : null;
  const etag = variantTag(p.etag, enc);
  const headers: http.OutgoingHttpHeaders = { 'Cache-Control': cacheControl, ETag: etag };
  if (zip) headers['Vary'] = 'Accept-Encoding';
  if (answerNotModified(req, res, etag, headers)) return;
  const body = enc ? await encode(p, enc) : p.body;
  res.writeHead(200, { ...headers, 'Content-Type': p.type, 'Content-Length': body.length, ...(enc ? { 'Content-Encoding': enc } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** The per-file state the cache keeps: valid while the file's size and mtime are unchanged. */
interface FileEntry {
  mtimeMs: number;
  size: number;
}

export class StaticCache {
  private readonly payloads = new Map<string, FileEntry & { payload: Payload }>();
  private readonly tags = new Map<string, FileEntry & { etag: string }>();
  private readonly bodies = new Map<string, Payload>();

  /** A body made in memory (index.html for a host, the manifest, an icon): the same content gets the same payload, so its compressed forms are made once. */
  intern(type: string, body: Buffer): Payload {
    const key = `${type}\0${hashOf(body)}`;
    let p = this.bodies.get(key);
    if (!p) {
      p = makePayload(type, body);
      if (this.bodies.size >= MAX_BODIES) this.bodies.delete(this.bodies.keys().next().value as string);
      this.bodies.set(key, p);
    }
    return p;
  }

  /** The whole file held in memory (for text, which is compressed); read again when it changes on disk. */
  private async payload(file: string, stat: fs.Stats, type: string): Promise<Payload> {
    const hit = this.payloads.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.payload;
    const payload = makePayload(type, await fs.promises.readFile(file));
    this.payloads.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
    return payload;
  }

  /** The content hash of a file that is streamed as it is (an image), computed once. */
  private async tag(file: string, stat: fs.Stats): Promise<string> {
    const hit = this.tags.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.etag;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    const etag = `"${hash.digest('base64url').slice(0, 22)}"`;
    this.tags.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, etag });
    return etag;
  }

  /** Send a file from disk with an ETag: text from memory (compressed), anything else streamed. */
  async sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, stat: fs.Stats, type: string, cacheControl: string): Promise<void> {
    if (compressibleType(type) && stat.size >= MIN_COMPRESS_BYTES) return sendPayload(req, res, await this.payload(file, stat, type), cacheControl);
    const etag = await this.tag(file, stat);
    const headers: http.OutgoingHttpHeaders = { 'Cache-Control': cacheControl, ETag: etag };
    if (answerNotModified(req, res, etag, headers)) return;
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return void res.end();
    await pipeline(fs.createReadStream(file), res);
  }
}
