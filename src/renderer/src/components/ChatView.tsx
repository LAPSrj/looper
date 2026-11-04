import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AddonSearchBox } from './AddonPane';
import { forkPoint, type ChatPermissionRequest, type ChatState } from '@shared/chat';
import { harnessKindLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import { AttachmentList, ChatRow, ToolGroup, type RowCtx } from './ChatRows';
import { groupRows, type ChatItem } from './chat-groups';
import { permissionLabel } from './chat-settings';
import { Composer, type ComposerHandle } from './Composer';
import { useChatsSettings } from './hooks';
import { PromptBody } from './Markdown';
import { ToolInputView } from './ToolContent';

const Items = memo(function Items({ items, ctx, prefix }: { items: ChatItem[]; ctx: RowCtx; prefix: string }) {
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
});

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
export function PermissionCard({ state, p }: { state: ChatState; p: ChatPermissionRequest }) {
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
      <div>{requestText(harnessKindLabel(state.harnessKind), p)}</div>
      <div className="chat-tool-body">
        <ToolInputView row={row} />
      </div>
      <PermissionButtons chatId={state.id} permissionId={p.id} />
    </div>
  );
}

/** Allow and Deny on a chat's permission request: in the chat, and on its dashboard card. */
export function PermissionButtons({ chatId, permissionId }: { chatId: string; permissionId: string }) {
  return (
    <div className="chat-permission-actions">
      <button className="btn primary" onClick={() => window.looper.chat.answer(chatId, permissionId, true)}>
        Allow
      </button>
      <button className="btn" onClick={() => window.looper.chat.answer(chatId, permissionId, false)}>
        Deny
      </button>
    </div>
  );
}

