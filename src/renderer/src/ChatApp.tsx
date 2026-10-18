import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contextText, forkPoint, type Attachment, type ChatPermissionRequest, type ChatState } from '@shared/chat';
import { EFFORT_LEVELS, PERMISSION_MODES } from '@shared/environments';
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

const permissionLabel = (state: ChatState): string =>
  PERMISSION_MODES[state.harnessKind].find(([v]) => v === state.settings.permissionMode)?.[1] ?? state.settings.permissionMode;

/** The window's bottom line: harness, model, effort, permission mode, and how full the context is. */
function ChatStatusBar({ state }: { state: ChatState }) {
  const s = state.settings;
  const entry = state.models.find((m) => m.id === s.model);
  const model = entry?.name ?? s.model ?? state.activeModel ?? 'Default model';
  // As resolveEffort: the chat's own, else the model entry's default.
  const effort = s.effort ?? (s.model ? entry?.defaultEffort : undefined);
  const effortName = effort ? EFFORT_LEVELS[state.harnessKind].find(([v]) => v === effort)?.[1] ?? effort : undefined;
  return (
    <div className="statusbar">
      <span>{state.harnessName}</span>
      <span>{model}</span>
      <span>{effortName ? `${effortName} effort` : 'Default effort'}</span>
      <span>Permission mode: {permissionLabel(state)}</span>
      <span className="spacer" />
      {state.context && <span>{contextText(state.context)}</span>}
    </div>
  );
}

/** The visible matches of `query` in `root`, in document order (case-insensitive, within one text node). */
function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Text in a closed <details> isn't on screen.
    acceptNode: (n) => (n.parentElement?.checkVisibility() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const hay = node.data.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      ranges.push(r);
    }
  }
  return ranges;
}

