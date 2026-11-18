// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { AttentionRow } from '../../shared/dashboard';
import { waitedText, waitingOf, type SessionSummary } from '../../shared/sessions';

// ---------- lists by day ----------

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A day's header: Today, Yesterday, else "19 Oct" (with the year when it isn't this year's). */
export function dayTitle(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (sameDay(d, today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export interface DayGroup<T> {
  /** The local date, unique per group. */
  key: string;
  title: string;
  items: T[];
}

/**
 * A list split into one group per day, in the list's own order (a run of
 * items from the same day is one group; a later run from that day starts
 * another only if the list isn't sorted by time). An item without a time
 * (NaN) stays in the group before it.
 */
export function dayGroups<T>(items: readonly T[], tsOf: (item: T) => number, now: number): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const ts = tsOf(item);
    const last = groups[groups.length - 1];
    if (!Number.isFinite(ts)) {
      if (last) last.items.push(item);
      else groups.push({ key: '', title: '', items: [item] });
      continue;
    }
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (last && last.key === key) last.items.push(item);
    else if (last && last.key === '' && groups.length === 1) {
      // The first items had no time: they belong to the first day that has one.
      last.key = key;
      last.title = dayTitle(ts, now);
      last.items.push(item);
    } else groups.push({ key, title: dayTitle(ts, now), items: [item] });
  }
  return groups;
}

/** The color of a run's result as plain text: Error in red, Warning in orange, anything else the ordinary secondary gray. */
export function resultTone(result: string): 'error' | 'warning' | undefined {
  if (result === 'error' || result === 'max-runtime' || result === 'idle-timeout') return 'error';
  if (result === 'warning' || result === 'held') return 'warning';
  return undefined;
}

/** A run window's title is "<task> – <run id>"; a phone's bar names the task only. */
export function taskNameOf(windowTitle: string, runId: string): string {
  const suffix = ` – ${runId}`;
  return windowTitle.endsWith(suffix) && windowTitle.length > suffix.length ? windowTitle.slice(0, -suffix.length) : windowTitle;
}

/** A row's metadata line: its time of day (fmtHourMinute), then its duration when it has one. */
export function timeAndDuration(time: string, durationText: string): string {
  return durationText ? `${time} · ${durationText}` : time;
}

// ---------- the Dashboard ----------

/** One row of the Dashboard's "Waiting for You": a chat, or a task run, that needs an answer. */
export type WaitingItem =
  | { kind: 'chat'; key: string; title: string; sub: string; since: number; session: SessionSummary }
  | { kind: 'run'; key: string; title: string; sub: string; since: number; attention: AttentionRow };

/** The waiting runs and the rest of the Needs Attention rows: a run that waits for the user is `Waiting for You`'s. */
export function splitAttention(rows: AttentionRow[]): { waiting: AttentionRow[]; rest: AttentionRow[] } {
  return { waiting: rows.filter((r) => r.runId !== null), rest: rows.filter((r) => r.runId === null) };
}

/**
 * What waits for the user: every chat or terminal session whose agent waits for
 * an answer, a permission or a look (the one that waited longest first), then
 * every task run that asks a question or holds for them. The row's subtitle is
 * the question, or what the wait is about.
 */
export function waitingForYou(sessions: SessionSummary[], attention: AttentionRow[]): WaitingItem[] {
  const chats = waitingOf(sessions.filter((s) => s.kind !== 'run')).map(
    (s): WaitingItem => ({
      kind: 'chat',
      key: `chat-${s.id}`,
      title: s.title,
      // A finished turn's text says nothing: the agent's last message is what it wants to be asked about.
      sub: s.waiting!.reason === 'turn' && s.latest ? s.latest : s.waiting!.text,
      since: s.waiting!.since,
      session: s,
    }),
  );
  const runs = splitAttention(attention).waiting.map(
    (r): WaitingItem => ({ kind: 'run', key: `run-${r.task.id}-${r.runId}`, title: r.task.name, sub: r.problem, since: r.at ?? 0, attention: r }),
  );
  return [...chats, ...runs];
}

/** How long a waiting item has waited, for a row's trailing text; empty when it isn't known. */
export function waitedFor(item: WaitingItem, now: number): string {
  return item.since > 0 ? waitedText(Math.max(0, now - item.since)) : '';
}

// ---------- terminals ----------

/** A terminal session's title on a phone: its name, with its project when the name is the plain "Terminal". */
export function terminalTitle(s: { title: string; groupName: string }): string {
  return s.title === 'Terminal' && s.groupName ? `Terminal – ${s.groupName}` : s.title;
}

/** What covers a terminal on a phone: nothing once it has output, "Starting" while its session hasn't printed yet. */
export function terminalOverlay(input: { loaded: boolean; hasOutput: boolean }): 'starting' | null {
  return !input.loaded || input.hasOutput ? null : 'starting';
}
