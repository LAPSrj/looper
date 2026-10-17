import { useEffect, useState } from 'react';
import type { Attachment } from '@shared/chat';
import type { MessageRow } from '@shared/messages';
import { MessageBody } from './Markdown';
import { ToolInputView, ToolResultView } from './ToolContent';

export type RowCtx = { taskId: string; runId: string };

const openAttachment = (a: Attachment) =>
  void window.looper.attachment.open(a.path).catch((e) => void window.looper.showError((e as Error).message));

/** An image attachment as a thumbnail; clicking it opens the file in the default viewer. */
function Thumbnail({ a }: { a: Attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void window.looper.attachment.thumbnail(a.path).then(setSrc);
  }, [a.path]);
  return (
    <button className="chat-thumb" title={`Open ${a.name}`} onClick={() => openAttachment(a)}>
      {src ? <img src={src} alt={a.name} /> : <span>{a.name}</span>}
    </button>
  );
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

export function ChatRow({ row, ctx }: { row: MessageRow; ctx: RowCtx }) {
  switch (row.kind) {
    case 'prompt':
      return (
        <div className="chat-msg chat-user">
          {row.text && <MessageBody text={row.text} />}
          {row.attachments && <AttachmentList items={row.attachments} />}
        </div>
      );
    case 'agent':
      return (
        <div className="chat-msg chat-agent">
          <MessageBody text={row.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="chat-aside">
          <summary>Thinking</summary>
          <MessageBody text={row.text} />
        </details>
      );
    case 'tool':
      return (
        <details className="chat-aside chat-tool">
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

/** Messages stay as they are; each run of tool calls (and the thinking between them) becomes one group. */
export function groupRows(rows: MessageRow[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const row of rows) {
    const last = items[items.length - 1];
    if (row.kind === 'tool' || row.kind === 'thinking') {
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
