import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useThumbnail } from './hooks';
import { onUi } from '../events';
import { sizeText, type CommandOutput, type SavedOutput } from '@shared/bash-mode';
import type { Attachment } from '@shared/chat';
import { handbackText, scriptCallsPage, type MessageRow, type ScriptCalls, type SentFile, type SentFileInfo, type SentFiles } from '@shared/messages';
import { fmtSize } from '../format';
import { toolGroupLabel } from './chat-groups';
import { MessageBody, PromptBody } from './Markdown';
import { atEnd, useStayAtEnd } from './newest-first';
import { ToolInputView, ToolResultView } from './ToolContent';
import { reportError } from '../report-error';

export type RowCtx = {
  taskId: string;
  runId: string;
  /** Where a Code Mode script's calls come from when the conversation isn't a run's (runs.scriptCalls otherwise). */
  scriptCalls?: (toolUseId: string, before: number | null, count: number) => Promise<ScriptCalls | null>;
  /** Right-click on a message or tool call (the chat window's menu). */
  onContextMenu?: (e: React.MouseEvent, row: MessageRow) => void;
};

/**
 * A row's right-click menu in a chat or a task run's conversation (`chatId`:
 * the run's id): the copy items, its file, a Task or Agent call's subagent,
 * and while the message box takes text (`quote`), Quote the selection and
 * Edit as New Message on the user's own message. `fork`: the chat's Fork from Here.
 */
export function showRowContextMenu(base: { chatId: string; taskId: string; quote: boolean; fork?: number; selectText?: string }, row: MessageRow): void {
  const selection = window.getSelection()?.toString() || undefined;
  const info = { ...base, selection, ...(row.agentId ? { agentId: row.agentId, label: row.preview } : {}) };
  switch (row.kind) {
    case 'prompt':
    case 'guidance':
      window.looper.chat.showContextMenu({
        ...info,
        text: row.text || undefined,
        resend: base.quote ? { text: row.text, attachments: row.attachments ?? [] } : undefined,
      });
      return;
    case 'tool':
      window.looper.chat.showContextMenu({ ...info, text: row.text || undefined, textLabel: 'Copy Input', result: row.result || undefined, file: row.file });
      return;
    default:
      window.looper.chat.showContextMenu({ ...info, text: row.text || undefined });
  }
}

const openAttachment = (a: Attachment) =>
  void window.looper.attachment.open(a.path).catch(reportError);

/** An image as a thumbnail button; `src` is null until it has loaded (the name shows meanwhile). */
function ThumbButton({ name, src, onOpen }: { name: string; src: string | null; onOpen: () => void }) {
  return (
    <button className="chat-thumb" title={`Open ${name}`} onClick={onOpen}>
      {src ? <img src={src} alt={name} /> : <span>{name}</span>}
    </button>
  );
}

/** An image attachment as a thumbnail; clicking it opens the file in the default viewer. */
function Thumbnail({ a }: { a: Attachment }) {
  const src = useThumbnail(() => window.looper.attachment.thumbnail(a.path), [a.path]);
  return <ThumbButton name={a.name} src={src ?? null}onOpen={() => openAttachment(a)} />;
}

/** xterm loads with the first command that runs. */
const CommandTerminal = lazy(() => import('./CommandTerminal'));

/** What a command's line says after it: still running, stopped, or its exit code when it failed. */
function commandStatus(c: CommandOutput): string {
  if (c.running) return 'Running…';
  if (c.stopped) return 'Stopped';
  return c.exitCode ? `Exit code ${c.exitCode}` : '';
}

export const CHEVRON = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2 3.5 3 3 3-3" />
  </svg>
);

/** Where a chat's files open: a saved command output opens by its path in the chat's own form. */
export type FileCtx = { taskId: string; runId: string };

/** A stream saved whole to a file: "Full output (363.5KB) saved to a file", and Open. */
function SavedLine({ what, saved, files }: { what: string; saved: SavedOutput; files?: FileCtx }) {
  const open = () =>
    files && void window.looper.sessions.openFile(files.taskId, files.runId, saved.path, false).catch(reportError);
  return (
    <div className="chat-command-saved" title={saved.path}>
      Full {what} ({sizeText(saved.bytes)}) saved to a file.{' '}
      {files && (
        <button className="link" onClick={open}>
          Open
        </button>
      )}
    </div>
  );
}

