import { useEffect, useState } from 'react';
import type { RemoteState } from '@shared/remote';
import type { Environment, Project, RunRecord, Task, TaskRuntime } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, describeEnvironment, harnessKindLabel, harnessModels, withKind } from '@shared/environments';
import { projectTaskId } from '@shared/projects';
import { isSessionRun } from '@shared/runs';
import { envToLine, joinTokens } from '@shared/cmdline';
import { fmtClock, resultLabel, stateLabel } from '../format';
import { resultTone } from '../phone-lists';
import { gitTabLabel } from '@shared/git';
import { DataTable, type DataCol } from './DataTable';
import { GitView, useGitStatus } from './GitView';
import { useGitRepo } from './hooks';
import { useSessionsState } from './phone/useSessionsState';
import { RunLog } from './RunLog';
import { TabBar } from './ui';
import { subscribe } from '../events';

type ProjectTab = 'status' | 'tasks' | 'sessions' | 'git';

const TABS: [ProjectTab, string][] = [
  ['status', 'Status'],
  ['tasks', 'Tasks'],
  ['sessions', 'Chats'],
];

const MAX_RECORDS = 500;

/** The main window's view of a project: its settings, its tasks, its chats and terminal sessions, and its git repository. */
export function ProjectDetail({
  project,
  tasks,
  runtimes,
  environments,
  remote,
  onSelectTask,
  untitled = false,
}: {
  project: Project;
  tasks: Task[];
  runtimes: Record<string, TaskRuntime>;
  environments: Environment[];
  remote: RemoteState | null;
  onSelectTask: (id: string) => void;
  /** The project's own window, whose title bar already names it. */
  untitled?: boolean;
}) {
  const [shownTab, setTab] = useState<ProjectTab>('status');
  const gitRepo = useGitRepo(project.id);
  const tab = shownTab === 'git' && !gitRepo ? 'status' : shownTab;
  const sessions = useSessionsState();
  const git = useGitStatus(gitRepo ? project.id : undefined, !!sessions?.sessions.some((s) => s.projectId === project.id && s.status === 'working'));
  const [picked, setPicked] = useState<string | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const standIn = projectTaskId(project.id);
  const mine = tasks.filter((t) => t.projectId === project.id);
  // The Chats tab lists the project's own sessions and the ones that went on from its tasks' runs.
  const taskKey = mine.map((t) => t.id).join('\n');

  useEffect(() => {
    const taskIds = new Set(taskKey ? taskKey.split('\n') : []);
    const mineRecord = (r: RunRecord) => r.taskId === standIn || (taskIds.has(r.taskId) && isSessionRun(r));
    let live = true;
    void Promise.all([standIn, ...taskIds].map((id) => window.looper.runs.list(id, MAX_RECORDS))).then((lists) => {
      if (live) setRecords(lists.flat().filter(mineRecord));
    });
    const off = subscribe((e) => {
      if (e.type === 'record' && mineRecord(e.record)) setRecords((list) => [...list, e.record].slice(-MAX_RECORDS));
    });
    return () => {
      live = false;
      off();
    };
  }, [standIn, taskKey]);

  const env = environments.find((e) => e.id === project.environmentId);
  const harness = env ? (project.harnessId ? env.harnesses.find((h) => h.id === project.harnessId) : env.harnesses[0]) : undefined;
  const kind = harness && harness.kind !== 'custom' ? harness.kind : undefined;
  const model = project.model ? (harness ? harnessModels(harness).find((m) => m.id === project.model)?.name : undefined) ?? project.model : 'Default';
  const effort = project.effort && kind ? (EFFORT_LEVELS[kind].find(([v]) => v === project.effort)?.[1] ?? project.effort) : project.effort;
  const mode = kind ? (PERMISSION_MODES[kind].find(([v]) => v === project.permissionMode)?.[1] ?? project.permissionMode) : project.permissionMode;
  const problem = remote?.problems[`project:${project.id}`];
  const remoteText = !project.remote
    ? 'Off'
    : !remote?.running
      ? 'Keeps a conversation open while Remote Control is on'
      : problem
        ? `No conversation: ${problem}`
        : 'Keeps a conversation open';
  /** What the task list's status line says, briefly: its state, or why it doesn't run. */
  const statusOf = (t: Task) => (t.completedAt ? 'Completed' : !t.enabled ? 'Disabled' : stateLabel(runtimes[t.id]));
  const taskCols: DataCol<Task>[] = [
    { label: 'Task', width: 240, cell: (t) => t.name, title: (t) => t.name },
    { label: 'Status', width: 110, cell: statusOf },
    { label: 'Last run', width: 150, cell: (t) => (runtimes[t.id]?.lastRunAt ? fmtClock(runtimes[t.id].lastRunAt!, Date.now()) : 'Never') },
    { label: 'Result', width: 96, cell: (t) => (runtimes[t.id]?.lastResult ? resultLabel(runtimes[t.id].lastResult!) : 'None') },
    { label: 'Details', cell: (t) => runtimes[t.id]?.lastDetail ?? '', title: (t) => runtimes[t.id]?.lastDetail ?? undefined },
  ];

  return (
    <div className="detail">
      {!untitled && (
        <div className="detail-bar">
          <span className="pane-title">{project.name}</span>
        </div>
      )}
      <TabBar
        tabs={gitRepo ? [...TABS, ['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)]] : TABS}
        active={tab}
        onSelect={setTab}
        ctrlTab
      />
      <section className="tab-body">
        {tab === 'status' && (
          <div className="status-pane">
            <dl className="props">
              <dt>Working directory</dt>
              <dd className="mono">{project.cwd}</dd>
              <dt>Environment</dt>
              <dd>{env ? withKind(env.name, describeEnvironment(env)) :<span className="warn">Unknown environment "{project.environmentId}"</span>}</dd>
              <dt>Harness</dt>
              <dd>{harness ? withKind(harness.name, harnessKindLabel(harness.kind)) : 'None'}</dd>
              <dt>Model</dt>
              <dd>
                {model}
                {effort ? `, ${effort.toLowerCase()} effort` : ''}
              </dd>
              <dt>Session type</dt>
              <dd>{project.mode === 'headless' ? 'Headless' : 'Interactive'}</dd>
              <dt>Permission mode</dt>
              <dd>{mode || 'None'}</dd>
              <dt>Extra command-line arguments</dt>
              <dd className={project.extraArgs.length ? 'mono' : undefined}>{project.extraArgs.length ? joinTokens(project.extraArgs) : 'None'}</dd>
              <dt>Extra environment variables</dt>
              <dd className={Object.keys(project.env).length ? 'mono' : undefined}>{Object.keys(project.env).length ? envToLine(project.env) : 'None'}</dd>
              <dt>Remote Control</dt>
              <dd>{remoteText}</dd>
            </dl>
          </div>
        )}
        {tab === 'tasks' && (
          <div className="runlog">
            <DataTable
              cols={taskCols}
              rows={mine}
              rowKey={(t) => t.id}
              idPrefix="project-task"
              label="Tasks"
              storageKey="project-tasks"
              rowClass={(t) => `${runtimes[t.id]?.lastResult ? `result-${runtimes[t.id].lastResult}` : ''}${!t.enabled ? ' muted' : ''}`}
              selected={picked}
              onSelect={(t) => setPicked(t.id)}
              onOpen={(t) => onSelectTask(t.id)}
              empty="No tasks run in this project."
              phoneRow={(t) => {
                const rt = runtimes[t.id];
                return {
                  title: t.name,
                  sub: [statusOf(t), rt?.lastRunAt ? fmtClock(rt.lastRunAt, Date.now()) : 'Never', rt?.lastDetail].filter(Boolean).join(' · '),
                  value: rt?.lastResult ? resultLabel(rt.lastResult) : undefined,
                  valueTone: rt?.lastResult ? resultTone(rt.lastResult) : undefined,
                  tone: t.enabled ? undefined : 'muted',
                };
              }}
            />
          </div>
        )}
        {tab === 'sessions' && <RunLog records={records} sessions />}
        {tab === 'git' && <GitView projectId={project.id} watch={git} />}
      </section>
    </div>
  );
}
