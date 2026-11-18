import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { FindBar, useFindFocus, useFindHighlights, type FindState } from './FindBar';
import { atEnd } from './newest-first';
import { ChatStatus, Conversation, type ConversationHandle, type ConversationPart } from './Conversation';
import { continueAt, continueSkipped, forkPoint, type ChatState } from '@shared/chat';
import { LOGIN_FAILED_RE } from '@shared/logins';
import type { MessageRow } from '@shared/messages';
import { fmtClock } from '../format';
import { MINUTE, useNow } from '../useNow';
import { useSessionsState } from './phone/useSessionsState';
import { showRowContextMenu, systemSelecting, UserMessage, useSelectText, type RowCtx } from './ChatRows';
import { groupRows } from './chat-groups';
import { permissionLabel } from './chat-settings';
import { Composer, type ComposerHandle } from './Composer';
import { onUi } from '../events';
import { useChatsSettings } from './hooks';
import { PermissionCard } from './PermissionCard';
import { reportError } from '../report-error';

/** Under the usage limit's message: whether Looper continues the chat at the reset, and the button that changes it. */
function LimitNotice({ state }: { state: ChatState }) {
  const sessions = useSessionsState();
  const rule = useChatsSettings().skipExpiredContinue;
  const now = useNow(MINUTE);
  const limit = state.limit;
  if (!limit) return null;
  const at = continueAt(limit);
  const passed = at !== undefined && at <= now;
  const notice = (text: string, button?: { label: string; run: () => void }) => (
    <div className="chat-limit-notice">
      {text}
      {button && (
        <button className="link" onClick={button.run}>
          {button.label}
        </button>
      )}
    </div>
  );
  if (!state.autoContinue) {
    if (passed) return null;
    return notice('Looper won’t continue this chat when the limit resets.', {
      label: 'Continue When Limit Resets',
      run: () => window.looper.chat.setAutoContinue(state.id, true),
    });
  }
  const dontContinue = { label: 'Don’t Continue', run: () => window.looper.chat.setAutoContinue(state.id, false) };
  const cacheUntil = sessions?.sessions.find((s) => s.id === state.id)?.cacheUntil;
  if (!state.continueAnyway && continueSkipped(rule, at ?? now, cacheUntil, state.context?.tokens)) {
    const size = rule.aboveTokens > 0 ? ` and the context is larger than ${Math.round(rule.aboveTokens / 1000)}k tokens` : '';
    const anyway = { label: 'Continue Anyway', run: () => window.looper.chat.continueAnyway(state.id) };
    if (passed) return notice(`The limit has reset, but Looper didn’t continue this chat because the cache has expired${size}.`, anyway);
    return notice(`Looper won’t continue this chat when the limit resets, because the cache will have expired${size}.`, anyway);
  }
  if (passed) return null;
  return notice(at === undefined ? 'Looper will try to continue this chat every hour.' : `Looper will continue this chat at ${fmtClock(at, now)}.`, dontContinue);
}

/** The latest turn ended on Claude Code's error for a missing login, and nothing came after it. */
function endsOnLogin(rows: readonly MessageRow[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'prompt' || r.kind === 'agent') return false;
    if (r.kind === 'error') return LOGIN_FAILED_RE.test(r.text);
  }
  return false;
}

/** Under Claude Code's error for a missing login: Log In, in a terminal window. */
function LoginNotice({ state }: { state: ChatState }) {
  const logIn = () => void window.looper.logins.logIn(state.environmentId, state.harnessId).catch(reportError);
  return (
    <div className="chat-limit-notice">
      Claude Code needs you to log in again.
      <button className="link" onClick={logIn}>
        Log In
      </button>
    </div>
  );
}

/** Right-click on a message or tool call: the chat's menu for that row. */
function showRowMenu(state: ChatState, row: MessageRow, selectText: string | undefined): void {
  const all = [...state.history, ...state.rows];
  const index = all.indexOf(row);
  const fork = index >= 0 && forkPoint(all, index, state.harnessKind, state.status === 'working') ? index : undefined;
  showRowContextMenu({ chatId: state.id, taskId: state.taskId, quote: state.status !== 'ended', fork, selectText }, row);
}

/**
 * On iOS the message box floats over the conversation's end (phone.css), so the conversation scrolls under it:
 * this keeps its height in `--chat-dock-h` for the conversation to scroll clear of it.
 */
