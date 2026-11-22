import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ChatSettingMenu, ChatState } from '@shared/chat';
import { harnessKindLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import type { RunAgent, SessionSummary, SlashCommand } from '@shared/sessions';
import { AttachmentList } from './ChatRows';
import { CommandPromptView, useCommandPrompt } from './CommandPrompt';
import { SETTING_TITLES, settingDisabled, settingLabels, showSettingMenu, shownSettings, type SettingsView } from './chat-settings';
import { bashModeEntry, commandAttachment, type CommandOutput } from '@shared/bash-mode';
import { MessageBox, type MessageBoxStop } from './MessageBox';
import { commandAt, insertCommand, matchCommands, quoteText, sendsOnEnter } from './composer-text';
import { MENU_ARROW } from './ToolButton';
import { Toolbar } from './Toolbar';
import { isPhone } from '../web/page-nav';
import { onUi } from '../events';
import { reportError } from '../report-error';
import { withShortcut } from '../shortcut';

/**
 * The bar above the message box: Attach Files and the skill list on the left,
 * the harness, model, effort, permission mode and session type on the right.
 * A chat's are menus (its harness changes only until the first message); a
 * task run's (`settings` without `menus`) are text, since they can't change
 * while it runs. A narrow box (a dashboard card) has one button instead, whose
 * menu has the five as submenus, or the model alone as text; the stylesheet shows one
 * or the other by the composer's width.
 */
function CommandBar({
  ended,
  hasCommands,
  settings,
  menus,
  onAttach,
  onSkills,
}: {
  ended: boolean;
  hasCommands: boolean;
  /** Unset: the bar shows no settings. */
  settings?: SettingsView;
  /** The chat whose settings the menus change. */
  menus?: ChatState;
  onAttach: () => void;
  onSkills: () => void;
}) {
  const labels = settings ? settingLabels(settings) : null;
  const shown = settings ? shownSettings(settings) : [];
  const open = (state: ChatState, which: ChatSettingMenu | 'all') => (e: React.MouseEvent<HTMLButtonElement>) =>
    showSettingMenu(state, which, e.currentTarget.getBoundingClientRect());
  return (
    <Toolbar
      inline
      className="chat-commandbar"
      groups={[
        {
          id: 'add',
          items: [
            { id: 'attach', label: 'Attach Files', shortcut: 'Ctrl+O', icon: 'attach', enabled: !ended, run: onAttach },
            { id: 'skills', label: 'Skills and Commands', shortcut: '/', icon: 'skills', enabled: !ended && hasCommands, run: onSkills },
          ],
        },
      ]}
    >
      <span className="spacer" />
      {labels && menus && (
        <>
          <span className="commandbar-full">
            {shown.map((which) => (
              <button
                key={which}
                className="labeled commandbar-menu"
                title={SETTING_TITLES[which]}
                aria-label={`${SETTING_TITLES[which]}: ${labels[which]}`}
                aria-haspopup="menu"
                disabled={settingDisabled(menus, which)}
                onClick={open(menus, which)}
              >
                {labels[which]}
                {MENU_ARROW}
              </button>
            ))}
          </span>
          <button
            className="labeled commandbar-menu commandbar-compact"
            title="Chat Settings"
            aria-label={`Chat Settings: ${shown.map((w) => labels[w]).join(', ')}`}
            aria-haspopup="menu"
            disabled={shown.every((w) => settingDisabled(menus, w))}
            onClick={open(menus, 'all')}
          >
            {labels.model}
            {MENU_ARROW}
          </button>
        </>
      )}
      {labels && !menus && (
        <>
          <span className="commandbar-full">
            {shown.map((which) => (
              <span key={which} className="commandbar-value" title={SETTING_TITLES[which]} aria-label={`${SETTING_TITLES[which]}: ${labels[which]}`}>
                {labels[which]}
              </span>
            ))}
          </span>
          <span className="commandbar-value commandbar-compact" title={shown.map((w) => `${SETTING_TITLES[w]}: ${labels[w]}`).join('\n')}>
            {labels.model}
          </span>
        </>
      )}
    </Toolbar>
  );
}

const PLUS = (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M10 4v12M4 10h12" />
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

/** Each conversation's unsent message and files, kept while the window shows another one. */
const drafts = new Map<string, { text: string; pending: Attachment[] }>();

/** What the engine keeps of the files waiting: a command still running isn't one yet. */
const saved = (pending: Attachment[]): Attachment[] => pending.filter((a) => !a.command?.running);

/** The message box showing each conversation, by its id: what comes for one that isn't showing goes into its draft instead. */
const shown = new Map<string, { setPending: (fn: (p: Attachment[]) => Attachment[]) => void; take: (text: string, attachments: Attachment[]) => void }>();
let commandSeq = 0;

/** A "!" command ended (`next`: its result; null: it couldn't run): it takes its running place among the files waiting. */
function finishCommand(id: string, key: string, next: Attachment | null, persist?: (text: string, pending: Attachment[]) => void): void {
  const swap = (p: Attachment[]) => p.flatMap((a) => (a.command?.id === key ? (next ? [next] : []) : [a]));
  const box = shown.get(id);
  if (box) {
    box.setPending(swap);
    return;
  }
  const d = drafts.get(id);
  if (!d) return;
  const pending = swap(d.pending);
  drafts.set(id, { ...d, pending });
  persist?.(d.text, saved(pending));
}

/** A message taken back (a run's guidance waiting, Edit): it goes before what the conversation's box holds. */
export function takeIntoBox(id: string, text: string, attachments: Attachment[]): void {
  const box = shown.get(id);
  if (box) {
    box.take(text, attachments);
    return;
  }
  const d = drafts.get(id);
  drafts.set(id, { text: d?.text.trim() ? `${text}\n\n${d.text}` : text, pending: [...attachments, ...(d?.pending ?? [])] });
}

/** The messages a conversation was sent, oldest first: what Up brings back. */
function sentTexts(rows: readonly MessageRow[]): string[] {
  return rows.filter((r) => (r.kind === 'prompt' || r.kind === 'guidance') && r.text).map((r) => r.text);
}

/**
 * A message box's list of skills and commands: "/" at the start of the box or
 * of a word lists the ones the word matches (Codex's "$" too), and `open` (the
 * skill button) lists them all. It drops from the box's top edge, like a combo
 * box's list; Up, Down, Enter or Tab and Esc work it while the box keeps the
 * focus. `putText` puts a picked command in the box with the cursor after it.
 */
function useCommandList(o: {
  id: string;
  text: string;
  commands: SlashCommand[];
  prefix: '/' | '$';
  /** The typed list can show (not while the box is a command line, or the session has ended). */
  active: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  putText: (text: string, caret: number) => void;
}) {
  const [pick, setPick] = useState(0);
  /** Where the cursor is in the message box: the list follows the word it's in. */
  const [caret, setCaret] = useState(0);
  /** Esc closed the list for the word starting here. */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  // The skill button: the whole list, whatever the box holds.
  const [picker, setPicker] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const prefixes = [...new Set(['/', o.prefix])];
  const typed = commandAt(o.text, caret, prefixes);
  const typedList = !!typed && typed.start !== closedAt && focused && o.active;
  const options = typedList ? matchCommands(o.commands, typed.query) : picker ? matchCommands(o.commands, '', Infinity) : [];
  const picked = Math.min(pick, options.length - 1);
  useLayoutEffect(() => {
    listRef.current?.querySelector('.slash-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [picked, options.length]);
  const choose = (c: SlashCommand) => {
    const command = `${o.prefix}${c.name}`;
    setPicker(false);
    if (typedList) {
      const next = insertCommand(o.text, typed.start, caret, command);
      setCaret(next.caret);
      o.putText(next.text, next.caret);
    } else {
      // From the skill button, the command goes in front of what's already typed.
      setCaret(command.length + 1);
      o.putText(`${command} ${o.text.replace(/^\s+/, '')}`, command.length + 1);
    }
  };
  /** The list's keys while it shows; true when it took the key. On a phone Enter is a line break: the list takes a tap, or Tab. */
  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (options.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setPick((picked + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if ((e.key === 'Enter' && !e.shiftKey && !isPhone) || e.key === 'Tab') {
      choose(options[picked]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (typed) setClosedAt(typed.start);
      setPicker(false);
    } else return false;
    e.preventDefault();
    return true;
  };
  const list = options.length > 0 && (
    <div className="slash-list" role="listbox" id={`slash-list-${o.id}`} ref={listRef}>
      {options.map((c, i) => (
        <div
          key={c.name}
          id={`slash-${o.id}-${i}`}
          role="option"
          aria-selected={i === picked}
          className={`slash-item${i === picked ? ' selected' : ''}`}
          // The box keeps the focus. On a phone the pick waits for the tap, so a drag scrolls the list instead of picking.
          onMouseDown={(e) => {
            e.preventDefault();
            if (!isPhone) choose(c);
          }}
          onClick={isPhone ? () => choose(c) : undefined}
          onMouseEnter={isPhone ? undefined : () => setPick(i)}
        >
          <span className="slash-name">
            {o.prefix}
            {c.name}
            {c.argumentHint ? <span className="slash-hint"> {c.argumentHint}</span> : null}
          </span>
          <span className="slash-desc">{c.description}</span>
        </div>
      ))}
    </div>
  );
  const input: React.TextareaHTMLAttributes<HTMLTextAreaElement> = {
    'aria-autocomplete': 'list',
    'aria-controls': options.length > 0 ? `slash-list-${o.id}` : undefined,
    'aria-activedescendant': options.length > 0 ? `slash-${o.id}-${picked}` : undefined,
    onSelect: (e) => setCaret(e.currentTarget.selectionStart),
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      setPicker(false);
    },
  };
  return {
    list,
    input,
    open: () => {
      setPicker(true);
      setPick(0);
      o.inputRef.current?.focus();
    },
    keyDown,
    /** The user typed: the box now holds `value`, with the cursor at `at`. */
    typedText: (value: string, at: number) => {
      setCaret(at);
      setPick(0);
      if (commandAt(value, at, prefixes)?.start !== closedAt) setClosedAt(null);
    },
    setCaret,
  };
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

/** A task run's side of the message box: what it sends guidance to, and what the box shows of the run. */
export interface ComposerRun {
  taskId: string;
  runId: string;
  placeholder: string;
  /** The skills the run's session offers: the "/" list. */
  commands: SlashCommand[];
  /** The run's harness and settings, shown as text; unset shows none. */
  agent?: RunAgent;
  /** The agent is in a turn: guidance waits for it (Queue). */
  working: boolean;
  /** Guidance waits for the agent: Send Now hands it over at once. */
  queued: boolean;
  /** The run's conversation: the messages it was sent are what Up brings back. */
  rows: readonly MessageRow[];
  /** Stop: the agent's turn ends (and the "!" commands running). */
  stop?: MessageBoxStop;
  onSent?: () => void;
}

/** A terminal session's side of the message box (its dashboard card): what's sent is typed into its terminal. */
export interface ComposerTerminal {
  summary: SessionSummary;
  /** The skills its transcript lists: the "/" list. */
  commands: SlashCommand[];
  stop: MessageBoxStop;
}

/** A chat's message box (`state`), a task run's (`run`), which sends the agent guidance, or a terminal session's (`terminal`). */
export type ComposerProps = { state: ChatState; embedded: boolean; onSent: () => void } | { run: ComposerRun } | { terminal: ComposerTerminal };

/** What the message box sends to, whichever conversation it is. */
interface Box {
  /** The conversation's id: its draft, its "!" commands' output and the menus' Quote and Edit find it by this. */
  id: string;
  /** Where an attached file's folder is, for opening it from the files waiting. */
  files: { taskId: string; runId: string };
  ended: boolean;
  /** The agent is in a turn: what's sent waits (Queue). */
  working: boolean;
  /** Something waits for the agent: Send Now. */
  queued: boolean;
  commands: SlashCommand[];
  prefix: '/' | '$';
  settings?: SettingsView;
  /** A chat's: its settings are menus. */
  menus?: ChatState;
  placeholder: string;
  stop?: MessageBoxStop;
  /** The draft kept for Looper's next start (a chat's). */
  persist?: (text: string, pending: Attachment[]) => void;
  attachFiles(files: File[]): Promise<Attachment[]>;
  pickFiles(): Promise<Attachment[]>;
  /** A "!" command line: its output, or null once it's typed into a terminal, which runs it in its own bash mode. */
  runCommand(command: string, key: string): Promise<CommandOutput> | null;
  stopCommand(key: string): Promise<void>;
  /** Send what the box holds: false when it stays in the box. */
  send(text: string, attachments: Attachment[]): Promise<boolean>;
  sendNow(): void;
}

function chatBox(state: ChatState, onSent: () => void): Box {
  const id = state.id;
  const working = state.status === 'working';
  return {
    id,
    files: { taskId: state.taskId, runId: id },
    ended: state.status === 'ended',
    working,
    queued: state.queued.some((q) => !q.delivered),
    commands: state.commands,
    prefix: state.commandPrefix,
    settings: state,
    menus: state,
    placeholder: `Message ${harnessKindLabel(state.harnessKind)}`,
    stop: { enabled: working || state.runningCommands > 0, run: () => void window.looper.chat.stop(id).catch(reportError), title: withShortcut('Stop', 'Esc') },
    persist: (text, pending) => window.looper.chat.setDraft(id, text, pending),
    attachFiles: (files) => window.looper.chat.attachFiles(id, files),
    pickFiles: () => window.looper.chat.pickFiles(id),
    runCommand: (command, key) => window.looper.chat.runCommand(id, command, key),
    stopCommand: (key) => window.looper.chat.stopCommand(id, key),
    send: async (text, attachments) => {
      // An idle agent whose cache expired may ask first (Settings → Chats); a message queued behind a turn doesn't.
      if (!working && !(await window.looper.chat.confirmSend(id).catch(() => true))) return false;
      window.looper.chat.send(id, text, attachments);
      // A phone without its computer (web/start.ts marks it) shows its own alert; the message stays to send later.
      if ('stale' in document.documentElement.dataset) return false;
      onSent();
      return true;
    },
    sendNow: () => void window.looper.chat.sendNow(id).catch(reportError),
  };
}

function runBox(run: ComposerRun): Box {
  const { taskId, runId } = run;
  return {
    id: runId,
    files: { taskId, runId },
    ended: false,
    working: run.working,
    queued: run.queued,
    commands: run.commands,
    prefix: run.agent?.commandPrefix ?? '/',
    settings: run.agent,
    placeholder: run.placeholder,
    stop: run.stop,
    attachFiles: (files) => window.looper.runs.attachFiles(taskId, files),
    pickFiles: () => window.looper.runs.pickFiles(taskId),
    runCommand: (command, key) => window.looper.runs.runCommand(taskId, runId, command, key),
    stopCommand: (key) => window.looper.runs.stopCommand(taskId, runId, key),
    send: async (text, attachments) => {
      // The engine says why a run can't take it: the box keeps the message.
      try {
        await window.looper.sendGuidance(taskId, runId, text, attachments);
      } catch (e) {
        reportError(e);
        return false;
      }
      run.onSent?.();
      return true;
    },
    sendNow: () => void window.looper.runs.sendNow(taskId, runId).catch(reportError),
  };
}

function terminalBox(t: ComposerTerminal): Box {
  const s = t.summary;
  const type = (data: string) => window.looper.terminalSession.write(s.id, data);
  return {
    id: s.id,
    files: { taskId: s.taskId, runId: s.id },
    ended: s.status === 'ended',
    // A terminal's agent takes what's typed whenever it comes, as its own box does.
    working: false,
    queued: false,
    commands: t.commands,
    prefix: s.harnessKind === 'codex' ? '$' : '/',
    placeholder: 'Reply',
    stop: t.stop,
    attachFiles: (files) => window.looper.runs.attachFiles(s.taskId, files),
    pickFiles: () => window.looper.runs.pickFiles(s.taskId),
    runCommand: (command) => {
      // Claude Code's and Codex's own bash mode: "!", then the command, pasted so a line break doesn't run it early.
      type(`!\x1b[200~${command}\x1b[201~\r`);
      return null;
    },
    stopCommand: async () => undefined,
    send: async (text, attachments) => {
      window.looper.sessions.send([s.id], text, attachments);
      return true;
    },
    sendNow: () => undefined,
  };
}

/**
 * The message box of a chat, a task run or a terminal session: the MessageBox
 * with its command bar (a + menu on a phone), the files waiting to go with
 * the message, the "/" list, bash mode ("!"), Queue while the agent works and
 * Send Now, the sent messages Up brings back, and Quote and Edit as New
 * Message from the conversation's menu. What's typed and attached is kept per
 * conversation while another one shows (a chat's also across a restart of
 * Looper). A chat's settings are menus; a run's are text, since they can't
 * change while it runs. It keeps its own state, so typing re-renders this and
 * not the conversation above it.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const chat = 'state' in props ? props.state : null;
  const box = 'state' in props ? chatBox(props.state, props.onSent) : 'run' in props ? runBox(props.run) : terminalBox(props.terminal);
  const { id, ended, working } = box;
  // A draft in bash mode is kept as "!" and the command, as it was typed.
  const initial = drafts.get(id)?.text ?? chat?.draft?.text ?? '';
  /**
   * Bash mode, as in Claude Code: "!" typed (or pasted) at the start of an
   * empty box turns it into a command line, the "!" a green prompt beside the
   * box's text, which is the command alone. Backspace in an empty box leaves it.
   */
  const [bash, setBashState] = useState(() => initial.startsWith('!'));
  const bashRef = useRef(bash);
  const [text, setTextState] = useState(() => (initial.startsWith('!') ? initial.slice(1) : initial));
  const [pending, setPendingState] = useState<Attachment[]>(() => drafts.get(id)?.pending ?? chat?.draft?.attachments ?? []);
  /** A message on its way: the box waits for the engine to take it. */
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Up/Down in the message box: which sent message is shown, and the draft to go back to. */
  const recall = useRef<{ index: number; draft: string } | null>(null);

  const keepDraft = (draft: { text: string; pending: Attachment[] }) => {
    drafts.set(id, draft);
    box.persist?.(draft.text, saved(draft.pending));
  };
  const setText = (t: string) => {
    setTextState(t);
    keepDraft({ text: (bashRef.current ? '!' : '') + t, pending: drafts.get(id)?.pending ?? pending });
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
      keepDraft({ text: drafts.get(id)?.text ?? (bashRef.current ? '!' : '') + text, pending: next });
      return next;
    });
  const take = (t: string, attachments: Attachment[]) => {
    // A command line being typed gives way to the message taken back.
    recall.current = null;
    setBox(text.trim() && !bash ? `${t}\n\n${text}` : t, false);
    setPending((p) => [...attachments, ...p]);
    composerRef.current?.focus();
  };
  const latest = useRef({ setPending, take });
  latest.current = { setPending, take };
  useEffect(() => {
    const entry = { setPending: (fn: (p: Attachment[]) => Attachment[]) => latest.current.setPending(fn), take: (t: string, a: Attachment[]) => latest.current.take(t, a) };
    shown.set(id, entry);
    return () => {
      if (shown.get(id) === entry) shown.delete(id);
    };
  }, [id]);

  /** Text put in the box by code: the box takes the focus with its cursor here once it shows the text. */
  const caretTo = useRef<number | null>(null);
  const putText = (t: string, at: number) => {
    // What code puts in the box is a message (a quote, a command picked from the "/" list), not a command line.
    setBox(t, false);
    cmd.setCaret(at);
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

  // A draft comes back with the caret at its end, where typing goes on, and not at the start of a box a script filled.
  useLayoutEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollTop = ta.scrollHeight;
  }, [id]);

  // Quote: the selection goes after what the box holds, and the cursor after the quote.
  const quoteIntoBox = (selection: string) => {
    const quote = quoteText(selection);
    if (!quote || ended) return;
    recall.current = null;
    const next = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${quote}` : quote;
    putText(next, next.length);
  };
  const quoteRef = useRef(quoteIntoBox);
  quoteRef.current = quoteIntoBox;

  // The conversation's menu: Quote and Edit as New Message; File → Attach Files is a chat window's.
  const isChat = !!chat;
  useEffect(() => {
    const unsubUi = onUi((e) => {
      // File → Attach Files…: the files wait under the message box like dropped ones.
      if (e.type === 'chat-attached' && isChat) setPending((p) => [...p, ...e.attachments]);
      else if (e.type === 'chat-quote') {
        if (e.chatId === id) quoteRef.current(e.text);
      } else if (e.type === 'chat-edit' && e.chatId === id) {
        recall.current = null;
        setBox(e.text, false);
        setPending(() => e.attachments);
        composerRef.current?.focus();
      }
    });
    if ('embedded' in props && !props.embedded) composerRef.current?.focus();
    return unsubUi;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const runRows = 'run' in props ? props.run.rows : null;
  const sent = useMemo(() => sentTexts(chat ? [...chat.history, ...chat.rows] : (runRows ?? [])), [chat?.history, chat?.rows, runRows]);

  const added = (list: Attachment[]) => setPending((p) => [...p, ...list]);
  const attach = (list: File[]) => {
    if (list.length === 0 || ended) return;
    void box.attachFiles(list).then(added).catch(reportError);
  };
  const pickFiles = () => void box.pickFiles().then(added).catch(reportError);

  useImperativeHandle(ref, () => ({
    focus: () => composerRef.current?.focus(),
    attach,
    quote: (selection) => quoteRef.current(selection),
    take,
  }));

  // A message goes with the files and the commands that have ended; a command still running stays for a later one.
  const ready = pending.filter((a) => !a.command?.running);
  const running = pending.length - ready.length;
  // A running command's terminal takes the focus as it shows; once it has ended and gone, the focus comes back here.
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = running < wasRunning.current;
    wasRunning.current = running;
    if (ended && (!document.activeElement || document.activeElement === document.body)) composerRef.current?.focus();
  }, [running]);
  const canRun = !ended && bash && !!text.trim();
  const canSend = !ended && !bash && !sending && (!!text.trim() || ready.length > 0);
  /** Run the command line: it waits among the files as it runs (or goes to a terminal), and the box is empty, out of bash mode, for the message. */
  const runCommand = () => {
    const command = text.trim();
    if (!command || ended) return;
    // Apart from the commands of a draft from before a restart, which keep their ids.
    const key = `run-${Date.now().toString(36)}-${++commandSeq}`;
    const result = box.runCommand(command, key);
    setBox('', false);
    recall.current = null;
    if (!result) return;
    setPending((p) => [...p, commandAttachment({ id: key, input: command, stdout: '', stderr: '', exitCode: null, running: true })]);
    const persist = box.persist;
    result.then(
      (out) => finishCommand(id, key, commandAttachment(out), persist),
      (e: Error) => {
        finishCommand(id, key, null, persist);
        reportError(e);
      },
    );
  };
  const send = async () => {
    if (bash) {
      runCommand();
      return;
    }
    if (!canSend) return;
    setSending(true);
    try {
      if (!(await box.send(text.trim(), ready))) return;
      // The message went: the box is empty again, but for the commands still running.
      setText('');
      setPending((p) => p.filter((a) => a.command?.running));
      recall.current = null;
    } finally {
      setSending(false);
    }
  };
  // Stop ends the commands running from the box too.
  const stop = box.stop && { ...box.stop, enabled: box.stop.enabled || running > 0 };

  const cmd = useCommandList({ id, text, commands: box.commands, prefix: box.prefix, active: !ended && !bash, inputRef: composerRef, putText });

  /** Up on the first line of an empty box (or while going through them) brings back the sent messages, newest first. */
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (cmd.keyDown(e)) return;
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

  // A sudo in a command running from this box asks for its password here.
  const asking = useCommandPrompt(
    id,
    pending.flatMap((a) => (a.command?.running ? [a.command.id] : [])),
  );
  const pendingList = (pending.length > 0 || asking) && (
    <div className="chat-pending">
      {asking && <CommandPromptView ownerId={id} commandId={asking.commandId} prompt={asking.prompt} />}
      <AttachmentList
        items={pending}
        onRemove={(a) => setPending((p) => p.filter((x) => x !== a))}
        onStop={(a) => a.command && void box.stopCommand(a.command.id).catch(reportError)}
        files={box.files}
      />
    </div>
  );
  const input: React.TextareaHTMLAttributes<HTMLTextAreaElement> = {
    ...cmd.input,
    'aria-label': bash ? 'Command' : undefined,
    spellCheck: !bash,
    onChange: (e) => {
      recall.current = null;
      const v = e.target.value;
      // "!" typed or pasted into an empty box: bash mode, the "!" its prompt and the rest the command.
      const command = bash ? null : bashModeEntry(text, v);
      if (command !== null) {
        setBox(command, true);
        cmd.setCaret(command.length);
        return;
      }
      setText(v);
      cmd.typedText(v, e.target.selectionStart);
    },
    onPaste: (e) => {
      const files = [...e.clipboardData.files];
      if (files.length === 0) return;
      e.preventDefault();
      attach(files);
    },
    onKeyDown: onComposerKey,
  };

  return (
    <MessageBox
      text={text}
      placeholder={bash ? 'Command' : box.placeholder}
      canSend={bash ? canRun : canSend}
      onSend={() => void send()}
      // Run in bash mode; Queue while the agent works; otherwise Send.
      action={bash ? 'run' : working ? 'queue' : 'send'}
      stop={stop}
      disabled={ended}
      bash={bash}
      bar={<CommandBar ended={ended} hasCommands={box.commands.length > 0} settings={box.settings} menus={box.menus} onAttach={pickFiles} onSkills={cmd.open} />}
      plus={<PlusMenu ended={ended} hasCommands={box.commands.length > 0} queued={box.queued} onAttach={pickFiles} onSkills={cmd.open} onSendNow={box.sendNow} />}
      pending={pendingList}
      inside={
        <>
          {cmd.list}
          {bash && BASH_PROMPT}
        </>
      }
      inputRef={composerRef}
      input={input}
    />
  );
});
