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

/** %APPDATA%\looper on Windows, ~/.config/looper elsewhere. LOOPER_HOME overrides. */
export function defaultDataDir(): string {
  if (process.env.LOOPER_HOME) return process.env.LOOPER_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'looper');
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'looper');
}

export function wslDistroName(): string | undefined {
  return process.env.WSL_DISTRO_NAME;
}
