import type { ActiveRun, Task, TaskRuntime } from '@shared/types';
import type { AttentionRow, RecentRun, RunningRow } from '@shared/dashboard';
import type { RemoteConversation } from '@shared/remote';
import { REMOTE_STATUS_LABELS, fmtClock, formatDuration, resultLabel } from '../format';
import type { DetailTab } from './TaskDetail';
import { showTaskMenu } from './TaskList';
import { useListNav } from './hooks';
import { StatusGlyph } from './icons';
import { Elapsed } from './Live';

/** A row the user picked on the dashboard; the menus act on its task. */
export interface DashboardPick {
  /** remote: a Remote Control conversation, which the task menus leave alone. */
  list: 'attention' | 'running' | 'remote' | 'recent';
  taskId: string;
  /** The run the row is about (a conversation's id); null for a row about the task's last result. */
  runId: string | null;
}

const STEP_LABELS: Record<ActiveRun['state'], string> = {
  checking: 'Checking',
  classifying: 'Classifying',
  running: 'Running agent',
};

const TRIGGER_LABELS: Record<ActiveRun['trigger'], string> = {
  timer: 'Schedule',
  manual: 'Manual',
  watcher: 'Event',
};

/** Fits a date and time in the regional formats' short style, e.g. "22/10/2026, 18:00". */
const STARTED_WIDTH = 150;

/** Windows' standard 16 px error and warning icons, named for assistive technology. */
function StatusIcon({ level }: { level: 'error' | 'warning' }) {
  return <StatusGlyph level={level} label={level === 'error' ? 'Error' : 'Warning'} />;
}

interface Props {
  attention: AttentionRow[];
  running: RunningRow[];
  /** Remote Control's open conversations; null while it is stopped (no section shows). */
  remote: RemoteConversation[] | null;
  /** The latest finished runs, newest first; null until they load. */
  recent: RecentRun[] | null;
  runtimes: Record<string, TaskRuntime>;
  pick: DashboardPick | null;
  onPick: (pick: DashboardPick) => void;
  /** Double-click or Enter: select the task and show one of its tabs. */
  onOpen: (taskId: string, tab: DetailTab) => void;
}

/** What opening a dashboard row does (double-click or Enter; a tap on a phone). */
export function dashboardOpeners(onOpen: (taskId: string, tab: DetailTab) => void) {
  return {
    // A waiting run opens on its terminal, or in its run window to answer its question; a failed one in its run window.
    attention: (r: AttentionRow) => {
      if (r.question && r.runId) void window.looper.openMessages(r.task.id, r.runId);
      else if (r.runId) onOpen(r.task.id, 'terminal');
      else if (r.lastRunId) void window.looper.openMessages(r.task.id, r.lastRunId);
      else onOpen(r.task.id, 'runs');
    },
    running: (r: RunningRow) => onOpen(r.task.id, 'terminal'),
    // An open conversation opens in a Looper terminal window.
    remote: (c: RemoteConversation) => void window.looper.remote.open(c.id),
    recent: (r: RecentRun) => void window.looper.openMessages(r.taskId, r.runId),
  };
}

export { StatusIcon, STEP_LABELS, TRIGGER_LABELS };