/**
 * A command the user ran from the message box ("!"), as a terminal: its
 * command line first, a green "!" for the shell's prompt, fixed at the top.
 * While it runs, its terminal shows under it and takes what's typed (a
 * password, a y/n); once it has ended, its output as text scrolls under it,
 * following the newest output unless scrolled up. A click on the command
 * line shows or hides the output: open while it runs or waits in the message
 * box (`onRemove`), closed in the conversation. Under the box, as under an
 * image: Stop while it runs (`onStop`), Remove once it has ended. Output too
 * long to send shows its preview and a line for the file it was saved to.
 * `files.runId` is the chat's or the run's id, whose command it is.
 */
function CommandItem({ c, onRemove, onStop, files }: { c: CommandOutput; onRemove?: () => void; onStop?: () => void; files?: FileCtx }) {
  const [open, setOpen] = useState(!!onRemove || !!c.running);
  const status = commandStatus(c);
  const output = [c.stdout.replace(/\n+$/, ''), c.stderr.replace(/\n+$/, '')].filter(Boolean).join('\n');
  const savedLines = [c.saved?.stdout && ['output', c.saved.stdout] as const, c.saved?.stderr && ['error output', c.saved.stderr] as const].filter(
    (x): x is readonly ['output' | 'error output', SavedOutput] => !!x,
  );
  const terminal = open && c.running && files;
  const shows = open && !c.running;
  const outRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useStayAtEnd(outRef, atBottom, output, shows);
  return (
    <div className="chat-command">
      <div className={`chat-command-box${shows || terminal ? ' open' : ''}`}>
        <button className="chat-command-line" aria-expanded={open} title={open ? 'Hide the output' : 'Show the output'} onClick={() => setOpen((o) => !o)}>
          <span className="chat-command-prompt">!</span>
          <span className="chat-command-input">{c.input}</span>
          {status && <span className={`chat-command-status${c.exitCode || c.stopped ? ' failed' : ''}`}>{status}</span>}
          <span className="chat-command-chevron">{CHEVRON}</span>
        </button>
        {shows && (
          <pre
            className="chat-command-output"
            ref={outRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = atEnd(el, 8);
            }}
          >
            {output || '(no output)'}
          </pre>
        )}
        {terminal && (
          <Suspense fallback={<div className="chat-command-terminal" />}>
            <CommandTerminal ownerId={files.runId} id={c.id} />
          </Suspense>
        )}
        {open && savedLines.map(([what, saved]) => <SavedLine key={what} what={what} saved={saved} files={files} />)}
      </div>
      {c.running
        ? onStop && (
            <button className="link chat-file-remove" onClick={onStop}>
              Stop
            </button>
          )
        : onRemove && (
            <button className="link chat-file-remove" onClick={onRemove}>
              Remove
            </button>
          )}
    </div>
  );
}

/**
 * A message's files: images as thumbnails, other files by name (each opens in
 * its default app); then the commands the user ran. `onStop`: the message box's
 * Stop under a running command; `files`: where a saved output opens.
 */
/** An attachment's Remove link; a phone's message box draws it as the × badge on the attachment's corner, as Messages does. */
function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button className="link chat-remove" aria-label={`Remove ${name}`} onClick={onClick}>
      <span className="chat-remove-text">Remove</span>
      <svg className="chat-remove-glyph" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M2 2l6 6M8 2l-6 6" />
      </svg>
    </button>
  );
}

