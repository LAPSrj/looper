import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import type { SubagentInfo } from '@shared/sessions';
import { Measured } from '../perf';
import { isPhone } from '../web/page-nav';
import { ChatRow, ToolGroup, type RowCtx } from './ChatRows';
import { groupRows } from './chat-groups';
import { sendsOnEnter } from './composer-text';
import { useChatsSettings } from './hooks';
import { PromptBody } from './Markdown';
import { MessageBox, type MessageBoxStop } from './MessageBox';
import { CARD_ITEMS, FIRST_ITEMS, useNewestFirst } from './newest-first';
import { InfoBar } from './ui';

/** Right-click on a row of a run's conversation: copy it, open its file, or (a Task or Agent call) its subagent's conversation. */
function rowMenu(taskId: string, runId: string, r: MessageRow): void {
  window.looper.showMessageContextMenu({
    taskId,
    runId,
    agentId: r.agentId,
    label: r.preview,
    file: r.file,
    text: (r.kind === 'tool' ? (r.result ?? r.text) : r.text) || undefined,
  });
}

/**
 * A conversation read from its transcript (a task run's agent, a subagent's,
 * a workflow agent's), as a chat, read again while it runs: the Chats tab's
 * task runs and the run window show it. `pendingGuidance`: guidance the agent
 * hasn't picked up yet, at the end like a queued message, with `pendingStatus`
 * under it. `footer`: what goes under it (a task run's guidance box).
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const { expandThinking } = useChatsSettings();
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, pendingGuidance]);
  // The guidance box (or the question) showing under it makes the view shorter: one at the newest message stays there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ctx = useMemo<RowCtx>(
    () => ({
      taskId,
      runId,
      onContextMenu: (_e, row) => rowMenu(taskId, runId, row),
    }),
    [taskId, runId],
  );
  const allItems = useMemo(() => groupRows(rows, expandThinking), [rows, expandThinking]);
  const { hidden, onScroll: showOlder } = useNewestFirst(scrollRef, `${taskId}/${runId}`, allItems.length, drawAll, embedded ? CARD_ITEMS : FIRST_ITEMS);
  const items = useMemo(() => allItems.slice(hidden), [allItems, hidden]);
  return (
    <div className="chat-app">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          showOlder(el);
        }}
      >
        <Measured id="Transcript rows">
          {items.map((item) =>
            item.kind === 'tools' ? <ToolGroup key={item.rows[0].id} rows={item.rows} ctx={ctx} /> : <ChatRow key={item.row.id} row={item.row} ctx={ctx} />,
          )}
        </Measured>
        {rows.length === 0 && !pendingGuidance && <div className="muted">{waitingText}</div>}
        {pendingGuidance && (
          <div className="chat-queued">
            <div className="chat-msg chat-user">
              <PromptBody text={pendingGuidance} />
            </div>
            <div className="chat-queued-actions muted">{pendingStatus}</div>
          </div>
        )}
      </div>
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
  const placeholder = `Message ${agent.description || agent.type}`;
  if (!isPhone) return <MessageBox text={text} onText={setText} placeholder={placeholder} canSend={!!text.trim()} onSend={() => void send()} />;
  return (
    <div className="guidance-compose">
      <textarea
        rows={3}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (sendsOnEnter(e, true)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary" disabled={!text.trim()} onClick={() => void send()}>
        Send
      </button>
    </div>
  );
}

/**
 * Under a task run's conversation: its agent's question, when it asks one, and
 * a box that sends the agent guidance (or the answer). It shows while the
 * run's agent takes guidance (Claude Code or Codex); `recheck` changing asks
 * again (the run going on: its session starting, its turns), since it may not
 * take guidance at first. On the desktop it's a chat's message box (Send above
 * `stop`, when given): Enter sends and Shift+Enter breaks the line; on a phone
 * Enter breaks the line, as in a chat's message box.
 */
export function RunGuidance({
  taskId,
  runId,
  question,
  recheck,
  onSent,
  stop,
}: {
  taskId: string;
  runId: string;
  question: string | null;
  recheck?: string;
  onSent?: () => void;
  stop?: MessageBoxStop;
}) {
  const [canGuide, setCanGuide] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let live = true;
    void window.looper.canGuideRun(taskId, runId).then((ok) => live && setCanGuide(ok));
    return () => {
      live = false;
    };
  }, [taskId, runId, question, recheck]);
  if (!canGuide) return null;
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await window.looper.sendGuidance(taskId, runId, t);
      setText('');
      onSent?.();
    } catch (e) {
      void window.looper.showError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const placeholder = question !== null ? 'Your answer' : 'Guidance for the agent';
  const info = question !== null && <InfoBar stacked title="The agent has a question" message={question} />;
  if (!isPhone) {
    return (
      <>
        {info}
        <MessageBox text={text} onText={setText} placeholder={placeholder} canSend={!sending && !!text.trim()} onSend={() => void send()} stop={stop} />
      </>
    );
  }
  return (
    <>
      {info}
      <div className="guidance-compose">
        <textarea
          rows={3}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (sendsOnEnter(e, true)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </>
  );
}
