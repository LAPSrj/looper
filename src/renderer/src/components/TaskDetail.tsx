import type { ReactNode } from 'react';
import type { RunFilter } from '@shared/runs';
import type { Environment, Project, RunRecord, Task, TaskRuntime } from '@shared/types';
import { watcherOf } from '@shared/types';
import { describeEnvironment, effortLabel, harnessKindLabel, harnessModels, resolveEffort, withKind } from '@shared/environments';
import { describeCron, describeRunWindow, nextWindowOpen } from '@shared/cron';
import { capFirst, fmtClock, fmtCountdown, fmtDate, fmtDateTime, resultLabel, stateLabel } from '../format';
import { tickFor, useNow } from '../useNow';
import { DetailStatus, DetailView } from './DetailView';
import { RunLog } from './RunLog';

export type DetailTab = 'status' | 'runs';

/** A task's tabs, in order (Ctrl+Tab steps through them). */
export const TASK_TABS: readonly (readonly [DetailTab, string])[] = [
  ['status', 'Status'],
  ['runs', 'Runs'],
];

interface Props {
  task: Task;
  project: Project | undefined;
  environments: Environment[];
  runtime: TaskRuntime | undefined;
  records: RunRecord[];
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  /** View → Task Runs: the runs the Runs tab leaves out (unset before the settings come: none). */
  runFilter?: RunFilter;
  /** Run to select in the run log (notification click). */
  focusRun?: { runId: string } | null;
  /** The task's own window, whose title bar already names it. */
  untitled?: boolean;
}

function describeTrigger(task: Task): string {
  if (task.trigger.mode === 'manual') return 'Manual';
  if (task.trigger.mode === 'watcher') {
    const w = task.trigger.watcher;
    const within = w ? describeRunWindow(w) : '';
    return `On events${within}${within && w?.timezone ? ` (${w.timezone})` : ''}`;
  }
  const schedule = task.trigger.schedule;
  if (!schedule) return 'Not configured';
  const tz = schedule.timezone ? ` (${schedule.timezone})` : '';
  return describeCron(schedule.cron) + tz;
}

/** The watcher process's own state, shown while it is up instead of "Idle". */
function watcherLabel(runtime: TaskRuntime | undefined): string {
  return runtime?.watcher === 'watching' ? 'Watching' : 'Watcher restarting';
}

function statusDetail(runtime: TaskRuntime | undefined): string {
  if (!runtime) return '';
  if (runtime.asking) return 'The agent is waiting for your answer in the run window';
  if (runtime.held) return 'The agent is waiting for your guidance in the run window';
  if (runtime.runs.length > 1) return `${runtime.runs.length} runs active`;
  switch (runtime.state) {
    case 'running':
      return runtime.currentRunId ? `Run ${runtime.currentRunId}` : '';
    case 'paused':
      return capFirst(runtime.pausedReason ?? '');
    default:
      return '';
  }
}

/** The next run's time and the countdown to it, which ticks (each second below an hour, then each minute). */
function NextAt({ at }: { at: number }): ReactNode {
  const left = at - Date.now();
  const now = useNow(left > 0 ? tickFor(left) : null);
  const countdown = fmtCountdown(at, now);
  if (countdown === 'now') return 'Now';
  // The countdown only means something live: a phone showing what it kept greys it out.
  return (
    <>
      {fmtClock(at, now)} <span className="live-only">(in {countdown})</span>
    </>
  );
}

function NextRun({ runtime }: { runtime: TaskRuntime | undefined }): ReactNode {
  if (!runtime || runtime.nextRunAt === null) return 'Not scheduled';
  return <NextAt at={runtime.nextRunAt} />;
}

/** The watcher is down (outside its run window): when watching is scheduled to resume. */
function NextWatch({ task, runtime }: { task: Task; runtime: TaskRuntime | undefined }): ReactNode {
  const watcher = watcherOf(task);
  if (!watcher || runtime?.state !== 'idle') return 'Not scheduled';
  const at = nextWindowOpen(watcher, Date.now());
  return at === null ? 'Not scheduled' : <NextAt at={at} />;
}

