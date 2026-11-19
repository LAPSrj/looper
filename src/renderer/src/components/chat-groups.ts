import { HANDBACK_TOOL, type MessageRow } from '../../../shared/messages';

export type ChatItem = { kind: 'row'; row: MessageRow } | { kind: 'tools'; rows: MessageRow[] };

/**
 * Messages stay as they are (a delivered SendUserFile call is the agent's
 * message, and so is a subagent's SubagentHandback call, its final report);
 * each run of tool calls (and the thinking and superseded replies between
 * them) becomes one group. `thinkingApart` (thinking shown expanded): thinking
 * stays out of the groups, between them.
 */
export function groupRows(rows: MessageRow[], thinkingApart = false): ChatItem[] {
  const items: ChatItem[] = [];
  for (const row of rows) {
    const last = items[items.length - 1];
    if ((row.kind === 'tool' && !row.sent && row.tool !== HANDBACK_TOOL) || (row.kind === 'thinking' && !thinkingApart) || row.superseded) {
      if (last?.kind === 'tools') last.rows.push(row);
      else items.push({ kind: 'tools', rows: [row] });
    } else items.push({ kind: 'row', row });
  }
  return items;
}

/**
 * A tool group's closed line: "5 tool uses", "Thinking and 1 tool use" once
 * the agent thought between the calls, "Thinking" for thinking alone,
 * "Thinking, 2 tool uses and 1 earlier reply" with a superseded reply; and how
 * many of the calls failed.
 */
export function toolGroupLabel(rows: MessageRow[]): { text: string; failed: number } {
  const tools = rows.filter((r) => r.kind === 'tool');
  const replies = rows.filter((r) => r.superseded).length;
  const parts = [
    ...(rows.some((r) => r.kind === 'thinking') ? ['Thinking'] : []),
    ...(tools.length ? [tools.length === 1 ? '1 tool use' : `${tools.length} tool uses`] : []),
    ...(replies ? [replies === 1 ? '1 earlier reply' : `${replies} earlier replies`] : []),
  ];
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return { text, failed: tools.filter((r) => r.resultError).length };
}
