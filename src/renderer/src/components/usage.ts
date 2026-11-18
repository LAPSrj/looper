// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import { contextText, type ChatContext } from '../../../shared/chat';
import { waitedText, type SessionSummary, type SessionsState, type UsageLimits, type UsageWindow } from '../../../shared/sessions';

/** The usage ring turns to its warning color from here, and to its critical color from the next. */
export const USAGE_WARNING = 0.8;
export const USAGE_CRITICAL = 0.95;

export type UsageTone = 'normal' | 'warning' | 'critical';

/** How close a usage limit's use (0..1) is to the limit. */
export function usageTone(used: number): UsageTone {
  return used >= USAGE_CRITICAL ? 'critical' : used >= USAGE_WARNING ? 'warning' : 'normal';
}

/** The context ring's color steps: yellow from half full, red from 80%. */
export function contextTone(frac: number): '' | 'mid' | 'high' {
  return frac >= 0.8 ? 'high' : frac >= 0.5 ? 'mid' : '';
}

/** How full the context is (0..1); null when the window's size isn't known. */
export function contextFraction(c: ChatContext | undefined): number | null {
  return c?.window ? Math.min(1, c.tokens / c.window) : null;
}

const percent = (frac: number) => `${Math.round(frac * 100)}%`;

/** One fact as a row: a label and its value. */
export interface Fact {
  label: string;
  value: string;
  /** The value's color, by how close a limit is. */
  tone?: 'warning' | 'error';
  /** A status bar's words for it, where they aren't its label and value. */
  line?: string;
  /** It counts down, so it's shown only while the page is current (`live-only`). */
  live?: boolean;
}

/** A fact as a status bar shows it: "5-hour limit 40%", "Last reply 5 min ago". */
export const factLine = (f: Fact): string => f.line ?? `${f.label} ${f.value}`;

const toneOf = (used: number): Fact['tone'] => {
  const t = usageTone(used);
  return t === 'critical' ? 'error' : t === 'warning' ? 'warning' : undefined;
};

/** The limits of the account the session's harness runs on; none without a session. */
export function sessionLimits(state: SessionsState, s: SessionSummary | undefined): UsageLimits {
  return (s?.limitsKey && state.limits[s.limitsKey]) || {};
}

/** The account's limits: the 5-hour use and when it resets, then the weekly use. */
export function limitFacts(limits: UsageLimits, now: number): Fact[] {
  const facts: Fact[] = [];
  const five = limits.fiveHour;
  if (five) {
    facts.push({ label: '5-hour limit', value: percent(five.used), tone: toneOf(five.used) });
    facts.push(five.resetsAt <= now ? { label: 'Resets', value: 'now' } : { label: 'Resets in', value: waitedText(five.resetsAt - now) });
  }
  if (limits.sevenDay) facts.push({ label: 'Weekly limit', value: percent(limits.sevenDay.used), tone: toneOf(limits.sevenDay.used) });
  return facts;
}

/** What a prompt cache that lasts until `until` has left: "Cached for 3 min", "Cache expired". */
export function cacheText(until: number, now: number): string {
  const left = until - now;
  return left <= 0 ? 'Cache expired' : left < 60_000 ? 'Cached for less than a minute' : `Cached for ${waitedText(left)}`;
}

/** A context as a fact's value: "58k of 1M (6%)". */
export const contextValue = (c: ChatContext): string => contextText(c).replace(' context', '');

export interface SessionFactsInput {
  harness?: string;
  model?: string;
  context?: ChatContext;
  lastReplyAt?: number;
  cacheUntil?: number;
}

/** The session's own facts, one per row; a fact that doesn't apply (no reply yet, no cache) has no row. */
export function sessionFacts(s: SessionFactsInput, now: number, clock: (ts: number, now: number) => string): Fact[] {
  const facts: Fact[] = [];
  if (s.harness) facts.push({ label: 'Harness', value: s.harness, line: s.harness });
  if (s.model) facts.push({ label: 'Model', value: s.model });
  if (s.context) facts.push({ label: 'Context', value: contextValue(s.context), line: contextText(s.context) });
  if (s.lastReplyAt) {
    facts.push({ label: 'Last reply', value: clock(s.lastReplyAt, now) });
    if (s.cacheUntil !== undefined) {
      const cache = cacheText(s.cacheUntil, now);
      facts.push({ label: 'Prompt cache', value: cache, line: cache, live: true });
    }
  }
  return facts;
}

export const FIVE_HOUR_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;

/** How much of a usage window's time has passed (0..1), from when it resets. */
export function windowPassed(w: UsageWindow, spanMs: number, now: number): number {
  return Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / spanMs));
}

/** How much of a prompt cache's time has passed (0..1); null once it has expired. */
export function cachePassed(cache: { from: number; until: number }, now: number): number | null {
  if (now >= cache.until) return null;
  const span = cache.until - cache.from;
  return span > 0 ? Math.max(0, (now - cache.from) / span) : 0;
}

const resetText = (w: UsageWindow, now: number): string => {
  const left = w.resetsAt - now;
  if (left < 86_400_000) return left < 60_000 ? 'resets now' : `resets in ${waitedText(left)}`;
  const d = Math.floor(left / 86_400_000), h = Math.floor((left % 86_400_000) / 3_600_000);
  return `resets in ${d} d${h ? ` ${h} h` : ''}`;
};

/** The Usage button's accessible name: what its icon draws. */
export function usageLabel(context: ChatContext | undefined, limits: UsageLimits, cacheUntil: number | undefined, now: number): string {
  const parts: string[] = [];
  if (context) parts.push(contextText(context));
  if (limits.fiveHour) parts.push(`5-hour limit ${percent(limits.fiveHour.used)}, ${resetText(limits.fiveHour, now)}`);
  if (limits.sevenDay) parts.push(`weekly limit ${percent(limits.sevenDay.used)}, ${resetText(limits.sevenDay, now)}`);
  if (cacheUntil !== undefined) parts.push(`prompt ${cacheText(cacheUntil, now).toLowerCase()}`);
  return parts.length ? `Usage: ${parts.join('; ')}` : 'Usage';
}