export function TaskDetail({
  task,
  project,
  environments,
  runtime,
  records,
  tab,
  onTab,
  runFilter,
  focusRun,
  untitled = false,
}: Props) {
  const env = environments.find((e) => e.id === task.environmentId);
  // As a run resolves it (resolveHarness): the environment's first only when the task names none.
  const harness = env ? (task.agent.harnessId ? env.harnesses.find((h) => h.id === task.agent.harnessId) : env.harnesses[0]) : undefined;
  // What a run will actually emit: the task's pin, or the model's default.
  const resolvedEffort = harness ? resolveEffort(task.agent, harness) : task.agent.effort;
  const effort = resolvedEffort ? effortLabel(harness?.kind, resolvedEffort) : null;

  const lastRun = runtime?.lastRunAt ? fmtClock(runtime.lastRunAt, Date.now()) : 'Never';
  const detail = statusDetail(runtime);
  // An idle watcher task with its watcher up is watching, not idle; with the
  // watcher down (outside its run window) it reads Idle like a scheduled task.
  const idleLabel =
    task.trigger.mode === 'watcher' && runtime?.state === 'idle' && runtime.watcher
      ? watcherLabel(runtime)
      : stateLabel(runtime);
  const status = runtime?.state === 'paused' && detail
    ? detail
    : `${idleLabel}${detail ? ` (${detail})` : ''}`;

  return (
    <DetailView title={task.name} untitled={untitled} tabs={{ items: TASK_TABS, active: tab, onSelect: onTab }}>
      {tab === 'status' && (
        <DetailStatus
          items={[
            { label: 'Status', value: status },
            !!task.completedAt && { label: 'Completed', value: `${fmtDate(task.completedAt)}${task.completedReason ? ` — ${task.completedReason}` : ''}` },
            { label: 'Trigger', value: describeTrigger(task) },
            task.trigger.mode === 'watcher' && { label: 'Watcher command', value: task.trigger.watcher?.command ?? 'None', className: 'mono' },
            {
              label: 'Next run',
              value: task.completedAt ? (
                'Never: the task is completed'
              ) : task.trigger.mode === 'schedule' ? (
                <NextRun runtime={runtime} />
              ) : task.trigger.mode === 'watcher' ? (
                runtime?.watcher === 'watching' ? (
                  'When the watcher fires'
                ) : runtime?.watcher === 'restarting' ? (
                  'Watcher restarting'
                ) : (
                  <NextWatch task={task} runtime={runtime} />
                )
              ) : (
                'When triggered manually'
              ),
            },
            !task.completedAt && task.trigger.mode !== 'manual' && !!task.trigger.stopOn?.enabled && { label: 'Stops running on', value: fmtDateTime(task.trigger.stopOn.at) },
            !!task.note && { label: 'Next run guidance', value: `${task.note.text}${task.note.runsLeft > 1 ? ` (next ${task.note.runsLeft} runs)` : ''}` },
            { label: 'Last run', value: lastRun },
            { label: 'Last run result', value: runtime?.lastResult ? resultLabel(runtime.lastResult) : 'None' },
            { label: 'Last run details', value: runtime?.lastDetail ? capFirst(runtime.lastDetail) : 'None' },
            { label: 'Check command', value: task.check?.enabled ? task.check.command : 'None (always runs)', className: task.check?.enabled ? 'mono' : '' },
            { label: 'Classifier', value: task.classifier?.enabled ? 'Yes' : 'No' },
            {
              label: 'Harness',
              value: harness ? (
                withKind(harness.name, harnessKindLabel(harness.kind))
              ) : env && task.agent.harnessId ? (
                <span className="warn">Unknown harness "{task.agent.harnessId}"</span>
              ) : (
                'None'
              ),
            },
            {
              label: 'Model',
              value: `${task.agent.model ? (harness ? (harnessModels(harness).find((m) => m.id === task.agent.model)?.name ?? task.agent.model) : task.agent.model) : 'Default'}${effort ? `, ${effort.toLowerCase()} effort` : ''}`,
            },
            { label: 'Session type', value: capFirst(task.agent.mode) },
            { label: 'Project', value: project?.name ?? task.projectId ?? 'None' },
            {
              label: 'Environment',
              value: env ? withKind(env.name, describeEnvironment(env)) : <span className="warn">Unknown environment "{task.environmentId}"</span>,
            },
            { label: 'Working directory', value: task.cwd, className: 'mono' },
          ]}
        />
      )}
      {tab === 'runs' && (
        <RunLog records={records} runtime={runtime} filter={runFilter} focusRun={focusRun} />
      )}
    </DetailView>
  );
}
