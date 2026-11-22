import { useEffect, useState } from 'react';
import { harnessKindLabel } from '@shared/environments';
import type { Environment } from '@shared/types';
import { CheckboxField, EmptyWindow, Field, FormGroup, SelectInput, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { TASKS, useLiveItem, useSave } from './components/hooks';

/**
 * Standalone "Run Now" options window: lets the user skip any step of the
 * task's flow (check, classifier, agent), set the next-run guidance and pick
 * another harness of the task's environment for this run only before a
 * manual run starts. Shown
 * only when Settings → General → "Show run options before manually running
 * a task" is on.
 */
export function RunOptionsApp({ taskId }: { taskId: string }) {
  const [check, setCheck] = useState(true);
  const [classifier, setClassifier] = useState(true);
  const [agent, setAgent] = useState(true);
  const [guidance, setGuidance] = useState('');
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  /** The harness picked for this run; unset: the task's own. */
  const [harnessId, setHarnessId] = useState<string>();
  const saver = useSave();
  const { item: task, missing } = useLiveItem(TASKS, taskId, (t) => setGuidance(t.note?.text ?? ''));

  useEffect(() => {
    document.title = 'Run Options';
    void window.looper.info().then((i) => setEnvironments(i.settings.environments));
  }, []);

  // The task's environment's harnesses; its own (or the environment's first) is picked until another one is.
  const harnesses = environments?.find((e) => e.id === task?.environmentId)?.harnesses ?? [];
  const own = harnesses.find((h) => h.id === task?.agent.harnessId) ?? harnesses[0];
  const picked = harnesses.find((h) => h.id === harnessId) ?? own;
  const kinds = new Set(harnesses.map((h) => h.kind)).size > 1;

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
      () => window.looper.applyRunOptions({ check, classifier, agent, ...(picked && picked.id !== own?.id ? { harnessId: picked.id } : {}) }),
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
          {harnesses.length > 1 && (
            <FormGroup>
              <Field label="Harness">
                <SelectInput value={picked?.id ?? ''} disabled={!agent} onChange={(e) => setHarnessId(e.target.value)}>
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {kinds && !h.name.includes(harnessKindLabel(h.kind)) ? `${h.name} (${harnessKindLabel(h.kind)})` : h.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </FormGroup>
          )}
        </div>
      </div>
      <WindowActions confirm={{ label: 'Run', run, disabled: nothingSelected }} busy={saver.busy} />
    </div>
  );
}
