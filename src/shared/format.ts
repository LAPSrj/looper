/** Human labels of run results, shared by the UI and notification text. */
const RESULT_LABELS: Record<string, string> = {
  act: 'Action',
  done: 'Done',
  success: 'Success',
  warning: 'Warning',
  noop: 'No action',
  skipped: 'Skipped',
  started: 'Started',
  exited: 'Exited',
  error: 'Error',
  'max-runtime': 'Timed out',
  interrupted: 'Interrupted',
  'idle-timeout': 'Idle timeout',
  held: 'Held',
  restarted: 'Restarted',
  stopped: 'Stopped',
  sent: 'Sent',
  delivered: 'Delivered',
  undelivered: 'Not delivered',
  chat: 'Chat',
  terminal: 'Terminal',
};

export function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? result;
}

export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "1 task", "3 tasks": the count and the word, its plural `many` (the word and an s unless given). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
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
  return dateTimeFormat(locale).format(d);
}

/** One formatter per locale: toLocaleString made a new one for each date, 30 ms for a screen of runs. */
const formats = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(locale: string | undefined): Intl.DateTimeFormat {
  const key = locale ?? '';
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      // An unusable locale name must never break a screen.
      f = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
    }
    formats.set(key, f);
  }
  return f;
}
