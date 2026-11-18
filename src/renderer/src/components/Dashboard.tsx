import type { ActiveRun, TaskRuntime } from '@shared/types';
import type { AttentionRow, RecentRun, RunningRow } from '@shared/dashboard';
import type { RemoteConversation } from '@shared/remote';
import type { SessionSummary } from '@shared/sessions';
import { REMOTE_STATUS_LABELS, fmtClock, formatDuration, resultLabel } from '../format';
import type { DetailTab } from './TaskDetail';
import { DataTable, type DataCol } from './DataTable';
import { DetailView } from './DetailView';
import type { LoginRow } from '@shared/logins';
import { showLoginMenu, showTaskMenu } from './row-menus';
import { StatusGlyph } from './icons';
import { Elapsed } from './Live';
import { Section } from './Section';
import { statusText } from './SessionList';
import { reportError } from '../report-error';

/** A row the user picked on the dashboard; the menus act on its task. */
export interface DashboardPick {
  /** remote: a Remote Control conversation, and login: a Claude Code login's row in Needs attention (its key as taskId), which the task menus leave alone. */
  list: 'attention' | 'running' | 'remote' | 'recent' | 'login';
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

/** A Needs attention row: a task's, or a Claude Code login's. */
export type NeedRow = { kind: 'task'; r: AttentionRow } | { kind: 'login'; r: LoginRow };

/** Needs attention's rows, errors first; within a level the logins first, since every task on one waits for it. */
export function needRows(attention: AttentionRow[], logins: LoginRow[]): NeedRow[] {
  const rows: NeedRow[] = [...logins.map((r) => ({ kind: 'login' as const, r })), ...attention.map((r) => ({ kind: 'task' as const, r }))];
  return rows.sort((a, b) => (a.r.level === b.r.level ? 0 : a.r.level === 'error' ? -1 : 1));
}

/** A need's title: its task, or the login's harnesses and environment. */
export const needTitle = (n: NeedRow): string => (n.kind === 'task' ? n.r.task.name : n.r.login.name);
/** When its problem started: the task's run, or the run or chat that failed on the login. */
export const needAt = (n: NeedRow): number | null => (n.kind === 'task' ? n.r.at : (n.r.login.failedAt ?? null));

interface Props {
  attention: AttentionRow[];
  /** The Claude Code logins that need the user. */
  logins: LoginRow[];
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
  onClearAttention: (rows: AttentionRow[], logins: LoginRow[]) => void;
}

/** What opening a dashboard row does (double-click or Enter; a tap on a phone). */
/** Log In: Claude Code's own login, in a terminal window. */
export const logIn = (r: LoginRow): void =>
  void window.looper.logins.logIn(r.login.environmentId, r.login.harnessIds[0]).catch(reportError);

export function dashboardOpeners(onOpen: (taskId: string, tab: DetailTab) => void) {
  // A waiting or failed run opens in its run window, where its question is answered and guidance sent.
  const attention = (r: AttentionRow) => {
    const runId = r.runId ?? r.lastRunId;
    if (runId) void window.looper.openMessages(r.task.id, runId);
    else onOpen(r.task.id, 'runs');
  };
  return {
    attention,
    running: (r: RunningRow) => void window.looper.openMessages(r.task.id, r.runId),
    // An open conversation opens in a Looper terminal window.
    remote: (c: RemoteConversation) => void window.looper.remote.open(c.id),
    recent: (r: RecentRun) => void window.looper.openMessages(r.taskId, r.runId),
    need: (n: NeedRow) => (n.kind === 'task' ? attention(n.r) : logIn(n.r)),
  };
}

/** A need's right-click menu (a long press on a phone): its task's, or Log In. */
export function showNeedMenu(n: NeedRow, runtimes: Record<string, TaskRuntime>): void {
  if (n.kind === 'task') showTaskMenu(n.r.task, runtimes[n.r.task.id]);
  else showLoginMenu(() => logIn(n.r));
}

export { StatusIcon, STEP_LABELS, TRIGGER_LABELS };

/** What the main window shows when no task is selected. */
export function Dashboard({ attention, logins, running, remote, chats, recent, runtimes, pick, onPick, onOpen, onClearAttention }: Props) {
  // Only names the day of a time: the running time ticks in its own component.
  const now = Date.now();
  const pickKey = (p: DashboardPick) => `${p.taskId}-${p.runId ?? 'last'}`;
  const pickedIn = (list: DashboardPick['list']) => (pick?.list === list ? pickKey(pick) : null);

  const needs = needRows(attention, logins);
  const needPick = (n: NeedRow): DashboardPick =>
    n.kind === 'task' ? { list: 'attention', taskId: n.r.task.id, runId: n.r.runId } : { list: 'login', taskId: n.r.login.key, runId: null };
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
  const attentionCols: DataCol<NeedRow>[] = [
    {
      label: 'Task',
      width: 240,
      title: needTitle,
      cell: (n) => (
        <>
          <StatusIcon level={n.r.level} />
          {needTitle(n)}
        </>
      ),
    },
    { label: 'Problem', cell: (n) => n.r.problem, title: (n) => n.r.problem },
    {
      label: 'Run started',
      width: STARTED_WIDTH,
      num: true,
      cell: (n) => {
        const at = needAt(n);
        return at !== null ? fmtClock(at, now) : '';
      },
    },
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
    <DetailView title="Dashboard">
      <div className="dashboard">
        <Section className="dashboard-section" title="Running now" empty={running.length === 0 && 'Nothing is running.'}>
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
        </Section>

        <Section
          className="dashboard-section"
          title="Needs attention"
          action={{ label: 'Clear', disabled: needs.length === 0, run: () => onClearAttention(attention, logins) }}
          empty={needs.length === 0 && 'Nothing needs attention.'}
        >
          <DataTable
            wrapClass="dashboard-list"
            label="Needs attention"
            cols={attentionCols}
            rows={needs}
            rowKey={(n) => pickKey(needPick(n))}
            idPrefix="dash-attention"
            storageKey="dashboard-attention"
            selected={pickedIn('attention') ?? pickedIn('login')}
            onSelect={(n) => onPick(needPick(n))}
            onOpen={(n) => opens.need(n)}
            onMenu={(n) => showNeedMenu(n, runtimes)}
            empty={null}
          />
        </Section>

        {chats && (
          <Section className="dashboard-section" title="Chats" empty={chats.length === 0 && 'No chats are open.'}>
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
          </Section>
        )}

        <Section className="dashboard-section" title="Recent runs" empty={!!recent && recentRuns.length === 0 && 'No runs yet.'}>
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
        </Section>

        {remote && (
          <Section className="dashboard-section" title="Remote Control" empty={conversations.length === 0 && 'No conversations are open.'}>
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
          </Section>
        )}
      </div>
    </DetailView>
  );
}
