import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostDirEntry, HostDirListing, HostPlace } from '../../shared/remote-access';

export type Flavor = 'windows' | 'posix';

/** The home folder's well-known folders, in the order the starting places list them. */
export type KnownFolder = 'desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos';
export const KNOWN_FOLDERS: KnownFolder[] = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'];
const KNOWN_NAMES: Record<KnownFolder, string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
};

export interface HostFilesDeps {
  /** The computer's own path style. */
  host: Flavor;
  /** Project folders, in their environment's form, with its WSL distro. */
  places: () => { name: string; cwd: string; distro?: string }[];
  distros: () => Promise<string[]>;
  defaultDistro: () => string | undefined;
  convert: (p: string, to: Flavor, distro?: string) => Promise<string | undefined>;
  home?: string;
  /** A well-known folder's host path (Electron's app.getPath, which follows a moved Documents); unset: the folder of that name in home. */
  known?: (k: KnownFolder) => string | undefined;
}

const MAX_ENTRIES = 5000;

const UNC_WSL = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;
const MNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i;

/** A path in `flavor` (a WSL environment's /home/x, or C:\x) as this computer reads it. */
export async function toHostPath(p: string, flavor: Flavor, d: HostFilesDeps, distro?: string): Promise<string | null> {
  if (flavor === d.host) return p;
  if (d.host === 'windows') {
    if (!p.startsWith('/')) return null;
    const m = MNT.exec(p);
    if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
    const name = distro || d.defaultDistro();
    if (name) return `\\\\wsl.localhost\\${name}${p === '/' ? '\\' : p.replace(/\//g, '\\')}`;
    return (await d.convert(p, 'windows', distro)) ?? null;
  }
  const m = DRIVE.exec(p);
  if (!m) return null;
  return (await d.convert(p, 'posix', distro)) ?? `/mnt/${m[1].toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`;
}

/** A path on this computer in `flavor`, or null when that side can't reach it (another distro's files). */
export function fromHostPath(p: string, flavor: Flavor, d: HostFilesDeps, distro?: string): string | null {
  if (flavor === d.host) return p;
  if (d.host === 'windows') {
    const unc = UNC_WSL.exec(p);
    if (unc) {
      const want = distro || d.defaultDistro();
      if (want && unc[1].toLowerCase() !== want.toLowerCase()) return null;
      return (unc[2] ?? '').replace(/\\/g, '/') || '/';
    }
    const m = DRIVE.exec(p);
    return m ? `/mnt/${m[1].toLowerCase()}${m[2] ? `/${m[2].replace(/\\/g, '/')}` : ''}` : null;
  }
  const m = MNT.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  const own = process.env.WSL_DISTRO_NAME;
  return own && p.startsWith('/') ? `\\\\wsl.localhost\\${own}${p === '/' ? '\\' : p.replace(/\//g, '\\')}` : null;
}

