import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { WatcherPool, type WatcherState } from '../src/engine/watchers';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';
import { WSL_TIMEOUT_TEXT } from './wsl-fixtures';

// A real watcher process through the real launcher, on a local bash target.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(command: (root: string) => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-watch-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = SettingsSchema.parse({
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        shell: 'bash -c',
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: 'true' }],
      },
    ],
  });
  const task = TaskSchema.parse({
    ...EXAMPLE_TASK,
    cwd: root,
    // One crash is already a crash loop: anything that counts pauses the task at once.
    backoff: { maxConsecutiveErrors: 1 },
    trigger: { mode: 'watcher', watcher: { command: command(root), debounceSec: 0.05 } },
  });
  const events: string[][] = [];
  const crashLoops: string[] = [];
  let onRestarting!: () => void;
  const restarting = new Promise<void>((r) => (onRestarting = r));
  const pool = new WatcherPool({
    dataDir: root,
    host: 'linux',
    settings,
    log: new Logger(),
    onEvents: (_id, lines) => events.push(lines),
    onState: (_id, state: WatcherState | null) => state === 'restarting' && onRestarting(),
    onCrashLoop: (_id, detail) => crashLoops.push(detail),
  });
  cleanups.push(() => pool.stopAll());
  pool.sync(task);
  return { root, events, crashLoops, restarting };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WatcherPool environment errors', () => {
  it('a watcher wsl.exe never started neither counts as a crash nor delivers its message as events', async () => {
    const w = setup((root) => {
      fs.writeFileSync(path.join(root, 'wsl.txt'), WSL_TIMEOUT_TEXT);
      // wsl.exe prints its error on stdout, then exits.
      return `cat '${path.join(root, 'wsl.txt')}'; sleep 0.2; exit 255`;
    });
    await w.restarting;
    await settle(200);
    expect(w.crashLoops).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('an ordinary crash still counts', async () => {
    const w = setup(() => `echo 'boom' >&2; exit 1`);
    await w.restarting;
    expect(w.crashLoops).toEqual(['watcher failed 1 times in a row: boom']);
  });
});
