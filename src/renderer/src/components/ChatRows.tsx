import { useEffect, useState } from 'react';
import type { Attachment } from '@shared/chat';
import type { MessageRow, SentFile, SentFileInfo, SentFiles } from '@shared/messages';
import { fmtSize } from '../format';
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

/** A message's files: images as thumbnails, other files by name; each opens in its default app. */
export function AttachmentList({ items, onRemove }: { items: Attachment[]; onRemove?: (a: Attachment) => void }) {
  const images = items.filter((a) => a.image);
  const files = items.filter((a) => !a.image);
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
function SentFileItem({ f, ctx }: { f: SentFile; ctx: RowCtx }) {
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
    void window.looper.sessions.openFile(ctx.taskId, ctx.runId, f.path, image).catch((e) => void window.looper.showError((e as Error).message));
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
  return (
    <div className="chat-attachments">
      {inline.length > 0 && (
        <div className="chat-thumbs">
          {inline.map((f) => (
            <span key={f.path} className="chat-thumb-wrap">
              <SentFileItem f={f} ctx={ctx} />
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

export function ChatRow({ row, ctx }: { row: MessageRow; ctx: RowCtx }) {
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
      return (
        <div className="chat-msg chat-user" onContextMenu={onContextMenu}>
          {row.text && <PromptBody text={row.text} />}
          {row.attachments && <AttachmentList items={row.attachments} />}
        </div>
      );
    case 'agent':
      return (
        <div className="chat-msg chat-agent" onContextMenu={onContextMenu}>
          <MessageBody text={row.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="chat-aside" onContextMenu={onContextMenu}>
          <summary>Thinking</summary>
          <MessageBody text={row.text} />
        </details>
      );
    case 'tool':
      if (row.sent) return <SentMessage sent={row.sent} ctx={ctx} onContextMenu={onContextMenu} />;
      return (
        <details className="chat-aside chat-tool" onContextMenu={onContextMenu}>
          <summary>
            <span className="chat-tool-name">{row.tool}</span> <span className="chat-tool-preview">{row.preview}</span>
            {row.resultError ? <span className="error-text"> failed</span> : null}
          </summary>
          <div className="chat-tool-body">
            <ToolInputView row={row} />
            {row.result !== undefined && (
              <div className="chat-tool-result">
                <ToolResultView row={row} ctx={ctx} />
              </div>
            )}
          </div>
        </details>
      );
    default:
      return null;
  }
}

export type ChatItem = { kind: 'row'; row: MessageRow } | { kind: 'tools'; rows: MessageRow[] };

/** Messages stay as they are (a delivered SendUserFile call is the agent's message); each run of tool calls (and the thinking between them) becomes one group. */
export function groupRows(rows: MessageRow[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const row of rows) {
    const last = items[items.length - 1];
    if ((row.kind === 'tool' && !row.sent) || row.kind === 'thinking') {
      if (last?.kind === 'tools') last.rows.push(row);
      else items.push({ kind: 'tools', rows: [row] });
    } else items.push({ kind: 'row', row });
  }
  return items;
}

/** "5 tool uses, 1 failed": closed, the group is one line; open, it lists each call, and each call opens to its details. */
export function ToolGroup({ rows, ctx }: { rows: MessageRow[]; ctx: RowCtx }) {
  const tools = rows.filter((r) => r.kind === 'tool');
  if (tools.length === 0) return <>{rows.map((r) => <ChatRow key={r.id} row={r} ctx={ctx} />)}</>;
  const failed = tools.filter((r) => r.resultError).length;
  return (
    <details className="chat-aside chat-tools">
      <summary>
        {tools.length === 1 ? '1 tool use' : `${tools.length} tool uses`}
        {failed ? <span className="error-text">, {failed} failed</span> : null}
      </summary>
      <div className="chat-tools-list">
        {rows.map((r) => (
          <ChatRow key={r.id} row={r} ctx={ctx} />
        ))}
      </div>
    </details>
  );
}
