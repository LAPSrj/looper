import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageRow } from '@shared/messages';
import { isPhone } from '../web/page-nav';
import { ChatRow, ToolGroup, type RowCtx } from './ChatRows';
import { groupRows } from './chat-groups';
import { sendsOnEnter } from './composer-text';
import { useChatsSettings } from './hooks';
import { PromptBody } from './Markdown';
import { MessageBox, type MessageBoxStop } from './MessageBox';
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
 * hasn't picked up yet, at the end like a queued message. `footer`: what goes
 * under it (a task run's guidance box).
 */
export function TranscriptView({
  taskId,
  runId,
  rows,
  waitingText,
  pendingGuidance,
  footer,
}: {
  taskId: string;
  runId: string;
  rows: MessageRow[];
  waitingText: string;
  pendingGuidance?: string;
  footer?: React.ReactNode;
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
  const items = useMemo(() => groupRows(rows, expandThinking), [rows, expandThinking]);
  return (
    <div className="chat-app">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.map((item) =>
          item.kind === 'tools' ? <ToolGroup key={item.rows[0].id} rows={item.rows} ctx={ctx} /> : <ChatRow key={item.row.id} row={item.row} ctx={ctx} />,
        )}
        {rows.length === 0 && !pendingGuidance && <div className="muted">{waitingText}</div>}
        {pendingGuidance && (
          <div className="chat-queued">
            <div className="chat-msg chat-user">
              <PromptBody text={pendingGuidance} />
            </div>
            <div className="chat-queued-actions muted">Waiting for the agent</div>
          </div>
        )}
      </div>
      {footer}
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
