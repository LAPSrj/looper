import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attentionKey, attentionRows, noticeKey, runningRows } from '../src/shared/dashboard';
import { migrateStateFile } from '../src/engine/store/state';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { TaskSchema, type ActiveRun, type TaskNotice, type RunResult, type TaskInput, type TaskRuntime } from '../src/shared/types';

const task = (id: string, over: Partial<TaskInput> = {}) => TaskSchema.parse({ ...EXAMPLE_TASK, id, name: id, ...over });

const runtime = (taskId: string, over: Partial<TaskRuntime> = {}): TaskRuntime => ({
  taskId,
  state: 'idle',
  held: false,
  asking: false,
  runs: [],
  children: [],
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
  lastResult: null,
  lastDetail: null,
  consecutiveErrors: 0,
  currentRunId: null,
  pausedReason: null,
  watcher: null,
  lastEventAt: null,
  session: null,
  notices: [],
  ...over,
});

const run = (runId: string, startedAt: number, over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId,
  state: 'running',
  held: false,
  question: null,
  startedAt,
  trigger: 'timer',
  ...over,
});

const problem = (runId: string | null, result: RunResult | null, detail: string | null, at: number, over: Partial<TaskNotice> = {}): TaskNotice => ({
  runId,
  result,
  detail,
  at,
  ...over,
});

describe('dashboard rows', () => {
  it('gives a row a new key for a new problem, so Clear keeps only what it saw', () => {
    const keyOf = (over: Partial<TaskRuntime>) => attentionKey(attentionRows([task('t')], { t: runtime('t', over) })[0]);
    const failed = problem('r1', 'error', 'boom', 1);
    expect(keyOf({ notices: [failed] })).toBe(keyOf({ notices: [{ ...failed }] }));
    expect(keyOf({ notices: [{ ...failed, runId: 'r2' }] })).not.toBe(keyOf({ notices: [failed] }));
    expect(keyOf({ notices: [{ ...failed, detail: 'other' }] })).not.toBe(keyOf({ notices: [failed] }));
    expect(keyOf({ notices: [failed] })).toBe(noticeKey('t', failed));
    const asks = (question: string) => ({ state: 'running' as const, runs: [run('r1', 1, { question })] });
    expect(keyOf(asks('a?'))).not.toBe(keyOf(asks('b?')));
  });

  it('lists each waiting run and every problem, whatever the task did since, errors first', () => {
    const tasks = [task('waits'), task('paused'), task('failed'), task('warned'), task('fine')];
    const rows = attentionRows(tasks, {
      waits: runtime('waits', { state: 'running', held: true, runs: [run('r1', 300, { held: true })] }),
      paused: runtime('paused', {
        state: 'paused',
        pausedReason: 'auto-paused after 5 consecutive errors',
        notices: [problem('p5', 'error', 'agent exited with code 1', 100, { paused: 'auto-paused after 5 consecutive errors' })],
      }),
      failed: runtime('failed', { lastResult: 'success', notices: [problem('f1', 'max-runtime', 'agent timed out', 200)] }),
      warned: runtime('warned', {
        lastResult: 'noop',
        notices: [problem('w1', 'warning', 'cache needs a look', 150), problem('w2', 'warning', null, 250)],
      }),
      fine: runtime('fine', { lastResult: 'success', lastRunAt: 400 }),
    });
    const erred = attentionRows([task('erred')], { erred: runtime('erred', { notices: [problem('e1', 'error', 'check error: check exited 1', 50)] }) });
    expect(erred[0].problem).toBe('Check error: check exited 1');
    expect(rows.map((r) => [r.task.id, r.level, r.problem, r.runId, r.lastRunId])).toEqual([
      ['failed', 'error', 'Timed out: Agent timed out', null, 'f1'],
      ['paused', 'error', 'Auto-paused after 5 consecutive errors. Last error: Agent exited with code 1', null, 'p5'],
      ['waits', 'warning', 'The agent is waiting for your guidance in the run window.', 'r1', null],
      ['warned', 'warning', 'Warning', null, 'w2'],
      ['warned', 'warning', 'Warning: Cache needs a look', null, 'w1'],
    ]);
  });

  it("shows a disabled or completed task's notices and the completion, after the warnings; a user pause adds nothing", () => {
    const tasks = [task('user-paused'), task('off', { enabled: false }), task('done')];
    const rows = attentionRows([...tasks.slice(0, 2), { ...tasks[2], completedAt: '2026-10-01T00:00:00Z' }], {
      'user-paused': runtime('user-paused', { state: 'paused', pausedReason: 'paused by user', lastResult: 'success' }),
      off: runtime('off', { state: 'disabled', notices: [problem('o1', 'error', null, 1)] }),
      done: runtime('done', {
        state: 'completed',
        notices: [problem('d1', 'warning', 'one site unreachable', 2), problem('d1', null, 'the rollout is finished', 3, { completed: true })],
      }),
    });
    expect(rows.map((r) => [r.task.id, r.level, r.problem, r.lastRunId])).toEqual([
      ['off', 'error', 'Error', 'o1'],
      ['done', 'warning', 'Warning: One site unreachable', 'd1'],
      ['done', 'info', 'Completed: The rollout is finished', 'd1'],
    ]);
    expect(new Set(rows.map(attentionKey)).size).toBe(3);
  });

  it('lists every run in progress, oldest first', () => {
    const tasks = [task('a'), task('b')];
    const rows = runningRows(tasks, {
      a: runtime('a', { state: 'running', runs: [run('a2', 500)] }),
      b: runtime('b', { state: 'checking', runs: [run('b1', 100, { state: 'checking' }), run('b2', 700)] }),
    });
    expect(rows.map((r) => r.runId)).toEqual(['b1', 'a2', 'b2']);
  });
});

