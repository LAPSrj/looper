import type { MessageRow } from '../../shared/messages';
import type { RunRecord } from '../../shared/types';

/** One of the run's own records (check, classifier, agent, result, guidance, question…), a row of the run window's table. */
export interface StepRow {
  id: string;
  ts: string;
  kind: 'step';
  preview: string;
  record: RunRecord;
}

/** A whole conversation (the agent's, or the classifier's) as one row of the table; selecting it shows it as a chat. */
export interface ConversationRow {
  id: string;
  /** When its first message was recorded; unset while it has none with a time. */
  ts?: string;
  kind: 'conversation';
  preview: string;
  source?: 'classifier';
  rows: MessageRow[];
}

export type RunTableRow = StepRow | ConversationRow | MessageRow;

export const AGENT_CONVERSATION = 'conversation';
export const CLASSIFIER_CONVERSATION = 'conversation-classifier';

const messagesText = (n: number): string => (n === 1 ? '1 message' : `${n} messages`);

/**
 * The run's conversations as rows: the classifier's when it had one, and the
 * agent's when it has messages, or while the run goes on (its first message
 * is on its way).
 */
export function conversationRows(messages: MessageRow[], running: boolean): ConversationRow[] {
  const out: ConversationRow[] = [];
  const of = (id: string, rows: MessageRow[], source?: 'classifier'): ConversationRow => ({
    id,
    ts: rows.find((r) => r.ts)?.ts,
    kind: 'conversation',
    preview: rows.length ? `Conversation, ${messagesText(rows.length)}` : 'Conversation, no messages yet',
    ...(source ? { source } : {}),
    rows,
  });
  const classifier = messages.filter((r) => r.source === 'classifier');
  const agent = messages.filter((r) => r.source !== 'classifier');
  if (classifier.length) out.push(of(CLASSIFIER_CONVERSATION, classifier, 'classifier'));
  if (agent.length || running) out.push(of(AGENT_CONVERSATION, agent));
  return out;
}

/** Rows and the run's records in one timeline, by time; a row without one stays where it is (at the end when nothing is before it). */
export function mergeByTime<T extends { ts?: string }>(rows: T[], steps: StepRow[]): (T | StepRow)[] {
  if (steps.length === 0) return rows;
  const out: (T | StepRow)[] = [];
  let i = 0;
  for (const m of rows) {
    if (m.ts) {
      const at = Date.parse(m.ts);
      while (i < steps.length && Date.parse(steps[i].ts) < at) out.push(steps[i++]);
    } else {
      // A conversation that hasn't recorded a time yet is still to come: after every record so far.
      while (i < steps.length && 'kind' in m && m.kind === 'conversation') out.push(steps[i++]);
    }
    out.push(m);
  }
  while (i < steps.length) out.push(steps[i++]);
  return out;
}

/**
 * The run window's table: its records and one row per conversation, placed
 * where it starts. `raw` (View → Raw Messages): every transcript record a row
 * of its own instead.
 */
export function runTableRows(messages: MessageRow[], steps: StepRow[], opts: { raw: boolean; running: boolean }): RunTableRow[] {
  if (opts.raw) return mergeByTime(messages, steps);
  return mergeByTime(conversationRows(messages, opts.running), steps);
}

function messageMatches(r: MessageRow, f: string): boolean {
  return (
    r.preview.toLowerCase().includes(f) ||
    r.text.toLowerCase().includes(f) ||
    (r.tool?.toLowerCase().includes(f) ?? false) ||
    (r.result?.toLowerCase().includes(f) ?? false)
  );
}

/** View → Filter…: a record by its text, a conversation when any of its messages matches. `f` is lowercase. */
export function rowMatches(r: RunTableRow, f: string): boolean {
  if (r.kind === 'step') return r.preview.toLowerCase().includes(f) || (r.record.body?.toLowerCase().includes(f) ?? false);
  if (r.kind === 'conversation') return r.rows.some((m) => messageMatches(m, f));
  return messageMatches(r, f);
}

/** The row the window selects as it opens: the agent's conversation, else the classifier's. */
export function initialRow(rows: RunTableRow[]): string | null {
  return (rows.find((r) => r.id === AGENT_CONVERSATION) ?? rows.find((r) => r.kind === 'conversation'))?.id ?? null;
}
