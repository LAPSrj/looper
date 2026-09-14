import type { Environment, RunRecord, Task, TaskRuntime } from '@shared/types';
import { describeEnvironment, harnessKindLabel, harnessModels } from '@shared/environments';
import { cronToForm } from '@shared/cron';
import { capFirst, fmtCountdown, fmtDate, fmtDateTime, fmtTime, resultLabel, stateLabel } from '../format';
import { Messages } from './Messages';
import { RunLog } from './RunLog';
import { Terminal } from './Terminal';
import { TabBar } from './ui';

export type DetailTab = 'status' | 'log' | 'messages' | 'terminal';

const TABS: [DetailTab, string][] = [
  ['status', 'Status'],
  ['log', 'Run log'],
  ['messages', 'Messages'],
  ['terminal', 'Terminal'],
];

interface Props {
  task: Task;
  environments: Environment[];
  runtime: TaskRuntime | undefined;
  records: RunRecord[];
  now: number;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  hideNoActionRuns: boolean;
  /** Run to select in the run log (notification click). */
  focusRun?: { runId: string } | null;
  /** The run the Terminal tab is pinned to when several are in flight (null = the newest). */
  terminalRun: string | null;
  onTerminalRun: (runId: string | null) => void;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function fmtDays(days: number[]): string {
  const d = [...days].sort((a, b) => a - b);
  const contiguous = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return contiguous ? `${DAY_NAMES[d[0]]} to ${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ');
}

function describeTrigger(task: Task): string {
  if (task.trigger.mode === 'manual') return 'Manual';
  if (task.trigger.mode === 'watcher') return 'On events';
  const schedule = task.trigger.schedule;
  if (!schedule) return 'Not configured';
  const tz = schedule.timezone ? ` (${schedule.timezone})` : '';
  return describeCron(schedule.cron) + tz;
}

/** The watcher process's own state, shown wherever an idle watcher task would otherwise read "Idle". */
function watcherLabel(runtime: TaskRuntime | undefined): string {
  return runtime?.watcher === 'watching'
    ? 'Watching'
    : runtime?.watcher === 'restarting'
      ? 'Watcher restarting'
      : 'Watcher stopped';
}

function describeCron(cron: string): string {
  const f = cronToForm(cron);
  switch (f.mode) {
    case 'minutes':
    case 'hours': {
      const base =
        f.mode === 'minutes'
          ? f.step === 1
            ? 'Every minute'
            : `Every ${f.step} minutes`
          : (f.step === 1 ? 'Hourly' : `Every ${f.step} hours`) +
            (f.minute ? ` at :${String(f.minute).padStart(2, '0')}` : '');
      const win = f.from !== undefined && f.to !== undefined ? `, from ${f.from}h to ${f.to}h` : '';
      return base + win + (f.days ? `, ${fmtDays(f.days)}` : '');
    }
    case 'daily':
      return `Daily at ${f.times.map((t) => hhmm(t.hour, t.minute)).join(', ')}`;
    case 'weekly':
      return `${fmtDays(f.days)} at ${hhmm(f.hour, f.minute)}`;
    case 'monthly':
      return `Monthly on day${f.days.length === 1 ? '' : 's'} ${[...f.days].sort((a, b) => a - b).join(', ')} at ${hhmm(f.hour, f.minute)}`;
    case 'custom':
      return `Cron ${f.cron}`;
  }
}

function statusDetail(runtime: TaskRuntime | undefined): string {
  if (!runtime) return '';
  if (runtime.held) return 'The agent is waiting for you in the Terminal tab';
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

function describeNextRun(runtime: TaskRuntime | undefined, now: number): string {
  if (!runtime || runtime.nextRunAt === null) return 'Not scheduled';
  const countdown = fmtCountdown(runtime.nextRunAt, now);
  const at = fmtTime(new Date(runtime.nextRunAt).toISOString());
  return countdown === 'now' ? 'Now' : `${at} (in ${countdown})`;
}

export function TaskDetail({ task, environments, runtime, records, now, tab, onTab, hideNoActionRuns, focusRun, terminalRun, onTerminalRun }: Props) {
  const env = environments.find((e) => e.id === task.environmentId);
  const harness = env ? (env.harnesses.find((h) => h.id === task.agent.harnessId) ?? env.harnesses[0]) : undefined;

  const lastRun = runtime?.lastRunAt ? fmtTime(new Date(runtime.lastRunAt).toISOString()) : 'Never';
  const detail = statusDetail(runtime);
  // An idle watcher task is not idle from the user's side: it is watching.
  const idleLabel =
    task.trigger.mode === 'watcher' && runtime?.state === 'idle' ? watcherLabel(runtime) : stateLabel(runtime);
  const status = runtime?.state === 'paused' && detail
    ? detail
    : `${idleLabel}${detail ? ` (${detail})` : ''}`;

  return (
    <div className="detail">
      <div className="detail-bar">
        <span className="pane-title">{task.name}</span>
      </div>
      <TabBar tabs={TABS} active={tab} onSelect={onTab} />
      <section className="tab-body">
        {tab === 'status' && (
          <div className="status-pane">
            <dl className="props">
              <dt>Status</dt>
              <dd>{status}</dd>
              {task.completedAt && (
                <>
                  <dt>Completed</dt>
                  <dd>
                    {fmtDate(task.completedAt)}
                    {task.completedReason ? ` — ${task.completedReason}` : ''}
                  </dd>
                </>
              )}
              <dt>Trigger</dt>
              <dd>{describeTrigger(task)}</dd>
              {task.trigger.mode === 'watcher' && (
                <>
                  <dt>Watcher command</dt>
                  <dd className="mono">{task.trigger.watcher?.command ?? 'None'}</dd>
                </>
              )}
              <dt>Next run</dt>
              <dd>
                {task.completedAt
                  ? 'Never: the task is completed'
                  : task.trigger.mode === 'schedule'
                    ? describeNextRun(runtime, now)
                    : task.trigger.mode === 'watcher'
                      ? runtime?.watcher === 'watching'
                        ? 'When the watcher fires'
                        : watcherLabel(runtime)
                      : 'When triggered manually'}
              </dd>
              {!task.completedAt && task.trigger.mode !== 'manual' && task.trigger.stopOn?.enabled && (
                <>
                  <dt>Stops running on</dt>
                  <dd>{fmtDateTime(task.trigger.stopOn.at)}</dd>
                </>
              )}
              {task.note && (
                <>
                  <dt>Next run guidance</dt>
                  <dd>
                    {task.note.text}
                    {task.note.runsLeft > 1 ? ` (next ${task.note.runsLeft} runs)` : ''}
                  </dd>
                </>
              )}
              <dt>Last run</dt>
              <dd>{lastRun}</dd>
              <dt>Last run result</dt>
              <dd>{runtime?.lastResult ? resultLabel(runtime.lastResult) : 'None'}</dd>
              <dt>Last run details</dt>
              <dd>{runtime?.lastDetail ? capFirst(runtime.lastDetail) : 'None'}</dd>
              <dt>Check command</dt>
              <dd className={task.check?.enabled ? 'mono' : ''}>{task.check?.enabled ? task.check.command : 'None (always runs)'}</dd>
              <dt>Classifier</dt>
              <dd>{task.classifier?.enabled ? 'Yes' : 'No'}</dd>
              <dt>Harness</dt>
              <dd>{harness ? `${harness.name} (${harnessKindLabel(harness.kind)})` : 'None'}</dd>
              <dt>Model</dt>
              <dd>{task.agent.model ? (harness ? harnessModels(harness).find((m) => m.id === task.agent.model)?.name ?? task.agent.model : task.agent.model) : 'Default'}</dd>
              <dt>Session type</dt>
              <dd>{capFirst(task.agent.mode)}</dd>
              <dt>Environment</dt>
              <dd>
                {env ? (
                  `${env.name} (${describeEnvironment(env)})`
                ) : (
                  <span className="warn">Unknown environment "{task.environmentId}"</span>
                )}
              </dd>
              <dt>Working directory</dt>
              <dd className="mono">{task.cwd}</dd>
            </dl>
          </div>
        )}
        {tab === 'log' && <RunLog task={task} records={records} hideNoAction={hideNoActionRuns} focusRun={focusRun} />}
        {tab === 'messages' && <Messages task={task} records={records} runtime={runtime} />}
        {tab === 'terminal' && (
          <Terminal taskId={task.id} runtime={runtime} selectedRun={terminalRun} onSelectRun={onTerminalRun} />
        )}
      </section>
    </div>
  );
}
