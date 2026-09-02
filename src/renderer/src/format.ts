import { formatDuration } from '@shared/duration';
import { stripAnsi as stripAnsiShared } from '@shared/ansi';
import type { TaskRuntime } from '@shared/types';

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtCountdown(ts: number | null, now: number): string {
  if (ts === null) return '';
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

const RESULT_LABELS: Record<string, string> = {
  act: 'Action',
  done: 'Done',
  success: 'Success',
  warning: 'Warning',
  noop: 'No action',
  skipped: 'Skipped',
  started: 'Started',
  error: 'Error',
  'max-runtime': 'Timed out',
  interrupted: 'Interrupted',
  'idle-timeout': 'Idle timeout',
  held: 'Held',
  stopped: 'Stopped',
};

export function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? result;
}

export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function stripAnsi(s: string): string {
  return stripAnsiShared(s).replace(/\r(?!\n)/g, '\n');
}

export { formatDuration };
