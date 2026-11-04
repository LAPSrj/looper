import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { CheckboxField, EmptyWindow, Field } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * Standalone "Run Now" options window: lets the user skip any step of the
 * task's flow (check, classifier, agent) and set the next-run guidance
 * before a manual run starts. Shown
 * only when Settings → General → "Show run options before manually running
 * a task" is on.
 */
export function RunOptionsApp({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  const [check, setCheck] = useState(true);
  const [classifier, setClassifier] = useState(true);
  const [agent, setAgent] = useState(true);
  const [guidance, setGuidance] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Run Options';
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        setMissing(true);
        return;
      }
      setTask(t);
      setGuidance(t.note?.text ?? '');
    });
    // Keep the guidance draft; only track the task itself (rename, deletion).
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
  const run = async () => {
    if (!task || nothingSelected || saving) return;
    // The guidance is the task's next-run note: saved before the run starts so the run picks it up.
    const trimmed = guidance.trim();
    if (trimmed !== (task.note?.text ?? '')) {
      setSaving(true);
      try {
        await window.looper.tasks.save({
          ...task,
          note: trimmed ? { text: trimmed, runsLeft: task.note?.runsLeft ?? 1 } : undefined,
        });
      } catch (e) {
        setSaving(false);
        void window.looper.showError((e as Error).message);
        return;
      }
    }
    window.looper.applyRunOptions({ check, classifier, agent });
  };

  if (missing || !task) return <EmptyWindow gone={missing && 'This task no longer exists.'} />;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Guidance">
            <textarea
              rows={5}
              style={{ resize: 'none' }}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
          </Field>
          {task.check?.enabled && <CheckboxField label="Check" autoFocus checked={check} onChange={setCheck} />}
          {task.classifier?.enabled && <CheckboxField label="Classifier" autoFocus={!task.check?.enabled} checked={classifier} onChange={setClassifier} />}
          <CheckboxField label="Agent" autoFocus={!task.check?.enabled && !task.classifier?.enabled} checked={agent} onChange={setAgent} />
        </div>
      </div>
      <WindowActions confirm={{ label: 'Run', run: () => void run(), disabled: nothingSelected }} busy={saving} />
    </div>
  );
}