/** A chat window: the task's harness without a terminal (Open Project in Chat, Continue in Chat, Fork from Here). */
export function ChatApp({ id, title }: { id: string; title: string }) {
  const [state, setState] = useState<ChatState | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [find, setFind] = useState<{ query: string; index: number } | null>(null);
  const [matches, setMatches] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  /** Up/Down in the message box: which sent message is shown, and the draft to go back to. */
  const recall = useRef<{ index: number; draft: string } | null>(null);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    void window.looper.chat.get(id).then((s) => {
      if (!s) return;
      setState(s);
      // Fork from Here on the user's own message: it waits in the message box, ready to change and send.
      if (s.draft) {
        setText(s.draft.text);
        setPending(s.draft.attachments);
      }
    });
    const unsubUi = window.looper.onUi((e) => {
      // File → Attach Files…: the files wait under the message box like dropped ones.
      if (e.type === 'chat-attached') setPending((p) => [...p, ...e.attachments]);
      else if (e.type === 'chat-find') {
        setFind((f) => f ?? { query: window.getSelection()?.toString().trim() ?? '', index: 0 });
        setTimeout(() => findRef.current?.select());
      } else if (e.type === 'chat-edit') {
        recall.current = null;
        setText(e.text);
        setPending(e.attachments);
        composerRef.current?.focus();
      }
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

  // Find: every match highlighted, the current one brought into view when it changes
  // (new output only updates the highlights, so reading elsewhere isn't interrupted).
  const scrolledTo = useRef('');
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !find) {
      CSS.highlights.delete('chat-find');
      CSS.highlights.delete('chat-find-current');
      setMatches(0);
      return;
    }
    const ranges = findRanges(root, find.query);
    setMatches(ranges.length);
    CSS.highlights.set('chat-find', new Highlight(...ranges));
    const current = ranges.length ? ranges[((find.index % ranges.length) + ranges.length) % ranges.length] : null;
    if (!current) {
      CSS.highlights.delete('chat-find-current');
      return;
    }
    CSS.highlights.set('chat-find-current', new Highlight(current));
    const key = `${find.query}\n${find.index}`;
    if (scrolledTo.current === key) return;
    scrolledTo.current = key;
    const box = current.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) {
      root.scrollTop += box.top - view.top - view.height / 2;
      atBottom.current = false;
    }
  }, [find, state]);

  const sent = useMemo(
    () => (state ? [...state.history, ...state.rows].filter((r) => r.kind === 'prompt' && r.text).map((r) => r.text) : []),
    [state],
  );

  const stepFind = (dir: 1 | -1) => setFind((f) => (f ? { ...f, index: f.index + dir } : f));
  const closeFind = () => {
    setFind(null);
    composerRef.current?.focus();
  };

  // Esc closes the find bar, else stops the agent's turn (the Chat menu shows it as Stop's key);
  // F3 and Shift+F3 step through the matches.
  const keys = useRef({ find, status: state?.status });
  keys.current = { find, status: state?.status };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (keys.current.find) closeFind();
        else if (keys.current.status === 'working') void window.looper.chat.stop(id);
        else return;
        e.preventDefault();
      } else if (e.key === 'F3' && keys.current.find) {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!state) return <div className="empty">Starting…</div>;

  const ended = state.status === 'ended';

  const all = [...state.history, ...state.rows];
  const onRowContextMenu = (_e: React.MouseEvent, row: MessageRow) => {
    const selection = window.getSelection()?.toString() || undefined;
    const index = all.indexOf(row);
    const fork = index >= 0 && forkPoint(all, index, state.harnessKind, state.status === 'working') ? index : undefined;
    const base = { chatId: id, taskId: state.taskId, selection, fork };
    switch (row.kind) {
      case 'prompt':
        window.looper.chat.showContextMenu({
          ...base,
          text: row.text || undefined,
          resend: ended ? undefined : { text: row.text, attachments: row.attachments ?? [] },
        });
        return;
      case 'tool':
        window.looper.chat.showContextMenu({
          ...base,
          text: row.text || undefined,
          textLabel: 'Copy Input',
          result: row.result || undefined,
          file: row.file,
        });
        return;
      default:
        window.looper.chat.showContextMenu({ ...base, text: row.text || undefined });
    }
  };

  const ctx: RowCtx = { taskId: state.taskId, runId: state.id, onContextMenu: onRowContextMenu };

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
    recall.current = null;
    atBottom.current = true;
  };

  /** Up on the first line of an empty box (or while going through them) brings back the sent messages, newest first. */
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && plain && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
      if (ta.value && !recall.current) return;
      const index = (recall.current?.index ?? sent.length) - 1;
      if (index < 0) return;
      e.preventDefault();
      recall.current = { index, draft: recall.current?.draft ?? ta.value };
      setText(sent[index]);
    } else if (e.key === 'ArrowDown' && plain && recall.current && !ta.value.slice(ta.selectionEnd).includes('\n')) {
      e.preventDefault();
      const index = recall.current.index + 1;
      if (index >= sent.length) {
        setText(recall.current.draft);
        recall.current = null;
      } else {
        recall.current = { ...recall.current, index };
        setText(sent[index]);
      }
    }
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
          Codex can't ask for permission in a chat, so it does only what the permission mode ({permissionLabel(state) || 'None'})
          allows.
        </div>
      )}
      {find && (
        <div className="chat-find">
          <input
            ref={findRef}
            value={find.query}
            placeholder="Find"
            autoFocus
            onChange={(e) => setFind({ query: e.target.value, index: 0 })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="muted">
            {!find.query ? '' : matches ? `${(((find.index % matches) + matches) % matches) + 1} of ${matches}` : 'No matches'}
          </span>
          <button className="btn small" disabled={!matches} onClick={() => stepFind(-1)}>
            Previous
          </button>
          <button className="btn small" disabled={!matches} onClick={() => stepFind(1)}>
            Next
          </button>
          <button className="btn small" onClick={closeFind}>
            Close
          </button>
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
          onContextMenu={(e) => {
            const selection = window.getSelection()?.toString();
            if (!selection) return;
            e.preventDefault();
            window.looper.chat.showContextMenu({ chatId: id, taskId: state.taskId, selection });
          }}
        >
          {state.history.length > 0 && state.historyLabel && (
            <div className="pane-title chat-divider">{state.historyLabel}</div>
          )}
          <Items items={groupRows(state.history)} ctx={ctx} prefix="h" />
          {state.history.length > 0 && state.historyLabel && <div className="pane-title chat-divider">This chat</div>}
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
            ref={composerRef}
            value={text}
            placeholder={`Message ${state.harnessName}`}
            rows={3}
            autoFocus
            disabled={ended}
            onChange={(e) => {
              recall.current = null;
              setText(e.target.value);
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              e.preventDefault();
              attach(files);
            }}
            onKeyDown={onComposerKey}
          />
          <button className="btn primary" disabled={ended || (!text.trim() && pending.length === 0)} onClick={send}>
            Send
          </button>
        </div>
      </section>
      <ChatStatusBar state={state} />
    </div>
  );
}
