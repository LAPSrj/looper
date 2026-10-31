import type { ReactNode } from 'react';
import type { RestState, Task, TaskRuntime } from '@shared/types';
import { waitedText } from '@shared/sessions';
import { formatDuration } from '../format';
import { SECOND, MINUTE, tickFor, useNow } from '../useNow';
import { taskSubline } from './task-status';

function restStatus(rest: RestState, now: number): string {
  if (rest.phase === 'countdown' && rest.sleepAt !== null) {
    return `Rest Mode — sleeping in ${Math.max(0, Math.ceil((rest.sleepAt - now) / 1000))} s`;
  }
  if (rest.phase === 'sleeping') {
    const wake = rest.wakeAt !== null
      ? ` until ${new Date(rest.wakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    return `Rest Mode — sleeping${wake}`;
  }
  return 'Rest Mode — waiting for tasks to finish';
}

/** How long ago `since` was, as "0s" or "1m5s". Seconds show below an hour, so it ticks each second, then each minute. */
export function Elapsed({ since }: { since: number }) {
  const now = useNow(tickFor(Date.now() - since));
  return <>{now - since < 1000 ? '0s' : formatDuration(now - since)}</>;
}

/** How long a session has waited, in minutes ("now" under one). */
export function WaitedFor({ since }: { since: number }) {
  return <>{waitedText(useNow(MINUTE) - since)}</>;
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
