import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newRunId, RunStore } from '../src/engine/store/runs';
import type { RunRecord } from '../src/shared/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeStore(): RunStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-retention-'));
  dirs.push(dir);
  return new RunStore(dir);
}

function record(taskId: string, runId: string, ts: Date): RunRecord {
  return { ts: ts.toISOString(), taskId, runId, phase: 'result', result: 'success' };
}

const DAY = 24 * 60 * 60 * 1000;

describe('run-log retention', () => {
  it('deletes records and run dirs older than the cutoff', () => {
    const store = makeStore();
    const now = new Date();
    const old = new Date(now.getTime() - 10 * DAY);
    const oldId = newRunId(old);
    const freshId = newRunId(now);
    store.createRunDir('t1', oldId);
    store.createRunDir('t1', freshId);
    store.append(record('t1', oldId, old));
    store.append(record('t1', freshId, now));

    const pruned = store.pruneOlderThan('t1', now.getTime() - 7 * DAY);

    expect(pruned).toEqual({ records: 1, dirs: 1 });
    expect(store.listRunIds('t1')).toEqual([freshId]);
    expect(store.list('t1').map((r) => r.runId)).toEqual([freshId]);
  });

  it('spares the run in progress even when past the cutoff', () => {
    const store = makeStore();
    const now = new Date();
    const old = new Date(now.getTime() - 10 * DAY);
    const oldId = newRunId(old);
    store.createRunDir('t1', oldId);
    store.append(record('t1', oldId, old));

    const pruned = store.pruneOlderThan('t1', now.getTime() - 7 * DAY, new Set([oldId]));

    expect(pruned).toEqual({ records: 0, dirs: 0 });
    expect(store.listRunIds('t1')).toEqual([oldId]);
    expect(store.list('t1')).toHaveLength(1);
  });

  it('removes the record log entirely when everything is expired', () => {
    const store = makeStore();
    const now = new Date();
    const old = new Date(now.getTime() - 10 * DAY);
    const oldId = newRunId(old);
    store.append(record('t1', oldId, old));

    const pruned = store.pruneOlderThan('t1', now.getTime() - 7 * DAY);

    expect(pruned).toEqual({ records: 1, dirs: 0 });
    expect(store.list('t1')).toEqual([]);
  });

  it('lists task ids with history on disk', () => {
    const store = makeStore();
    store.createRunDir('a', newRunId());
    store.createRunDir('b', newRunId());
    expect(store.listTaskIds().sort()).toEqual(['a', 'b']);
  });
});
