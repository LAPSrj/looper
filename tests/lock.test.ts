import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineLock, liveHolder, lockFile, STALE_MS, type LockHolder } from '../src/engine/lock';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looper-lock-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (dir: string) => JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as LockHolder;

describe('EngineLock', () => {
  it('holds the data dir while it beats, and frees it on release', () => {
    const dir = tmp();
    expect(liveHolder(dir)).toBeNull();
    const lock = new EngineLock(dir, 'serve', () => {});
    lock.acquire();
    expect(liveHolder(dir)?.pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lockFile(dir))).toBe(false);
    expect(liveHolder(dir)).toBeNull();
  });

  it('a lock whose heartbeat stopped is free, like after a crash', () => {
    const dir = tmp();
    const lock = new EngineLock(dir, 'desktop', () => {});
    lock.acquire();
    const beat = read(dir).heartbeatAt;
    expect(liveHolder(dir, beat + STALE_MS - 1)).not.toBeNull();
    expect(liveHolder(dir, beat + STALE_MS + 1)).toBeNull();
    lock.release();
  });

  it('a fresh lock from a dead process on this OS is free right away', () => {
    const dir = tmp();
    const lock = new EngineLock(dir, 'serve', () => {});
    lock.acquire();
    const mine = read(dir);
    lock.release();
    fs.writeFileSync(lockFile(dir), JSON.stringify({ ...mine, id: 'dead', pid: 2 ** 22 + 7 }));
    expect(liveHolder(dir)).toBeNull();
  });

  it('a fresh lock from another OS is held, whatever its pid', () => {
    const dir = tmp();
    const other: LockHolder = {
      id: 'x',
      app: 'desktop',
      where: process.platform === 'win32' ? 'wsl' : 'windows',
      hostname: os.hostname(),
      pid: 2 ** 22 + 7,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    fs.writeFileSync(lockFile(dir), JSON.stringify(other));
    expect(liveHolder(dir)?.id).toBe('x');
  });

  it('the engine taken over stops beating and is told who took over; release leaves the new lock alone', async () => {
    const dir = tmp();
    let lostTo: LockHolder | null | undefined;
    const first = new EngineLock(dir, 'desktop', (by) => (lostTo = by), { heartbeatMs: 10 });
    first.acquire();
    const second = new EngineLock(dir, 'serve', () => {}, { heartbeatMs: 10 });
    second.acquire();
    const secondId = read(dir).id;
    await sleep(50);
    expect(lostTo?.id).toBe(secondId);
    first.release();
    expect(read(dir).id).toBe(secondId);
    second.release();
  });
});
