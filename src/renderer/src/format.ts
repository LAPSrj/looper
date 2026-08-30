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

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  checking: 'Checking',
  classifying: 'Classifying',
  running: 'Running',
  paused: 'Paused',
  disabled: 'Disabled',
};

export function stateLabel(rt: TaskRuntime | undefined): string {
  if (!rt) return 'Idle';
  if (rt.held) return 'Needs attention';
  return STATE_LABELS[rt.state] ?? rt.state;
}

export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function stripAnsi(s: string): string {
  return stripAnsiShared(s).replace(/\r(?!\n)/g, '\n');
}

export { formatDuration };
