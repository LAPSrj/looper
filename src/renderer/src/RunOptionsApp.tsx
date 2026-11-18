import { useEffect, useState } from 'react';
import { CheckboxField, EmptyWindow, Field, FormGroup, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { TASKS, useLiveItem, useSave } from './components/hooks';

/**
 * Standalone "Run Now" options window: lets the user skip any step of the
 * task's flow (check, classifier, agent) and set the next-run guidance
 * before a manual run starts. Shown
 * only when Settings → General → "Show run options before manually running
 * a task" is on.
 */
export function RunOptionsApp({ taskId }: { taskId: string }) {
  const [check, setCheck] = useState(true);
  const [classifier, setClassifier] = useState(true);
  const [agent, setAgent] = useState(true);
  const [guidance, setGuidance] = useState('');
  const saver = useSave();
  const { item: task, missing } = useLiveItem(TASKS, taskId, (t) => setGuidance(t.note?.text ?? ''));

  useEffect(() => {
    document.title = 'Run Options';
  }, []);

  // Only steps this task actually has count: a hidden checkbox stays true but selects nothing.
  const nothingSelected =
    !(task?.check?.enabled && check) && !(task?.classifier?.enabled && classifier) && !agent;
  const run = () => {
    if (!task || nothingSelected) return;
    saver.save(
      async () => {
        // The guidance is the task's next-run note: saved before the run starts so the run picks it up.
        const trimmed = guidance.trim();
        if (trimmed === (task.note?.text ?? '')) return;
        await window.looper.tasks.save({
          ...task,
          note: trimmed ? { text: trimmed, runsLeft: task.note?.runsLeft ?? 1 } : undefined,
        });
      },
      () => window.looper.applyRunOptions({ check, classifier, agent }),
    );
  };

  if (missing || !task) return <EmptyWindow gone={missing && 'This task no longer exists.'} />;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Guidance">
              <TextArea
                rows={5}
                style={{ resize: 'none' }}
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
              />
            </Field>
          </FormGroup>
          <FormGroup>
            {task.check?.enabled && <CheckboxField label="Check" autoFocus checked={check} onChange={setCheck} />}
            {task.classifier?.enabled && <CheckboxField label="Classifier" autoFocus={!task.check?.enabled} checked={classifier} onChange={setClassifier} />}
            <CheckboxField label="Agent" autoFocus={!task.check?.enabled && !task.classifier?.enabled} checked={agent} onChange={setAgent} />
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Run', run, disabled: nothingSelected }} busy={saver.busy} />
    </div>
  );
}