export function joinFlavor(dir: string, name: string, flavor: Flavor): string {
  const sep = flavor === 'windows' ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** The folder above, or null at a root (the client goes back to the starting places). */
export function parentFlavor(p: string, flavor: Flavor): string | null {
  if (flavor === 'posix') return p === '/' || !p.startsWith('/') ? null : path.posix.dirname(p);
  const trimmed = p.replace(/\\+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return null;
  const up = path.win32.dirname(trimmed);
  return up === trimmed ? null : /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
}

const flavorOf = (p: string): Flavor => (p.startsWith('/') ? 'posix' : 'windows');

/** One folder's entries, folders first, with paths in `flavor`. */
async function listFolder(p: string, flavor: Flavor, d: HostFilesDeps, distro?: string): Promise<HostDirListing> {
  const hostPath = await toHostPath(p, flavor, d, distro);
  if (!hostPath) throw new Error(`Looper can't reach ${p} from the host computer.`);
  const dirents = await fs.promises.readdir(hostPath, { withFileTypes: true });
  const entries: HostDirEntry[] = [];
  for (const de of dirents.slice(0, MAX_ENTRIES)) {
    const full = path.join(hostPath, de.name);
    let dir = de.isDirectory();
    let size: number | undefined;
    let modifiedAt: number | undefined;
    try {
      const st = await fs.promises.stat(full);
      dir = st.isDirectory();
      if (!dir) size = st.size;
      modifiedAt = Math.round(st.mtimeMs);
    } catch {
      if (de.isSymbolicLink()) continue; // a dangling link
    }
    entries.push({ name: de.name, path: joinFlavor(p, de.name, flavor), dir, ...(size !== undefined ? { size } : {}), ...(modifiedAt !== undefined ? { modifiedAt } : {}) });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.dir ? -1 : 1));
  return { path: p, parent: parentFlavor(p, flavor), entries, home: homeIn(flavor, d, distro) };
}

const hostHome = (d: HostFilesDeps): string => d.home ?? os.homedir();

/** The host user's home folder in `flavor`. */
const homeIn = (flavor: Flavor, d: HostFilesDeps, distro?: string): string | null => fromHostPath(hostHome(d), flavor, d, distro);

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The starting places (Host Computer), as Windows' This PC: home and its
 * well-known folders, then the drives (or the file system), the WSL distros
 * and Looper's project folders. Each is listed once, in its first group.
 */
async function startingPlaces(flavor: Flavor, d: HostFilesDeps, distro?: string): Promise<HostDirListing> {
  const found: { name: string; host: string; place: HostPlace }[] = [];
  const home = hostHome(d);
  found.push({ name: 'Home', host: home, place: 'home' });
  const known = await Promise.all(
    KNOWN_FOLDERS.map(async (k) => {
      const host = d.known?.(k) ?? path.join(home, KNOWN_NAMES[k]);
      return (await isDir(host)) ? { name: KNOWN_NAMES[k], host, place: k } : null;
    }),
  );
  for (const k of known) if (k) found.push(k);
  if (d.host === 'windows') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const drives = await Promise.all(letters.map(async (l) => ((await isDir(`${l}:\\`)) ? l : null)));
    for (const l of drives) if (l) found.push({ name: `Drive (${l}:)`, host: `${l}:\\`, place: 'drive' });
    for (const name of await d.distros()) found.push({ name, host: `\\\\wsl.localhost\\${name}\\`, place: 'linux' });
  } else found.push({ name: 'File System', host: '/', place: 'drive' });
  for (const p of d.places()) {
    if (!p.cwd) continue;
    const host = await toHostPath(p.cwd, flavorOf(p.cwd), d, p.distro);
    if (host) found.push({ name: p.name, host, place: 'project' });
  }
  const seen = new Set<string>();
  const entries: HostDirEntry[] = [];
  for (const f of found) {
    const p = fromHostPath(f.host, flavor, d, distro);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    entries.push({ name: f.name, path: p, dir: true, place: f.place });
  }
  return { path: null, parent: null, entries, home: homeIn(flavor, d, distro) };
}

/** `name` in `dir`, or "name (2).ext" and on when that's taken, as a browser names a download. */
async function freeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * REMOTE_CHANNELS.saveOnHost: copy a file on this computer into `dir` (the
 * host user's Downloads folder) as `as` (default: its own name), or a name
 * not taken there like it; resolves the copy's path. Nothing already in
 * `dir` is replaced.
 */
export async function copyIntoFolder(file: unknown, dir: string, as?: string): Promise<string> {
  if (typeof file !== 'string' || !file.trim()) throw new Error('No file to download.');
  const src = file.trim();
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(src);
  } catch {
    throw new Error(`${src} doesn't exist.`);
  }
  if (!st.isFile()) throw new Error(`${src} isn't a file.`);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = path.basename((as || src).replace(/\\/g, '/'));
  for (;;) {
    const dest = await freeName(dir, name);
    try {
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      // Taken between the check and the copy: the next free name.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * REMOTE_CHANNELS.makeDir: a new folder `name` in `parent` (paths in
 * `flavor`); resolves its path. A name that isn't a single plain folder name
 * is refused, and so is one that's already there.
 */
export async function makeDir(d: HostFilesDeps, parent: unknown, name: unknown, flavor?: Flavor, distro?: string): Promise<string> {
  if (typeof parent !== 'string' || !parent.trim()) throw new Error('No folder to make the new folder in.');
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error('Type a name for the folder.');
  if (/[\\/]/.test(n)) throw new Error("A folder name can't contain \\ or /.");
  if (n === '.' || n === '..' || /[\u0000-\u001f<>:"|?*]/.test(n)) throw new Error(`${n} can't be a folder name.`);
  const f = flavor === 'windows' || flavor === 'posix' ? flavor : d.host;
  const dir = parent.trim();
  const hostDir = await toHostPath(dir, f, d, typeof distro === 'string' && distro ? distro : undefined);
  if (!hostDir) throw new Error(`Looper can't reach ${dir} from the host computer.`);
  try {
    await fs.promises.mkdir(path.join(hostDir, n));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`There's already a file or folder named ${n} here.`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Looper isn't allowed to make a folder in ${dir}.`);
    throw err;
  }
  return joinFlavor(dir, n, f);
}

/** REMOTE_CHANNELS.listDir: a folder's entries, or the starting places without a path. */
export function listDir(d: HostFilesDeps, p?: string | null, flavor?: Flavor, distro?: string): Promise<HostDirListing> {
  const f = flavor === 'windows' || flavor === 'posix' ? flavor : d.host;
  const dist = typeof distro === 'string' && distro ? distro : undefined;
  return typeof p === 'string' && p.trim() ? listFolder(p.trim(), f, d, dist) : startingPlaces(f, d, dist);
}
