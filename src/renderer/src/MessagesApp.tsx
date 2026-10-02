import { useEffect, useState } from 'react';
import type { TaskRuntime } from '@shared/types';
import { MessagesView } from './components/Messages';
import { subscribe } from './events';

/**
 * A conversation in its own window: a run's messages, or a subagent's
 * (agentId set). While the run's agent is going, a box under it sends the
 * agent guidance; a subagent's window has none, since guidance goes to the
 * main session.
 */
export function MessagesApp({ taskId, runId, agentId, title }: { taskId: string; runId: string; agentId?: string; title: string }) {
  const [runtime, setRuntime] = useState<TaskRuntime | null>(null);
  const [canGuide, setCanGuide] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [sending, setSending] = useState(false);
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

  const run = runtime?.runs.find((r) => r.runId === runId);
  const running = run?.state === 'running' || run?.state === 'classifying';
  const agentRunning = run?.state === 'running';

  useEffect(() => {
    if (agentId || !agentRunning) {
      setCanGuide(false);
      return;
    }
    void window.looper.canGuideRun(taskId, runId).then(setCanGuide);
  }, [taskId, runId, agentId, agentRunning]);

  const send = async () => {
    const text = guidance.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await window.looper.sendGuidance(taskId, runId, text);
      setGuidance('');
      setSent((n) => n + 1);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="messages-app">
      <MessagesView taskId={taskId} runId={runId} agentId={agentId} running={running} refreshKey={sent} />
      {canGuide && (
        <div className="guidance-compose">
          <textarea
            rows={3}
            placeholder="Guidance for the agent"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn primary" disabled={sending || !guidance.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
