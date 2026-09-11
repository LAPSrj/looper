import { execFile, execFileSync } from 'node:child_process';
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
 */
export function convertWslPath(p: string, to: 'windows' | 'posix', distro?: string): Promise<string | undefined> {
  const local = !distro && detectHost() === 'wsl';
  const flag = to === 'windows' ? '-w' : '-u';
  const cmd = local ? 'wslpath' : 'wsl.exe';
  const args = local ? [flag, p] : [...(distro ? ['-d', distro] : []), 'wslpath', flag, p];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        const out = stdout ? String(stdout).replace(/\0/g, '').trim() : '';
        resolve(err || !out ? undefined : out);
      });
    } catch {
      resolve(undefined);
    }
  });
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
