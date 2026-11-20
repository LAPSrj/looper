import { attentionKey, type AttentionRow, type RunningRow } from '@shared/dashboard';
import { fmtClock, formatDuration, resultLabel } from '../../format';
import type { MainWindow } from '../../useMainWindow';
import { STEP_LABELS, StatusIcon, TRIGGER_LABELS, dashboardOpeners, needAt, needRows, needTitle, showNeedMenu } from '../Dashboard';
import { Elapsed } from '../Live';
import { showTaskMenu } from '../row-menus';
import { Section } from '../Section';
import { Row } from './PhoneList';

/** A long press on a row about a task: its menu, which acts on that task. */
export const taskRowMenu = (m: MainWindow, taskId: string, list: 'attention' | 'running', runId: string | null, key?: string) => () => {
  const task = m.tasks.find((t) => t.id === taskId);
  if (!task) return;
  m.setPick({ list, taskId, runId, key });
  showTaskMenu(task, m.runtimes[taskId]);
};

/** Needs Attention, with the Claude Code logins that need the user: a tap opens a row as a double-click does. */
export function AttentionGroup({ m, rows }: { m: MainWindow; rows: AttentionRow[] }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  const needs = needRows(rows, m.loginAttention);
  return (
    <Section
      title="Needs Attention"
      action={{ label: 'Clear', disabled: needs.length === 0, run: () => m.clearAttention(rows, m.loginAttention) }}
      empty={needs.length === 0 && 'Nothing needs attention.'}
    >
      {needs.map((n) => {
        const at = needAt(n);
        return (
          <Row
            key={n.kind === 'task' ? attentionKey(n.r) : n.r.login.key}
            lead={<StatusIcon level={n.r.level} />}
            title={needTitle(n)}
            sub={at !== null ? `${fmtClock(at, now)} · ${n.r.problem}` : n.r.problem}
            chevron
            onOpen={() => opens.need(n)}
            onMenu={n.kind === 'task' ? taskRowMenu(m, n.r.task.id, 'attention', n.r.runId, attentionKey(n.r)) : () => showNeedMenu(n, m.runtimes)}
          />
        );
      })}
    </Section>
  );
}

export function RunningGroup({ m, rows }: { m: MainWindow; rows: RunningRow[] }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  return (
    <Section title="Running Now" empty={rows.length === 0 && 'Nothing is running.'}>
      {rows.map((r) => (
        <Row
          key={r.runId}
          title={r.task.name}
          sub={`${STEP_LABELS[r.run.state]} · ${TRIGGER_LABELS[r.run.trigger]} · ${fmtClock(r.run.startedAt, now)}`}
          value={<span className="live-only"><Elapsed since={r.run.startedAt} /></span>}
          chevron
          onOpen={() => opens.running(r)}
          onMenu={taskRowMenu(m, r.task.id, 'running', r.runId)}
        />
      ))}
    </Section>
  );
}

export function RecentGroup({ m }: { m: MainWindow }) {
  const opens = dashboardOpeners(m.openFromDashboard);
  const now = Date.now();
  const recent = m.recentShown ?? [];
  return (
    <Section title="Recent Runs" empty={!!m.recentShown && recent.length === 0 && 'No runs yet.'}>
      {recent.map((r) => (
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
      ))}
    </Section>
  );
}