function useDockHeight(sectionRef: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!on || !section) return;
    const measure = () => {
      let h = 0;
      let scroll: HTMLElement | null = null;
      for (const el of section.children) {
        if (el.classList.contains('chat-scroll')) scroll = el as HTMLElement;
        else h += (el as HTMLElement).offsetHeight;
      }
      // A reader at the end stays there as the box takes more or less room.
      const stays = !!scroll && atEnd(scroll);
      section.style.setProperty('--chat-dock-h', `${h}px`);
      if (scroll && stays) scroll.scrollTop = scroll.scrollHeight;
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      // The border box: the box's padding changes alone as the keyboard and the home indicator's inset come and go.
      for (const el of section.children) if (!el.classList.contains('chat-scroll')) ro.observe(el, { box: 'border-box' });
      measure();
    };
    const mo = new MutationObserver(watch);
    mo.observe(section, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [sectionRef, on]);
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
  const findField = useFindFocus();
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
  const [find, setFind] = useState<FindState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversation = useRef<ConversationHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // On iOS the message box floats over the conversation, and what the agent is doing is the conversation's last row.
  const floatingBox = !embedded && document.documentElement.dataset.platform === 'ios';
  useDockHeight(sectionRef, floatingBox);

  const matches = useFindHighlights(scrollRef, find, setFind, () => conversation.current?.leaveEnd());

  const stepFind = (dir: 1 | -1) => setFind((f) => (f ? { ...f, index: f.index + dir } : f));
  const closeFind = () => {
    setFind(null);
    composer.current?.focus();
  };

  useEffect(() => {
    return onUi((e) => {
      if (e.type !== 'chat-find') return;
      setFind((f) => f ?? { query: window.getSelection()?.toString().trim() ?? '', index: 0 });
      findField.focus();
    });
  }, [findField]);

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
  const selectText = useSelectText(id);
  const ctx = useMemo<RowCtx>(
    () => ({ taskId: state.taskId, runId: state.id, onContextMenu: (e, row) => showRowMenu(latest.current, row, selectText(e)) }),
    [state.taskId, state.id, selectText],
  );
  const { expandThinking } = useChatsSettings();
  const allHistory = useMemo(() => groupRows(state.history, expandThinking), [state.history, expandThinking]);
  const allItems = useMemo(() => groupRows(state.rows, expandThinking), [state.rows, expandThinking]);

  const parts = useMemo<ConversationPart[]>(
    () => [
      { key: 'h', items: allHistory, heading: state.historyLabel },
      { key: 'r', items: allItems, heading: state.history.length > 0 && state.historyLabel ? 'This chat' : undefined },
    ],
    [allHistory, allItems, state.history.length, state.historyLabel],
  );

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
        // Only files are the chat's: a dashboard card dropped here goes on to the dashboard.
        if (!e.dataTransfer.types.includes('Files')) return;
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
        <FindBar
          find={find}
          matches={matches}
          onChange={setFind}
          onClose={closeFind}
          inputRef={findField.inputRef}
        />
      )}
      <section className="builder-chat" ref={sectionRef}>
        <Conversation
          ref={conversation}
          id={id}
          parts={parts}
          ctx={ctx}
          endKey={`${state.rows.length}/${state.history.length}/${state.permissions.length}/${state.status}/${state.queued.length}`}
          scrollRef={scrollRef}
          // Find draws every item, so it searches the whole chat.
          drawAll={find !== null}
          card={embedded}
          keepPlace={!embedded}
          onContextMenu={(e) => {
            const selection = window.getSelection()?.toString();
            if (!selection || systemSelecting(e)) return;
            e.preventDefault();
            window.looper.chat.showContextMenu({ chatId: id, taskId: state.taskId, selection, quote: !ended });
          }}
        >
          {state.limit && state.status === 'ready' && <LimitNotice state={state} />}
          {state.harnessKind === 'claude-code' && state.status !== 'working' && endsOnLogin(state.rows) && <LoginNotice state={state} />}
          {state.permissions.map((p) => (
            <PermissionCard key={p.id} harnessKind={state.harnessKind} p={p} answer={(allow) => window.looper.chat.answer(state.id, p.id, allow)} />
          ))}
          {/* Queued messages close the conversation, outlined until the agent reads them; Edit and Cancel until they've gone to it. */}
          {state.queued.map((m) => (
            <div key={m.id} className="chat-queued">
              <UserMessage text={m.text} attachments={m.attachments.length > 0 ? m.attachments : undefined} />
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
          {floatingBox && <ChatStatus state={state} />}
        </Conversation>
        {!floatingBox && <ChatStatus state={state} />}
        <Composer
          ref={composer}
          state={state}
          embedded={embedded}
          onSent={() => conversation.current?.toEnd()}
        />
      </section>
    </div>
  );
}
