import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { RunStore } from '../src/engine/store/runs';
import { RunSummaries, groupRuns, runShown } from '../src/shared/runs';
import { TaskSchema, type RunRecord } from '../src/shared/types';

function task(id: string, name: string) {
  return TaskSchema.parse({ id, name, trigger: { mode: 'manual' }, environmentId: 'local', cwd: '/tmp', agent: { prompt: 'go' } });
}

function rec(taskId: string, runId: string, ts: string, phase: RunRecord['phase'], result: RunRecord['result'], summary?: string): RunRecord {
  return { ts, taskId, runId, phase, result, summary };
}

describe('groupRuns', () => {
  it('names a run whose agent exited by its exit, not its start', () => {
    const [run] = groupRuns([
      rec('t1', 'a', '2026-10-20T10:00:00Z', 'agent', 'started'),
      rec('t1', 'a', '2026-10-20T10:00:15Z', 'agent', 'exited'),
      rec('t1', 'a', '2026-10-20T10:00:15Z', 'result', 'exited', 'Sleeper exited 0'),
    ]);
    expect([run.result, run.details]).toEqual(['exited', 'Sleeper exited 0']);
  });

  it('names a run the classifier turned down as noop, and one still classifying as started', () => {
    const classifying = [
      rec('t1', 'a', '2026-10-20T10:00:00Z', 'watcher', 'act'),
      rec('t1', 'a', '2026-10-20T10:00:01Z', 'check', 'act'),
      rec('t1', 'a', '2026-10-20T10:00:01Z', 'classify', 'started'),
    ];
    expect(groupRuns(classifying)[0].result).toBe('started');
    const [run] = groupRuns([...classifying, rec('t1', 'a', '2026-10-20T10:00:12Z', 'classify', 'noop', 'nothing new')]);
    expect(run.result).toBe('noop');
  });

  it('shows task runs only, and hides skipped and no-action ones on request, each apart', () => {
    const runs = groupRuns([
      rec('t1', 'a', '2026-10-20T10:00:00Z', 'result', 'success'),
      rec('t1', 'b', '2026-10-21T10:00:00Z', 'chat', 'chat'),
      rec('t1', 'c', '2026-10-22T10:00:00Z', 'terminal', 'terminal'),
      rec('t1', 'd', '2026-10-23T10:00:00Z', 'check', 'noop'),
      rec('t1', 'e', '2026-10-24T10:00:00Z', 'system', 'skipped'),
    ]);
    expect(runs.filter((g) => runShown(g, { hideSkipped: true, hideNoAction: false })).map((g) => g.runId)).toEqual(['d', 'a']);
    expect(runs.filter((g) => runShown(g, { hideSkipped: false, hideNoAction: true })).map((g) => g.runId)).toEqual(['e', 'a']);
    expect(runs.filter((g) => runShown(g, { hideSkipped: false, hideNoAction: false })).map((g) => g.runId)).toEqual(['e', 'd', 'a']);
    expect(runs.filter((g) => runShown(g, { hideSkipped: true, hideNoAction: true })).map((g) => g.runId)).toEqual(['a']);
  });

  it('keeps a retried run as started while its agent restarts', () => {
    const [run] = groupRuns([
      rec('t1', 'a', '2026-10-20T10:00:00Z', 'system', 'started', 'retry 1'),
      rec('t1', 'a', '2026-10-20T10:00:01Z', 'check', 'act'),
      rec('t1', 'a', '2026-10-20T10:00:02Z', 'agent', 'started'),
      rec('t1', 'a', '2026-10-20T10:05:00Z', 'agent', 'restarted', 'restart 1 of 3'),
    ]);
    expect(run.result).toBe('started');
  });
});

/** Random records over a few runs, in time order (some sharing a second), with every phase and result a summary reads. */
function randomRecords(seed: number, count: number, shuffled = false): RunRecord[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const phases: RunRecord['phase'][] = ['watcher', 'check', 'classify', 'agent', 'guidance', 'events', 'question', 'delegate', 'result', 'skip', 'system', 'chat', 'terminal'];
  const results: RunRecord['result'][] = ['act', 'noop', 'error', 'skipped', 'started', 'done', 'success', 'warning', 'idle-timeout', 'max-runtime', 'exited', 'stopped', 'interrupted', 'held', 'restarted', 'sent', 'delivered', 'undelivered', 'chat', 'terminal'];
  let t = Date.parse('2026-10-20T10:00:00Z');
  const out: RunRecord[] = [];
  for (let i = 0; i < count; i++) {
    // Shuffled, each its own second: two runs starting in the same second sort by where they first appear.
    if (shuffled || rnd() < 0.7) t += 1000;
    const r: RunRecord = { ts: new Date(t).toISOString(), taskId: 't1', runId: pick(['a', 'b', 'c', 'd', 'e']), phase: pick(phases), result: pick(results) };
    if (rnd() < 0.5) r.summary = `s${i}`;
    if (rnd() < 0.2) r.error = `e${i}`;
    if (rnd() < 0.3) r.durationMs = Math.floor(rnd() * 1000);
    if (rnd() < 0.3) r.detail = { costUsd: rnd() };
    if (r.phase === 'delegate' && rnd() < 0.6) r.detail = { parentRunId: `p${i}`, ...(rnd() < 0.5 ? { title: `t${i}` } : {}) };
    out.push(r);
  }
  return shuffled ? out.sort(() => rnd() - 0.5) : out;
}

