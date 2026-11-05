import { useEffect, useState } from 'react';
import { Field, FormGroup, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * Guidance window for one run. Continue mode (run context menu → Continue
 * with Guidance…): the text becomes the whole prompt of a new run that resumes
 * the finished run's conversation; check and classifier never run. Send mode
 * (→ Send Guidance…): the text goes to the run in flight, whose agent gets it
 * mid-run.
 */
export function ContinueRunApp({ taskId, runId, mode }: { taskId: string; runId: string; mode: 'continue' | 'send' }) {
  const [text, setText] = useState('');
  const [starting, setStarting] = useState(false);
  const name = mode === 'send' ? 'Send Guidance' : 'Continue Run';

  useEffect(() => {
    document.title = `${name} ${runId}`;
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (t) document.title = `${t.name} – ${name}`;
    });
  }, [taskId, runId, name]);

  const start = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setStarting(true);
    try {
      if (mode === 'send') await window.looper.sendGuidance(taskId, runId, trimmed);
      else await window.looper.continueRun(taskId, runId, trimmed);
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
    } finally {
      setStarting(false);
    }
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
      <WindowActions confirm={{ label: mode === 'send' ? 'Send' : 'Continue', run: () => void start(), disabled: !text.trim() }} busy={starting} />
    </div>
  );
}
