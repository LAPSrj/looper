import { capFirst, resultLabel } from './format';
import type { RunSummary } from './runs';
import type { ActiveRun, RunResult, Task, TaskNotice, TaskRuntime } from './types';

/** A main-window dashboard row that needs the user. */
export interface AttentionRow {
  task: Task;
  level: 'error' | 'warning' | 'info';
  problem: string;
  /** When the run the row is about started, or when the task paused or was completed. */
  at: number | null;
  /** The waiting run; null for a row about one of the task's notices. */
  runId: string | null;
  /** The finished run a notice's row is about; null for one no run caused. */
  lastRunId: string | null;
  /** The waiting run's agent asked a question: the row opens its run window, where the answer goes. */
  question?: true;
}

/** What Clear remembers a row by: the run it's about and its problem, so a new problem is a new row. */
export const attentionKey = (r: AttentionRow): string => `${r.task.id}|${r.runId ?? r.lastRunId ?? ''}|${r.problem}`;

/** A main-window dashboard row for a run in progress. */
export interface RunningRow {
  task: Task;
  run: ActiveRun;
  runId: string;
}

/** A main-window dashboard row for one of the latest runs: a task's, or a Remote Control folder project's or helper's. */
export interface RecentRun extends RunSummary {
  taskId: string;
  taskName: string;
}

const ERROR_RESULTS = new Set<RunResult>(['error', 'max-runtime', 'idle-timeout']);

/** A run that ends this way stays in Needs attention until the user clears it. */
export const isProblemResult = (r: RunResult): boolean => r === 'warning' || ERROR_RESULTS.has(r);

/** What a notice's row says. An error's detail already says what failed; other results name themselves first. */
export function noticeText(p: TaskNotice): string {
  const detail = p.detail ? capFirst(p.detail) : '';
  if (p.completed) return detail ? `Completed: ${detail}` : 'Completed';
  if (p.paused) return `${capFirst(p.paused)}.${p.paused.startsWith('auto-paused after') && detail ? ` Last error: ${detail}` : ''}`;
  const label = resultLabel(p.result ?? '');
  return !detail ? label : p.result === 'error' ? detail : `${label}: ${detail}`;
}

/** A notice's attentionKey, which Clear hands the engine to forget it. */
export const noticeKey = (taskId: string, p: TaskNotice): string => `${taskId}|${p.runId ?? ''}|${noticeText(p)}`;

const LEVEL_ORDER = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then the rest. */
export const byLevel = (a: { level: keyof typeof LEVEL_ORDER }, b: { level: keyof typeof LEVEL_ORDER }): number => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];

/**
 * Tasks that need the user: a run waiting for them, and each run that ended in
 * an error or a warning, auto-paused the task or completed it, which stays
 * until the user clears it, whether the task is disabled or completed since.
 */
export function attentionRows(tasks: Task[], runtimes: Record<string, TaskRuntime>): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const task of tasks) {
    const rt = runtimes[task.id];
    if (!rt) continue;
    for (const run of rt.runs) {
      if (run.question !== null) {
        rows.push({ task, level: 'warning', problem: `The agent asks: ${run.question}`, at: run.startedAt, runId: run.runId, lastRunId: null, question: true });
      } else if (run.held) {
        rows.push({ task, level: 'warning', problem: 'The agent is waiting for your guidance in the run window.', at: run.startedAt, runId: run.runId, lastRunId: null });
      }
    }
    for (const p of rt.notices) {
      const level = p.completed ? 'info' : p.result === 'warning' && !p.paused ? 'warning' : 'error';
      rows.push({ task, level, problem: noticeText(p), at: p.at, runId: null, lastRunId: p.runId });
    }
  }
  // Errors first, then warnings, then completions, the most recent first within each.
  return rows.sort((a, b) => byLevel(a, b) || (b.at ?? 0) - (a.at ?? 0));
}

/** Every run in progress, oldest first. */
export function runningRows(tasks: Task[], runtimes: Record<string, TaskRuntime>): RunningRow[] {
  const rows: RunningRow[] = [];
  for (const task of tasks) {
    for (const run of runtimes[task.id]?.runs ?? []) rows.push({ task, run, runId: run.runId });
  }
  return rows.sort((a, b) => a.run.startedAt - b.run.startedAt);
}
