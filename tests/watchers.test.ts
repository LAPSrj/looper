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
// Stopping the pool runs the real leftover sweep: two scans of every process on
// the machine with a 1.5 s pause between them, 3.7 s on an idle machine with
// ~220 processes and longer with more, so the default 10 s is too tight under load.
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 30_000);

function setup(
  command: (root: string) => string,
  watcher: { debounceSec?: number; maxWaitSec?: number } = {},
  sendRelatedEvents = false,
) {
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
    trigger: { mode: 'watcher', sendRelatedEvents, watcher: { command: command(root), debounceSec: 0.05, ...watcher } },
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

  it("a Node crash reports the error's line, not Node's version footer", async () => {
    const w = setup((root) => {
      fs.writeFileSync(
        path.join(root, 'crash.txt'),
        [
          'node:fs:624',
          '    return binding.readFileUtf8(path, stringToFlags(options.flag));',
          '                   ^',
          '',
          "Error: ENOENT: no such file or directory, open '/home/u/.config/app/token'",
          '    at Object.readFileSync (node:fs:624:20)',
          '    at file:///home/u/watch.mjs:54:19 {',
          "  code: 'ENOENT',",
          '}',
          '',
          'Node.js v26.13.1',
          '',
        ].join('\n'),
      );
      return `cat '${path.join(root, 'crash.txt')}' >&2; exit 1`;
    });
    await w.restarting;
    expect(w.crashLoops).toEqual([
      "watcher failed 1 times in a row: Error: ENOENT: no such file or directory, open '/home/u/.config/app/token'",
    ]);
  });
});

describe('WatcherPool batches', () => {
  const ev = (id: string, n: number) => JSON.stringify({ looper_related_id: id, n });
  // a1 and b1 at once, a2 0.3 s later: with a 0.6 s quiet, b's batch goes out alone before a's.
  const interleaved = () => `echo '${ev('a', 1)}'; echo '${ev('b', 1)}'; sleep 0.3; echo '${ev('a', 2)}'; sleep 60`;

  it('with related events, each id waits for its own quiet', async () => {
    const w = setup(interleaved, { debounceSec: 0.6 }, true);
    await settle(2500);
    expect(w.events).toEqual([[ev('b', 1)], [ev('a', 1), ev('a', 2)]]);
  });

  it('without them, every line waits in one batch', async () => {
    const w = setup(interleaved, { debounceSec: 0.6 });
    await settle(2500);
    expect(w.events).toEqual([[ev('a', 1), ev('b', 1), ev('a', 2)]]);
  });

  it('sends a batch at the max wait while events keep coming', async () => {
    const w = setup(() => `for i in $(seq 1 20); do echo "line $i"; sleep 0.1; done; sleep 60`, { debounceSec: 1, maxWaitSec: 0.5 });
    await settle(1500);
    // Without the max wait nothing goes out until a second after the last line, about 3 s in.
    expect(w.events.length).toBeGreaterThan(0);
    expect(w.events[0][0]).toBe('line 1');
    expect(w.events[0].length).toBeLessThan(20);
  });
});
