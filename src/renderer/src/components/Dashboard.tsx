import type { ActiveRun, TaskRuntime } from '@shared/types';
import type { AttentionRow, RecentRun, RunningRow } from '@shared/dashboard';
import type { RemoteConversation } from '@shared/remote';
import type { SessionSummary } from '@shared/sessions';
import { REMOTE_STATUS_LABELS, fmtClock, formatDuration, resultLabel } from '../format';
import type { DetailTab } from './TaskDetail';
import { DataTable, type DataCol } from './DataTable';
import { showTaskMenu } from './row-menus';
import { StatusGlyph } from './icons';
import { Elapsed } from './Live';
import { statusText } from './SessionList';

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
  /** The open chats and terminal sessions; unset where they have a list of their own (the Tasks tab's dashboard). */
  chats?: SessionSummary[];
  /** The latest finished runs, newest first; null until they load. */
  recent: RecentRun[] | null;
  runtimes: Record<string, TaskRuntime>;
  pick: DashboardPick | null;
  onPick: (pick: DashboardPick) => void;
  /** Double-click or Enter: select the task and show one of its tabs. */
  onOpen: (taskId: string, tab: DetailTab) => void;
  onClearAttention: (rows: AttentionRow[]) => void;
}

/** What opening a dashboard row does (double-click or Enter; a tap on a phone). */
export function dashboardOpeners(onOpen: (taskId: string, tab: DetailTab) => void) {
  return {
    // A waiting or failed run opens in its run window, where its question is answered and guidance sent.
    attention: (r: AttentionRow) => {
      const runId = r.runId ?? r.lastRunId;
      if (runId) void window.looper.openMessages(r.task.id, runId);
      else onOpen(r.task.id, 'runs');
    },
    running: (r: RunningRow) => void window.looper.openMessages(r.task.id, r.runId),
    // An open conversation opens in a Looper terminal window.
    remote: (c: RemoteConversation) => void window.looper.remote.open(c.id),
    recent: (r: RecentRun) => void window.looper.openMessages(r.taskId, r.runId),
  };
}

export { StatusIcon, STEP_LABELS, TRIGGER_LABELS };

