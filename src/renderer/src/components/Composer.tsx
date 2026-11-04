import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ChatSettingMenu, ChatState } from '@shared/chat';
import { harnessKindLabel } from '@shared/environments';
import type { SlashCommand } from '@shared/sessions';
import { AttachmentList } from './ChatRows';
import { SETTINGS, SETTING_TITLES, settingDisabled, settingLabels, showSettingMenu } from './chat-settings';
import { bashModeEntry, commandAttachment } from '@shared/bash-mode';
import { commandAt, insertCommand, matchCommands, quoteText, sendsOnEnter } from './composer-text';
import { ICONS } from './icons';
import { useAutoGrow } from './phone/auto-grow';
import { ToolButton } from './ToolButton';
import { isPhone } from '../web/page-nav';
import { subscribe } from '../events';
import { withShortcut } from '../shortcut';

const reportError = (e: Error) => void window.looper.showError(e.message);

const MENU_ARROW = (
  <svg width="8" height="16" viewBox="0 0 8 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m1.5 6.8 2.5 2.5 2.5-2.5" />
  </svg>
);

/**
 * The bar above the message box: Attach Files and the skill list on the left,
 * the chat's harness, model, effort and permission mode on the right, each a
 * menu. The harness changes only until the first message. A narrow chat (a
 * dashboard card) has one button instead, whose menu has the four as
 * submenus; the stylesheet shows one or the other by the composer's width.
 */
