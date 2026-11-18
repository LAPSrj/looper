import { useEffect, useState } from 'react';
import { windowTitle } from '@shared/window-title';
import { Field, FormGroup, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useSave } from './components/hooks';

/**
 * Guidance window for one run. Continue mode (run context menu → Continue
 * with Guidance…): the text becomes the whole prompt of a new run that resumes
 * the finished run's conversation; check and classifier never run. Send mode
 * (→ Send Guidance…): the text goes to the run in flight, whose agent gets it
 * mid-run.
 */
export function ContinueRunApp({ taskId, runId, mode }: { taskId: string; runId: string; mode: 'continue' | 'send' }) {
  const [text, setText] = useState('');
  const saver = useSave();
  const name = mode === 'send' ? 'Send Guidance' : 'Continue Run';

  useEffect(() => {
    document.title = `${name} ${runId}`;
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (t) document.title = windowTitle(name, t.name);
    });
  }, [taskId, runId, name]);

  const start = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    saver.save(async () => {
      if (mode === 'send') await window.looper.sendGuidance(taskId, runId, trimmed);
      else await window.looper.continueRun(taskId, runId, trimmed);
    });
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form fill">
          <FormGroup>
            <Field label="Guidance">
              <TextArea autoFocus rows={10} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: mode === 'send' ? 'Send' : 'Continue', run: start, disabled: !text.trim() }} busy={saver.busy} />
    </div>
  );
}
