import { describe, expect, it } from 'vitest';
import { attentionRows, runningRows } from '../src/shared/dashboard';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { TaskSchema, type ActiveRun, type TaskInput, type TaskRuntime } from '../src/shared/types';

const task = (id: string, over: Partial<TaskInput> = {}) => TaskSchema.parse({ ...EXAMPLE_TASK, id, name: id, ...over });

const runtime = (taskId: string, over: Partial<TaskRuntime> = {}): TaskRuntime => ({
  taskId,
  state: 'idle',
  held: false,
  runs: [],
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
  ...over,
});

const run = (runId: string, startedAt: number, over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId,
  state: 'running',
  held: false,
  startedAt,
  trigger: 'timer',
  ...over,
});

describe('dashboard rows', () => {
  it('lists a waiting run, an auto-pause and a failed last run, errors first', () => {
    const tasks = [task('waits'), task('paused'), task('failed'), task('fine')];
    const rows = attentionRows(tasks, {
      waits: runtime('waits', { state: 'running', held: true, runs: [run('r1', 300, { held: true })] }),
      paused: runtime('paused', {
        state: 'paused',
        pausedReason: 'auto-paused after 5 consecutive errors',
        lastResult: 'error',
        lastDetail: 'agent exited with code 1',
        lastRunAt: 100,
        lastRunId: 'p5',
      }),
      failed: runtime('failed', { lastResult: 'max-runtime', lastDetail: 'agent timed out', lastRunAt: 200, lastRunId: 'f1' }),
      fine: runtime('fine', { lastResult: 'success', lastRunAt: 400 }),
    });
    const erred = attentionRows([task('erred')], {
      erred: runtime('erred', { lastResult: 'error', lastDetail: 'check error: check exited 1', lastRunAt: 50 }),
    });
    expect(erred[0].problem).toBe('Check error: check exited 1');
    expect(rows.map((r) => [r.task.id, r.level, r.problem, r.runId, r.lastRunId])).toEqual([
      ['failed', 'error', 'Timed out: Agent timed out', null, 'f1'],
      ['paused', 'error', 'Auto-paused after 5 consecutive errors. Last error: Agent exited with code 1', null, 'p5'],
      ['waits', 'warning', 'The agent is waiting for you in the Terminal tab.', 'r1', null],
    ]);
  });

  it('leaves out user pauses, disabled and completed tasks', () => {
    const tasks = [task('user-paused'), task('off', { enabled: false }), task('done')];
    const rows = attentionRows([...tasks.slice(0, 2), { ...tasks[2], completedAt: '2026-10-01T00:00:00Z' }], {
      'user-paused': runtime('user-paused', { state: 'paused', pausedReason: 'paused by user', lastResult: 'success' }),
      off: runtime('off', { state: 'disabled', lastResult: 'error' }),
      done: runtime('done', { state: 'completed', lastResult: 'error' }),
    });
    expect(rows).toEqual([]);
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