function CommandBar({ state, onAttach, onSkills }: { state: ChatState; onAttach: () => void; onSkills: () => void }) {
  const ended = state.status === 'ended';
  const labels = settingLabels(state);
  const open = (which: ChatSettingMenu | 'all') => (e: React.MouseEvent<HTMLButtonElement>) => showSettingMenu(state, which, e.currentTarget.getBoundingClientRect());
  return (
    <div className="toolbar chat-commandbar">
      <ToolButton icon={ICONS.attach} title={withShortcut('Attach Files', 'Ctrl+O')} enabled={!ended} onClick={onAttach} />
      <ToolButton icon={ICONS.skills} title={withShortcut('Skills and Commands', '/')} enabled={!ended && state.commands.length > 0} onClick={onSkills} />
      <span className="spacer" />
      <span className="commandbar-full">
        {SETTINGS.map((which) => (
          <button
            key={which}
            className="labeled commandbar-menu"
            title={SETTING_TITLES[which]}
            aria-label={`${SETTING_TITLES[which]}: ${labels[which]}`}
            aria-haspopup="menu"
            disabled={settingDisabled(state, which)}
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
        disabled={SETTINGS.every((w) => settingDisabled(state, w))}
        onClick={open('all')}
      >
        {labels.model}
        {MENU_ARROW}
      </button>
    </div>
  );
}

const PLUS = (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M10 4v12M4 10h12" />
  </svg>
);
const ARROW_UP = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" />
  </svg>
);
const STOP = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
  </svg>
);

/** The phone composer's + menu: what the desktop's command bar has, as a short list. */
function PlusMenu({
  ended,
  hasCommands,
  queued,
  onAttach,
  onSkills,
  onSendNow,
}: {
  ended: boolean;
  hasCommands: boolean;
  queued: boolean;
  onAttach: () => void;
  onSkills: () => void;
  onSendNow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="phone-plus">
      <button className="phone-plus-button" aria-label="Add" aria-haspopup="menu" aria-expanded={open} disabled={ended} onClick={() => setOpen((o) => !o)}>
        {PLUS}
      </button>
      {open && (
        <>
          <div className="phone-plus-scrim" onClick={() => setOpen(false)} />
          <div className="phone-plus-menu" role="menu">
            <button role="menuitem" onClick={pick(onAttach)}>
              Attach Files
            </button>
            <button role="menuitem" disabled={!hasCommands} onClick={pick(onSkills)}>
              Skills and Commands
            </button>
            {queued && (
              <button role="menuitem" onClick={pick(onSendNow)}>
                Send Now
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Bash mode's prompt, drawn beside the command line in the box, in a shell prompt's green. */
const BASH_PROMPT = (
  <span className="bash-prompt" aria-hidden="true">
    !
  </span>
);

/** Each chat's unsent message and files, kept while the window shows another session. */
const drafts = new Map<string, { text: string; pending: Attachment[] }>();

/** What the engine keeps of the files waiting: a command still running isn't one yet. */
const saved = (pending: Attachment[]): Attachment[] => pending.filter((a) => !a.command?.running);

/** The message box showing each chat, by its id: a command that ends while another chat shows goes into that chat's draft instead. */
const shown = new Map<string, (fn: (p: Attachment[]) => Attachment[]) => void>();
let commandSeq = 0;

/** A "!" command ended (`next`: its result; null: it couldn't run): it takes its running place among the chat's files waiting. */
function finishCommand(chatId: string, key: string, next: Attachment | null): void {
  const swap = (p: Attachment[]) => p.flatMap((a) => (a.command?.id === key ? (next ? [next] : []) : [a]));
  const set = shown.get(chatId);
  if (set) {
    set(swap);
    return;
  }
  const d = drafts.get(chatId);
  if (!d) return;
  const pending = swap(d.pending);
  drafts.set(chatId, { ...d, pending });
  window.looper.chat.setDraft(chatId, d.text, saved(pending));
}

/** What the chat view can ask of its message box. */
export interface ComposerHandle {
  focus(): void;
  /** Files dropped on the chat. */
  attach(files: File[]): void;
  /** Text selected in the conversation, quoted after what the box holds. */
  quote(selection: string): void;
  /** A queued message taken back: it goes before what the box holds. */
  take(text: string, attachments: Attachment[]): void;
}

/**
 * The message box of a chat: its text, the files waiting to go with it, the "/"
 * list of commands and the buttons. It keeps its own state, so typing re-renders
 * this and not the conversation above it. On a phone it's a Messages-style box:
 * a + menu, a capsule that grows with the text, and one round button that sends,
 * queues or stops by the chat's state.
 */
export const Composer = forwardRef<ComposerHandle, { state: ChatState; embedded: boolean; onSent: () => void }>(function Composer({ state, embedded, onSent }, ref) {
  const id = state.id;
  // A draft in bash mode is kept as "!" and the command, as it was typed.
  const initial = drafts.get(id)?.text ?? state.draft?.text ?? '';
  /**
   * Bash mode, as in Claude Code: "!" typed (or pasted) at the start of an
   * empty box turns it into a command line, the "!" a green prompt beside the
   * box's text, which is the command alone. Backspace in an empty box leaves it.
   */
  const [bash, setBashState] = useState(() => initial.startsWith('!'));
  const bashRef = useRef(bash);
  const [text, setTextState] = useState(() => (initial.startsWith('!') ? initial.slice(1) : initial));
  const [pending, setPendingState] = useState<Attachment[]>(() => drafts.get(id)?.pending ?? state.draft?.attachments ?? []);
  const [pick, setPick] = useState(0);
  /** Where the cursor is in the message box: the "/" list follows the word it's in. */
  const [caret, setCaret] = useState(0);
  /** Esc closed the "/" list for the word starting here. */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  // The skill button: the whole list, whatever the box holds.
  const [picker, setPicker] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Up/Down in the message box: which sent message is shown, and the draft to go back to. */
  const recall = useRef<{ index: number; draft: string } | null>(null);
  const ended = state.status === 'ended';
  const working = state.status === 'working';

  const setText = (t: string) => {
    setTextState(t);
    const draft = { text: (bashRef.current ? '!' : '') + t, pending: drafts.get(id)?.pending ?? pending };
    drafts.set(id, draft);
    // The engine keeps it too, for the next start of Looper.
    window.looper.chat.setDraft(id, draft.text, saved(draft.pending));
  };
  /** The box's text and whether it's in bash mode, together. */
  const setBox = (t: string, b: boolean) => {
    bashRef.current = b;
    setBashState(b);
    setText(t);
  };
  const setPending = (fn: (p: Attachment[]) => Attachment[]) =>
    setPendingState((p) => {
      const next = fn(p);
      const draft = { text: drafts.get(id)?.text ?? (bashRef.current ? '!' : '') + text, pending: next };
      drafts.set(id, draft);
      window.looper.chat.setDraft(id, draft.text, saved(next));
      return next;
    });
  const setPendingRef = useRef(setPending);
  setPendingRef.current = setPending;
  useEffect(() => {
    const set = (fn: (p: Attachment[]) => Attachment[]) => setPendingRef.current(fn);
    shown.set(id, set);
    return () => {
      if (shown.get(id) === set) shown.delete(id);
    };
  }, [id]);

  /** Text put in the box by code: the box takes the focus with its cursor here once it shows the text. */
  const caretTo = useRef<number | null>(null);
  const putText = (t: string, at: number) => {
    // What code puts in the box is a message (a quote, a command picked from the "/" list), not a command line.
    setBox(t, false);
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
  useAutoGrow(composerRef, text, 150, isPhone);

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
      } else if (e.type === 'chat-edit' && e.chatId === id) {
        recall.current = null;
        setBox(e.text, false);
        setPending(() => e.attachments);
        composerRef.current?.focus();
      }
    });
    if (!embedded) composerRef.current?.focus();
    return unsubUi;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const sent = useMemo(
    () => [...state.history, ...state.rows].filter((r) => r.kind === 'prompt' && r.text).map((r) => r.text),
    [state.history, state.rows],
  );

  const attach = (files: File[]) => {
    if (files.length === 0 || ended) return;
    void window.looper.chat
      .attachFiles(id, files)
      .then((added) => setPending((p) => [...p, ...added]))
      .catch(reportError);
  };

  useImperativeHandle(ref, () => ({
    focus: () => composerRef.current?.focus(),
    attach,
    quote: (selection) => quoteRef.current(selection),
    take: (t, attachments) => {
      // A command line being typed gives way to the message taken back.
      setBox(text.trim() && !bash ? `${t}\n\n${text}` : t, false);
      setPending((p) => [...attachments, ...p]);
      composerRef.current?.focus();
    },
  }));

  // A running command's output as it comes: into its place among the files waiting (the engine keeps none of it until it ends).
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== 'chat:command' || e.chatId !== id) return;
        const live = (p: Attachment[]) =>
          p.map((a) => (a.command?.id === e.id && a.command.running ? commandAttachment({ ...a.command, stdout: e.stdout, stderr: e.stderr }) : a));
        setPendingState(live);
        const d = drafts.get(id);
        if (d) drafts.set(id, { ...d, pending: live(d.pending) });
      }),
    [id],
  );

  // A message goes with the files and the commands that have ended; a command still running stays for a later one.
  const ready = pending.filter((a) => !a.command?.running);
  const canRun = !ended && bash && !!text.trim();
  const canSend = !ended && !bash && (!!text.trim() || ready.length > 0);
  const stoppable = working || state.runningCommands > 0;
  /** Run the command line: it waits among the files as it runs, and the box is empty, out of bash mode, for the message. */
  const run = () => {
    const command = text.trim();
    if (!command || ended) return;
    // Apart from the commands of a draft from before a restart, which keep their ids.
    const key = `run-${Date.now().toString(36)}-${++commandSeq}`;
    setPending((p) => [...p, commandAttachment({ id: key, input: command, stdout: '', stderr: '', exitCode: null, running: true })]);
    setBox('', false);
    recall.current = null;
    window.looper.chat.runCommand(id, command, key).then(
      (out) => finishCommand(id, key, commandAttachment(out)),
      (e: Error) => {
        finishCommand(id, key, null);
        reportError(e);
      },
    );
  };
  const send = async () => {
    if (bash) {
      run();
      return;
    }
    if (!canSend) return;
    // An idle agent whose cache expired may ask first (Settings → Chats); a message queued behind a turn doesn't.
    if (state.status !== 'working' && !(await window.looper.chat.confirmSend(id).catch(() => true))) return;
    window.looper.chat.send(id, text.trim(), ready);
    // A phone without its computer (web/start.ts marks it) shows its own alert; the message stays to send later.
    if ('stale' in document.documentElement.dataset) return;
    setText('');
    setPending((p) => p.filter((a) => a.command?.running));
    recall.current = null;
    onSent();
  };
  const stop = () => void window.looper.chat.stop(id).catch(reportError);

  // "/" at the start of the box or of a word lists the harness's commands and skills (Codex's "$" too).
  const typed = commandAt(text, caret, [...new Set(['/', state.commandPrefix])]);
  const typedList = !!typed && typed.start !== closedAt && focused && !ended && !bash;
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
      // On a phone Enter is a line break; the list takes a tap, or Tab from a hardware keyboard.
      if ((e.key === 'Enter' && !e.shiftKey && !isPhone) || e.key === 'Tab') {
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
    if (sendsOnEnter(e, isPhone)) {
      e.preventDefault();
      void send();
    } else if (bash && e.key === 'Backspace' && plain && !ta.value) {
      // Backspace in an empty command line takes the "!" away: the box is a message box again.
      e.preventDefault();
      setBox('', false);
    } else if (bash) {
      // A command line has no sent messages to go back through.
      return;
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

  const pendingList = pending.length > 0 && (
    <div className="chat-pending">
      <AttachmentList
        items={pending}
        onRemove={(a) => setPending((p) => p.filter((x) => x !== a))}
        onStop={(a) => a.command && void window.looper.chat.stopCommand(id, a.command.id).catch(reportError)}
        files={{ taskId: state.taskId, runId: id }}
      />
    </div>
  );
  // The "/" list drops from the message box's top edge, like a combo box's list.
  const slashList = options.length > 0 && (
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
  );
  const textarea = (
    <textarea
      ref={composerRef}
      value={text}
      placeholder={bash ? 'Command' : `Message ${harnessKindLabel(state.harnessKind)}`}
      aria-label={bash ? 'Command' : undefined}
      spellCheck={!bash}
      rows={isPhone ? 1 : 3}
      disabled={ended}
      aria-autocomplete="list"
      aria-controls={options.length > 0 ? `slash-list-${id}` : undefined}
      aria-activedescendant={options.length > 0 ? `slash-${id}-${picked}` : undefined}
      onChange={(e) => {
        recall.current = null;
        const v = e.target.value;
        // "!" typed or pasted into an empty box: bash mode, the "!" its prompt and the rest the command.
        const command = bash ? null : bashModeEntry(text, v);
        if (command !== null) {
          setBox(command, true);
          setCaret(command.length);
          return;
        }
        const at = e.target.selectionStart;
        setText(v);
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
  );

  if (isPhone) {
    // Run in bash mode; Stop while the agent (or a command) works and there's nothing to queue; otherwise Send, or Queue while it works.
    const mode = bash ? 'run' : stoppable && !canSend ? 'stop' : working ? 'queue' : 'send';
    return (
      <div className="chat-composer phone-composer">
        {pendingList}
        <div className="phone-composer-row">
          <PlusMenu
            ended={ended}
            hasCommands={state.commands.length > 0}
            queued={state.queued.length > 0}
            onAttach={pickFiles}
            onSkills={openPicker}
            onSendNow={() => void window.looper.chat.sendNow(id).catch(reportError)}
          />
          <div className={`composer-input phone-composer-box${bash ? ' bash-mode' : ''}`}>
            {slashList}
            {bash && BASH_PROMPT}
            {textarea}
            <button
              className={`phone-composer-action ${mode}`}
              aria-label={mode === 'stop' ? 'Stop' : mode === 'queue' ? 'Queue' : mode === 'run' ? 'Run' : 'Send'}
              disabled={mode === 'run' ? !canRun : mode !== 'stop' && !canSend}
              // The box keeps the focus, so the keyboard stays up.
              onMouseDown={(e) => e.preventDefault()}
              onClick={mode === 'stop' ? stop : send}
            >
              {mode === 'stop' ? STOP : ARROW_UP}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-composer">
      <div className="composer-main">
        <CommandBar state={state} onAttach={pickFiles} onSkills={openPicker} />
        {pendingList}
        <div className={`composer-input${bash ? ' bash-mode' : ''}`}>
          {slashList}
          {bash && BASH_PROMPT}
          {textarea}
        </div>
      </div>
      <div className="composer-actions">
        <button className="btn primary" disabled={bash ? !canRun : !canSend} onClick={() => void send()}>
          {bash ? 'Run' : working ? 'Queue' : 'Send'}
        </button>
        <button className="btn" title={withShortcut('Stop', 'Esc')} disabled={!stoppable} onClick={stop}>
          Stop
        </button>
      </div>
    </div>
  );
});
