import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHost, wslDistroName, type HostKind } from './host';
import { readJson, writeJsonAtomic } from './store/fsutil';

/**
 * One engine per data dir. Two engines on the same data dir (the Windows app
 * and a `looper serve` in WSL, say) would run every task twice and write the
 * same store files, so the running engine keeps `engine.lock` with a
 * heartbeat. The heartbeat makes a crashed engine's lock expire on its own,
 * and works across Windows, WSL and other machines sharing the folder,
 * where none can see the others' processes.
 */

export interface LockHolder {
  /** Random per engine start: tells "my lock" from "someone took over". */
  id: string;
  app: 'desktop' | 'serve';
  where: HostKind;
  distro?: string;
  hostname: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export const HEARTBEAT_MS = 5_000;
/** A lock not refreshed for this long belongs to an engine that is gone (crashed, killed, hung). */
export const STALE_MS = 20_000;

export function lockFile(dataDir: string): string {
  return path.join(dataDir, 'engine.lock');
}

function readLock(dataDir: string): LockHolder | null {
  const raw = readJson<Partial<LockHolder> | null>(lockFile(dataDir), null);
  return raw && typeof raw.id === 'string' && typeof raw.heartbeatAt === 'number' ? (raw as LockHolder) : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the holder runs on this OS instance, where its pid can be checked. */
function sameOs(h: LockHolder): boolean {
  return h.where === detectHost() && h.hostname === os.hostname() && h.distro === wslDistroName();
}

/** The engine currently holding the data dir, or null when it's free (no lock, a stale one, or a dead pid here). */
export function liveHolder(dataDir: string, now = Date.now()): LockHolder | null {
  const h = readLock(dataDir);
  if (!h || now - h.heartbeatAt > STALE_MS) return null;
  if (sameOs(h) && !pidAlive(h.pid)) return null;
  return h;
}

const WHERE: Record<HostKind, string> = { windows: 'Windows', wsl: 'WSL', linux: 'Linux', mac: 'macOS' };

/** "the Looper app in Windows (process 1234), started Oct 13, 2026, 11:20 AM". */
export function describeHolder(h: LockHolder): string {
  const what = h.app === 'desktop' ? 'the Looper app' : 'looper serve';
  const where = h.where === 'wsl' && h.distro ? `WSL (${h.distro})` : WHERE[h.where];
  const machine = h.hostname === os.hostname() ? '' : ` on ${h.hostname}`;
  const started = new Date(h.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `${what} in ${where}${machine} (process ${h.pid}), started ${started}`;
}

export class EngineLock {
  private timer: NodeJS.Timeout | null = null;
  private readonly me: LockHolder;

  constructor(
    private readonly dataDir: string,
    app: LockHolder['app'],
    /** Another engine took the lock over: stop this one. Called once. */
    private readonly onLost: (by: LockHolder | null) => void,
    private readonly opts: { heartbeatMs?: number; now?: () => number } = {},
  ) {
    const now = this.now();
    this.me = {
      id: Math.random().toString(36).slice(2, 12),
      app,
      where: detectHost(),
      ...(wslDistroName() ? { distro: wslDistroName() } : {}),
      hostname: os.hostname(),
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private write(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    writeJsonAtomic(lockFile(this.dataDir), { ...this.me, heartbeatAt: this.now() });
  }

  /** Take the lock (replacing any holder) and keep it fresh. */
  acquire(): void {
    this.write();
    this.timer = setInterval(() => this.beat(), this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private beat(): void {
    const current = readLock(this.dataDir);
    if (current && current.id !== this.me.id) {
      this.stopTimer();
      this.onLost(current);
      return;
    }
    try {
      this.write();
    } catch {
      /* the next beat retries; a lock this stale lets another engine start */
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop the heartbeat and remove the lock, unless another engine has taken it. */
  release(): void {
    this.stopTimer();
    if (readLock(this.dataDir)?.id !== this.me.id) return;
    try {
      fs.unlinkSync(lockFile(this.dataDir));
    } catch {
      /* already gone */
    }
  }
}

/** How long an engine that took over waits for the previous one to notice and stop. */
export const TAKEOVER_WAIT_MS = HEARTBEAT_MS + 2_000;
