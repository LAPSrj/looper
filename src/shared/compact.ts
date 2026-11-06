import { fileAttachments, withCommands } from './bash-mode';
import type { MessageRow } from './messages';

/** The tools that start a subagent: their result is the subagent's final report. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** A background subagent's launch answers with this; its report comes later, as the row's background summary. */
const ASYNC_LAUNCH = 'Async agent launched';

const OPEN = '<compacted-conversation>';
const CLOSE = '</compacted-conversation>';

/**
 * One row as a compacted conversation keeps it, or null when it leaves it
 * out: the user's messages, the agent's (not Looper's notes or the
 * classifier's), files the agent sent, and each subagent's final report.
 * Thinking, tool calls and their results, errors and raw records go.
 */
export function compactRow(r: MessageRow): MessageRow | null {
  if (r.source === 'classifier' || r.note) return null;
  const base = { id: r.id, ...(r.ts ? { ts: r.ts } : {}) };
  if (r.kind === 'prompt' || r.kind === 'guidance') {
    return { ...base, kind: r.kind, preview: r.preview, text: r.text, ...(r.attachments?.length ? { attachments: r.attachments } : {}) };
  }
  if (r.kind === 'agent' || r.kind === 'events') return { ...base, kind: r.kind, preview: r.preview, text: r.text };
  if (r.kind !== 'tool') return null;
  if (r.sent) return { ...base, kind: 'tool', tool: r.tool, preview: r.preview, text: r.sent.caption ?? '', sent: r.sent };
  if (!AGENT_TOOLS.has(r.tool ?? '')) return null;
  const result = r.result?.trim() ?? '';
  const report = result.startsWith(ASYNC_LAUNCH) ? (r.background?.summary?.trim() ?? '') : result;
  if (!report) return null;
  return { ...base, kind: 'tool', tool: r.tool, preview: r.preview, text: r.preview, result: report, ...(r.resultError ? { resultError: true } : {}) };
}

/** A conversation's rows as compaction keeps them, numbered c0, c1… so they don't share ids with the rows that follow. */
export function compactRows(rows: MessageRow[]): MessageRow[] {
  const out: MessageRow[] = [];
  for (const r of rows) {
    const c = compactRow(r);
    if (c) out.push({ ...c, id: `c${out.length}` });
  }
  return out;
}

/**
 * The compacted conversation as the agent receives it, ahead of the user's
 * first message in the new conversation: one block of the messages in order.
 * `path` turns a file's host path into the agent's.
 */
export function compactedText(rows: MessageRow[], path: (hostPath: string) => string = (p) => p): string {
  const parts = rows.map((r) => {
    if (r.sent) {
      const files = r.sent.files.map((f) => `- ${f.path}`);
      return ['[Agent sent files]', ...(r.sent.caption ? [r.sent.caption] : []), ...files].join('\n');
    }
    if (r.kind === 'tool') return `[Subagent report: ${r.text}]\n${r.result ?? ''}`;
    if (r.kind === 'agent') return `[Agent]\n${r.text}`;
    if (r.kind === 'events') return `[Trigger events, while the agent worked]\n${r.text}`;
    const attached = fileAttachments(r.attachments ?? []);
    const files = attached.length ? `\n\nAttached files:\n${attached.map((a) => `- ${path(a.path)}`).join('\n')}` : '';
    // The commands the user ran go ahead of the text, as they went to the agent.
    return `[${r.kind === 'guidance' ? 'User, while the agent worked' : 'User'}]\n${withCommands(r.text, r.attachments ?? [])}${files}`;
  });
  const intro = 'The conversation so far, continued in a new session. Only the messages are kept: tool calls and their results were left out.';
  // A message quoting the closing tag would end the block early for withoutCompacted.
  const body = parts.join('\n\n').split(CLOSE).join('</compacted conversation>');
  return `${OPEN}\n${intro}\n\n${body}\n${CLOSE}`;
}

/** A user message without the compacted conversation it starts with (the first message of a compacted chat). */
export function withoutCompacted(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith(OPEN)) return text;
  const end = t.indexOf(CLOSE);
  return end === -1 ? '' : t.slice(end + CLOSE.length).trim();
}
