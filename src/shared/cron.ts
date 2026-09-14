/**
 * Structured view of the cron expressions the trigger UI can build. Anything
 * the patterns below cannot express round-trips as `custom` (the raw string).
 *
 * Invariants the UI maintains:
 * - `from`/`to` (active-hours window) come together or not at all.
 * - `days` is 1-6 weekdays; "all days" is `undefined`, never a 7-element list.
 * - daily `times` is non-empty and all entries share the hour OR the minute
 *   (a single 5-field cron cannot express e.g. 9:00 + 17:30).
 */
export type CronForm =
  | { mode: 'minutes'; step: number; from?: number; to?: number; days?: number[] }
  | { mode: 'hours'; step: number; minute: number; from?: number; to?: number; days?: number[] }
  | { mode: 'daily'; times: { hour: number; minute: number }[] }
  | { mode: 'weekly'; days: number[]; hour: number; minute: number }
  | { mode: 'monthly'; days: number[]; hour: number; minute: number }
  | { mode: 'custom'; cron: string };

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Extra timezone names offered and accepted alongside the IANA list, resolved to a real zone. */
export const TIMEZONE_ALIASES: Record<string, string> = {
  'America/Rio_de_Janeiro': 'America/Sao_Paulo',
};

/** Croner options for a schedule's timezone; unset = the computer's timezone. */
export function cronTz(timezone?: string): { timezone: string } | undefined {
  return timezone ? { timezone: TIMEZONE_ALIASES[timezone] ?? timezone } : undefined;
}

export interface RunWindow {
  activeHours?: { from: number; to: number };
  /** 0 = Sunday. Unset = every day. */
  days?: number[];
  timezone?: string;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** One formatter per timezone: `nextWindowOpen` probes many instants in a row. */
const WINDOW_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function windowFormatter(tz: string | undefined): Intl.DateTimeFormat {
  let fmt = WINDOW_FORMATTERS.get(tz ?? '');
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    });
    WINDOW_FORMATTERS.set(tz ?? '', fmt);
  }
  return fmt;
}

/**
 * Whether a run may start at `atMs` under the window's hours/days, evaluated
 * in its timezone (unset = the computer's). No constraints = always open.
 */
export function runWindowOpen(window: RunWindow, atMs: number): boolean {
  if (!window.activeHours && !window.days?.length) return true;
  const tz = window.timezone ? (TIMEZONE_ALIASES[window.timezone] ?? window.timezone) : undefined;
  const parts = windowFormatter(tz).formatToParts(new Date(atMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const day = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday')?.value ?? ''];
  if (!Number.isFinite(hour) || day === undefined) return true; // unparseable: never hold work hostage
  if (window.days?.length && !window.days.includes(day)) return false;
  const h = window.activeHours;
  return !h || (hour >= h.from && hour <= h.to);
}

/** Search step for the window's next opening; every timezone offset is a multiple of 15 minutes. */
const OPEN_STEP_MS = 15 * 60_000;
/** Hours plus weekdays repeat within a week; past this the window never opens. */
const OPEN_HORIZON_MS = 8 * 24 * 3_600_000;

/**
 * When the window next opens, at or after `fromMs`: `fromMs` itself while it
 * is open, else the first quarter-hour boundary inside it (hours and days are
 * whole). Null when it never opens — a window whose days/hours exclude
 * everything.
 */
export function nextWindowOpen(window: RunWindow, fromMs: number): number | null {
  if (runWindowOpen(window, fromMs)) return fromMs;
  const end = fromMs + OPEN_HORIZON_MS;
  for (let t = Math.ceil(fromMs / OPEN_STEP_MS) * OPEN_STEP_MS; t <= end; t += OPEN_STEP_MS) {
    if (runWindowOpen(window, t)) return t;
  }
  return null;
}

/** [1,2,3,4,5] -> "1-5"; [1,3,5] -> "1,3,5"; all seven -> "*". */
function buildDow(days: number[] | undefined): string {
  if (!days || days.length === 0 || days.length === 7) return '*';
  const d = [...new Set(days)].sort((a, b) => a - b);
  const contiguous = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return contiguous ? `${d[0]}-${d[d.length - 1]}` : d.join(',');
}

/** "1-5" | "1,3,5" | "0,2-4" -> sorted unique days (7 folds to 0); null = unparseable, undefined = "*" (all). */
function parseDow(s: string): number[] | undefined | null {
  if (s === '*') return undefined;
  const days = new Set<number>();
  for (const atom of s.split(',')) {
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(atom);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b || b > 7) return null;
      for (let d = a; d <= b; d++) days.add(d === 7 ? 0 : d);
    } else if (/^\d{1,2}$/.test(atom) && Number(atom) <= 7) {
      days.add(Number(atom) === 7 ? 0 : Number(atom));
    } else {
      return null;
    }
  }
  if (days.size === 0) return null;
  if (days.size === 7) return undefined;
  return [...days].sort((a, b) => a - b);
}

