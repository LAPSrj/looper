import type { ActiveRun, Task, TaskRuntime } from '@shared/types';
import type { AttentionRow, RunningRow } from '@shared/dashboard';
import type { RemoteConversation } from '@shared/remote';
import { REMOTE_STATUS_LABELS, fmtClock, formatDuration } from '../format';
import type { DetailTab } from './TaskDetail';
import { showTaskMenu } from './TaskList';
import { useListNav } from './hooks';

/** A row the user picked on the dashboard; the toolbar and menus act on its task. */
export interface DashboardPick {
  /** remote: a Remote Control conversation, which the task menus and toolbar leave alone. */
  list: 'attention' | 'running' | 'remote';
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

/** Windows' standard 16 px error and warning icons. */
function StatusIcon({ level }: { level: 'error' | 'warning' }) {
  return (
    <svg className="status-icon" width="16" height="16" viewBox="0 0 16 16" aria-label={level === 'error' ? 'Error' : 'Warning'}>
      {level === 'error' ? (
        <>
          <circle className="status-icon-error" cx="8" cy="8" r="7.5" />
          <path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path className="status-icon-warning" d="M8 1.2 15.3 14.3H.7Z" strokeLinejoin="round" />
          <path d="M8 5.6v4.3" stroke="#1b1b1b" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="12" r=".9" fill="#1b1b1b" />
        </>
      )}
    </svg>
  );
}

interface Props {
  attention: AttentionRow[];
  running: RunningRow[];
  /** Remote Control's open conversations; null while it is stopped (no section shows). */
  remote: RemoteConversation[] | null;
  runtimes: Record<string, TaskRuntime>;
  now: number;
  pick: DashboardPick | null;
  onPick: (pick: DashboardPick) => void;
  /** Double-click or Enter: select the task and show one of its tabs. */
  onOpen: (taskId: string, tab: DetailTab) => void;
}

/** What the main window shows when no task is selected. */
export function Dashboard({ attention, running, remote, runtimes, now, pick, onPick, onOpen }: Props) {
  const isPicked = (list: DashboardPick['list'], taskId: string, runId: string | null) =>
    pick?.list === list && pick.taskId === taskId && pick.runId === runId;

  const attentionPick = (r: AttentionRow): DashboardPick => ({ list: 'attention', taskId: r.task.id, runId: r.runId });
  const runningPick = (r: RunningRow): DashboardPick => ({ list: 'running', taskId: r.task.id, runId: r.runId });
  // A waiting run opens on its terminal; a failed one in its run window.
  const openAttention = (r: AttentionRow) => {
    if (r.runId) onOpen(r.task.id, 'terminal');
    else if (r.lastRunId) void window.looper.openMessages(r.task.id, r.lastRunId);
    else onOpen(r.task.id, 'runs');
  };
  const openRunning = (r: RunningRow) => onOpen(r.task.id, 'terminal');

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
  // An open conversation opens in a Looper terminal window.
  const openRemote = (c: RemoteConversation) => void window.looper.remote.open(c.id);
  const remoteKeys = useListNav({
    count: conversations.length,
    index: conversations.findIndex((c) => isPicked('remote', c.taskId, c.id)),
    onIndex: (i) => onPick(remotePick(conversations[i])),
    onActivate: (i) => openRemote(conversations[i]),
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
          <span className="pane-title">Needs attention</span>
          {attention.length === 0 ? (
            <div className="dashboard-empty muted">Nothing needs attention.</div>
          ) : (
            <div className="dashboard-list" tabIndex={0} role="listbox" aria-label="Needs attention" onKeyDown={attentionKeys}>
              <table className="runlog-table">
                <colgroup>
                  <col style={{ width: 240 }} />
                  <col />
                  <col style={{ width: 120 }} />
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
          <span className="pane-title">Running now</span>
          {running.length === 0 ? (
            <div className="dashboard-empty muted">Nothing is running.</div>
          ) : (
            <div className="dashboard-list" tabIndex={0} role="listbox" aria-label="Running now" onKeyDown={runningKeys}>
              <table className="runlog-table">
                <colgroup>
                  <col style={{ width: 240 }} />
                  <col />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 120 }} />
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
                        className={`run-row${isPicked(p.list, p.taskId, p.runId) ? ' selected' : ''}`}
                        onClick={() => onPick(p)}
                        onDoubleClick={() => openRunning(r)}
                        onContextMenu={menu(r.task, p)}
                      >
                        <td title={r.task.name}>{r.task.name}</td>
                        <td>{r.run.held ? 'Waiting for you' : STEP_LABELS[r.run.state]}</td>
                        <td>{TRIGGER_LABELS[r.run.trigger]}</td>
                        <td className="num">{fmtClock(r.run.startedAt, now)}</td>
                        <td className="num">{now - r.run.startedAt < 1000 ? '0s' : formatDuration(now - r.run.startedAt)}</td>
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
              <div className="dashboard-empty muted">No sessions are open.</div>
            ) : (
              <div className="dashboard-list" tabIndex={0} role="listbox" aria-label="Remote Control" onKeyDown={remoteKeys}>
                <table className="runlog-table">
                  <colgroup>
                    <col style={{ width: 240 }} />
                    <col style={{ width: 110 }} />
                    <col />
                    <col style={{ width: 120 }} />
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
