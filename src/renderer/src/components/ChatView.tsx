import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AddonSearchBox } from './AddonPane';
import { forkPoint, type Attachment, type ChatPermissionRequest, type ChatSettingMenu, type ChatState } from '@shared/chat';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessKindLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import type { SlashCommand } from '@shared/sessions';
import { AttachmentList, ChatRow, ToolGroup, groupRows, type ChatItem, type RowCtx } from './ChatRows';
import { commandAt, insertCommand, matchCommands, quoteText } from './composer';
import { ICONS } from './icons';
import { PromptBody } from './Markdown';
import { ToolButton } from './ToolButton';
import { ToolInputView } from './ToolContent';

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
  if (state.permissions.length > 0) return <div className="chat-status chat-working muted">{harnessKindLabel(state.harnessKind)} is waiting for your answer.</div>;
  if (state.status === 'working') return <div className="chat-status chat-working muted">{harnessKindLabel(state.harnessKind)} is working…</div>;
  if (state.status === 'starting') return <div className="chat-status chat-working muted">Starting {harnessKindLabel(state.harnessKind)}…</div>;
  if (state.status === 'ended') return <div className="chat-status chat-working error-text">{state.error ?? 'The session ended.'}</div>;
  return null;
}

export const permissionLabel = (state: ChatState): string =>
  PERMISSION_MODES[state.harnessKind].find(([v]) => v === state.settings.permissionMode)?.[1] ?? state.settings.permissionMode;

/** The chat's harness, model, effort and permission mode as the command bar names them. */
function settingLabels(state: ChatState): Record<ChatSettingMenu, string> {
  const s = state.settings;
  const entry = state.models.find((m) => m.id === s.model);
  // As resolveEffort: the chat's own, else the model entry's default.
  const effort = s.effort ?? (s.model ? entry?.defaultEffort : undefined);
  return {
    harness: state.harnessName,
    model: entry?.name ?? s.model ?? state.activeModel ?? 'Default model',
    effort: effort ? (EFFORT_LEVELS[state.harnessKind].find(([v]) => v === effort)?.[1] ?? effort) : 'Default effort',
    permission: permissionLabel(state) || 'Default',
  };
}

const SETTING_TITLES = { harness: 'Harness', model: 'Model', effort: 'Effort', permission: 'Permission Mode' } as const;
const SETTINGS = ['harness', 'model', 'effort', 'permission'] as const;

const MENU_ARROW = (
  <svg width="8" height="16" viewBox="0 0 8 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m1.5 6.8 2.5 2.5 2.5-2.5" />
  </svg>
);

/**
 * The bar above the message box: Attach Files and the skill list on the left,
 * the chat's harness, model, effort and permission mode on the right, each a
 * menu. The harness changes only until the first message. A narrow chat (a
 * dashboard card, a phone) has one button instead, whose menu has the four
 * as submenus; the stylesheet shows one or the other by the composer's width.
 */
