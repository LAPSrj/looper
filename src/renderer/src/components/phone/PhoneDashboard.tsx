import { REMOTE_STATUS_LABELS, fmtClock, formatDuration, resultLabel } from '../../format';
import { preventSleepStatus, restStatus, type MainWindow } from '../../useMainWindow';
import { STEP_LABELS, StatusIcon, TRIGGER_LABELS, dashboardOpeners } from '../Dashboard';
import { showTaskMenu } from '../TaskList';
import { EmptyRow, Group, LargeTitle, Row } from './PhoneList';

/**
 * The main window's dashboard on a phone: the status bar's counts, then the
 * desktop dashboard's tables as lists. A tap opens a row as a double-click
 * does; a long press shows its menu, which acts on that row's task.
 */
export function PhoneDashboard({ m }: { m: MainWindow }) {
  const { counts, now, rest, remoteOpen, addons, runtimes } = m;
  const opens = dashboardOpeners(m.openFromDashboard);
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
      <Group title="Tasks" footer={[rest?.armed ? restStatus(rest, now) : null, m.preventSleep ? preventSleepStatus(m.preventSleep) : null].filter(Boolean).join(' · ') || undefined}>
        <Row title="Running" value={counts.running} />
        <Row title="Paused" value={counts.paused} />
        <Row title="Enabled" value={counts.enabled} />
        <Row title="Disabled" value={counts.disabled} />
        <Row title="Completed" value={counts.completed} />
        {remoteOpen && <Row title="Remote Control sessions" value={remoteOpen.length} />}
        {addons.length > 0 && <Row title="Addons running" value={m.runningAddons} />}
      </Group>

      <Group title="Running Now">
        {m.running.length === 0 ? (
          <EmptyRow>Nothing is running.</EmptyRow>
        ) : (
          m.running.map((r) => (
            <Row
              key={r.runId}
              title={r.task.name}
              sub={`${r.run.question !== null ? 'Waiting for your answer' : r.run.held ? 'Waiting for you' : STEP_LABELS[r.run.state]} · ${TRIGGER_LABELS[r.run.trigger]} · ${fmtClock(r.run.startedAt, now)}`}
              value={now - r.run.startedAt < 1000 ? '0s' : formatDuration(now - r.run.startedAt)}
              chevron
              onOpen={() => opens.running(r)}
              onMenu={taskMenu(r.task.id, 'running', r.runId)}
            />
          ))
        )}
      </Group>

      <Group title="Needs Attention">
        {m.attention.length === 0 ? (
          <EmptyRow>Nothing needs attention.</EmptyRow>
        ) : (
          m.attention.map((r) => (
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
