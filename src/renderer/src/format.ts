import { formatDuration } from '@shared/duration';
import { formatDateTime } from '@shared/format';
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
  completed: 'Completed',
};

export function stateLabel(rt: TaskRuntime | undefined): string {
  if (!rt) return 'Idle';
  if (rt.held) return 'Needs attention';
  return STATE_LABELS[rt.state] ?? rt.state;
}

export { resultLabel, capFirst } from '@shared/format';

/**
 * The machine's regional format, reported by the main process (Chromium's own
 * default follows the display language instead). Each window sets it once
 * from `info()`; until then dates fall back to the runtime default.
 */
let appLocale: string | undefined;

export function setAppLocale(locale: string | undefined): void {
  appLocale = locale;
}

/** A date and time in the computer's format, e.g. "12/09/2026, 18:00". */
export function fmtDateTime(value: string | number | Date): string {
  return formatDateTime(value, appLocale);
}

export function stripAnsi(s: string): string {
  return stripAnsiShared(s).replace(/\r(?!\n)/g, '\n');
}

export { formatDuration };