describe('state.json version 1', () => {
  it("keeps each task's Needs attention row as its notice, unless Clear took it off, and adds its completion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-state-'));
    const file = path.join(dir, 'state.json');
    const { notices: _none, ...v1 } = runtime('x');
    const old = (taskId: string, over: Partial<TaskRuntime>) => ({ ...v1, taskId, ...over });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-19T00:00:00Z',
        tasks: {
          warned: old('warned', { lastResult: 'warning', lastDetail: 'look', lastRunId: 'r1', lastRunAt: 10 }),
          cleared: old('cleared', { lastResult: 'warning', lastDetail: 'seen', lastRunId: 'r2', lastRunAt: 20 }),
          paused: old('paused', { state: 'paused', pausedReason: 'auto-paused after 3 consecutive errors', lastResult: 'error', lastDetail: 'boom', lastRunId: 'r3', lastRunAt: 30 }),
          fine: old('fine', { lastResult: 'success', lastRunId: 'r4', lastRunAt: 40 }),
          expired: old('expired', { lastResult: 'error', lastDetail: 'long ago', lastRunId: 'r0', lastRunAt: 1 }),
          done: old('done', { state: 'completed', lastResult: 'warning', lastDetail: 'one site unreachable', lastRunId: 'r5', lastRunAt: 45 }),
        },
        conversations: [],
      }),
    );
    migrateStateFile(file, ['cleared|r2|Warning: Seen'], { done: { at: 50, reason: 'the rollout is finished' } }, 5);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.tasks.warned.notices).toEqual([{ runId: 'r1', result: 'warning', detail: 'look', at: 10 }]);
    expect(saved.tasks.cleared.notices).toEqual([]);
    expect(saved.tasks.paused.notices).toEqual([{ runId: 'r3', result: 'error', detail: 'boom', at: 30, paused: 'auto-paused after 3 consecutive errors' }]);
    expect(saved.tasks.fine.notices).toEqual([]);
    expect(saved.tasks.expired.notices).toEqual([]);
    expect(saved.tasks.done.notices).toEqual([
      { runId: 'r5', result: 'warning', detail: 'one site unreachable', at: 45 },
      { runId: null, result: null, detail: 'the rollout is finished', at: 50, completed: true },
    ]);
    // A file in the new format is left alone.
    const text = fs.readFileSync(file, 'utf8');
    migrateStateFile(file, [], {}, 0);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
