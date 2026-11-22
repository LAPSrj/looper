import { useEffect, useState } from 'react';
import type { ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SubagentInfo } from '@shared/sessions';
import { EmptyState } from './EmptyState';
import { SubagentConversation, TranscriptView } from './Transcript';
import { readAgentRows, type AgentRows } from '../agent-rows';

/** How often a running agent's conversation is read again, as the conversation's own tab does. */
const POLL_MS = 1500;

/** A subagent's or workflow agent's conversation, read once, and again every POLL_MS while it runs and the window shows. */
function useAgentRows(taskId: string, runId: string, agentId: string, running: boolean): MessageRow[] | null {
  const [read, setRead] = useState<{
    agentId: string;
    rows: MessageRow[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    let busy = false;
    let first = true;
    let held: AgentRows | null = null;
    const load = () => {
      if (busy || (!first && document.visibilityState === 'hidden')) return;
      busy = true;
      first = false;
      void readAgentRows(taskId, runId, agentId, held).then(
        (r) => {
          busy = false;
          if (!live || !r) return;
          held = r;
          setRead((was) => (was && was.agentId === agentId && was.rows === r.rows ? was : { agentId, rows: r.rows }));
        },
        () => {
          busy = false;
        },
      );
    };
    load();
    const timer = running ? setInterval(load, POLL_MS) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, runId, agentId, running]);
  return read && read.agentId === agentId ? read.rows : null;
}

/**
 * The Activity pane's Subagents tab: the selected agent's conversation under the list, drawn as the conversation's
 * own tab draws a followed subagent (SubagentConversation in a chat on Claude Code that hasn't ended, with its
 * message box while the subagent runs; else TranscriptView).
 */
export function ActivityAgentConversation({
  taskId,
  runId,
  agentId,
  running,
  chat,
  subagent,
}: {
  taskId: string;
  runId: string;
  agentId: string;
  running: boolean;
  /** The session's chat, when it is one. */
  chat?: ChatState | null;
  /** The subagent's info; unset for a workflow's agent. */
  subagent?: SubagentInfo;
}) {
  const rows = useAgentRows(taskId, runId, agentId, running);
  let body;
  if (rows === null) body = <EmptyState>Loading…</EmptyState>;
  else if (subagent && chat?.harnessKind === 'claude-code' && chat.status !== 'ended')
    body = <SubagentConversation taskId={taskId} runId={runId} rows={rows} chat={chat} agent={subagent} />;
  else
    body = (
      <TranscriptView
        taskId={taskId}
        runId={runId}
        rows={rows}
        waitingText={subagent ? "Waiting for the subagent's first message…" : "Waiting for the agent's first message…"}
      />
    );
  return <div className="activity-agent">{body}</div>;
}