/** What the main window shows when no task is selected. */
export function Dashboard({ attention, running, remote, chats, recent, runtimes, pick, onPick, onOpen, onClearAttention }: Props) {
  // Only names the day of a time: the running time ticks in its own component.
  const now = Date.now();
  const pickKey = (p: DashboardPick) => `${p.taskId}-${p.runId ?? 'last'}`;
  const pickedIn = (list: DashboardPick['list']) => (pick?.list === list ? pickKey(pick) : null);

  const attentionPick = (r: AttentionRow): DashboardPick => ({ list: 'attention', taskId: r.task.id, runId: r.runId });
  const runningPick = (r: RunningRow): DashboardPick => ({ list: 'running', taskId: r.task.id, runId: r.runId });
  const opens = dashboardOpeners(onOpen);
  const conversations = remote ?? [];
  const remotePick = (c: RemoteConversation): DashboardPick => ({ list: 'remote', taskId: c.taskId, runId: c.id });
  const recentRuns = recent ?? [];
  const recentPick = (r: RecentRun): DashboardPick => ({ list: 'recent', taskId: r.taskId, runId: r.runId });

  const runningCols: DataCol<RunningRow>[] = [
    { label: 'Task', width: 240, cell: (r) => r.task.name, title: (r) => r.task.name },
    { label: 'Step', cell: (r) => (r.run.question !== null ? 'Waiting for your answer' : r.run.held ? 'Waiting for you' : STEP_LABELS[r.run.state]) },
    { label: 'Trigger', width: 110, cell: (r) => TRIGGER_LABELS[r.run.trigger] },
    { label: 'Started', width: STARTED_WIDTH, num: true, cell: (r) => fmtClock(r.run.startedAt, now) },
    { label: 'Elapsed', width: 100, num: true, cellClass: 'live-only', cell: (r) => <Elapsed since={r.run.startedAt} /> },
  ];
  const attentionCols: DataCol<AttentionRow>[] = [
    {
      label: 'Task',
      width: 240,
      title: (r) => r.task.name,
      cell: (r) => (
        <>
          <StatusIcon level={r.level} />
          {r.task.name}
        </>
      ),
    },
    { label: 'Problem', cell: (r) => r.problem, title: (r) => r.problem },
    { label: 'Run started', width: STARTED_WIDTH, num: true, cell: (r) => (r.at !== null ? fmtClock(r.at, now) : '') },
  ];
  const recentCols: DataCol<RecentRun>[] = [
    { label: 'Task', width: 240, cell: (r) => r.taskName, title: (r) => r.taskName },
    { label: 'Result', width: 110, cell: (r) => resultLabel(r.result) },
    { label: 'Details', cell: (r) => r.details, title: (r) => r.details },
    { label: 'Started', width: STARTED_WIDTH, num: true, cell: (r) => fmtClock(Date.parse(r.startTs), now) },
    { label: 'Duration', width: 100, num: true, cell: (r) => (r.totalDurationMs > 0 ? formatDuration(r.totalDurationMs) : '') },
  ];
  const chatCols: DataCol<SessionSummary>[] = [
    { label: 'Chat', width: 240, cell: (s) => s.title, title: (s) => s.title },
    { label: 'Project', width: 160, cell: (s) => s.groupName, title: (s) => s.groupName },
    { label: 'Status', width: 110, cell: statusText },
    { label: 'Last message', cell: (s) => s.latest ?? '', title: (s) => s.latest },
    { label: 'Last reply', width: STARTED_WIDTH, num: true, cell: (s) => (s.lastReplyAt !== undefined ? fmtClock(s.lastReplyAt, now) : '') },
  ];
  const remoteCols: DataCol<RemoteConversation>[] = [
    { label: 'Session', width: 240, cell: (c) => c.name, title: (c) => c.cwd },
    { label: 'Status', width: 110, cell: (c) => REMOTE_STATUS_LABELS[c.status] },
    { label: 'Last message', cell: (c) => c.lastMessage ?? (c.status === 'waiting' ? 'No message yet' : ''), title: (c) => c.lastMessage },
    { label: 'Started', width: STARTED_WIDTH, num: true, cell: (c) => fmtClock(Date.parse(c.startedAt), now) },
  ];

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
            <DataTable
              wrapClass="dashboard-list"
              label="Running now"
              cols={runningCols}
              rows={running}
              rowKey={(r) => pickKey(runningPick(r))}
              idPrefix="dash-running"
              storageKey="dashboard-running"
              selected={pickedIn('running')}
              onSelect={(r) => onPick(runningPick(r))}
              onOpen={opens.running}
              onMenu={(r) => showTaskMenu(r.task, runtimes[r.task.id])}
              empty={null}
            />
          )}
        </section>

        <section className="dashboard-section">
          <div className="dashboard-section-head">
            <span className="pane-title">Needs attention</span>
            <button className="btn small" disabled={attention.length === 0} onClick={() => onClearAttention(attention)}>
              Clear
            </button>
          </div>
          {attention.length === 0 ? (
            <div className="dashboard-empty muted">Nothing needs attention.</div>
          ) : (
            <DataTable
              wrapClass="dashboard-list"
              label="Needs attention"
              cols={attentionCols}
              rows={attention}
              rowKey={(r) => pickKey(attentionPick(r))}
              idPrefix="dash-attention"
              storageKey="dashboard-attention"
              selected={pickedIn('attention')}
              onSelect={(r) => onPick(attentionPick(r))}
              onOpen={opens.attention}
              onMenu={(r) => showTaskMenu(r.task, runtimes[r.task.id])}
              empty={null}
            />
          )}
        </section>

        {chats && (
          <section className="dashboard-section">
            <span className="pane-title">Chats</span>
            {chats.length === 0 ? (
              <div className="dashboard-empty muted">No chats are open.</div>
            ) : (
              <DataTable
                wrapClass="dashboard-list"
                label="Chats"
                cols={chatCols}
                rows={chats}
                rowKey={(s) => s.id}
                idPrefix="dash-chats"
                storageKey="dashboard-chats"
                onOpen={(s) => window.looper.sessions.openWindow(s.id)}
                onMenu={(s) => window.looper.sessions.showContextMenu(s.id, false)}
                empty={null}
              />
            )}
          </section>
        )}

        <section className="dashboard-section">
          <span className="pane-title">Recent runs</span>
          {recent && recentRuns.length === 0 ? (
            <div className="dashboard-empty muted">No runs yet.</div>
          ) : (
            <DataTable
              wrapClass="dashboard-list"
              label="Recent runs"
              cols={recentCols}
              rows={recentRuns}
              rowKey={(r) => pickKey(recentPick(r))}
              idPrefix="dash-recent"
              storageKey="dashboard-recent"
              rowClass={(r) => `result-${r.result}`}
              selected={pickedIn('recent')}
              onSelect={(r) => onPick(recentPick(r))}
              onOpen={opens.recent}
              onMenu={(r) => window.looper.showRunContextMenu({ taskId: r.taskId, runId: r.runId, details: r.details })}
              empty={null}
            />
          )}
        </section>

        {remote && (
          <section className="dashboard-section">
            <span className="pane-title">Remote Control</span>
            {conversations.length === 0 ? (
              <div className="dashboard-empty muted">No conversations are open.</div>
            ) : (
              <DataTable
                wrapClass="dashboard-list"
                label="Remote Control"
                cols={remoteCols}
                rows={conversations}
                rowKey={(c) => pickKey(remotePick(c))}
                idPrefix="dash-remote"
                storageKey="dashboard-remote"
                selected={pickedIn('remote')}
                onSelect={(c) => onPick(remotePick(c))}
                onOpen={opens.remote}
                onMenu={(c) => window.looper.remote.showContextMenu(c.id)}
                empty={null}
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
