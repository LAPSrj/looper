import { useEffect, useState } from 'react';
import type { TaskRuntime } from '@shared/types';
import { MessagesView } from './components/Messages';
import { subscribe } from './events';

/** A conversation in its own window: a run's messages, or a subagent's (agentId set). */
export function MessagesApp({ taskId, runId, agentId, title }: { taskId: string; runId: string; agentId?: string; title: string }) {
  const [runtime, setRuntime] = useState<TaskRuntime | null>(null);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    void window.looper.runtime.list().then((list) => setRuntime(list.find((r) => r.taskId === taskId) ?? null));
    return subscribe((e) => {
      if (e.type === 'runtime' && e.runtime.taskId === taskId) setRuntime(e.runtime);
    });
  }, [taskId]);

  const running =
    (runtime?.state === 'running' || runtime?.state === 'classifying') && runtime.currentRunId === runId;
  return (
    <div className="messages-app">
      <MessagesView taskId={taskId} runId={runId} agentId={agentId} running={running} />
    </div>
  );
}
