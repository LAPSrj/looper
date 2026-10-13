import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSignalWatcher } from '../src/engine/signals';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-signals-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(10);
  }
}

describe('FileSignalWatcher', () => {
  it('delivers the done text and each parsed Stop payload, retrying an unfinished write', async () => {
    const w = new FileSignalWatcher(path.join(dir, 'done'), path.join(dir, 'stop.json'), 10);
    const dones: string[] = [];
    const stops: Record<string, unknown>[] = [];
    w.start({ onDone: (m) => dones.push(m), onStop: (_mtime, p) => stops.push(p) });
    try {
      // A half-written payload is not a signal yet.
      fs.writeFileSync(path.join(dir, 'stop.json'), '{"last_assistant_mess');
      await sleep(60);
      expect(stops).toEqual([]);
      // The finished write (BOM included, as PowerShell may produce) fires exactly once.
      fs.writeFileSync(path.join(dir, 'stop.json'), '﻿{"last_assistant_message":"Report"}');
      await until(() => stops.length === 1);
      expect(stops[0].last_assistant_message).toBe('Report');
      await sleep(60);
      expect(stops.length).toBe(1);

      fs.writeFileSync(path.join(dir, 'done'), 'Fixed it\n');
      await until(() => dones.length === 1);
      expect(dones[0]).toBe('Fixed it');
    } finally {
      w.stop();
    }
  });

  it('reads the done file only once it stops changing, so a write in progress keeps its status', async () => {
    const w = new FileSignalWatcher(path.join(dir, 'done'), path.join(dir, 'stop.json'), 20);
    const dones: string[] = [];
    w.start({ onDone: (m) => dones.push(m), onStop: () => undefined });
    try {
      // Rewritten every 5ms, it never looks the same on two polls 20ms apart.
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(dir, 'done'), i % 2 ? 'error\n' : 'error\nGave up\n'.slice(0, 6 + (i % 7)));
        await sleep(5);
      }
      expect(dones).toEqual([]);
      fs.writeFileSync(path.join(dir, 'done'), 'error\nGave up\n');
      await until(() => dones.length === 1);
      expect(dones[0]).toBe('error\nGave up');
    } finally {
      w.stop();
    }
  });

  it('reports an empty done file as "done"', async () => {
    const w = new FileSignalWatcher(path.join(dir, 'done'), path.join(dir, 'stop.json'), 10);
    const dones: string[] = [];
    w.start({ onDone: (m) => dones.push(m), onStop: () => undefined });
    try {
      fs.writeFileSync(path.join(dir, 'done'), '');
      await until(() => dones.length === 1);
      expect(dones[0]).toBe('done');
    } finally {
      w.stop();
    }
  });
});
