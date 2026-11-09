import { REMOTE_STATUS_LABELS, fmtClock } from '../../format';
import { splitAttention, waitingForYou } from '../../phone-lists';
import type { MainWindow } from '../../useMainWindow';
import { StatusIcon, dashboardOpeners } from '../Dashboard';
import { WaitedFor } from '../Live';
import { statusText } from '../SessionList';
import { AttentionGroup, RecentGroup, RunningGroup, taskRowMenu } from './overview-rows';
import { EmptyRow, Group, LargeTitle, Row } from './PhoneList';
import { useSessionsState } from './useSessionsState';

/**
 * The main window's dashboard on a phone, in the order of what needs a
 * decision: what waits for you (chats and runs), what needs attention, what is
 * running, the other chats, the latest runs, then the Remote Control sessions,
 * as the desktop's dashboard has them. A tap opens a row as a double-click does;
 * a long press shows its menu, which acts on that row's task.
 */
export function PhoneDashboard({ m }: { m: MainWindow }) {
  const { remoteOpen } = m;
  // Only names the day of a time: the waited and running times tick in their own components.
  const now = Date.now();
  const opens = dashboardOpeners(m.openFromDashboard);
  const sessions = useSessionsState();
  // What waits for the user comes first: chats and terminals, then runs that ask or hold.
  const waiting = waitingForYou(sessions?.sessions ?? [], m.attention);
  const waitingRunIds = new Set(waiting.flatMap((w) => (w.kind === 'run' ? [w.attention.runId] : [])));
  const attention = splitAttention(m.attention).rest;
  const running = m.running.filter((r) => !waitingRunIds.has(r.runId));
  const waitingChats = new Set(waiting.flatMap((w) => (w.kind === 'chat' ? [w.session.id] : [])));
  const chats = (sessions?.sessions ?? []).filter((s) => !waitingChats.has(s.id));

  return (
    <div className="pg-scroll">
      <LargeTitle>Dashboard</LargeTitle>
      {waiting.length > 0 && (
        <Group title="Waiting for You">
          {waiting.map((w) => (
            <Row
              key={w.key}
              lead={<StatusIcon level="warning" />}
              title={w.title}
              sub={w.sub}
              value={w.since > 0 ? <span className="live-only"><WaitedFor since={w.since} /></span> : undefined}
              tone="warning"
              chevron
              // A chat opens on its conversation, ready to answer; a run on its run window (the question) or its terminal.
              onOpen={() => (w.kind === 'chat' ? window.looper.sessions.openWindow(w.session.id) : opens.attention(w.attention))}
              onMenu={w.kind === 'chat' ? () => window.looper.sessions.showContextMenu(w.session.id, false) : taskRowMenu(m, w.attention.task.id, 'attention', w.attention.runId)}
            />
          ))}
        </Group>
      )}

      <AttentionGroup m={m} rows={attention} />
      <RunningGroup m={m} rows={running} />
      {sessions && (
        <Group title="Chats">
          {chats.length === 0 ? (
            <EmptyRow>{waitingChats.size ? 'No other chats are open.' : 'No chats are open.'}</EmptyRow>
          ) : (
            chats.map((s) => (
              <Row
                key={s.id}
                title={s.title}
                sub={[s.groupName, s.lastReplyAt !== undefined ? fmtClock(s.lastReplyAt, now) : '', s.latest ?? statusText(s)].filter(Boolean).join(' · ')}
                chevron
                onOpen={() => window.looper.sessions.openWindow(s.id)}
                onMenu={() => window.looper.sessions.showContextMenu(s.id, false)}
              />
            ))
          )}
        </Group>
      )}
      <RecentGroup m={m} />

      {remoteOpen && (
        <Group title="Remote Control">
          {remoteOpen.length === 0 ? (
            <EmptyRow>No sessions are open.</EmptyRow>
          ) : (
            remoteOpen.map((c) => (
              <Row
                key={c.id}
                title={c.name}
                sub={[fmtClock(Date.parse(c.startedAt), now), REMOTE_STATUS_LABELS[c.status], c.lastMessage ?? (c.status === 'waiting' ? 'No message yet' : '')].filter(Boolean).join(' · ')}
                chevron
                onOpen={() => opens.remote(c)}
                onMenu={() => {
                  m.setPick({ list: 'remote', taskId: c.taskId, runId: c.id });
                  window.looper.remote.showContextMenu(c.id);
                }}
              />
            ))
          )}
        </Group>
      )}
    </div>
  );
}
