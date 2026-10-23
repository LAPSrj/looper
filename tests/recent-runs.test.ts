import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { RunStore } from '../src/engine/store/runs';
import { TaskSchema, type RunRecord } from '../src/shared/types';

function task(id: string, name: string) {
  return TaskSchema.parse({ id, name, trigger: { mode: 'manual' }, environmentId: 'local', cwd: '/tmp', agent: { prompt: 'go' } });
}

function rec(taskId: string, runId: string, ts: string, phase: RunRecord['phase'], result: RunRecord['result'], summary?: string): RunRecord {
  return { ts, taskId, runId, phase, result, summary };
}

describe('engine recent runs', () => {
  let engine: Engine | null = null;
  let dataDir = '';
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the newest shown runs across tasks, newest first', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-recent-'));
    engine = createEngine({ dataDir });
    engine.start();
    engine.saveTask(task('t1', 'First'));
    engine.saveTask(task('t2', 'Second'));
    const store = new RunStore(dataDir);
    store.append(rec('t1', 'a', '2026-10-20T10:00:00Z', 'result', 'success', 'did a'));
    store.append(rec('t1', 'b', '2026-10-21T10:00:00Z', 'check', 'noop', 'nothing'));
    store.append(rec('t2', 'c', '2026-10-22T10:00:00Z', 'check', 'act'));
    store.append(rec('t2', 'c', '2026-10-22T10:00:05Z', 'agent', 'started'));
    // A task that no longer exists keeps its run log on disk; it isn't listed.
    store.append(rec('gone', 'd', '2026-10-23T10:00:00Z', 'result', 'success'));

    const hide = { hideNoAction: true, hideChatsAndTerminals: false };
    expect(engine.recentRuns(10, hide).map((r) => [r.taskName, r.runId, r.result])).toEqual([
      ['Second', 'c', 'started'],
      ['First', 'a', 'success'],
    ]);
    expect(engine.recentRuns(10, { ...hide, hideNoAction: false }).map((r) => r.runId)).toEqual(['c', 'b', 'a']);
    expect(engine.recentRuns(1, hide).map((r) => r.runId)).toEqual(['c']);

    // A new record shows on the next read.
    store.append(rec('t1', 'e', '2026-10-23T11:00:00Z', 'result', 'error'));
    expect(engine.recentRuns(2, hide).map((r) => [r.runId, r.details])).toEqual([
      ['e', ''],
      ['c', ''],
    ]);
  });
});
