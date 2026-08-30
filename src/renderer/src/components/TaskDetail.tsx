import { useState } from 'react';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { fmtCountdown, fmtTime, stateLabel } from '../format';
import { RunLog } from './RunLog';
import { Terminal } from './Terminal';
import { TaskEditor } from './TaskEditor';

export type DetailTab = 'log' | 'terminal' | 'edit';

interface Props {
  task: Task;
  runtime: TaskRuntime | undefined;
  records: RunRecord[];
  now: number;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
}

export function TaskDetail({ task, runtime, records, now, tab, onTab }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  return (
    <div className="detail">
      <header className="detail-header">
        <div className="detail-title">
          <h1>{task.name}</h1>
          <span className={`badge state-${runtime?.held ? 'held' : runtime?.state ?? 'idle'}`}>{stateLabel(runtime)}</span>
        </div>
        <div className="detail-meta">
          <span>
            <b>id</b> {task.id}
          </span>
          <span>
            <b>schedule</b> {'every' in task.schedule ? `every ${task.schedule.every}` : `cron ${task.schedule.cron}`}
          </span>
          <span>
            <b>target</b> {task.target.kind}
            {task.target.kind === 'wsl' && task.target.distro ? `:${task.target.distro}` : ''}
          </span>
          <span>
            <b>cwd</b> {task.cwd}
          </span>
          {runtime?.state === 'idle' && (
            <span>
              <b>next</b> {fmtCountdown(runtime.nextRunAt, now)}
            </span>
          )}
          {runtime?.lastRunAt && (
            <span>
              <b>last</b> {fmtTime(new Date(runtime.lastRunAt).toISOString())}
              {runtime.lastResult ? ` — ${runtime.lastResult}` : ''}
            </span>
          )}
          {runtime?.pausedReason && (
            <span className="warn">
              <b>paused</b> {runtime.pausedReason}
            </span>
          )}
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
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => window.looper.tasks.save({ ...task, enabled: !task.enabled }))}
          >
            {task.enabled ? 'Disable' : 'Enable'}
          </button>
          {confirmDelete ? (
            <>
              <button className="btn danger" disabled={busy} onClick={() => act(() => window.looper.tasks.remove(task.id))}>
                Confirm delete
              </button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      </header>
      <nav className="tabs">
        {(['log', 'terminal', 'edit'] as DetailTab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => onTab(t)}>
            {t === 'log' ? 'Run log' : t === 'terminal' ? (running ? '● Terminal' : 'Terminal') : 'Edit'}
          </button>
        ))}
      </nav>
      <section className="tab-body">
        {tab === 'log' && <RunLog task={task} records={records} />}
        {tab === 'terminal' && <Terminal taskId={task.id} running={!!running} runtime={runtime} />}
        {tab === 'edit' && <TaskEditor task={task} onSaved={() => onTab('log')} onCancel={() => onTab('log')} />}
      </section>
    </div>
  );
}
