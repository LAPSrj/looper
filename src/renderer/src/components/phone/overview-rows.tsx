import type { AttentionRow, RunningRow } from '@shared/dashboard';
import { fmtClock, formatDuration, resultLabel } from '../../format';
import type { MainWindow } from '../../useMainWindow';
import { STEP_LABELS, StatusIcon, TRIGGER_LABELS, dashboardOpeners } from '../Dashboard';
import { Elapsed } from '../Live';
import { showTaskMenu } from '../row-menus';
import { EmptyRow, Group, Row } from './PhoneList';

/** A long press on a row about a task: its menu, which acts on that task. */
export const taskRowMenu = (m: MainWindow, taskId: string, list: 'attention' | 'running', runId: string | null) => () => {
  const task = m.tasks.find((t) => t.id === taskId);
  if (!task) return;
  m.setPick({ list, taskId, runId });
  showTaskMenu(task, m.runtimes[taskId]);
};

/** Needs Attention: a tap opens a row as a double-click does. */
export function AttentionGroup({ m, rows }: { m: MainWindow; rows: AttentionRow[] }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  return (
    <Group title="Needs Attention">
      {rows.length === 0 ? (
        <EmptyRow>Nothing needs attention.</EmptyRow>
      ) : (
        rows.map((r) => (
          <Row
            key={`${r.task.id}-${r.runId ?? 'last'}`}
            lead={<StatusIcon level={r.level} />}
            title={r.task.name}
            sub={r.at !== null ? `${fmtClock(r.at, now)} · ${r.problem}` : r.problem}
            chevron
            onOpen={() => opens.attention(r)}
            onMenu={taskRowMenu(m, r.task.id, 'attention', r.runId)}
          />
        ))
      )}
      {rows.length > 0 && <Row title="Clear" onOpen={() => m.clearAttention(rows)} />}
    </Group>
  );
}

export function RunningGroup({ m, rows }: { m: MainWindow; rows: RunningRow[] }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  return (
    <Group title="Running Now">
      {rows.length === 0 ? (
        <EmptyRow>Nothing is running.</EmptyRow>
      ) : (
        rows.map((r) => (
          <Row
            key={r.runId}
            title={r.task.name}
            sub={`${STEP_LABELS[r.run.state]} · ${TRIGGER_LABELS[r.run.trigger]} · ${fmtClock(r.run.startedAt, now)}`}
            value={<span className="live-only"><Elapsed since={r.run.startedAt} /></span>}
            chevron
            onOpen={() => opens.running(r)}
            onMenu={taskRowMenu(m, r.task.id, 'running', r.runId)}
          />
        ))
      )}
    </Group>
  );
}

export function RecentGroup({ m }: { m: MainWindow }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  const recent = m.recentShown ?? [];
  return (
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
  );
}
