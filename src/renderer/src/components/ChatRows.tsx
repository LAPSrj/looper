import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { sizeText, type CommandOutput, type SavedOutput } from '@shared/bash-mode';
import type { Attachment } from '@shared/chat';
import { handbackText, type MessageRow, type SentFile, type SentFileInfo, type SentFiles } from '@shared/messages';
import { fmtSize } from '../format';
import { toolGroupLabel } from './chat-groups';
import { MessageBody, PromptBody } from './Markdown';
import { ToolInputView, ToolResultView } from './ToolContent';

export type RowCtx = {
  taskId: string;
  runId: string;
  /** Right-click on a message or tool call (the chat window's menu). */
  onContextMenu?: (e: React.MouseEvent, row: MessageRow) => void;
};

const openAttachment = (a: Attachment) =>
  void window.looper.attachment.open(a.path).catch((e) => void window.looper.showError((e as Error).message));

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
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void window.looper.attachment.thumbnail(a.path).then(setSrc);
  }, [a.path]);
  return <ThumbButton name={a.name} src={src} onOpen={() => openAttachment(a)} />;
}

/** What a command's line says after it: still running, stopped, or its exit code when it failed. */
function commandStatus(c: CommandOutput): string {
  if (c.running) return 'Running…';
  if (c.stopped) return 'Stopped';
  return c.exitCode ? `Exit code ${c.exitCode}` : '';
}

const CHEVRON = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2 3.5 3 3 3-3" />
  </svg>
);

/** Where a chat's files open: a saved command output opens by its path in the chat's own form. */
export type FileCtx = { taskId: string; runId: string };

/** A stream saved whole to a file: "Full output (363.5KB) saved to a file", and Open. */
function SavedLine({ what, saved, files }: { what: string; saved: SavedOutput; files?: FileCtx }) {
  const open = () =>
    files && void window.looper.sessions.openFile(files.taskId, files.runId, saved.path, false).catch((e) => void window.looper.showError((e as Error).message));
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
 * command line first, a green "!" for the shell's prompt, fixed at the top
 * while the output (stdout, then stderr) scrolls under it, following the
 * newest output as it comes unless scrolled up. A click on the command line
 * shows or hides the output: open while it runs or waits in the message box
 * (`onRemove`), closed in the conversation. Under the box, as under an image:
 * Stop while it runs (`onStop`), Remove once it has ended. Output too long to
 * send shows its preview and a line for the file it was saved to.
 */
function CommandItem({ c, onRemove, onStop, files }: { c: CommandOutput; onRemove?: () => void; onStop?: () => void; files?: FileCtx }) {
  const [open, setOpen] = useState(!!onRemove || !!c.running);
  const status = commandStatus(c);
  const output = [c.stdout.replace(/\n+$/, ''), c.stderr.replace(/\n+$/, '')].filter(Boolean).join('\n');
  const savedLines = [c.saved?.stdout && ['output', c.saved.stdout] as const, c.saved?.stderr && ['error output', c.saved.stderr] as const].filter(
    (x): x is readonly ['output' | 'error output', SavedOutput] => !!x,
  );
  const shows = open && !(c.running && !output);
  const outRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [output, shows]);
  return (
    <div className="chat-command">
      <div className={`chat-command-box${shows ? ' open' : ''}`}>
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
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            }}
          >
            {output || '(no output)'}
          </pre>
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
              {onRemove && (
                <button className="link" onClick={() => onRemove(a)}>
                  Remove
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.path} className="chat-file">
          <button className="link" title={`Open ${a.name}`} onClick={() => openAttachment(a)}>
            {a.name}
          </button>
          {onRemove && (
            <button className="link chat-file-remove" onClick={() => onRemove(a)}>
              Remove
            </button>
          )}
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
  const [info, setInfo] = useState<SentFileInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setInfo(undefined);
    window.looper.sessions.sentFile(taskId, path).then(
      (i) => live && setInfo(i),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [taskId, path]);
  return info;
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
    void window.looper.sessions.openFile(ctx.taskId, ctx.runId, f.path, image, image ? images : undefined).catch((e) => void window.looper.showError((e as Error).message));
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

const sameCtx = (a: RowCtx, b: RowCtx): boolean =>
  a === b || (a.taskId === b.taskId && a.runId === b.runId && a.onContextMenu === b.onContextMenu);

function ChatRowView({ row, ctx }: { row: MessageRow; ctx: RowCtx }) {
  // The innermost row answers: a tool call inside its group, not the group.
  const onContextMenu = ctx.onContextMenu
    ? (e: React.MouseEvent) => {
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
      return (
        <div className="chat-msg chat-agent" onContextMenu={onContextMenu}>
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
    case 'error':
      return (
        <div className="chat-msg chat-agent error-text" onContextMenu={onContextMenu}>
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
