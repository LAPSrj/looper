import { useEffect, useState } from 'react';
import type { TaskRuntime } from '@shared/types';
import { MessagesView } from './components/Messages';
import { RunGuidance } from './components/Transcript';
import { subscribe } from './events';
import { taskNameOf } from './phone-lists';

/**
 * A conversation in its own window: a run's records and its conversation, or
 * a subagent's conversation (agentId set). While the run's agent is going, a
 * box at the bottom sends the agent guidance, or the answer to the question
 * it is waiting on; a subagent's window has none, since guidance goes to the
 * main session.
 */
export function MessagesApp({
  taskId,
  runId,
  agentId,
  title,
  focusReport,
}: {
  taskId: string;
  runId: string;
  agentId?: string;
  title: string;
  /** Opened from a warning/error toast: select the report row. */
  focusReport?: boolean;
}) {
  const [runtime, setRuntime] = useState<TaskRuntime | null>(null);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    void window.looper.runtime.list().then((list) => setRuntime(list.find((r) => r.taskId === taskId) ?? null));
    return subscribe((e) => {
      if (e.type === 'runtime' && e.runtime.taskId === taskId) setRuntime(e.runtime);
    });
  }, [taskId]);

  // The window's title is "<task> – <run id>"; a phone's bar names the task only (the run is the screen's content).
  const phoneTitle = agentId ? title : taskNameOf(title, runId);

  const run = runtime?.runs.find((r) => r.runId === runId);
  const running = run?.state === 'running' || run?.state === 'classifying';
  const agentRunning = run?.state === 'running';

  return (
    <div className="messages-app">
      <MessagesView
        taskId={taskId}
        runId={runId}
        agentId={agentId}
        running={running}
        refreshKey={sent}
        focusReport={focusReport}
        phoneTitle={phoneTitle}
      />
      {!agentId && agentRunning && (
        <RunGuidance taskId={taskId} runId={runId} question={run?.question ?? null} recheck={run?.state} onSent={() => setSent((n) => n + 1)} />
      )}
    </div>
  );
}