/** What the main window shows when no task is selected. */
export function Dashboard({ attention, running, remote, recent, runtimes, pick, onPick, onOpen }: Props) {
  // Only names the day of a time: the running time ticks in its own component.
  const now = Date.now();
  const isPicked = (list: DashboardPick['list'], taskId: string, runId: string | null) =>
    pick?.list === list && pick.taskId === taskId && pick.runId === runId;

  const rowId = (p: DashboardPick) => `dash-${p.list}-${p.taskId}-${p.runId ?? 'last'}`;
  const activeId = (list: DashboardPick['list']) => (pick?.list === list ? rowId(pick) : undefined);

  const attentionPick = (r: AttentionRow): DashboardPick => ({ list: 'attention', taskId: r.task.id, runId: r.runId });
  const runningPick = (r: RunningRow): DashboardPick => ({ list: 'running', taskId: r.task.id, runId: r.runId });
  const opens = dashboardOpeners(onOpen);
  const openAttention = opens.attention;
  const openRunning = opens.running;

  const attentionIndex = attention.findIndex((r) => isPicked('attention', r.task.id, r.runId));
  const runningIndex = running.findIndex((r) => isPicked('running', r.task.id, r.runId));
  const attentionKeys = useListNav({
    count: attention.length,
    index: attentionIndex,
    onIndex: (i) => onPick(attentionPick(attention[i])),
    onActivate: (i) => openAttention(attention[i]),
  });
  const runningKeys = useListNav({
    count: running.length,
    index: runningIndex,
    onIndex: (i) => onPick(runningPick(running[i])),
    onActivate: (i) => openRunning(running[i]),
  });
  const conversations = remote ?? [];
  const remotePick = (c: RemoteConversation): DashboardPick => ({ list: 'remote', taskId: c.taskId, runId: c.id });
  const openRemote = opens.remote;
  const remoteKeys = useListNav({
    count: conversations.length,
    index: conversations.findIndex((c) => isPicked('remote', c.taskId, c.id)),
    onIndex: (i) => onPick(remotePick(conversations[i])),
    onActivate: (i) => openRemote(conversations[i]),
  });
  const recentRuns = recent ?? [];
  const recentPick = (r: RecentRun): DashboardPick => ({ list: 'recent', taskId: r.taskId, runId: r.runId });
  const openRecent = opens.recent;
  const recentKeys = useListNav({
    count: recentRuns.length,
    index: recentRuns.findIndex((r) => isPicked('recent', r.taskId, r.runId)),
    onIndex: (i) => onPick(recentPick(recentRuns[i])),
    onActivate: (i) => openRecent(recentRuns[i]),
  });

  const menu = (task: Task, p: DashboardPick) => (e: React.MouseEvent) => {
    e.preventDefault();
    onPick(p);
    showTaskMenu(task, runtimes[task.id]);
  };

  return (
    <div className="detail">
      <div className="detail-bar">
        <span className="pane-title">Dashboard</span>
      </div>
      <div className="dashboard">
        <section className="dashboard-section">
          <span className="pane-title">Running now</span>
          {running.length === 0 ? (
            <div className="dashboard-empty muted">Nothing is running.</div>
          ) : (
            <div className="dashboard-list">
              <table className="runlog-table" tabIndex={0} role="grid" aria-label="Running now" aria-activedescendant={activeId('running')} onKeyDown={runningKeys}>
                <colgroup>
                  <col style={{ width: 240 }} />
                  <col />
                  <col style={{ width: 110 }} />
                  <col style={{ width: STARTED_WIDTH }} />
                  <col style={{ width: 100 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Step</th>
                    <th>Trigger</th>
                    <th className="num">Started</th>
                    <th className="num">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {running.map((r) => {
                    const p = runningPick(r);
                    return (
                      <tr
                        key={r.runId}
                        id={rowId(p)}
                        aria-selected={isPicked(p.list, p.taskId, p.runId)}
                        className={`run-row${isPicked(p.list, p.taskId, p.runId) ? ' selected' : ''}`}
                        onClick={() => onPick(p)}
                        onDoubleClick={() => openRunning(r)}
                        onContextMenu={menu(r.task, p)}
                      >
                        <td title={r.task.name}>{r.task.name}</td>
                        <td>{r.run.question !== null ? 'Waiting for your answer' : r.run.held ? 'Waiting for you' : STEP_LABELS[r.run.state]}</td>
                        <td>{TRIGGER_LABELS[r.run.trigger]}</td>
                        <td className="num">{fmtClock(r.run.startedAt, now)}</td>
                        <td className="num live-only"><Elapsed since={r.run.startedAt} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="dashboard-section">
          <span className="pane-title">Needs attention</span>
          {attention.length === 0 ? (
            <div className="dashboard-empty muted">Nothing needs attention.</div>
          ) : (
            <div className="dashboard-list">
              <table className="runlog-table" tabIndex={0} role="grid" aria-label="Needs attention" aria-activedescendant={activeId('attention')} onKeyDown={attentionKeys}>
                <colgroup>
                  <col style={{ width: 240 }} />
                  <col />
                  <col style={{ width: STARTED_WIDTH }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Problem</th>
                    <th className="num">Run started</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((r) => {
                    const p = attentionPick(r);
                    return (
                      <tr
                        key={`${r.task.id}-${r.runId ?? 'last'}`}
                        id={rowId(p)}
                        aria-selected={isPicked(p.list, p.taskId, p.runId)}
                        className={`run-row${isPicked(p.list, p.taskId, p.runId) ? ' selected' : ''}`}
                        onClick={() => onPick(p)}
                        onDoubleClick={() => openAttention(r)}
                        onContextMenu={menu(r.task, p)}
                      >
                        <td title={r.task.name}>
                          <StatusIcon level={r.level} />
                          {r.task.name}
                        </td>
                        <td title={r.problem}>{r.problem}</td>
                        <td className="num">{r.at !== null ? fmtClock(r.at, now) : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="dashboard-section">
          <span className="pane-title">Recent runs</span>
          {recent && recentRuns.length === 0 ? (
            <div className="dashboard-empty muted">No runs yet.</div>
          ) : (
            <div className="dashboard-list">
              <table className="runlog-table" tabIndex={0} role="grid" aria-label="Recent runs" aria-activedescendant={activeId('recent')} onKeyDown={recentKeys}>
                <colgroup>
                  <col style={{ width: 240 }} />
                  <col style={{ width: 110 }} />
                  <col />
                  <col style={{ width: STARTED_WIDTH }} />
                  <col style={{ width: 100 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Result</th>
                    <th>Details</th>
                    <th className="num">Started</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((r) => {
                    const p = recentPick(r);
                    return (
                      <tr
                        key={`${r.taskId}-${r.runId}`}
                        id={rowId(p)}
                        aria-selected={isPicked(p.list, p.taskId, p.runId)}
                        className={`result-${r.result} run-row${isPicked(p.list, p.taskId, p.runId) ? ' selected' : ''}`}
                        onClick={() => onPick(p)}
                        onDoubleClick={() => openRecent(r)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onPick(p);
                          window.looper.showRunContextMenu({ taskId: r.taskId, runId: r.runId, details: r.details });
                        }}
                      >
                        <td title={r.taskName}>{r.taskName}</td>
                        <td>{resultLabel(r.result)}</td>
                        <td title={r.details}>{r.details}</td>
                        <td className="num">{fmtClock(Date.parse(r.startTs), now)}</td>
                        <td className="num">{r.totalDurationMs > 0 ? formatDuration(r.totalDurationMs) : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {remote && (
          <section className="dashboard-section">
            <span className="pane-title">Remote Control</span>
            {conversations.length === 0 ? (
              <div className="dashboard-empty muted">No conversations are open.</div>
            ) : (
              <div className="dashboard-list">
                <table className="runlog-table" tabIndex={0} role="grid" aria-label="Remote Control" aria-activedescendant={activeId('remote')} onKeyDown={remoteKeys}>
                  <colgroup>
                    <col style={{ width: 240 }} />
                    <col style={{ width: 110 }} />
                    <col />
                    <col style={{ width: STARTED_WIDTH }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Status</th>
                      <th>Last message</th>
                      <th className="num">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conversations.map((c) => {
                      const p = remotePick(c);
                      return (
                        <tr
                          key={c.id}
                          id={rowId(p)}
                          aria-selected={isPicked(p.list, p.taskId, p.runId)}
                          className={`run-row${isPicked(p.list, p.taskId, p.runId) ? ' selected' : ''}`}
                          onClick={() => onPick(p)}
                          onDoubleClick={() => openRemote(c)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onPick(p);
                            window.looper.remote.showContextMenu(c.id);
                          }}
                        >
                          <td title={c.cwd}>{c.name}</td>
                          <td>{REMOTE_STATUS_LABELS[c.status]}</td>
                          <td title={c.lastMessage}>{c.lastMessage ?? (c.status === 'waiting' ? 'No message yet' : '')}</td>
                          <td className="num">{fmtClock(Date.parse(c.startedAt), now)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
