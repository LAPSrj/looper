import { useState } from 'react';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { capFirst, fmtCountdown, fmtTime, stateLabel } from '../format';
import { RunLog } from './RunLog';
import { Terminal } from './Terminal';

export type DetailTab = 'log' | 'terminal';

interface Props {
  task: Task;
  runtime: TaskRuntime | undefined;
  records: RunRecord[];
  now: number;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
}

function describeSchedule(task: Task): string {
  return 'every' in task.schedule ? `Every ${task.schedule.every}` : `Cron ${task.schedule.cron}`;
}

function describeTarget(task: Task): string {
  if (task.target.kind === 'windows') return 'Windows (PowerShell)';
  return task.target.distro ? `WSL (${task.target.distro})` : 'WSL (default distro)';
}

function describeStatus(runtime: TaskRuntime | undefined, now: number): string {
  if (!runtime) return 'Idle';
  if (runtime.held) return 'Needs attention — the agent is waiting for you in the Terminal tab';
  switch (runtime.state) {
    case 'idle':
      return runtime.nextRunAt ? `Idle — next run in ${fmtCountdown(runtime.nextRunAt, now)}` : 'Idle';
    case 'running':
      return runtime.currentRunId ? `Running — run ${runtime.currentRunId}` : 'Running';
    case 'paused':
      return `Paused — ${runtime.pausedReason ?? 'paused'}`;
    default:
      return stateLabel(runtime);
  }
}

export function TaskDetail({ task, runtime, records, now, tab, onTab }: Props) {
  const [busy, setBusy] = useState(false);
  const active = runtime && ['checking', 'classifying', 'running'].includes(runtime.state);
  const running = runtime?.state === 'running';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (window.confirm(`Delete task "${task.name}"?`)) void act(() => window.looper.tasks.remove(task.id));
  };

  const lastRun = runtime?.lastRunAt
    ? `${fmtTime(new Date(runtime.lastRunAt).toISOString())}${runtime.lastResult ? ` — ${capFirst(runtime.lastResult)}` : ''}`
    : 'Never';

  return (
    <div className="detail">
      <header className="detail-header">
        <div className="detail-title">
          <h1>{task.name}</h1>
          <span className={`badge state-${runtime?.held ? 'held' : runtime?.state ?? 'idle'}`}>{stateLabel(runtime)}</span>
        </div>
        <div className="actions">
          <button className="btn" disabled={busy || active} onClick={() => act(() => window.looper.runtime.runNow(task.id))}>
            Run now
          </button>
          {runtime?.state === 'paused' ? (
            <button className="btn" disabled={busy} onClick={() => act(() => window.looper.runtime.resume(task.id))}>
              Resume
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy || runtime?.state === 'disabled'}
              onClick={() => act(() => window.looper.runtime.pause(task.id))}
              title={active ? 'Pauses after the current run finishes' : undefined}
            >
              Pause
            </button>
          )}
          <button className="btn danger" disabled={busy || !running} onClick={() => act(() => window.looper.runtime.stopAgent(task.id))}>
            Stop agent
          </button>
          <button className="btn" disabled={busy} onClick={() => void window.looper.openEditor(task.id)}>
            Edit…
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => window.looper.tasks.save({ ...task, enabled: !task.enabled }))}
          >
            {task.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
        <dl className="props">
          <dt>Status</dt>
          <dd>{describeStatus(runtime, now)}</dd>
          <dt>Schedule</dt>
          <dd>{describeSchedule(task)}</dd>
          <dt>Environment</dt>
          <dd>{describeTarget(task)}</dd>
          <dt>Working directory</dt>
          <dd className="mono">{task.cwd}</dd>
          <dt>Last run</dt>
          <dd>{lastRun}</dd>
          <dt>Task ID</dt>
          <dd className="mono">{task.id}</dd>
        </dl>
      </header>
      <nav className="tabs">
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => onTab('log')}>
          Run log
        </button>
        <button className={`tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => onTab('terminal')}>
          {running ? '● Terminal' : 'Terminal'}
        </button>
      </nav>
      <section className="tab-body">
        {tab === 'log' && <RunLog task={task} records={records} />}
        {tab === 'terminal' && <Terminal taskId={task.id} running={!!running} runtime={runtime} />}
      </section>
    </div>
  );
}
