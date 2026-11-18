import type { ReactNode } from 'react';
import type { RestState, Task, TaskRuntime } from '@shared/types';
import { waitedText } from '@shared/sessions';
import { fmtHourMinute, formatDuration } from '../format';
import { SECOND, MINUTE, tickFor, useNow } from '../useNow';
import { taskSubline } from './task-status';

function restStatus(rest: RestState, now: number): string {
  if (rest.phase === 'countdown' && rest.sleepAt !== null) {
    return `Rest Mode — sleeping in ${Math.max(0, Math.ceil((rest.sleepAt - now) / 1000))} s`;
  }
  if (rest.phase === 'sleeping') {
    const wake = rest.wakeAt !== null
      ? ` until ${fmtHourMinute(rest.wakeAt)}`
      : '';
    return `Rest Mode — sleeping${wake}`;
  }
  return 'Rest Mode — waiting for tasks to finish';
}

/**
 * How long ago `since` was, or with `until` how long it ran, as "0s" or "1m5s". Seconds show below an hour, so it
 * ticks each second, then each minute; with `until` it's still.
 */
export function Elapsed({ since, until }: { since: number; until?: number }) {
  const now = useNow(until === undefined ? tickFor(Date.now() - since) : null);
  const ms = (until ?? now) - since;
  return <>{ms < 1000 ? '0s' : formatDuration(ms)}</>;
}

/**
 * How long a session has waited, in minutes ("now" under one). With `label` it follows the label from a minute on,
 * and under one the label shows alone ("Running", then "Running for 3 min").
 */
export function WaitedFor({ since, label }: { since: number; label?: string }) {
  const ms = useNow(MINUTE) - since;
  if (label === undefined) return <>{waitedText(ms)}</>;
  return <>{ms < 60_000 ? label : `${label} for ${waitedText(ms)}`}</>;
}

/** The status bar's Rest Mode text: a countdown to sleep ticks each second, every other phase is still. */
export function RestStatusText({ rest }: { rest: RestState }) {
  const now = useNow(rest.phase === 'countdown' ? SECOND : null);
  return <>{restStatus(rest, now)}</>;
}

/** The task list's second line for a task (its countdown to the next run ticks, the rest is still). */
export function useTaskSubline(t: Task, rt: TaskRuntime | undefined, sorted = false): { text: string; countdown: boolean } {
  const at = rt?.state === 'idle' ? rt.nextRunAt : null;
  const left = at === null ? 0 : at - Date.now();
  const now = useNow(left > 0 ? tickFor(left) : null);
  return taskSubline(t, rt, now, sorted);
}

/** The second line of a desktop task row. */
export function TaskSubline({ task, runtime, sorted }: { task: Task; runtime: TaskRuntime | undefined; sorted: boolean }) {
  const sub = useTaskSubline(task, runtime, sorted);
  return (
    <div className="task-item-sub" title={sub.text}>
      {sub.countdown ? <span className="live-only">{sub.text}</span> : sub.text}
    </div>
  );
}

/** The line under a task's name in a phone row: a countdown reads grey while the phone shows what it kept. */
export function TaskSubText({ task, runtime }: { task: Task; runtime: TaskRuntime | undefined }): ReactNode {
  const sub = useTaskSubline(task, runtime);
  return sub.countdown ? <span className="live-only">{sub.text}</span> : sub.text;
}
