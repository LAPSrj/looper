/** Human labels of run results, shared by the UI and notification text. */
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

/**
 * A date and time in the computer's own format: the short date and time
 * patterns of `locale` — the machine's regional format, which the caller
 * passes in because Chromium's default follows the display language instead
 * (see `detectSystemLocale`). "12/09/2026, 18:00" under en-150, "9/12/26,
 * 6:00 PM" under en-US.
 */
export function formatDateTime(value: string | number | Date, locale?: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  try {
    return d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    // An unusable locale name must never break a screen.
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }
}
