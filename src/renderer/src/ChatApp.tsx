import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, ChatPermissionRequest, ChatState } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import { AttachmentList, ChatRow, ToolGroup, groupRows, type ChatItem, type RowCtx } from './components/ChatRows';
import { ToolInputView } from './components/ToolContent';
import { subscribe } from './events';

const reportError = (e: Error) => void window.looper.showError(e.message);

function Items({ items, ctx, prefix }: { items: ChatItem[]; ctx: RowCtx; prefix: string }) {
  return (
    <>
      {items.map((item) =>
        item.kind === 'tools' ? (
          <ToolGroup key={prefix + item.rows[0].id} rows={item.rows} ctx={ctx} />
        ) : (
          <ChatRow key={prefix + item.row.id} row={item.row} ctx={ctx} />
        ),
      )}
    </>
  );
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** What the agent asks to do, in words. */
function requestText(harnessName: string, p: ChatPermissionRequest): string {
  const input = (p.input ?? {}) as Record<string, unknown>;
  const file = str(input.file_path) ?? str(input.notebook_path);
  switch (p.tool) {
    case 'Bash':
    case 'PowerShell':
      return `${harnessName} wants to run a command.`;
    case 'Write':
      return `${harnessName} wants to write ${file ?? 'a file'}.`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${harnessName} wants to change ${file ?? 'a file'}.`;
    case 'WebFetch':
      return `${harnessName} wants to fetch ${str(input.url) ?? 'a web page'}.`;
    default:
      return `${harnessName} wants to use ${p.tool}.`;
  }
}

/** A tool call waiting for the user: what it does, then Allow or Deny. */
function PermissionCard({ state, p }: { state: ChatState; p: ChatPermissionRequest }) {
  const row: MessageRow = {
    id: `permission-${p.id}`,
    kind: 'tool',
    tool: p.tool,
    input: p.input,
    text: JSON.stringify(p.input, null, 2),
    preview: '',
  };
  return (
    <div className="chat-card chat-permission">
      <div>{requestText(state.harnessName, p)}</div>
      <div className="chat-tool-body">
        <ToolInputView row={row} />
      </div>
      <div className="chat-permission-actions">
        <button className="btn primary" onClick={() => window.looper.chat.answer(state.id, p.id, true)}>
          Allow
        </button>
        <button className="btn" onClick={() => window.looper.chat.answer(state.id, p.id, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** One line above the input: what the agent is doing, or why the chat ended. */
function ChatStatus({ state }: { state: ChatState }) {
  if (state.permissions.length > 0) return <div className="chat-status muted">{state.harnessName} is waiting for your answer.</div>;
  if (state.status === 'working') return <div className="chat-status muted">{state.harnessName} is working…</div>;
  if (state.status === 'starting') return <div className="chat-status muted">Starting {state.harnessName}…</div>;
  if (state.status === 'ended') return <div className="chat-status error-text">{state.error ?? 'The session ended.'}</div>;
  return null;
}

/** A chat window: the task's harness without a terminal (Open Project in Chat, Continue in Chat). */
export function ChatApp({ id, title }: { id: string; title: string }) {
  const [state, setState] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    void window.looper.chat.get(id).then((s) => s && setState(s));
    const unsubUi = window.looper.onUi((e) => {
      // File → Attach Files…: the files wait under the message box like dropped ones.
      if (e.type === 'chat-attached') setPending((p) => [...p, ...e.attachments]);
    });
    const unsub = subscribe((e) => {
      if (e.type === 'chat' && e.state.id === id) setState(e.state);
    });
    return () => {
      unsub();
      unsubUi();
    };
  }, [id]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state?.rows.length, state?.history.length, state?.permissions.length, state?.status]);

  if (!state) return <div className="empty">Starting…</div>;

  const ended = state.status === 'ended';
  const ctx: RowCtx = { taskId: state.taskId, runId: state.fromRunId ?? '' };

  const attach = (files: File[]) => {
    if (files.length === 0 || ended) return;
    void window.looper.chat
      .attachFiles(id, files)
      .then((added) => setPending((p) => [...p, ...added]))
      .catch(reportError);
  };

  const send = () => {
    if (ended || (!text.trim() && pending.length === 0)) return;
    window.looper.chat.send(id, text.trim(), pending);
    setText('');
    setPending([]);
    atBottom.current = true;
  };

  return (
    <div
      className={`chat-app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      {state.harnessKind === 'codex' && (
        <div className="banner muted">
          Codex can't ask for permission in a chat, so it does only what the task's permission mode
          ({state.permissionLabel || 'None'}) allows.
        </div>
      )}
      <section className="builder-chat">
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {state.history.length > 0 && (
            <>
              <div className="pane-title chat-divider">Earlier in run {state.fromRunId}</div>
              <Items items={groupRows(state.history)} ctx={ctx} prefix="h" />
              <div className="pane-title chat-divider">This chat</div>
            </>
          )}
          <Items items={groupRows(state.rows)} ctx={ctx} prefix="r" />
          {state.permissions.map((p) => (
            <PermissionCard key={p.id} state={state} p={p} />
          ))}
          <ChatStatus state={state} />
        </div>
        {pending.length > 0 && (
          <div className="chat-pending">
            <AttachmentList items={pending} onRemove={(a) => setPending((p) => p.filter((x) => x !== a))} />
          </div>
        )}
        <div className="chat-composer">
          <textarea
            value={text}
            placeholder={`Message ${state.harnessName}`}
            rows={3}
            autoFocus
            disabled={ended}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              e.preventDefault();
              attach(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn primary" disabled={ended || (!text.trim() && pending.length === 0)} onClick={send}>
            Send
          </button>
        </div>
      </section>
    </div>
  );
}
