import type { MessageRow } from '@shared/messages';
import { keepRows } from '@shared/chat-delta';

/** A subagent's (or workflow agent's) rows as a page holds them, with the version of its transcript they're of. */
export interface AgentRows {
  rows: MessageRow[];
  version?: string;
}

/**
 * A subagent's conversation read again by a poll: it sends the version it holds, so a transcript nobody wrote to
 * since answers without its rows, and the rows that did change come back with the unchanged ones as the same
 * objects. Null when there's nothing new to show (nothing written, or not readable now).
 */
export async function readAgentRows(taskId: string, runId: string, agentId: string, held: AgentRows | null): Promise<AgentRows | null> {
  const r = await window.looper.runs.messages(taskId, runId, agentId, undefined, held?.version);
  if (r.status !== 'ok' || r.unchanged) return null;
  return { rows: keepRows(held?.rows ?? [], r.rows.filter((row) => row.kind !== 'raw')), version: r.version };
}
