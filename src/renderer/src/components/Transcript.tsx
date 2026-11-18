import { useEffect, useMemo, useState } from 'react';
import type { ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { RunAgent, SlashCommand, SubagentInfo } from '@shared/sessions';
import { commandAttachment, parseCommands } from '@shared/bash-mode';
import { showRowContextMenu, UserMessage, useSelectText, type RowCtx } from './ChatRows';
import { groupRows } from './chat-groups';
import { Composer, takeIntoBox } from './Composer';
import { Conversation, type ConversationPart } from './Conversation';
import { useChatsSettings } from './hooks';
import { MessageBox, type MessageBoxStop } from './MessageBox';
import { reportError } from '../report-error';
import { InfoBar } from './ui';

/** A message waiting for the agent, at the conversation's end like a chat's queued one; the commands the user ran show as its attachments. */
function PendingMessage({ text, status, taskId, runId }: { text: string; status: React.ReactNode; taskId: string; runId: string }) {
  const { commands, text: rest } = useMemo(() => parseCommands(text, 'pending'), [text]);
  return (
    <div className="chat-queued">
      <UserMessage text={rest} attachments={commands.length ? commands.map(commandAttachment) : undefined} files={{ taskId, runId }} />
      <div className="chat-queued-actions muted">{status}</div>
    </div>
  );
}

/** Under a task run's guidance that waits for its agent: Edit puts it back in the run's message box, Cancel takes it back. */
export function QueuedGuidanceActions({ taskId, runId }: { taskId: string; runId: string }) {
  const unqueue = () => window.looper.runs.unqueue(taskId, runId);
  return (
    <>
      <button className="link" onClick={() => void unqueue().then((m) => m && takeIntoBox(runId, m.text, m.attachments), reportError)}>
        Edit
      </button>
      <button className="link" onClick={() => void unqueue().catch(reportError)}>
        Cancel
      </button>
    </>
  );
}

/**
 * A conversation read from its transcript (a task run's agent, a subagent's,
 * a workflow agent's), as a chat, read again while it runs: the Chats tab's
 * task runs and the run window show it. `pendingGuidance`: guidance the agent
 * hasn't picked up yet, at the end like a queued message, with `pendingStatus`
 * under it. `footer`: what goes under it (a task run's guidance box). `quote`:
 * that box takes text, so the rows' menu has Quote and Edit as New Message.
 */
export function TranscriptView({
  taskId,
  runId,
  rows,
  waitingText,
  pendingGuidance,
  pendingStatus = 'Waiting for the agent',
  footer,
  drawAll = false,
  embedded = false,
  rowMenu = true,
  quote = false,
}: {
  taskId: string;
  runId: string;
  rows: MessageRow[];
  waitingText: string;
  pendingGuidance?: string;
  pendingStatus?: React.ReactNode;
  footer?: React.ReactNode;
  /** Every message drawn, not only the newest ones (a Find over it). */
  drawAll?: boolean;
  /** One of several on the dashboard: only its newest messages are drawn at first. */
  embedded?: boolean;
  /** A right-click on a row shows its menu (Copy, Open File, the subagent's conversation). */
  rowMenu?: boolean;
  quote?: boolean;
}) {
  const { expandThinking } = useChatsSettings();
  const selectText = useSelectText(`${taskId}/${runId}`);
  const ctx = useMemo<RowCtx>(
    () =>
      rowMenu
        ? { taskId, runId, onContextMenu: (e, row) => showRowContextMenu({ chatId: runId, taskId, quote, selectText: selectText(e) }, row) }
        : { taskId, runId },
    [taskId, runId, selectText, rowMenu, quote],
  );
  const items = useMemo(() => groupRows(rows, expandThinking), [rows, expandThinking]);
  const parts = useMemo<ConversationPart[]>(() => [{ key: '', items }], [items]);
  return (
    <div className="chat-app">
      <Conversation
        id={`${taskId}/${runId}`}
        parts={parts}
        ctx={ctx}
        endKey={`${rows.length}/${pendingGuidance ?? ''}`}
        drawAll={drawAll}
        card={embedded}
        measure="Transcript rows"
      >
        {rows.length === 0 && !pendingGuidance && <div className="muted">{waitingText}</div>}
        {pendingGuidance && <PendingMessage text={pendingGuidance} status={pendingStatus} taskId={taskId} runId={runId} />}
      </Conversation>
      {footer}
    </div>
  );
}

/**
 * A subagent's conversation in a chat on Claude Code that hasn't ended. While
 * the subagent runs, a box under it sends the subagent a message, which waits
 * at the end of the conversation (with Cancel) until the chat's subagent hook
 * hands it over with the subagent's next tool call. A subagent that finishes
 * first never gets it: the message is taken back, so a later resume doesn't
 * hand it over either, and stays here, unread, while this tab shows.
 */
export function SubagentConversation({ taskId, runId, rows, chat, agent }: { taskId: string; runId: string; rows: MessageRow[]; chat: ChatState; agent: SubagentInfo }) {
  const running = agent.status === 'running';
  const waiting = chat.subagentMessages?.[agent.agentId];
  const [unread, setUnread] = useState<string>();
  useEffect(() => {
    if (running || waiting === undefined) return;
    void window.looper.chat.unmessageSubagent(chat.id, agent.agentId).then((text) => text && setUnread(text));
  }, [running, waiting, chat.id, agent.agentId]);
  return (
    <TranscriptView
      taskId={taskId}
      runId={runId}
      rows={rows}
      waitingText="Waiting for the subagent's first message…"
      pendingGuidance={waiting ?? unread}
      pendingStatus={
        waiting !== undefined && running ? (
          <>
            Waiting for the subagent{' '}
            <button className="link" onClick={() => void window.looper.chat.unmessageSubagent(chat.id, agent.agentId)}>
              Cancel
            </button>
          </>
        ) : (
          'The subagent finished before reading this.'
        )
      }
      footer={running ? <SubagentMessageBox chat={chat} agent={agent} /> : undefined}
    />
  );
}

/** The box under a running subagent's conversation. Laid out like RunGuidance's box. */
function SubagentMessageBox({ chat, agent }: { chat: ChatState; agent: SubagentInfo }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    window.looper.chat.messageSubagent(chat.id, agent.agentId, t);
    // A phone without its computer (web/start.ts marks it) shows its own alert; the message stays to send later.
    if ('stale' in document.documentElement.dataset) return;
    setText('');
  };
  return <MessageBox text={text} onText={setText} placeholder={`Message ${agent.description || agent.type}`} canSend={!!text.trim()} onSend={send} />;
}