function buildHourField(step: number, from?: number, to?: number): string {
  const range = from !== undefined && to !== undefined ? `${from}-${to}` : '*';
  if (step === 1) return range;
  return `${range}/${step}`;
}

export function formToCron(f: CronForm): string {
  switch (f.mode) {
    case 'minutes':
      return `*/${f.step} ${f.from !== undefined && f.to !== undefined ? `${f.from}-${f.to}` : '*'} * * ${buildDow(f.days)}`;
    case 'hours':
      return `${f.minute} ${buildHourField(f.step, f.from, f.to)} * * ${buildDow(f.days)}`;
    case 'daily': {
      const times = [...f.times].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
      const hours = [...new Set(times.map((t) => t.hour))];
      const minutes = [...new Set(times.map((t) => t.minute))];
      if (minutes.length === 1) return `${minutes[0]} ${hours.join(',')} * * *`;
      return `${minutes.join(',')} ${hours[0]} * * *`;
    }
    case 'weekly':
      return `${f.minute} ${f.hour} * * ${buildDow(f.days)}`;
    case 'monthly':
      return `${f.minute} ${f.hour} ${[...f.days].sort((a, b) => a - b).join(',')} * *`;
    case 'custom':
      return f.cron;
  }
}

const int = (s: string, max: number): number | undefined =>
  /^\d{1,2}$/.test(s) && Number(s) <= max ? Number(s) : undefined;

const intList = (s: string, max: number): number[] | undefined => {
  if (!/^\d{1,2}(,\d{1,2})*$/.test(s)) return undefined;
  const v = [...new Set(s.split(',').map(Number))].sort((a, b) => a - b);
  return v.every((x) => x <= max) ? v : undefined;
};

/** Parse a cron expression back into the UI's structured form. */
export function cronToForm(cron: string): CronForm {
  const custom: CronForm = { mode: 'custom', cron };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  const [m, h, dom, mon, dowField] = parts;
  if (mon !== '*') return custom;
  const dow = parseDow(dowField);
  if (dow === null) return custom;

  // Monthly: specific days of the month, no weekday constraint.
  if (dom !== '*') {
    const days = intList(dom, 31);
    const minute = int(m, 59);
    const hour = int(h, 23);
    if (dow === undefined && days && days.every((d) => d >= 1) && minute !== undefined && hour !== undefined) {
      return { mode: 'monthly', days, hour, minute };
    }
    return custom;
  }

  const window = /^(\d{1,2})-(\d{1,2})$/.exec(h);
  const winStep = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(h);
  const hourStep = /^\*\/(\d{1,2})$/.exec(h);
  const win = (a: string, b: string): { from: number; to: number } | undefined => {
    const from = int(a, 23);
    const to = int(b, 23);
    return from !== undefined && to !== undefined && from <= to ? { from, to } : undefined;
  };

  // */N minute steps.
  const minStep = /^\*\/(\d{1,2})$/.exec(m);
  if (minStep) {
    const step = Number(minStep[1]);
    if (step < 1 || step > 59) return custom;
    const base = { mode: 'minutes' as const, step, ...(dow ? { days: dow } : {}) };
    if (h === '*') return base;
    if (window) {
      const w = win(window[1], window[2]);
      return w ? { ...base, ...w } : custom;
    }
    return custom;
  }

  // A single minute value: hourly / daily / weekly shapes.
  const minute = int(m, 59);
  if (minute !== undefined) {
    const hoursBase = { mode: 'hours' as const, minute, ...(dow ? { days: dow } : {}) };
    if (h === '*') return { ...hoursBase, step: 1 };
    if (hourStep) {
      const step = Number(hourStep[1]);
      return step >= 1 && step <= 23 ? { ...hoursBase, step } : custom;
    }
    if (winStep) {
      const w = win(winStep[1], winStep[2]);
      const step = Number(winStep[3]);
      return w && step >= 1 && step <= 23 ? { ...hoursBase, step, ...w } : custom;
    }
    if (window) {
      const w = win(window[1], window[2]);
      return w ? { ...hoursBase, step: 1, ...w } : custom;
    }
    const hour = int(h, 23);
    if (hour !== undefined) {
      if (dow) return { mode: 'weekly', days: dow, hour, minute };
      return { mode: 'daily', times: [{ hour, minute }] };
    }
    const hours = intList(h, 23);
    if (hours && dow === undefined) return { mode: 'daily', times: hours.map((hour_) => ({ hour: hour_, minute })) };
    return custom;
  }

  // Several minutes at one hour: daily times sharing the hour.
  const minutes = intList(m, 59);
  const hour = int(h, 23);
  if (minutes && hour !== undefined && dow === undefined) {
    return { mode: 'daily', times: minutes.map((minute_) => ({ hour, minute: minute_ })) };
  }
  return custom;
}

/** Whether a set of daily times fits one cron expression (shared hour or shared minute). */
export function timesExpressible(times: { hour: number; minute: number }[]): boolean {
  return new Set(times.map((t) => t.hour)).size <= 1 || new Set(times.map((t) => t.minute)).size <= 1;
}