/** One line above the input: what the agent is doing, or why the chat ended. */
function ChatStatus({ state }: { state: ChatState }) {
  if (state.permissions.length > 0) return <div className="chat-status chat-working muted">{harnessKindLabel(state.harnessKind)} is waiting for your answer.</div>;
  if (state.status === 'working') return <div className="chat-status chat-working muted">{harnessKindLabel(state.harnessKind)} is working…</div>;
  if (state.status === 'starting') return <div className="chat-status chat-working muted">Starting {harnessKindLabel(state.harnessKind)}…</div>;
  if (state.status === 'ended') return <div className="chat-status chat-working error-text">{state.error ?? 'The session ended.'}</div>;
  return null;
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

/** Right-click on a message or tool call: the chat's menu for that row. */
function showRowMenu(state: ChatState, row: MessageRow): void {
  const ended = state.status === 'ended';
  const all = [...state.history, ...state.rows];
  const selection = window.getSelection()?.toString() || undefined;
  const index = all.indexOf(row);
  const fork = index >= 0 && forkPoint(all, index, state.harnessKind, state.status === 'working') ? index : undefined;
  const base = { chatId: state.id, taskId: state.taskId, selection, quote: !ended, fork };
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
}

/**
 * A chat in the Sessions window: the conversation, its queue, and the message box.
 * `embedded`: one of several on the dashboard, so it doesn't take the focus when it
 * opens, and Esc stops its agent only while the focus is in it.
 */
export function ChatView({ state, embedded = false }: { state: ChatState; embedded?: boolean }) {
  const id = state.id;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  /** Ctrl+F counts up: the find box takes the focus and selects what it holds, once it shows. */
  const [findFocus, setFindFocus] = useState(0);
  useEffect(() => {
    if (!findFocus) return;
    findRef.current?.focus();
    findRef.current?.select();
  }, [findFocus]);
  // A drag that ends anywhere else (dropped outside, cancelled, left the window) clears the border.
  useEffect(() => {
    const end = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    // Leaving the window gives a dragleave at its edge (relatedTarget is unreliable in drag events).
    const leaveWindow = (e: DragEvent) => {
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) end();
    };
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    window.addEventListener('dragleave', leaveWindow);
    return () => {
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragleave', leaveWindow);
    };
  }, []);
  const [find, setFind] = useState<{ query: string; index: number } | null>(null);
  const [matches, setMatches] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.rows.length, state.history.length, state.permissions.length, state.status, state.queued.length]);

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

  const stepFind = (dir: 1 | -1) => setFind((f) => (f ? { ...f, index: f.index + dir } : f));
  const closeFind = () => {
    setFind(null);
    composer.current?.focus();
  };

  useEffect(() => {
    return window.looper.onUi((e) => {
      if (e.type !== 'chat-find') return;
      setFind((f) => f ?? { query: window.getSelection()?.toString().trim() ?? '', index: 0 });
      setFindFocus((n) => n + 1);
    });
  }, []);

  // Esc closes the find bar, else stops the agent's turn (the Chat menu shows it as Stop's key);
  // F3 and Shift+F3 step through the matches; Ctrl+Shift+Q quotes the text selected in the messages.
  const keys = useRef({ find, status: state.status, commands: state.runningCommands });
  keys.current = { find, status: state.status, commands: state.runningCommands };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.code === 'KeyQ' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const sel = window.getSelection();
        const root = scrollRef.current;
        if (!sel || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
        e.preventDefault();
        composer.current?.quote(sel.toString());
      } else if (e.key === 'Escape') {
        const mine = !embedded || !!scrollRef.current?.closest('.chat-app')?.contains(document.activeElement);
        if (keys.current.find) closeFind();
        // Stop ends the agent's turn and the commands the user ran from the message box.
        else if ((keys.current.status === 'working' || keys.current.commands > 0) && mine) void window.looper.chat.stop(id);
        else return;
        e.preventDefault();
      } else if (e.key === 'F3' && keys.current.find) {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, embedded]);

  const ended = state.status === 'ended';
  // Stable while the chat is the same one, so the rows don't re-render for what changes around them; the menu reads the chat as it is.
  const latest = useRef(state);
  latest.current = state;
  const ctx = useMemo<RowCtx>(() => ({ taskId: state.taskId, runId: state.id, onContextMenu: (_e, row) => showRowMenu(latest.current, row) }), [state.taskId, state.id]);
  const { expandThinking } = useChatsSettings();
  const history = useMemo(() => groupRows(state.history, expandThinking), [state.history, expandThinking]);
  const items = useMemo(() => groupRows(state.rows, expandThinking), [state.rows, expandThinking]);

  const editQueued = (messageId: string) =>
    void window.looper.chat.unqueue(id, messageId).then((m) => {
      if (m) composer.current?.take(m.text, m.attachments);
    });

  return (
    <div
      className={`chat-app${dragging ? ' dragging' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        // Every child fires its own enter and leave: only the last leave ends the drag.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        composer.current?.attach([...e.dataTransfer.files]);
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
          <div
            style={{ display: 'contents' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              }
            }}
          >
            <AddonSearchBox
              value={find.query}
              placeholder="Find"
              inputRef={(el) => {
                findRef.current = el;
              }}
              onChange={(query) => setFind({ query, index: 0 })}
            />
          </div>
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
            window.looper.chat.showContextMenu({ chatId: id, taskId: state.taskId, selection, quote: !ended });
          }}
        >
          {state.history.length > 0 && state.historyLabel && <div className="pane-title chat-divider">{state.historyLabel}</div>}
          <Items items={history} ctx={ctx} prefix="h" />
          {state.history.length > 0 && state.historyLabel && <div className="pane-title chat-divider">This chat</div>}
          <Items items={items} ctx={ctx} prefix="r" />
          {state.permissions.map((p) => (
            <PermissionCard key={p.id} state={state} p={p} />
          ))}
          {/* Queued messages close the conversation, outlined until the agent reads them; Edit and Cancel until they've gone to it. */}
          {state.queued.map((m) => (
            <div key={m.id} className="chat-queued">
              <div className="chat-msg chat-user">
                {m.text && <PromptBody text={m.text} />}
                {m.attachments.length > 0 && <AttachmentList items={m.attachments} />}
              </div>
              {!m.sent && (
                <div className="chat-queued-actions">
                  <button className="link" onClick={() => editQueued(m.id)}>
                    Edit
                  </button>
                  <button className="link" onClick={() => void window.looper.chat.unqueue(id, m.id)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <ChatStatus state={state} />
        <Composer
          ref={composer}
          state={state}
          embedded={embedded}
          onSent={() => {
            atBottom.current = true;
          }}
        />
      </section>
    </div>
  );
}