const summariesFrom = (records: RunRecord[]) => groupRuns(records).map(({ records: _r, resultText: _t, ...s }) => s);

describe('RunSummaries', () => {
  it('gives what groupRuns gives, a record at a time', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const records = randomRecords(seed, 40);
      const runs = new RunSummaries();
      for (const r of records) expect(runs.add(r)).toBe(true);
      expect(runs.list()).toEqual(summariesFrom(records));
    }
  });

  it('turns down a record older than its run\'s last', () => {
    const runs = new RunSummaries();
    expect(runs.add(rec('t1', 'a', '2026-10-20T10:00:05Z', 'agent', 'started'))).toBe(true);
    expect(runs.add(rec('t1', 'a', '2026-10-20T10:00:01Z', 'check', 'act'))).toBe(false);
  });

  it('reads a log written out of time order as groupRuns does, and follows records appended after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-summaries-'));
    try {
      const shuffled = randomRecords(7, 60, true);
      const writer = new RunStore(dataDir);
      for (const r of shuffled) writer.append(r);
      const store = new RunStore(dataDir);
      expect(await store.loadSummaries('t1')).toEqual(summariesFrom(shuffled));
      // Appended through this store: the summaries follow without reading the log.
      const later = rec('t1', 'b', '2027-01-01T00:00:00Z', 'result', 'success', 'later');
      store.append(later);
      expect(store.summaries('t1')).toEqual(summariesFrom([...shuffled, later]));
      // Appended by another store: the size no longer matches, and the log is read again.
      const other = rec('t1', 'f', '2027-01-02T00:00:00Z', 'result', 'error', 'elsewhere');
      writer.append(other);
      expect(await store.loadSummaries('t1')).toEqual(summariesFrom([...shuffled, later, other]));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reads the last records from the end of the log', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-tail-'));
    try {
      const store = new RunStore(dataDir);
      const records = randomRecords(3, 5000);
      for (const r of records) store.append({ ...r, body: 'x'.repeat(200) });
      expect(await store.listTail('t1', 200)).toEqual(store.list('t1', 200));
      expect(await store.listTail('t1', 10_000)).toEqual(store.list('t1', 10_000));
      expect(await store.listTail('none', 5)).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('engine recent runs', () => {
  let engine: Engine | null = null;
  let dataDir = '';
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the newest shown runs across tasks, newest first', async () => {
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

    const hide = { hideSkipped: false, hideNoAction: true };
    expect((await engine.recentRuns(10, hide)).map((r) => [r.taskName, r.runId, r.result])).toEqual([
      ['Second', 'c', 'started'],
      ['First', 'a', 'success'],
    ]);
    expect((await engine.recentRuns(10, { ...hide, hideNoAction: false })).map((r) => r.runId)).toEqual(['c', 'b', 'a']);
    expect((await engine.recentRuns(1, hide)).map((r) => r.runId)).toEqual(['c']);

    // A new record shows on the next read.
    store.append(rec('t1', 'e', '2026-10-23T11:00:00Z', 'result', 'error'));
    expect((await engine.recentRuns(2, hide)).map((r) => [r.runId, r.details])).toEqual([
      ['e', ''],
      ['c', ''],
    ]);
  });

  it('lists task runs only: chats and terminal sessions show in their project', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-recent-'));
    engine = createEngine({ dataDir });
    engine.start();
    engine.saveTask(task('t1', 'First'));
    const store = new RunStore(dataDir);
    store.append(rec('t1', 'a', '2026-10-20T10:00:00Z', 'result', 'success'));
    store.append(rec('t1', 'b', '2026-10-21T10:00:00Z', 'chat', 'chat', 'a chat'));
    store.append(rec('t1', 'c', '2026-10-22T10:00:00Z', 'terminal', 'terminal', 'a terminal'));
    expect((await engine.recentRuns(10, { hideSkipped: false, hideNoAction: false })).map((r) => r.runId)).toEqual(['a']);
  });
});
