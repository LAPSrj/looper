import { formatDuration } from '@shared/duration';
import { stripAnsi as stripAnsiShared } from '@shared/ansi';
import type { TaskRuntime } from '@shared/types';

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

export function fmtCountdown(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const diff = ts - now;
  if (diff <= 0) return 'now';
  return formatDuration(diff);
}

export function stateLabel(rt: TaskRuntime | undefined): string {
  if (!rt) return 'idle';
  if (rt.held) return 'needs attention';
  return rt.state;
}

export function stripAnsi(s: string): string {
  return stripAnsiShared(s).replace(/\r(?!\n)/g, '\n');
}

export { formatDuration };
