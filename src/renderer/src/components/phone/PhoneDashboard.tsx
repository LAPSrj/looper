import { REMOTE_STATUS_LABELS, fmtClock, formatDuration, resultLabel } from '../../format';
import { splitAttention, taskSummary, waitingForYou } from '../../phone-lists';
import { preventSleepStatus, type MainWindow } from '../../useMainWindow';
import { STEP_LABELS, StatusIcon, TRIGGER_LABELS, dashboardOpeners } from '../Dashboard';
import { Elapsed, RestStatusText, WaitedFor } from '../Live';
import { showTaskMenu } from '../TaskList';
import { EmptyRow, Group, LargeTitle, Row } from './PhoneList';
import { useSessionsState } from './useSessionsState';

/**
 * The main window's dashboard on a phone, in the order of what needs a
 * decision: what waits for you (chats and runs), what needs attention, what is
 * running, the latest runs, then one summary row of the task counts that opens
 * Tasks. A tap opens a row as a double-click does; a long press shows its menu,
 * which acts on that row's task.
 */
export function PhoneDashboard({ m, onOpenTasks }: { m: MainWindow; onOpenTasks: () => void }) {
  const { counts, loaded, rest, remoteOpen, addons, runtimes } = m;
  // Only names the day of a time: the waited and running times tick in their own components.
  const now = Date.now();
  const opens = dashboardOpeners(m.openFromDashboard);
  const sessions = useSessionsState();
  // What waits for the user comes first: chats and terminals, then runs that ask or hold.
  const waiting = waitingForYou(sessions?.sessions ?? [], m.attention);
  const waitingRunIds = new Set(waiting.flatMap((w) => (w.kind === 'run' ? [w.attention.runId] : [])));
  const attention = splitAttention(m.attention).rest;
  const running = m.running.filter((r) => !waitingRunIds.has(r.runId));
  // Zero before the data arrives is wrong, not empty: each part joins the summary only once it has answered.
  const summary = taskSummary({
    counts,
    loaded,
    addonsRunning: m.addonsLoaded && addons.length > 0 ? m.runningAddons : null,
    remoteSessions: m.remoteLoaded && remoteOpen ? remoteOpen.length : null,
  });
  const taskMenu = (taskId: string, list: 'attention' | 'running', runId: string | null) => () => {
    const task = m.tasks.find((t) => t.id === taskId);
    if (!task) return;
    m.setPick({ list, taskId, runId });
    showTaskMenu(task, runtimes[taskId]);
  };
  const recent = m.recentShown ?? [];

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
              onMenu={w.kind === 'chat' ? () => window.looper.sessions.showContextMenu(w.session.id, false) : taskMenu(w.attention.task.id, 'attention', w.attention.runId)}
            />
          ))}
        </Group>
      )}

      <Group title="Needs Attention">
        {attention.length === 0 ? (
          <EmptyRow>Nothing needs attention.</EmptyRow>
        ) : (
          attention.map((r) => (
            <Row
              key={`${r.task.id}-${r.runId ?? 'last'}`}
              lead={<StatusIcon level={r.level} />}
              title={r.task.name}
              sub={r.at !== null ? `${fmtClock(r.at, now)} · ${r.problem}` : r.problem}
              chevron
              onOpen={() => opens.attention(r)}
              onMenu={taskMenu(r.task.id, 'attention', r.runId)}
            />
          ))
        )}
      </Group>

      <Group title="Running Now">
        {running.length === 0 ? (
          <EmptyRow>Nothing is running.</EmptyRow>
        ) : (
          running.map((r) => (
            <Row
              key={r.runId}
              title={r.task.name}
              sub={`${STEP_LABELS[r.run.state]} · ${TRIGGER_LABELS[r.run.trigger]} · ${fmtClock(r.run.startedAt, now)}`}
              value={<span className="live-only"><Elapsed since={r.run.startedAt} /></span>}
              chevron
              onOpen={() => opens.running(r)}
              onMenu={taskMenu(r.task.id, 'running', r.runId)}
            />
          ))
        )}
      </Group>

      <Group title="Recent Runs">
        {m.recentShown && recent.length === 0 ? (
          <EmptyRow>No runs yet.</EmptyRow>
        ) : (
          recent.map((r) => (
            <Row
              key={`${r.taskId}-${r.runId}`}
              title={r.taskName}
              sub={[fmtClock(Date.parse(r.startTs), now), resultLabel(r.result), r.details].filter(Boolean).join(' · ')}
              value={r.totalDurationMs > 0 ? formatDuration(r.totalDurationMs) : undefined}
              tone={r.result === 'error' ? 'error' : r.result === 'warning' ? 'warning' : r.result === 'noop' || r.result === 'skipped' ? 'muted' : undefined}
              chevron
              onOpen={() => opens.recent(r)}
              onMenu={() => {
                m.setPick({ list: 'recent', taskId: r.taskId, runId: r.runId });
                window.looper.showRunContextMenu({ taskId: r.taskId, runId: r.runId, details: r.details });
              }}
            />
          ))
        )}
      </Group>

      <Group title="Tasks" footer={
        rest?.armed || m.preventSleep ? (
          <>
            {rest?.armed && <RestStatusText rest={rest} />}
            {rest?.armed && m.preventSleep && preventSleepStatus(m.preventSleep) ? ' · ' : null}
            {m.preventSleep ? preventSleepStatus(m.preventSleep) : null}
          </>
        ) : undefined
      }
    >
        <Row title="All Tasks" sub={summary || undefined} chevron onOpen={onOpenTasks} />
      </Group>

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
