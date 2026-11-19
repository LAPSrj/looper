import { useEffect, useState } from 'react';
import type { RemoteConversation, RemoteMessage, RemoteState } from '@shared/remote';
import { DataTable, type DataCol } from './components/DataTable';
import { EmptyState } from './components/EmptyState';
import { ListDetail } from './components/ListDetail';
import { Markdown } from './components/Markdown';
import { EmptyWindow } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { REMOTE_STATUS_LABELS, fmtDate, fmtTime } from './format';
import { subscribe } from './events';
import { keptSelection } from './components/selection';

const lastLine = (c: RemoteConversation) => c.lastMessage ?? (c.status === 'waiting' ? 'No message yet' : '');

const COLS: readonly DataCol<RemoteConversation>[] = [
  { label: 'Date', width: 92, cell: (c) => fmtDate(c.startedAt) },
  { label: 'Start', width: 76, cell: (c) => fmtTime(c.startedAt) },
  { label: 'Status', width: 76, cell: (c) => REMOTE_STATUS_LABELS[c.status] },
  { label: 'From', width: 150, cell: (c) => c.name, title: (c) => c.cwd },
  { label: 'Details', cell: lastLine, title: (c) => c.lastMessage },
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

  useEffect(() => {
    document.title = 'Remote Control Conversations';
    const apply = (s: RemoteState) => {
      setState(s);
      setSelected((id) => keptSelection(id, s.conversations, (c) => c.id));
    };
    void window.looper.remote.state().then(apply);
    return subscribe((e) => {
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

  if (!state) return <EmptyWindow />;

  return (
    <div className="editor">
      <div className="runlog">
        <ListDetail
          preview
          panes={{ axis: 'y', initial: 60, unit: '%', min: 20, max: 90 }}
          list={
            <DataTable
              cols={COLS}
              rows={state.conversations}
              rowKey={(c) => c.id}
              idPrefix="conv"
              storageKey="remote-conversations"
              selected={selected}
              onSelect={(c) => setSelected(c.id)}
              onOpen={(c) => void window.looper.remote.open(c.id)}
              onMenu={(c) => window.looper.remote.showContextMenu(c.id)}
              empty={state.running ? 'No conversations yet.' : 'Remote Control is off.'}
              dayOf={(c) => Date.parse(c.startedAt)}
              phoneRow={(c) => ({
                title: c.name,
                sub: [fmtTime(c.startedAt), lastLine(c)].filter(Boolean).join(' · '),
                value: REMOTE_STATUS_LABELS[c.status],
              })}
            />
          }
          empty="Select a conversation"
          detail={
            conv && (
              <div className="runlog-result">
                {message ? (
                  <>
                    {message.from === 'user' && <div className="runlog-result-from muted">You</div>}
                    <Markdown text={message.text} />
                  </>
                ) : (
                  <EmptyState at="detail">No message yet</EmptyState>
                )}
              </div>
            )
          }
        />
      </div>
      <WindowActions close />
    </div>
  );
}