function CommandBar({ state, onAttach, onSkills }: { state: ChatState; onAttach: () => void; onSkills: () => void }) {
  const ended = state.status === 'ended';
  const labels = settingLabels(state);
  // A chat whose harness didn't start can still move to another one.
  const disabled = (which: ChatSettingMenu) => (which === 'harness' ? state.harnessLocked : ended);
  const open = (which: ChatSettingMenu | 'all') => (e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    window.looper.chat.showSettingMenu(state.id, which, box.left, box.bottom);
  };
  return (
    <div className="toolbar chat-commandbar">
      <ToolButton icon={ICONS.attach} title="Attach Files (Ctrl+O)" enabled={!ended} onClick={onAttach} />
      <ToolButton icon={ICONS.skills} title="Skills and Commands (/)" enabled={!ended && state.commands.length > 0} onClick={onSkills} />
      <span className="spacer" />
      <span className="commandbar-full">
        {SETTINGS.map((which) => (
          <button
            key={which}
            className="labeled commandbar-menu"
            title={SETTING_TITLES[which]}
            aria-label={`${SETTING_TITLES[which]}: ${labels[which]}`}
            aria-haspopup="menu"
            disabled={disabled(which)}
            onClick={open(which)}
          >
            {labels[which]}
            {MENU_ARROW}
          </button>
        ))}
      </span>
      <button
        className="labeled commandbar-menu commandbar-compact"
        title="Chat Settings"
        aria-label={`Chat Settings: ${SETTINGS.map((w) => labels[w]).join(', ')}`}
        aria-haspopup="menu"
        disabled={SETTINGS.every(disabled)}
        onClick={open('all')}
      >
        {labels.model}
        {MENU_ARROW}
      </button>
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

/** Each chat's unsent message and files, kept while the window shows another session. */
const drafts = new Map<string, { text: string; pending: Attachment[] }>();

/**
 * A chat in the Sessions window: the conversation, its queue, and the message box.
 * `embedded`: one of several on the dashboard, so it doesn't take the focus when it
 * opens, and Esc stops its agent only while the focus is in it.
 */
export function ChatView({ state, embedded = false }: { state: ChatState; embedded?: boolean }) {
  const id = state.id;
  const [text, setTextState] = useState(() => drafts.get(id)?.text ?? state.draft?.text ?? '');
  const [pending, setPendingState] = useState<Attachment[]>(() => drafts.get(id)?.pending ?? state.draft?.attachments ?? []);
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
  const [pick, setPick] = useState(0);
  /** Where the cursor is in the message box: the "/" list follows the word it's in. */
  const [caret, setCaret] = useState(0);
  /** Esc closed the "/" list for the word starting here. */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The command bar's skill button: the whole list, whatever the box holds.
  const [picker, setPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const atBottom = useRef(true);
  /** Up/Down in the message box: which sent message is shown, and the draft to go back to. */
  const recall = useRef<{ index: number; draft: string } | null>(null);

  const setText = (t: string) => {
    setTextState(t);
    const draft = { text: t, pending: drafts.get(id)?.pending ?? pending };
    drafts.set(id, draft);
    // The engine keeps it too, for the next start of Looper.
    window.looper.chat.setDraft(id, draft.text, draft.pending);
  };
  const setPending = (fn: (p: Attachment[]) => Attachment[]) =>
    setPendingState((p) => {
      const next = fn(p);
      const draft = { text: drafts.get(id)?.text ?? text, pending: next };
      drafts.set(id, draft);
      window.looper.chat.setDraft(id, draft.text, next);
      return next;
    });

  /** Text put in the box by code: the box takes the focus with its cursor here once it shows the text. */
  const caretTo = useRef<number | null>(null);
  const putText = (t: string, at: number) => {
    setText(t);
    setCaret(at);
    caretTo.current = at;
  };
  useLayoutEffect(() => {
    const ta = composerRef.current;
    const at = caretTo.current;
    if (at === null || !ta) return;
    caretTo.current = null;
    ta.focus();
    ta.setSelectionRange(at, at);
    if (at === ta.value.length) ta.scrollTop = ta.scrollHeight;
  }, [text]);

  // Quote: the selection goes after what the box holds, and the cursor after the quote.
  const quoteIntoBox = (selection: string) => {
    const quote = quoteText(selection);
    if (!quote || state.status === 'ended') return;
    recall.current = null;
    const next = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${quote}` : quote;
    putText(next, next.length);
  };
  const quoteRef = useRef(quoteIntoBox);
  quoteRef.current = quoteIntoBox;

  useEffect(() => {
    const unsubUi = window.looper.onUi((e) => {
      // File → Attach Files…: the files wait under the message box like dropped ones.
      if (e.type === 'chat-attached') setPending((p) => [...p, ...e.attachments]);
      else if (e.type === 'chat-quote') {
        if (e.chatId === id) quoteRef.current(e.text);
      }
      else if (e.type === 'chat-find') {
        setFind((f) => f ?? { query: window.getSelection()?.toString().trim() ?? '', index: 0 });
        setFindFocus((n) => n + 1);
      } else if (e.type === 'chat-edit' && e.chatId === id) {
        recall.current = null;
        setText(e.text);
        setPending(() => e.attachments);
        composerRef.current?.focus();
      }
    });
    if (!embedded) composerRef.current?.focus();
    return unsubUi;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  const sent = useMemo(
    () => [...state.history, ...state.rows].filter((r) => r.kind === 'prompt' && r.text).map((r) => r.text),
    [state.history, state.rows],
  );

  const stepFind = (dir: 1 | -1) => setFind((f) => (f ? { ...f, index: f.index + dir } : f));
  const closeFind = () => {
    setFind(null);
    composerRef.current?.focus();
  };

  // Esc closes the find bar, else stops the agent's turn (the Chat menu shows it as Stop's key);
  // F3 and Shift+F3 step through the matches; Ctrl+Shift+Q quotes the text selected in the messages.
  const keys = useRef({ find, status: state.status });
  keys.current = { find, status: state.status };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.code === 'KeyQ' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const sel = window.getSelection();
        const root = scrollRef.current;
        if (!sel || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
        e.preventDefault();
        quoteRef.current(sel.toString());
      } else if (e.key === 'Escape') {
        const mine = !embedded || !!scrollRef.current?.closest('.chat-app')?.contains(document.activeElement);
        if (keys.current.find) closeFind();
        else if (keys.current.status === 'working' && mine) void window.looper.chat.stop(id);
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
  const all = [...state.history, ...state.rows];
  const onRowContextMenu = (_e: React.MouseEvent, row: MessageRow) => {
    const selection = window.getSelection()?.toString() || undefined;
    const index = all.indexOf(row);
    const fork = index >= 0 && forkPoint(all, index, state.harnessKind, state.status === 'working') ? index : undefined;
    const base = { chatId: id, taskId: state.taskId, selection, quote: !ended, fork };
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
    setPending(() => []);
    recall.current = null;
    atBottom.current = true;
  };

  // "/" at the start of the box or of a word lists the harness's commands and skills (Codex's "$" too).
  const typed = commandAt(text, caret, [...new Set(['/', state.commandPrefix])]);
  const typedList = !!typed && typed.start !== closedAt && focused && !ended;
  const options = typedList ? matchCommands(state.commands, typed.query) : picker ? matchCommands(state.commands, '', Infinity) : [];
  const picked = Math.min(pick, options.length - 1);
  useLayoutEffect(() => {
    listRef.current?.querySelector('.slash-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [picked, options.length]);
  const choose = (c: SlashCommand) => {
    const command = `${state.commandPrefix}${c.name}`;
    setPicker(false);
    if (typedList) {
      const next = insertCommand(text, typed.start, caret, command);
      putText(next.text, next.caret);
    } else {
      // From the skill button, the command goes in front of what's already typed.
      putText(`${command} ${text.replace(/^\s+/, '')}`, command.length + 1);
    }
  };
  const openPicker = () => {
    setPicker(true);
    setPick(0);
    composerRef.current?.focus();
  };
  const pickFiles = () =>
    void window.looper.chat
      .pickFiles(id)
      .then((added) => setPending((p) => [...p, ...added]))
      .catch(reportError);

  /** Up on the first line of an empty box (or while going through them) brings back the sent messages, newest first. */
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (options.length > 0) {
      const at = Math.min(pick, options.length - 1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(options[at]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typed) setClosedAt(typed.start);
        setPicker(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
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

  const editQueued = (messageId: string) =>
    void window.looper.chat.unqueue(id, messageId).then((m) => {
      if (!m) return;
      setText(text.trim() ? `${m.text}\n\n${text}` : m.text);
      setPending((p) => [...m.attachments, ...p]);
      composerRef.current?.focus();
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
          <Items items={groupRows(state.history)} ctx={ctx} prefix="h" />
          {state.history.length > 0 && state.historyLabel && <div className="pane-title chat-divider">This chat</div>}
          <Items items={groupRows(state.rows)} ctx={ctx} prefix="r" />
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
        <div className="chat-composer">
          <div className="composer-main">
            <CommandBar state={state} onAttach={pickFiles} onSkills={openPicker} />
            {pending.length > 0 && (
              <div className="chat-pending">
                <AttachmentList items={pending} onRemove={(a) => setPending((p) => p.filter((x) => x !== a))} />
              </div>
            )}
            {/* The "/" list drops from the message box's top edge, like a combo box's list. */}
            <div className="composer-input">
              {options.length > 0 && (
                <div className="slash-list" role="listbox" id={`slash-list-${id}`} ref={listRef}>
                  {options.map((c, i) => (
                    <div
                      key={c.name}
                      id={`slash-${id}-${i}`}
                      role="option"
                      aria-selected={i === picked}
                      className={`slash-item${i === picked ? ' selected' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(c);
                      }}
                      onMouseEnter={() => setPick(i)}
                    >
                      <span className="slash-name">
                        {state.commandPrefix}
                        {c.name}
                        {c.argumentHint ? <span className="slash-hint"> {c.argumentHint}</span> : null}
                      </span>
                      <span className="slash-desc">{c.description}</span>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={text}
                placeholder={`Message ${harnessKindLabel(state.harnessKind)}`}
                rows={3}
                disabled={ended}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={options.length > 0}
                aria-controls={options.length > 0 ? `slash-list-${id}` : undefined}
                aria-activedescendant={options.length > 0 ? `slash-${id}-${picked}` : undefined}
                onChange={(e) => {
                  recall.current = null;
                  const at = e.target.selectionStart;
                  setText(e.target.value);
                  setCaret(at);
                  setPick(0);
                  if (commandAt(e.target.value, at, ['/', state.commandPrefix])?.start !== closedAt) setClosedAt(null);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files];
                  if (files.length === 0) return;
                  e.preventDefault();
                  attach(files);
                }}
                onKeyDown={onComposerKey}
                onFocus={() => setFocused(true)}
                onBlur={() => {
                  setFocused(false);
                  setPicker(false);
                }}
              />
            </div>
          </div>
          <div className="composer-actions">
            <button className="btn primary" disabled={ended || (!text.trim() && pending.length === 0)} onClick={send}>
              {state.status === 'working' ? 'Queue' : 'Send'}
            </button>
            <button className="btn" title="Stop (Esc)" disabled={state.status !== 'working'} onClick={() => void window.looper.chat.stop(id).catch(reportError)}>
              Stop
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