export function AttachmentList({
  items,
  onRemove,
  onStop,
  files: fileCtx,
}: {
  items: Attachment[];
  onRemove?: (a: Attachment) => void;
  onStop?: (a: Attachment) => void;
  files?: FileCtx;
}) {
  const images = items.filter((a) => a.image);
  const files = items.filter((a) => !a.image && !a.command);
  const commands = items.filter((a) => a.command);
  return (
    <div className="chat-attachments">
      {images.length > 0 && (
        <div className="chat-thumbs">
          {images.map((a) => (
            <span key={a.path} className="chat-thumb-wrap">
              <Thumbnail a={a} />
              {onRemove && <RemoveButton name={a.name} onClick={() => onRemove(a)} />}
            </span>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.path} className="chat-file">
          <button className="link" title={`Open ${a.name}`} onClick={() => openAttachment(a)}>
            {a.name}
          </button>
          {onRemove && <RemoveButton name={a.name} onClick={() => onRemove(a)} />}
        </div>
      ))}
      {commands.map((a) => (
        <CommandItem key={a.command!.id} c={a.command!} onRemove={onRemove && (() => onRemove(a))} onStop={onStop && (() => onStop(a))} files={fileCtx} />
      ))}
    </div>
  );
}

/** What the computer knows about a file the agent sent: undefined while it loads, null when the file is gone. */
function useSentFile(taskId: string, path: string): SentFileInfo | null | undefined {
  return useThumbnail<SentFileInfo>(() => window.looper.sessions.sentFile(taskId, path), [taskId, path]);
}

/**
 * A file the agent sent, like an attachment: an image as a thumbnail (it opens
 * in the image window, or a device's file viewer), any other file as its name
 * and size (it opens in its default app, or a device's file viewer).
 */
function SentFileItem({ f, ctx, images }: { f: SentFile; ctx: RowCtx; images?: string[] }) {
  const info = useSentFile(ctx.taskId, f.path);
  if (info === null) {
    return (
      <div className="chat-file">
        <span>{f.name}</span>
        <span className="muted">File not found</span>
      </div>
    );
  }
  const open = (image: boolean) =>
    void window.looper.sessions.openFile(ctx.taskId, ctx.runId, f.path, image, image ? images : undefined).catch(reportError);
  if (f.inline && (info === undefined || info.thumbnail)) {
    return <ThumbButton name={f.name} src={info?.thumbnail ?? null} onOpen={() => open(true)} />;
  }
  const size = info?.size ?? f.size;
  return (
    <div className="chat-file">
      <button className="link" title={`Open ${f.name}`} onClick={() => open(false)}>
        {f.name}
      </button>
      {size !== undefined && <span className="muted">{fmtSize(size)}</span>}
    </div>
  );
}

/** The files of a SendUserFile call: the images side by side, then each other file. */
export function SentFileList({ files, ctx }: { files: SentFile[]; ctx: RowCtx }) {
  const inline = files.filter((f) => f.inline);
  const cards = files.filter((f) => !f.inline);
  const images = inline.map((f) => f.path);
  return (
    <div className="chat-attachments">
      {inline.length > 0 && (
        <div className="chat-thumbs">
          {inline.map((f) => (
            <span key={f.path} className="chat-thumb-wrap">
              <SentFileItem f={f} ctx={ctx} images={images} />
            </span>
          ))}
        </div>
      )}
      {cards.map((f) => (
        <SentFileItem key={f.path} f={f} ctx={ctx} />
      ))}
    </div>
  );
}

/** A SendUserFile call: the agent's message, the caption as its text and each file an attachment. */
export function SentMessage({ sent, ctx, onContextMenu }: { sent: SentFiles; ctx: RowCtx; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <div className="chat-msg chat-agent" onContextMenu={onContextMenu}>
      {sent.caption && <MessageBody text={sent.caption} />}
      <SentFileList files={sent.files} ctx={ctx} />
    </div>
  );
}

/**
 * Whether two copies of a row show the same thing. Rows reach the renderer
 * through IPC, so every update brings new objects even for the rows that
 * didn't change; comparing their fields (objects by their JSON) keeps a
 * streamed update from re-rendering the whole conversation.
 */
function sameRow(a: MessageRow, b: MessageRow): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MessageRow>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (Object.is(x, y)) continue;
    if (typeof x === 'object' && typeof y === 'object' && x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

/**
 * The agent's thinking: a block on a faded ground, its text always showing.
 * With Settings → Chats → Show thinking expanded off it sits inside a tool
 * group ("Thinking and 3 tool uses"), whose toggle is the one that hides it.
 */
function ThinkingBubble({ text, onContextMenu }: { text: string; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <div className="chat-msg chat-thinking" onContextMenu={onContextMenu}>
      <MessageBody text={text} />
    </div>
  );
}

/** The user's message: its text and files. */
export function UserMessage({
  text,
  attachments,
  files,
  onContextMenu,
}: {
  text: string;
  attachments?: Attachment[];
  files?: FileCtx;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="chat-msg chat-user" onContextMenu={onContextMenu}>
      {text && <PromptBody text={text} />}
      {attachments && <AttachmentList items={attachments} files={files} />}
    </div>
  );
}

/**
 * Select Text: the message's text selected, its ends there to drag. Until a touch outside it, a long
 * press in it is the system's (selecting a word, its Copy bar) instead of opening the message menu.
 */
function selectMessage(el: HTMLElement): void {
  el.dataset.selecting = '';
  window.getSelection()?.selectAllChildren(el);
  const leave = (e: Event) => {
    if (el.contains(e.target as Node)) return;
    delete el.dataset.selecting;
    document.removeEventListener('pointerdown', leave, true);
  };
  document.addEventListener('pointerdown', leave, true);
}

/**
 * A message menu's Select Text: `remember` takes the message a menu opens for and gives the key the
 * menu sends back (a message-select-text ui event), or undefined when the message has no text.
 */
export function useSelectText(key: string): (e: React.MouseEvent) => string | undefined {
  const message = useRef<HTMLElement | null>(null);
  useEffect(
    () =>
      onUi((ev) => {
        if (ev.type === 'message-select-text' && ev.key === key && message.current?.isConnected) selectMessage(message.current);
      }),
    [key],
  );
  return useCallback(
    (e: React.MouseEvent) => {
      const el = e.currentTarget as HTMLElement;
      message.current = el.matches('.chat-msg') ? el : el.querySelector<HTMLElement>('.chat-msg');
      return message.current?.textContent?.trim() ? key : undefined;
    },
    [key],
  );
}

/** A press in a message being selected on a phone (Select Text): the system's selection takes it, not a menu. */
export const systemSelecting = (e: React.SyntheticEvent): boolean =>
  document.documentElement.classList.contains('phone-window') && !!(e.target as Element).closest?.('[data-selecting]');

const sameCtx = (a: RowCtx, b: RowCtx): boolean =>
  a === b || (a.taskId === b.taskId && a.runId === b.runId && a.onContextMenu === b.onContextMenu && a.scriptCalls === b.scriptCalls);

function ChatRowView({ row, ctx }: { row: MessageRow; ctx: RowCtx }) {
  // The innermost row answers: a tool call inside its group, not the group.
  const onContextMenu = ctx.onContextMenu
    ? (e: React.MouseEvent) => {
        if (systemSelecting(e)) {
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        ctx.onContextMenu!(e, row);
      }
    : undefined;
  switch (row.kind) {
    case 'prompt':
    case 'guidance':
      // Guidance is the user's own message too: its text, without the header Looper sends the agent with it.
      return <UserMessage text={row.text} attachments={row.attachments} files={ctx} onContextMenu={onContextMenu} />;
    case 'agent':
      if (row.note) {
        return (
          <div className="chat-msg chat-system" onContextMenu={onContextMenu}>
            <MessageBody text={row.text} />
          </div>
        );
      }
      return (
        <div className={row.superseded ? 'chat-msg chat-agent chat-superseded' : 'chat-msg chat-agent'} onContextMenu={onContextMenu}>
          <MessageBody text={row.text} />
        </div>
      );
    case 'thinking':
      return <ThinkingBubble text={row.text} onContextMenu={onContextMenu} />;
    case 'task':
      // The task a workflow script computed for its agent: not the user's message, so a muted block.
      return (
        <Disclosure
          className="chat-aside"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              Task <span className="chat-tool-preview">{row.preview}</span>
            </summary>
          }
        >
          <MessageBody text={row.text} />
        </Disclosure>
      );
    case 'events':
      // Related events a trigger sent the running agent: from outside, not the user's message.
      return (
        <Disclosure
          className="chat-aside"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              Trigger events <span className="chat-tool-preview">{row.preview}</span>
            </summary>
          }
        >
          <pre className="chat-tool-pre">{row.text}</pre>
        </Disclosure>
      );
    case 'delegate':
      // The results and questions of the agents this one started: their own words, not the user's.
      return (
        <Disclosure
          className="chat-aside"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              From the agents it started <span className="chat-tool-preview">{row.preview}</span>
            </summary>
          }
        >
          <MessageBody text={row.text} />
        </Disclosure>
      );
    case 'taskEvents':
      // The run ends and trigger events of the tasks the chat watches: Looper's message, not the user's.
      return (
        <Disclosure
          className="chat-aside"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              Task events <span className="chat-tool-preview">{row.preview}</span>
            </summary>
          }
        >
          <MessageBody text={row.text} />
        </Disclosure>
      );
    case 'peer':
      // A message another Claude Code session sent the agent: that session's words, not the user's.
      return (
        <Disclosure
          className="chat-aside"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              Message from {row.from ?? 'another session'} <span className="chat-tool-preview">{row.preview}</span>
            </summary>
          }
        >
          <MessageBody text={row.text} />
        </Disclosure>
      );
    case 'error':
      return (
        <div className="chat-msg chat-system error-text" onContextMenu={onContextMenu}>
          {row.text}
        </div>
      );
    case 'tool': {
      if (row.sent) return <SentMessage sent={row.sent} ctx={ctx} onContextMenu={onContextMenu} />;
      const report = handbackText(row);
      if (report !== null) {
        // A subagent's last call: its final report, the end of its session, as its message.
        return (
          <div className="chat-agent-group" onContextMenu={onContextMenu}>
            <div className="chat-handback muted">Handed back to the main agent</div>
            <div className="chat-msg chat-agent">
              <MessageBody text={report} />
            </div>
          </div>
        );
      }
      return (
        <Disclosure
          className="chat-aside chat-tool"
          onContextMenu={onContextMenu}
          summary={
            <summary>
              <span className="chat-tool-name">{row.tool}</span> <span className="chat-tool-preview">{row.preview}</span>
              {row.resultError ? <span className="error-text"> failed</span> : null}
            </summary>
          }
        >
          <div className="chat-tool-body">
            <ToolInputView row={row} />
            {row.result !== undefined && (
              <div className="chat-tool-result">
                <ToolResultView row={row} ctx={ctx} />
              </div>
            )}
            {row.calls && row.toolUseId ? <ScriptCalls calls={row.calls} toolUseId={row.toolUseId} ctx={ctx} /> : null}
          </div>
        </Disclosure>
      );
    }
    default:
      return null;
  }
}

