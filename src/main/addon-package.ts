import { inflate, inflateSync } from 'fflate';
import { readAddonManifest, type AddonManifest, type ReadManifestResult } from '../shared/addons';

/**
 * A `.looperaddon` package: a zip with the manifest at its root as addon.json,
 * and the files the addon needs (its script, binaries) beside it. Every entry
 * is checked before anything is decompressed or written, and the entries are
 * decompressed a few at a time, letting the main process's input in between.
 */

/** The manifest's name in a package and in an installed addon's folder. */
export const ADDON_MANIFEST_FILE = 'addon.json';

export interface PackageLimits {
  entries: number;
  /** Uncompressed bytes, all entries together. */
  bytes: number;
}

export const PACKAGE_LIMITS: PackageLimits = { entries: 5_000, bytes: 500 * 1024 * 1024 };

/** One entry of a package's central directory. */
export interface ZipEntry {
  name: string;
  /** 0: stored, 8: deflated. */
  method: number;
  compressedSize: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
  directory: boolean;
  /** Its Unix mode has an execute bit (a binary the addon runs). */
  executable: boolean;
}

export interface PackageFile {
  /** Its path in the package, with "/" between folders. */
  name: string;
  data: Uint8Array;
  executable: boolean;
}

export type ReadPackageResult =
  | { ok: true; manifest: AddonManifest; files: PackageFile[] }
  | Extract<ReadManifestResult, { ok: false }>;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
/** Characters a file name can't hold on Windows (":" would write an alternate data stream). */
const BAD_NAME_CHAR = /[\x00-\x1f<>:"|?*]/;

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u32 = (d: Uint8Array, at: number) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

/** A zip entry's name: UTF-8 when its flag says so, else one character per byte (as fflate reads it). */
function entryName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** What's wrong with an entry's name, as a path inside the addon's folder. */
function nameProblem(name: string): string | undefined {
  if (!name) return 'An entry has no name.';
  if (name.includes('\\')) return `"${name}" has a backslash in its path.`;
  if (name.startsWith('/')) return `"${name}" is an absolute path.`;
  if (/^[a-z]:/i.test(name)) return `"${name}" starts with a drive letter.`;
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.includes('..')) return `"${name}" leaves the addon's folder.`;
  if (parts.some((p) => p === '' || p === '.')) return `"${name}" has an empty folder name.`;
  if (BAD_NAME_CHAR.test(name)) return `"${name}" has a character a file name can't have.`;
  return undefined;
}

/**
 * The central directory's entries, each checked: a safe path inside the
 * addon's folder, no links, no name twice (in any case, as Windows sees
 * names), no file where another entry needs a folder, a known compression,
 * and the limits. A string says why the package can't be installed; null:
 * it isn't a zip.
 */
export function zipEntries(data: Uint8Array, limits: PackageLimits = PACKAGE_LIMITS): ZipEntry[] | string | null {
  let end = -1;
  for (let at = data.length - 22; at >= 0 && data.length - at <= 22 + 0xffff; at--) {
    if (u32(data, at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = u16(data, end + 10);
  const cdSize = u32(data, end + 12);
  let at = u32(data, end + 16);
  // Zip64's markers: more entries or bytes than the limits allow anyway.
  if (count === 0xffff || cdSize === 0xffffffff || at === 0xffffffff) return 'The package is larger than an addon can be.';
  if (count > limits.entries) return `The package has ${count} files; an addon can have ${limits.entries}.`;
  if (at + cdSize > end) return null;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(data, at) !== CENTRAL) return null;
    const madeBy = u16(data, at + 4) >> 8;
    const flags = u16(data, at + 8);
    const method = u16(data, at + 10);
    const compressedSize = u32(data, at + 20);
    const size = u32(data, at + 24);
    const nameLen = u16(data, at + 28);
    const extraLen = u16(data, at + 30);
    const commentLen = u16(data, at + 32);
    const attrs = u32(data, at + 38);
    const offset = u32(data, at + 42);
    if (at + 46 + nameLen > end) return null;
    const name = entryName(data.subarray(at + 46, at + 46 + nameLen), (flags & 0x800) !== 0);
    at += 46 + nameLen + extraLen + commentLen;
    const problem = nameProblem(name);
    if (problem) return problem;
    // The upper half of the external attributes is a Unix mode (made on Unix, 3; zip tools set it elsewhere too).
    const mode = attrs >>> 16;
    if ((mode & S_IFMT) === S_IFLNK) return `"${name}" is a link.`;
    if (flags & 1) return `"${name}" is encrypted.`;
    if (method !== 0 && method !== 8) return `"${name}" uses a compression Looper can't read.`;
    if (compressedSize === 0xffffffff || size === 0xffffffff) return 'The package is larger than an addon can be.';
    const directory = name.endsWith('/') || (madeBy === 3 && (mode & S_IFMT) === S_IFDIR);
    const key = name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return `"${name}" is in the package twice.`;
    seen.add(key);
    total += size;
    if (total > limits.bytes) return `The package's files take more than ${Math.round(limits.bytes / 1024 / 1024)} MB.`;
    entries.push({ name, method, compressedSize, size, offset, directory, executable: (mode & 0o111) !== 0 });
  }
  // A file can't also be a folder another entry is in.
  const files = new Set(entries.filter((e) => !e.directory).map((e) => e.name.toLowerCase()));
  for (const e of entries) {
    const parts = e.name.replace(/\/$/, '').toLowerCase().split('/');
    for (let n = 1; n < parts.length; n++) {
      const folder = parts.slice(0, n).join('/');
      if (files.has(folder)) return `"${e.name}" is inside "${folder}", which is a file.`;
    }
  }
  return entries;
}

/** Decompressing this long holds the main process at most this long before input gets in. */
const SLICE_MS = 8;
/** Entries at least this big are inflated on fflate's worker. */
const WORKER_BYTES = 512 * 1024;

function inflateOnWorker(data: Uint8Array, size: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => inflate(data, { size }, (e, out) => (e ? reject(e) : resolve(out))));
}

