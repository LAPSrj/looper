import { useEffect, useRef, useState } from 'react';
import { Field, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

/**
 * Continue-run window (run context menu → Continue with Guidance…). The text
 * becomes the whole prompt of a new run that resumes the finished run's
 * conversation; check and classifier never run.
 */
export function ContinueRunApp({ taskId, runId }: { taskId: string; runId: string }) {
  const [text, setText] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.title = `Continue Run ${runId}`;
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (t) document.title = `${t.name} – Continue Run`;
    });
  }, [taskId, runId]);

  const startRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void startRef.current(), onCancel: () => window.close() });

  const start = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      void window.looper.showError('Enter the guidance to continue the run with.');
      return;
    }
    setStarting(true);
    try {
      await window.looper.continueRun(taskId, runId, trimmed);
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  startRef.current = start;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Guidance">
            <textarea autoFocus rows={10} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      </div>
      <EditorFooter primaryLabel="Continue" onPrimary={() => void start()} onCancel={() => window.close()} saving={starting} />
    </div>
  );
}
