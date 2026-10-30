import { useEffect, useState } from 'react';
import type { RemoteState } from '@shared/remote';
import type { Environment, Project, RunRecord, Task, TaskRuntime } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, describeEnvironment, harnessKindLabel, harnessModels } from '@shared/environments';
import { projectTaskId } from '@shared/projects';
import { envToLine, joinTokens } from '@shared/cmdline';
import { fmtClock, resultLabel, stateLabel } from '../format';
import { gitTabLabel } from '@shared/git';
import { GitView, useGitStatus } from './GitView';
import { useGitRepo, useListNav } from './hooks';
import { RunLog } from './RunLog';
import { ResizableColumns, TabBar, type TableCol } from './ui';
import { isPhone } from '../web/page-nav';

type ProjectTab = 'status' | 'tasks' | 'sessions' | 'git';

const TABS: [ProjectTab, string][] = [
  ['status', 'Status'],
  ['tasks', 'Tasks'],
  ['sessions', 'Sessions'],
];

const MAX_RECORDS = 500;

const TASK_COLS: readonly TableCol[] = [
  { label: 'Task', width: 240 },
  { label: 'Status', width: 110 },
  { label: 'Last run', width: 150 },
  { label: 'Result', width: 96 },
  { label: 'Details' },
];

/** The main window's view of a project: its settings, its tasks, its chats and terminal sessions, and its git repository. */
export function ProjectDetail({
  project,
  tasks,
  runtimes,
  environments,
  remote,
  now,
  onSelectTask,
}: {
  project: Project;
  tasks: Task[];
  runtimes: Record<string, TaskRuntime>;
  environments: Environment[];
  remote: RemoteState | null;
  now: number;
  onSelectTask: (id: string) => void;
}) {
  const [shownTab, setTab] = useState<ProjectTab>('status');
  const gitRepo = useGitRepo(project.id);
  const tab = shownTab === 'git' && !gitRepo ? 'status' : shownTab;
  const git = useGitStatus(gitRepo ? project.id : undefined);
  const [picked, setPicked] = useState<string | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const standIn = projectTaskId(project.id);

  useEffect(() => {
    void window.looper.runs.list(standIn, MAX_RECORDS).then(setRecords);
    return window.looper.onEvent((e) => {
      if (e.type === 'record' && e.record.taskId === standIn) setRecords((list) => [...list, e.record].slice(-MAX_RECORDS));
    });
  }, [standIn]);

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
  const mine = tasks.filter((t) => t.projectId === project.id);
  const pickedIndex = mine.findIndex((t) => t.id === picked);
  const taskKeys = useListNav({
    count: mine.length,
    index: pickedIndex,
    onIndex: (i) => setPicked(mine[i].id),
    onActivate: (i) => onSelectTask(mine[i].id),
    scrollToId: picked ? `project-task-${picked}` : null,
  });
  /** What the task list's status line says, briefly: its state, or why it doesn't run. */
  const statusOf = (t: Task) => (t.completedAt ? 'Completed' : !t.enabled ? 'Disabled' : stateLabel(runtimes[t.id]));

  return (
    <div className="detail">
      <div className="detail-bar">
        <span className="pane-title">{project.name}</span>
      </div>
      <TabBar
        tabs={gitRepo ? [...TABS, ['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)]] : TABS}
        active={tab}
        onSelect={setTab}
      />
      <section className="tab-body">
        {tab === 'status' && (
          <div className="status-pane">
            <dl className="props">
              <dt>Working directory</dt>
              <dd className="mono">{project.cwd}</dd>
              <dt>Environment</dt>
              <dd>{env ? `${env.name} (${describeEnvironment(env)})` : <span className="warn">Unknown environment "{project.environmentId}"</span>}</dd>
              <dt>Harness</dt>
              <dd>{harness ? `${harness.name} (${harnessKindLabel(harness.kind)})` : 'None'}</dd>
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
              <dd className="mono">{project.extraArgs.length ? joinTokens(project.extraArgs) : 'None'}</dd>
              <dt>Extra environment variables</dt>
              <dd className="mono">{Object.keys(project.env).length ? envToLine(project.env) : 'None'}</dd>
              <dt>Remote Control</dt>
              <dd>{remoteText}</dd>
            </dl>
          </div>
        )}
        {tab === 'tasks' && (
          <div className="runlog">
            <div className="runlog-table-wrap" style={{ height: '100%' }} tabIndex={0} role="listbox" aria-label="Tasks" onKeyDown={taskKeys}>
              <table className="runlog-table">
                <ResizableColumns cols={TASK_COLS} storageKey="project-tasks" />
                <tbody>
                  {mine.map((t) => {
                    const rt = runtimes[t.id];
                    return (
                      <tr
                        key={t.id}
                        id={`project-task-${t.id}`}
                        className={`run-row${rt?.lastResult ? ` result-${rt.lastResult}` : ''}${t.id === picked ? ' selected' : ''}${!t.enabled ? ' muted' : ''}`}
                        // A phone has no double-click: a tap opens the task.
                        onClick={() => (isPhone ? onSelectTask(t.id) : setPicked(t.id))}
                        onDoubleClick={() => onSelectTask(t.id)}
                      >
                        <td title={t.name}>{t.name}</td>
                        <td>{statusOf(t)}</td>
                        <td>{rt?.lastRunAt ? fmtClock(rt.lastRunAt, now) : 'Never'}</td>
                        <td>{rt?.lastResult ? resultLabel(rt.lastResult) : 'None'}</td>
                        <td title={rt?.lastDetail ?? undefined}>{rt?.lastDetail ?? ''}</td>
                      </tr>
                    );
                  })}
                  {mine.length === 0 && (
                    <tr>
                      <td colSpan={TASK_COLS.length} className="muted">
                        No tasks run in this project.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === 'sessions' && (
          <RunLog taskId={standIn} records={records} runtime={undefined} hideNoAction={false} hideChatsAndTerminals={false} />
        )}
        {tab === 'git' && <GitView projectId={project.id} watch={git} narrow={isPhone} />}
      </section>
    </div>
  );
}