/** The entries' contents, each the size its header says. */
async function entryData(data: Uint8Array, entries: ZipEntry[]): Promise<PackageFile[] | string> {
  const out: PackageFile[] = [];
  let since = performance.now();
  for (const e of entries) {
    if (e.directory) continue;
    if (e.offset + 30 > data.length || u32(data, e.offset) !== LOCAL) return `"${e.name}" is damaged.`;
    const start = e.offset + 30 + u16(data, e.offset + 26) + u16(data, e.offset + 28);
    if (start + e.compressedSize > data.length) return `"${e.name}" is damaged.`;
    const raw = data.subarray(start, start + e.compressedSize);
    let bytes: Uint8Array;
    try {
      if (e.method === 0) bytes = raw.slice();
      else if (e.size >= WORKER_BYTES) bytes = await inflateOnWorker(raw, e.size);
      else bytes = inflateSync(raw, { out: new Uint8Array(e.size) });
    } catch {
      return `"${e.name}" is damaged.`;
    }
    if (bytes.length !== e.size) return `"${e.name}" is damaged.`;
    out.push({ name: e.name, data: bytes, executable: e.executable });
    if (performance.now() - since >= SLICE_MS) {
      await new Promise((r) => setImmediate(r));
      since = performance.now();
    }
  }
  return out;
}

/**
 * Read a `.looperaddon` file's bytes. Format 1 was the manifest alone, as
 * JSON: such a file reads as made for an older Looper.
 */
export async function readAddonPackage(data: Uint8Array, limits: PackageLimits = PACKAGE_LIMITS): Promise<ReadPackageResult> {
  const head = await packageManifest(data, limits);
  if (!head.ok) return head;
  const files = await entryData(data, head.entries.filter((e) => e !== head.entry));
  if (typeof files === 'string') return { ok: false, reason: 'invalid', error: files };
  return { ok: true, manifest: head.manifest, files: [head.file, ...files] };
}

/** The package's manifest alone, its entries checked as for an install. */
export async function readPackageManifest(data: Uint8Array, limits: PackageLimits = PACKAGE_LIMITS): Promise<ReadManifestResult> {
  const head = await packageManifest(data, limits);
  return head.ok ? { ok: true, manifest: head.manifest } : head;
}

async function packageManifest(
  data: Uint8Array,
  limits: PackageLimits,
): Promise<{ ok: true; manifest: AddonManifest; entries: ZipEntry[]; entry: ZipEntry; file: PackageFile } | Extract<ReadManifestResult, { ok: false }>> {
  const entries = zipEntries(data, limits);
  if (entries === null) return notZip(data);
  if (typeof entries === 'string') return { ok: false, reason: 'invalid', error: entries };
  const entry = entries.find((e) => e.name === ADDON_MANIFEST_FILE);
  if (!entry) return { ok: false, reason: 'not-addon' };
  // The manifest first: a newer or older format says so without the rest being read.
  const head = await entryData(data, [entry]);
  if (typeof head === 'string') return { ok: false, reason: 'invalid', error: head };
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(head[0].data));
  } catch (e) {
    return { ok: false, reason: 'invalid', error: `${ADDON_MANIFEST_FILE}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = readAddonManifest(input);
  return r.ok ? { ok: true, manifest: r.manifest, entries, entry, file: head[0] } : r;
}

/** A file that isn't a zip: a format 1 addon (its manifest as JSON) reads as older or newer, anything else as no addon. */
function notZip(data: Uint8Array): Extract<ReadManifestResult, { ok: false }> {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return { ok: false, reason: 'not-addon' };
  }
  const r = readAddonManifest(input);
  return !r.ok && (r.reason === 'older' || r.reason === 'newer') ? r : { ok: false, reason: 'not-addon' };
}