export const ChatRow = memo(ChatRowView, (prev, next) => sameRow(prev.row, next.row) && sameCtx(prev.ctx, next.ctx));

/** "Thinking and 5 tool uses, 1 failed": closed, the group is one line; open, it lists each call (each opens to its details) and the thinking's text. */
function ToolGroupView({ rows, ctx }: { rows: MessageRow[]; ctx: RowCtx }) {
  const { text, failed } = toolGroupLabel(rows);
  return (
    <Disclosure
      className="chat-aside chat-tools"
      summary={
        <summary>
          {text}
          {failed ? <span className="error-text">, {failed} failed</span> : null}
        </summary>
      }
    >
      <div className="chat-tools-list">
        {rows.map((r) => (
          <ChatRow key={r.id} row={r} ctx={ctx} />
        ))}
      </div>
    </Disclosure>
  );
}

/** How many of a script's calls are read at a time: a screen of closed lines and more. */
const SCRIPT_CALLS_PAGE = 30;
/** How far above the view (px) the list's top comes before older calls are read. */
const SCRIPT_CALLS_AHEAD = 300;

/** The tool calls a Code Mode script made, under its REPL call: one closed line; open, the calls, newest last. */
function ScriptCalls({ calls, toolUseId, ctx }: { calls: NonNullable<MessageRow['calls']>; toolUseId: string; ctx: RowCtx }) {
  return (
    <Disclosure
      className="chat-aside chat-tools chat-script-calls"
      summary={
        <summary>
          {calls.count === 1 ? '1 tool use' : `${calls.count} tool uses`}
          {calls.failed ? <span className="error-text">, {calls.failed} failed</span> : null}
        </summary>
      }
    >
      <ScriptCallBox toolUseId={toolUseId} count={calls.count} running={calls.running} ctx={ctx} className="chat-tools-list chat-script-list">
        {(rows) => rows.map((r) => <ChatRow key={r.id} row={r} ctx={ctx} />)}
      </ScriptCallBox>
    </Disclosure>
  );
}

