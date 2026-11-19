import { useMemo, useState } from 'react';
import type { RemoteState } from '@shared/remote';
import type { Environment, Project, RunRecord, Task, TaskRuntime } from '@shared/types';
import { describeEnvironment, effortLabel, harnessKindLabel, harnessModels, permissionLabel, withKind } from '@shared/environments';
import { projectTaskId } from '@shared/projects';
import { isSessionRun } from '@shared/runs';
import { envToLine, joinTokens } from '@shared/cmdline';
import { fmtClock, resultLabel, stateLabel } from '../format';
import { resultTone } from '../phone-lists';
import { gitTabLabel } from '@shared/git';
import { DataTable, type DataCol } from './DataTable';
import { GitView, useGitStatus } from './GitView';
import { AddonProjectTabView, useAddonProjectTabs, type AddonProjectTabId } from './AddonProjectTabs';
import { DetailStatus, DetailView } from './DetailView';
import { useDialogKeys, useGitRepo } from './hooks';
import { useSessionsState } from '../live-state';
import { RunLog } from './RunLog';
import { useRunRecords } from '../useRunRecords';

type ProjectTab = 'status' | 'tasks' | 'sessions' | 'git' | AddonProjectTabId;

/** A project's tabs, in order (Ctrl+Tab steps through them), before Git, which a project in a repository adds, and the started addons' project tabs. */
export const PROJECT_TABS: readonly (readonly [ProjectTab, string])[] = [
  ['status', 'Status'],
  ['tasks', 'Tasks'],
  ['sessions', 'Chats'],
];

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
  const addonTabs = useAddonProjectTabs(project.id);
  const addonTab = addonTabs.find((t) => t.id === shownTab);
  // A tab that went (the folder stopped being a repository, the addon stopped or hid its tab) leaves the Status tab showing.
  const tab = (shownTab === 'git' && !gitRepo) || (shownTab.startsWith('addon:') && !addonTab) ? 'status' : shownTab;
  const sessions = useSessionsState();
  const git = useGitStatus(gitRepo ? project.id : undefined, !!sessions?.sessions.some((s) => s.projectId === project.id && s.status === 'working'));
  const [picked, setPicked] = useState<string | null>(null);
  const standIn = projectTaskId(project.id);
  const mine = tasks.filter((t) => t.projectId === project.id);
  // The Chats tab lists the project's own sessions and the ones that went on from its tasks' runs.
  const idKey = [standIn, ...mine.map((t) => t.id)].join('\n');
  const ids = useMemo(() => idKey.split('\n'), [idKey]);
  const { records: byTask } = useRunRecords(ids);
  const records = useMemo(() => ids.flatMap((id) => (byTask[id] ?? []).filter((r: RunRecord) => id === standIn || isSessionRun(r))), [ids, byTask, standIn]);

  const tabs: (readonly [ProjectTab, string])[] = [
    ...PROJECT_TABS,
    ...(gitRepo ? [['git', gitTabLabel(git.status?.repo ? git.status.changes : undefined)] as const] : []),
    ...addonTabs.map((t) => [t.id, t.title] as const),
  ];
  // Ctrl+Tab and Ctrl+PageUp/PageDown step through the tabs, as they do a task's.
  useDialogKeys<ProjectTab>({ tabs: tabs.map(([id]) => id), tab, onTab: setTab });

  const env = environments.find((e) => e.id === project.environmentId);
  const harness = env ? (project.harnessId ? env.harnesses.find((h) => h.id === project.harnessId) : env.harnesses[0]) : undefined;
  const kind = harness && harness.kind !== 'custom' ? harness.kind : undefined;
  const model = project.model ? (harness ? harnessModels(harness).find((m) => m.id === project.model)?.name : undefined) ?? project.model : 'Default';
  const effort = project.effort ? effortLabel(kind, project.effort) : project.effort;
  const mode = permissionLabel(kind, project.permissionMode);
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
    <DetailView title={project.name} untitled={untitled} tabs={{ items: tabs, active: tab, onSelect: setTab }}>
      {tab === 'status' && (
        <DetailStatus
          items={[
            { label: 'Working directory', value: project.cwd, className: 'mono' },
            { label: 'Environment', value: env ? withKind(env.name, describeEnvironment(env)) : <span className="warn">Unknown environment "{project.environmentId}"</span> },
            { label: 'Harness', value: harness ? withKind(harness.name, harnessKindLabel(harness.kind)) : 'None' },
            {
              label: 'Model',
              value: (
                <>
                  {model}
                  {effort ? `, ${effort.toLowerCase()} effort` : ''}
                </>
              ),
            },
            { label: 'Session type', value: project.mode === 'headless' ? 'Headless' : 'Interactive' },
            { label: 'Permission mode', value: mode || 'None' },
            { label: 'Extra command-line arguments', value: project.extraArgs.length ? joinTokens(project.extraArgs) : 'None', className: project.extraArgs.length ? 'mono' : undefined },
            { label: 'Extra environment variables', value: Object.keys(project.env).length ? envToLine(project.env) : 'None', className: Object.keys(project.env).length ? 'mono' : undefined },
            { label: 'Remote Control', value: remoteText },
          ]}
        />
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
      {addonTab && tab === addonTab.id && <AddonProjectTabView shown={addonTab} projectId={project.id} />}
    </DetailView>
  );
}
