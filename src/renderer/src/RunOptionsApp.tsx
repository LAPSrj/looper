import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { useDialogKeys } from './components/hooks';
import { EditorFooter } from './components/ui';

/**
 * Standalone "Run Now" options window: lets the user skip any step of the
 * task's flow (check, classifier, agent) before a manual run starts. Shown
 * only when Settings → Advanced → "Show run options before manually running
 * a task" is on.
 */
export function RunOptionsApp({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  const [check, setCheck] = useState(true);
  const [classifier, setClassifier] = useState(true);
  const [agent, setAgent] = useState(true);

  useEffect(() => {
    document.title = 'Run Options';
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        setMissing(true);
        return;
      }
      setTask(t);
    });
    return window.looper.onEvent((e) => {
      if (e.type !== 'tasks') return;
      const t = e.tasks.find((x) => x.id === taskId);
      if (t) setTask(t);
      else setMissing(true);
    });
  }, [taskId]);

  // Only steps this task actually has count: a hidden checkbox stays true but selects nothing.
  const nothingSelected =
    !(task?.check?.enabled && check) && !(task?.classifier?.enabled && classifier) && !agent;
  const run = () => {
    if (nothingSelected) return;
    void window.looper.applyRunOptions({ check, classifier, agent });
  };
  useDialogKeys({ onSave: run, onCancel: () => window.close() });

  if (missing) return <div className="empty">This task no longer exists.</div>;
  if (!task) return <div className="empty">Loading…</div>;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          {task.check?.enabled && (
            <label className="checkbox-field">
              <input type="checkbox" checked={check} onChange={(e) => setCheck(e.target.checked)} />
              Check
            </label>
          )}
          {task.classifier?.enabled && (
            <label className="checkbox-field">
              <input type="checkbox" checked={classifier} onChange={(e) => setClassifier(e.target.checked)} />
              Classifier
            </label>
          )}
          <label className="checkbox-field">
            <input type="checkbox" checked={agent} onChange={(e) => setAgent(e.target.checked)} />
            Agent
          </label>
        </div>
      </div>
      <EditorFooter primaryLabel="Run" onPrimary={run} onCancel={() => window.close()} primaryDisabled={nothingSelected} />
    </div>
  );
}
