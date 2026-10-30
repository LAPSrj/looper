import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostDirEntry, HostDirListing } from '../../shared/remote-access';

export type Flavor = 'windows' | 'posix';

export interface HostFilesDeps {
  /** The computer's own path style. */
  host: Flavor;
  /** Project folders, in their environment's form, with its WSL distro. */
  places: () => { name: string; cwd: string; distro?: string }[];
  distros: () => Promise<string[]>;
  defaultDistro: () => string | undefined;
  convert: (p: string, to: Flavor, distro?: string) => Promise<string | undefined>;
  home?: string;
}

const MAX_ENTRIES = 5000;
const MAX_RECENT = 10;

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
  if (!hostPath) throw new Error(`Looper can't reach ${p} from this computer.`);
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
  return { path: p, parent: parentFlavor(p, flavor), entries };
}

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
};

/** Claude Code's folders under one home (as this computer reads it), most recently used first. */
async function claudeFolders(home: string, side: Flavor, d: HostFilesDeps, distro?: string): Promise<{ host: string; at: number }[]> {
  let config: { projects?: Record<string, unknown> };
  try {
    config = JSON.parse(await fs.promises.readFile(path.join(home, '.claude.json'), 'utf8'));
  } catch {
    return [];
  }
  const out: { host: string; at: number }[] = [];
  for (const raw of Object.keys(config?.projects ?? {})) {
    const folder = raw.length > 1 ? raw.replace(/[\\/]+$/, '') : raw;
    const host = await toHostPath(folder, side, d, distro);
    if (!host || !(await isDir(host))) continue;
    let at = 0;
    try {
      // Claude Code keeps a folder's transcripts under its path with every other character turned into "-".
      at = (await fs.promises.stat(path.join(home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-')))).mtimeMs;
    } catch {
      /* no transcripts */
    }
    out.push({ host, at });
  }
  return out;
}

/** The starting places: drives, home, project folders, WSL distros and recent Claude Code folders. */
async function startingPlaces(flavor: Flavor, d: HostFilesDeps, distro?: string): Promise<HostDirListing> {
  const found: { name: string; host: string }[] = [];
  const home = d.home ?? os.homedir();
  const distros = d.host === 'windows' ? await d.distros() : [];
  if (d.host === 'windows') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const drives = await Promise.all(letters.map(async (l) => ((await isDir(`${l}:\\`)) ? l : null)));
    for (const l of drives) if (l) found.push({ name: `${l}:`, host: `${l}:\\` });
  } else found.push({ name: '/', host: '/' });
  found.push({ name: 'Home', host: home });
  for (const p of d.places()) {
    if (!p.cwd) continue;
    const host = await toHostPath(p.cwd, flavorOf(p.cwd), d, p.distro);
    if (host) found.push({ name: p.name, host });
  }
  for (const name of distros) found.push({ name, host: `\\\\wsl.localhost\\${name}\\` });
  const recent = await claudeFolders(home, d.host, d);
  for (const name of distros) {
    const root = `\\\\wsl.localhost\\${name}`;
    let users: string[] = [];
    try {
      users = (await fs.promises.readdir(`${root}\\home`)).map((u) => `${root}\\home\\${u}`);
    } catch {
      /* not running, or no /home */
    }
    for (const h of [...users, `${root}\\root`]) recent.push(...(await claudeFolders(h, 'posix', d, name)));
  }
  recent.sort((a, b) => b.at - a.at);
  for (const r of recent.slice(0, MAX_RECENT)) found.push({ name: path.basename(r.host.replace(/\\/g, '/')) || r.host, host: r.host });
  const seen = new Set<string>();
  const entries: HostDirEntry[] = [];
  for (const f of found) {
    const p = fromHostPath(f.host, flavor, d, distro);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    entries.push({ name: f.name, path: p, dir: true });
  }
  return { path: null, parent: null, entries };
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
  if (!hostDir) throw new Error(`Looper can't reach ${dir} from this computer.`);
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
