import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HostKind = 'windows' | 'wsl' | 'linux' | 'mac';

export function detectHost(): HostKind {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  try {
    const v = fs.readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(v)) return 'wsl';
  } catch {
    /* not linux or unreadable */
  }
  return 'linux';
}

/** ~/looper — the user's data travels with the user folder, not the app. LOOPER_HOME overrides. */
export function defaultDataDir(): string {
  if (process.env.LOOPER_HOME) return process.env.LOOPER_HOME;
  return path.join(os.homedir(), 'looper');
}

export function wslDistroName(): string | undefined {
  return process.env.WSL_DISTRO_NAME;
}

/** The default WSL distro's name, once detected: what a WSL environment with no distro set runs in. */
let defaultWslDistro: string | undefined;

export function detectedDefaultWslDistro(): string | undefined {
  return defaultWslDistro;
}

/**
 * Learn the default distro's name by asking it (`wsl.exe printenv
 * WSL_DISTRO_NAME` runs there when no -d is given), so its files get a
 * \\wsl.localhost\<name> host path. Windows hosts only.
 */
export function detectDefaultWslDistro(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('wsl.exe', ['printenv', 'WSL_DISTRO_NAME'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        const name = stdout ? String(stdout).replace(/\0/g, '').trim() : '';
        if (!err && name) defaultWslDistro = name;
        resolve(defaultWslDistro);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Tests: set or clear the detected default distro. */
export function setDefaultWslDistro(name: string | undefined): void {
  defaultWslDistro = name;
}

/** Cached: the lookup spawns a process, and the regional format never changes mid-session. */
let systemLocale: string | null | undefined;

/**
 * The locale dates and times are shown in — Windows' **regional format**
 * (Settings → Time & language → Region), not the display language Chromium
 * reports. The two are set separately, so an English machine formatting dates
 * as 12/09/2026 is ordinary. Undefined = let the runtime pick.
 */
export function detectSystemLocale(): string | undefined {
  if (systemLocale !== undefined) return systemLocale ?? undefined;
  systemLocale = readWindowsLocale() ?? readPosixLocale() ?? null;
  return systemLocale ?? undefined;
}

/** `HKCU\Control Panel\International\LocaleName`, e.g. "en-150". Also reachable from WSL through interop. */
function readWindowsLocale(): string | undefined {
  const host = detectHost();
  if (host !== 'windows' && host !== 'wsl') return undefined;
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /LocaleName\s+REG_SZ\s+(\S+)/.exec(out);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** LC_TIME/LC_ALL/LANG, e.g. "pt_BR.UTF-8" -> "pt-BR". */
function readPosixLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG;
  const name = raw?.split('.')[0]?.replace('_', '-');
  return name && name !== 'C' && name !== 'POSIX' ? name : undefined;
}

/** `/mnt/c/` -> `/mnt`. Undefined when the output is not a drive mount path. */
export function mountPrefixFromWslPath(output: string): string | undefined {
  const out = output.replace(/\0/g, '').trim();
  const m = /^(.+)\/c\/?$/i.exec(out);
  return m ? m[1] : undefined;
}

/**
 * The Windows-drive mount root of a WSL distro (its automount root, usually
 * /mnt), read by running `wslpath -u C:\` inside it. Without a distro name:
 * the default distro from a Windows host, looper's own distro from WSL.
 */
export function detectWslMountPrefix(distro?: string): Promise<string | undefined> {
  const local = !distro && detectHost() === 'wsl';
  const cmd = local ? 'wslpath' : 'wsl.exe';
  const args = local ? ['-u', 'C:\\'] : [...(distro ? ['-d', distro] : []), 'wslpath', '-u', 'C:\\'];
  return new Promise((resolve) => {
    try {
      // The child's stdout passes through as UTF-8 (unlike wsl.exe's own UTF-16 listings).
      execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        resolve(err || !stdout ? undefined : mountPrefixFromWslPath(String(stdout)));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Convert a path with `wslpath` inside the given distro: to 'windows'
 * (/home/x -> \\wsl.localhost\<distro>\home\x, /mnt/c/y -> C:\y) or to
 * 'posix' (C:\y -> /mnt/c/y). Without a distro name: the default distro from
 * a Windows host, looper's own distro from WSL. Undefined when wslpath fails.
 * `existing`: the path names a file that may not exist yet. wslpath resolves
 * links only in a path that exists, and Windows can't follow a WSL link over
 * \\wsl.localhost, so such a conversion is kept only once its result exists.
 */
export function convertWslPath(p: string, to: 'windows' | 'posix', distro?: string, existing = false): Promise<string | undefined> {
  // Transcript polling and a Files tab convert the same paths again and again.
  const key = `${to}\0${distro ?? ''}\0${p}`;
  const known = converted.get(key);
  if (known) return known;
  const local = !distro && detectHost() === 'wsl';
  const result = local ? viaWslpath(p, to, distro) : mappedOrWslpath(p, to, distro);
  converted.set(key, result);
  void result.then(async (out) => {
    const forget = () => {
      if (converted.get(key) === result) converted.delete(key);
    };
    if (!out) return forget();
    // A file not there yet is asked about again a little later, not on every poll (each one starts wsl.exe).
    if (existing && !(await fs.promises.stat(out).then(() => true, () => false))) setTimeout(forget, MISSING_RETRY_MS).unref?.();
  });
  return result;
}
const converted = new Map<string, Promise<string | undefined>>();
/** How long the conversion of a file that doesn't exist yet is kept before it's asked again. */
const MISSING_RETRY_MS = 5_000;

/** `wslpath` run in the distro (from a Windows host, by starting wsl.exe). */
function viaWslpath(p: string, to: 'windows' | 'posix', distro?: string): Promise<string | undefined> {
  const local = !distro && detectHost() === 'wsl';
  const flag = to === 'windows' ? '-w' : '-u';
  // -e: without it wsl.exe runs the command through the shell, which drops a Windows path's backslashes.
  const args = local ? [flag, p] : [...(distro ? ['-d', distro] : []), '-e', 'wslpath', flag, p];
  return new Promise<string | undefined>((resolve) => {
    try {
      execFile(local ? 'wslpath' : 'wsl.exe', args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        const out = stdout ? String(stdout).replace(/\0/g, '').trim() : '';
        resolve(err || !out ? undefined : out);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** A distro's root as Windows names it (\\wsl.localhost\<name>\) and where it mounts Windows' drives (/mnt). */
export interface WslRoots {
  unc: string;
  mount: string;
}

/**
 * Starting wsl.exe holds the main process's thread, which on Windows takes every window's input: inside Looper
 * each start held it 35-60 ms, and a Files tab of screenshots started one for each path. So a distro's roots
 * are learned once, and its paths are converted from them.
 */
const rootsOf = new Map<string, Promise<WslRoots | undefined>>();

function wslRoots(distro?: string): Promise<WslRoots | undefined> {
  const k = distro ?? '';
  let roots = rootsOf.get(k);
  if (!roots) {
    const s = wslpathServer(distro);
    roots = Promise.all([s.convert('/', 'windows'), s.convert('C:\\', 'posix')]).then(([unc, drive]) => {
      const mount = drive === undefined ? undefined : mountPrefixFromWslPath(drive);
      return unc && /^\\\\/.test(unc) && mount !== undefined ? { unc: unc.endsWith('\\') ? unc : `${unc}\\`, mount } : undefined;
    });
    rootsOf.set(k, roots);
    // wsl.exe failing (WSL starting, not installed) is asked again next time.
    void roots.then((r) => !r && rootsOf.get(k) === roots && rootsOf.delete(k));
  }
  return roots;
}

/**
 * `p` converted with a distro's roots as wslpath converts it, without links resolved; undefined for a path they
 * don't cover: a relative one, another distro's, or one with a character a Windows name can't hold.
 */
export function mapWslPath(p: string, to: 'windows' | 'posix', roots: WslRoots): string | undefined {
  if (to === 'windows') {
    if (!p.startsWith('/') || /[\\:*?"<>|]/.test(p)) return undefined;
    const prefix = roots.mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const drive = new RegExp(`^${prefix}/([a-zA-Z])(?=/|$)/?(.*)$`).exec(p);
    if (drive) return `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}`;
    return roots.unc + p.slice(1).replace(/\//g, '\\');
  }
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (drive) return `${roots.mount}/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  const name = roots.unc.split('\\')[3]?.toLowerCase();
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(p);
  if (unc && name && unc[1].toLowerCase() === name) return `/${(unc[2] ?? '').replace(/\\/g, '/')}`;
  return undefined;
}

/**
 * From a Windows host: converted with the distro's roots when the result is a file Windows reaches; otherwise
 * (a link on the way, which Windows can't follow or read, or a file not there yet) by wslpath, which resolves links.
 */
async function mappedOrWslpath(p: string, to: 'windows' | 'posix', distro?: string): Promise<string | undefined> {
  const roots = await wslRoots(distro);
  const mapped = roots ? mapWslPath(p, to, roots) : undefined;
  if (mapped !== undefined) {
    if (to === 'posix') return mapped;
    if (await fs.promises.stat(mapped).then(() => true, () => false)) return mapped;
  }
  return wslpathServer(distro).convert(p, to);
}

/** How long a distro's wslpath process waits for another path before it ends. */
const SERVER_IDLE_MS = 60_000;
const SERVER_TIMEOUT_MS = 15_000;
// Each line: w or u, a space, the path. Each answer: wslpath's output on one line, empty when it failed.
const SERVER_SCRIPT = 'while IFS= read -r line; do out=$(wslpath "-${line%% *}" "${line#* }" 2>/dev/null); printf "%s\\n" "$out"; done';

interface WslpathServer {
  convert(p: string, to: 'windows' | 'posix'): Promise<string | undefined>;
}

/** Keep the Node process alive for the wsl.exe only while a conversion waits on it (a CLI command ends otherwise). */
function hold(c: ChildProcess, on: boolean): void {
  for (const h of [c, c.stdin, c.stdout] as ({ ref?: () => void; unref?: () => void } | null)[]) (on ? h?.ref : h?.unref)?.call(h);
}
const servers = new Map<string, WslpathServer>();

/** One wsl.exe per distro that converts the paths written to it, so a conversion doesn't start a process. */
function wslpathServer(distro?: string): WslpathServer {
  const k = distro ?? '';
  const known = servers.get(k);
  if (known) return known;
  let child: ChildProcess | null = null;
  let waiting: { done: (out: string | undefined) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  let buffer = '';
  let idle: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    const c = child;
    child = null;
    buffer = '';
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer);
      w.done(undefined);
    }
    c?.kill();
  };
  const start = (): ChildProcess => {
    const c = spawn('wsl.exe', [...(distro ? ['-d', distro] : []), '-e', 'sh', '-c', SERVER_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout!.setEncoding('utf8');
    c.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).replace(/\0/g, '').replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        const w = waiting.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        w.done(line || undefined);
      }
      if (!waiting.length) {
        hold(c, false);
        idle = setTimeout(stop, SERVER_IDLE_MS);
        idle.unref?.();
      }
    });
    c.on('error', () => child === c && stop());
    c.on('exit', () => child === c && stop());
    c.stdin!.on('error', () => child === c && stop());
    return c;
  };
  const server: WslpathServer = {
    convert(p, to) {
      // A path with a line break can't go on one line.
      if (/[\r\n]/.test(p)) return viaWslpath(p, to, distro);
      if (idle) clearTimeout(idle);
      idle = null;
      child ??= start();
      const c = child;
      hold(c, true);
      return new Promise((resolve) => {
        // No answer in time: the process is stuck, and the answers after would be out of step.
        const timer = setTimeout(() => child === c && stop(), SERVER_TIMEOUT_MS);
        waiting.push({ done: resolve, timer });
        c.stdin!.write(`${to === 'windows' ? 'w' : 'u'} ${p}\n`);
      });
    },
  };
  servers.set(k, server);
  return server;
}

/**
 * Installed WSL distros via `wsl.exe --list --quiet` (works on a Windows host
 * and from inside WSL through interop). Empty when wsl.exe is unavailable.
 */
export function listWslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile(
        'wsl.exe',
        ['--list', '--quiet'],
        { encoding: 'buffer', timeout: 15_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          // wsl.exe prints UTF-16LE.
          const names = stdout
            .toString('utf16le')
            .split(/\r?\n/)
            .map((s) => s.replace(/\0/g, '').trim())
            .filter(Boolean);
          resolve(names);
        },
      );
    } catch {
      resolve([]);
    }
  });
}