const NO_ROWS: readonly MessageRow[] = [];

/**
 * Under a task run's conversation: its agent's question, when it asks one, and
 * the message box (Composer) that sends the agent guidance (or the answer). It
 * shows while the run's agent takes guidance (Claude Code or Codex);
 * `recheck` changing asks again (the run going on: its session starting, its
 * turns), since it may not take guidance at first. Files go with the guidance
 * as their paths, a skill picked from `commands` goes as its name for the
 * agent to run, and `agent` shows the run's harness and settings, which can't
 * change. `working`: the agent is in a turn, so guidance waits for it (Queue);
 * `queued`: guidance waits (Send Now); `rows`: the conversation, whose sent
 * messages Up brings back.
 */
export function RunGuidance({
  taskId,
  runId,
  question,
  recheck,
  onSent,
  stop,
  commands = [],
  agent,
  working = false,
  queued = false,
  rows = NO_ROWS,
}: {
  taskId: string;
  runId: string;
  question: string | null;
  recheck?: string;
  onSent?: () => void;
  stop?: MessageBoxStop;
  commands?: SlashCommand[];
  agent?: RunAgent;
  working?: boolean;
  queued?: boolean;
  rows?: readonly MessageRow[];
}) {
  const [canGuide, setCanGuide] = useState(false);
  useEffect(() => {
    let live = true;
    void window.looper.canGuideRun(taskId, runId).then((ok) => live && setCanGuide(ok));
    return () => {
      live = false;
    };
  }, [taskId, runId, question, recheck]);
  if (!canGuide) return null;
  const placeholder = question !== null ? 'Your answer' : 'Guidance for the agent';
  return (
    <>
      {question !== null && <InfoBar stacked title="The agent has a question" message={question} />}
      <Composer key={runId} run={{ taskId, runId, placeholder, commands, agent, working, queued, rows, stop, onSent }} />
    </>
  );
}
