import { useEffect, useRef, useState } from 'react';
import type { RemoteMessage, RemoteState } from '@shared/remote';
import { useDialogKeys, useDragResize, useListNav } from './components/hooks';
import { Markdown } from './components/Markdown';
import { ResizableColumns, type TableCol } from './components/ui';
import { REMOTE_STATUS_LABELS, fmtDate, fmtTime } from './format';

const COLS: readonly TableCol[] = [
  { label: 'Date', width: 92 },
  { label: 'Start', width: 76 },
  { label: 'Status', width: 76 },
  { label: 'From', width: 150 },
  { label: 'Details' },
];

/**
 * Advanced → Remote Control → Conversations: Remote Control's conversations,
 * open ones first, laid out like a task's Runs tab, with the selected one's
 * last message below. Opening an open one shows it in a Looper terminal
 * window, where it can go on at the computer; an ended one opens its run window.
 */
export function RemoteConversationsApp() {
  const [state, setState] = useState<RemoteState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<RemoteMessage | null>(null);
  const [splitPct, setSplitPct] = useState(60);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Remote Control Conversations';
    const apply = (s: RemoteState) => {
      setState(s);
      setSelected((id) => (id && s.conversations.some((c) => c.id === id) ? id : (s.conversations[0]?.id ?? null)));
    };
    void window.looper.remote.state().then(apply);
    return window.looper.onEvent((e) => {
      if (e.type === 'remote') apply(e.state);
    });
  }, []);

  // The panel follows the selection, and the conversation's turns (each one changes its status).
  const conv = state?.conversations.find((c) => c.id === selected);
  const status = conv?.status;
  useEffect(() => {
    if (!selected) {
      setMessage(null);
      return;
    }
    let stale = false;
    void window.looper.remote.lastMessage(selected).then((m) => {
      if (!stale) setMessage(m);
    });
    return () => {
      stale = true;
    };
  }, [selected, status]);

  useDialogKeys({ onCancel: () => window.close() });

  const list = state?.conversations ?? [];
  const idx = list.findIndex((c) => c.id === selected);
  const nav = useListNav({
    count: list.length,
    index: idx,
    onIndex: (i) => setSelected(list[i].id),
    onActivate: (i) => void window.looper.remote.open(list[i].id),
    scrollToId: selected ? `conv-${selected}` : null,
  });
  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(20, Math.min(90, (y / rect.height) * 100))),
  });

  if (!state) return <div className="empty">Loading…</div>;

  return (
    <div className="runlog" ref={containerRef}>
      <div className="runlog-table-wrap" style={{ height: `${splitPct}%` }} tabIndex={0} onKeyDown={nav}>
        <table className="runlog-table">
          <ResizableColumns cols={COLS} storageKey="remote-conversations" />
          <tbody>
            {list.map((c) => (
              <tr
                key={c.id}
                id={`conv-${c.id}`}
                className={`run-row${selected === c.id ? ' selected' : ''}`}
                onClick={() => setSelected(c.id)}
                onDoubleClick={() => void window.looper.remote.open(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(c.id);
                  window.looper.remote.showContextMenu(c.id);
                }}
              >
                <td>{fmtDate(c.startedAt)}</td>
                <td>{fmtTime(c.startedAt)}</td>
                <td>{REMOTE_STATUS_LABELS[c.status]}</td>
                <td title={c.cwd}>{c.name}</td>
                <td title={c.lastMessage}>{c.lastMessage ?? (c.status === 'waiting' ? 'No message yet' : '')}</td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {state.running ? 'No conversations yet.' : 'Remote Control is off.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="runlog-divider" onMouseDown={onDragStart} />
      <div className="runlog-result" style={{ height: `calc(${100 - splitPct}% - 5px)` }}>
        {message ? (
          <>
            {message.from === 'user' && <div className="runlog-result-from muted">You</div>}
            <Markdown text={message.text} />
          </>
        ) : (
          <div className="runlog-result-empty muted">{conv ? 'No message yet' : 'Select a conversation'}</div>
        )}
      </div>
    </div>
  );
}
