import { capFirst, resultLabel } from './format';
import type { ActiveRun, Task, TaskRuntime } from './types';

/** A main-window dashboard row that needs the user. */
export interface AttentionRow {
  task: Task;
  level: 'error' | 'warning';
  problem: string;
  /** When the run the problem comes from started. */
  at: number | null;
  /** The waiting run; null for a row about the task's last result. */
  runId: string | null;
  /** The finished run a row about the task's last result comes from. */
  lastRunId: string | null;
}

/** A main-window dashboard row for a run in progress. */
export interface RunningRow {
  task: Task;
  run: ActiveRun;
  runId: string;
}

const ERROR_RESULTS = new Set(['error', 'max-runtime', 'idle-timeout']);

/**
 * Tasks that need the user: a run waiting for them, an auto-pause, or a last
 * run that ended in an error or a warning. The row stays until the next run
 * ends well. Disabled and completed tasks are left out.
 */
export function attentionRows(tasks: Task[], runtimes: Record<string, TaskRuntime>): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const task of tasks) {
    const rt = runtimes[task.id];
    if (!rt || task.completedAt || rt.state === 'disabled') continue;
    for (const run of rt.runs) {
      if (run.held) {
        rows.push({ task, level: 'warning', problem: 'The agent is waiting for you in the Terminal tab.', at: run.startedAt, runId: run.runId, lastRunId: null });
      }
    }
    const detail = rt.lastDetail ? capFirst(rt.lastDetail) : '';
    if (rt.state === 'paused' && rt.pausedReason?.startsWith('auto-paused')) {
      const last = rt.pausedReason.startsWith('auto-paused after') && detail ? ` Last error: ${detail}` : '';
      rows.push({ task, level: 'error', problem: `${capFirst(rt.pausedReason)}.${last}`, at: rt.lastRunAt, runId: null, lastRunId: rt.lastRunId });
    } else if (rt.lastResult && (ERROR_RESULTS.has(rt.lastResult) || rt.lastResult === 'warning')) {
      const label = resultLabel(rt.lastResult);
      // An error's detail already says what failed; other results name themselves first.
      const problem = !detail ? label : rt.lastResult === 'error' ? detail : `${label}: ${detail}`;
      rows.push({
        task,
        level: rt.lastResult === 'warning' ? 'warning' : 'error',
        problem,
        at: rt.lastRunAt,
        runId: null,
        lastRunId: rt.lastRunId,
      });
    }
  }
  // Errors first, then the most recent.
  return rows.sort((a, b) => (a.level === b.level ? (b.at ?? 0) - (a.at ?? 0) : a.level === 'error' ? -1 : 1));
}

/** Every run in progress, oldest first. */
export function runningRows(tasks: Task[], runtimes: Record<string, TaskRuntime>): RunningRow[] {
  const rows: RunningRow[] = [];
  for (const task of tasks) {
    for (const run of runtimes[task.id]?.runs ?? []) rows.push({ task, run, runId: run.runId });
  }
  return rows.sort((a, b) => a.run.startedAt - b.run.startedAt);
}