/**
 * A script's calls in a box of their own (`className` scrolls it), which opens at its end: read from the engine a page
 * at a time, the newest first, and the ones before as the box's top comes near, keeping the reader where they are. A
 * box too short to scroll reads more until it's full. The list reads the calls the script makes next, and again the ones
 * that were running when it read them, as the script's counts change. `children`
 * draws the calls read so far, the first being the script's `start`th.
 */
export function ScriptCallBox({
  toolUseId,
  count,
  running,
  ctx,
  agentId,
  className,
  children,
}: {
  toolUseId: string;
  count: number;
  /** How many of its calls are still running (row.calls.running). */
  running?: number;
  ctx: RowCtx;
  agentId?: string;
  className: string;
  children: (rows: MessageRow[], start: number) => ReactNode;
}) {
  const [list, setList] = useState<{ start: number; rows: MessageRow[] } | null | 'gone'>(null);
  const busy = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const atEndOnce = useRef(false);
  const anchor = useRef<{ el: HTMLElement; height: number; top: number } | null>(null);
  const read = (before: number | null, size: number) =>
    (ctx.scriptCalls ? ctx.scriptCalls(toolUseId, before, size) : window.looper.runs.scriptCalls(ctx.taskId, ctx.runId, toolUseId, before, size, agentId)).catch(() => null);

  useEffect(() => {
    let live = true;
    if (list === 'gone' || busy.current) return;
    // From the first call that was running when it was read, or else the calls made since.
    const open = list ? list.rows.findIndex((r) => r.result === undefined) : -1;
    const from = !list ? 0 : open === -1 ? list.start + list.rows.length : list.start + open;
    if (list && from >= count) return;
    busy.current = true;
    void read(list ? count : null, list ? Math.min(count - from, 200) : SCRIPT_CALLS_PAGE).then((page) => {
      busy.current = false;
      if (!live) return;
      if (!page) setList((l) => l ?? 'gone');
      else
        setList((l) =>
          // The page replaces the calls it holds; one that starts past the list's end starts the list over.
          l && l !== 'gone' && page.start <= l.start + l.rows.length
            ? { start: l.start, rows: [...l.rows.slice(0, Math.max(0, page.start - l.start)), ...page.rows.slice(Math.max(0, l.start - page.start))] }
            : { start: page.start, rows: page.rows },
        );
    });
    return () => {
      live = false;
      busy.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, running, list === null, list === 'gone']);

  const older = () => {
    if (busy.current || !list || list === 'gone' || list.start === 0) return;
    busy.current = true;
    const from = list.start;
    void read(from, SCRIPT_CALLS_PAGE).then((page) => {
      busy.current = false;
      if (!page) return;
      const el = box.current;
      if (el) anchor.current = { el, height: el.scrollHeight, top: el.scrollTop };
      setList((l) => (l && l !== 'gone' && l.start === from ? { start: page.start, rows: [...page.rows, ...l.rows] } : l));
    });
  };

  /** The box's top is in view, or less than SCRIPT_CALLS_AHEAD px above it. */
  const topNear = (): boolean => !!box.current && box.current.scrollTop < SCRIPT_CALLS_AHEAD;

  // The box opens at its newest call. Older calls went in above: the reader stays on what they were reading, and while the top is still near, more come.
  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && !atEndOnce.current) {
      el.scrollTop = el.scrollHeight;
      atEndOnce.current = true;
    } else if (a) a.el.scrollTop = a.top + a.el.scrollHeight - a.height;
    if (topNear()) older();
  });

  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) older();
    }, { root: box.current, rootMargin: `${SCRIPT_CALLS_AHEAD}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (list === null) return <div className="muted tc-image-note">Loading the calls…</div>;
  if (list === 'gone') return <div className="muted tc-image-note">The calls can’t be shown.</div>;
  return (
    <div className={className} ref={box}>
      <div ref={top} />
      {children(list.rows, list.start)}
    </div>
  );
}

/** The calls of a transcript outside Looper's runs (HistoryConversation.scriptCalls), a page at a time. */
export const localScriptCalls =
  (all: Record<string, MessageRow[]>): NonNullable<RowCtx['scriptCalls']> =>
  async (id, before, count) =>
    all[id] ? scriptCallsPage(all[id], before, count) : null;

/**
 * A <details> whose body is drawn the first time it opens, then kept. Closed, a chat's tool calls built every
 * input, result and highlighted file anyway: 38,000 elements for a dashboard of chats, none of them on screen.
 */
function Disclosure({ className, summary, onContextMenu, children }: { className: string; summary: ReactNode; onContextMenu?: React.MouseEventHandler; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className={className}
      onContextMenu={onContextMenu}
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      {summary}
      {opened ? children : null}
    </details>
  );
}

/** groupRows builds a new `rows` array on every call, so the group compares its rows one by one. */
export const ToolGroup = memo(
  ToolGroupView,
  (prev, next) =>
    sameCtx(prev.ctx, next.ctx) && prev.rows.length === next.rows.length && prev.rows.every((r, i) => sameRow(r, next.rows[i])),
);
