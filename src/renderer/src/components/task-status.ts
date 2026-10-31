import type { Task, TaskRuntime } from '@shared/types';
import { capFirst, fmtClock, fmtCountdown, fmtDate, fmtDateTime, resultLabel, stateLabel } from '../format';

/**
 * The line under a task's name in a list: what it is doing, when it runs next, or
 * how its last run went. `countdown`: the line counts down to the next run, so it
 * only means something live. `sorted`: the Goals list, which gives the date of the next run.
 */
export function taskSubline(t: Task, rt: TaskRuntime | undefined, now: number, sorted = false): { text: string; countdown: boolean } {
  const label = stateLabel(rt);
  const countdown = rt?.state === 'idle' ? fmtCountdown(rt.nextRunAt, now) : '';
  const sub =
    rt?.state === 'idle'
      ? countdown === ''
        ? t.trigger.mode === 'manual'
          ? 'Manual'
          : t.trigger.mode === 'watcher'
            ? (rt.watcher === 'watching' ? 'Watching' : rt.watcher === 'restarting' ? 'Watcher restarting' : 'Idle') +
              (rt.lastEventAt !== null ? ` · last event ${fmtClock(rt.lastEventAt, now)}` : '')
            : 'Not scheduled'
        : countdown === 'now'
          ? 'Next run now'
          : sorted && rt.nextRunAt !== null
            ? `Next run ${fmtDateTime(rt.nextRunAt)}`
            : `Next run in ${countdown}`
      : rt?.state === 'paused'
        ? capFirst(rt.pausedReason ?? 'paused')
        : capFirst(rt?.lastDetail ?? '') || resultLabel(rt?.lastResult ?? '');
  const active = rt?.state === 'running' || rt?.state === 'checking' || rt?.state === 'classifying';
  const text = active ? label : t.completedAt ? `Completed ${fmtDate(t.completedAt)}` : rt?.state === 'disabled' ? 'Disabled' : sub;
  return { text, countdown: !active && !t.completedAt && rt?.state === 'idle' && countdown !== '' && countdown !== 'now' };
}
