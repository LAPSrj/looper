import { useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/types';
import { Field, NumberField, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

/**
 * Standalone next-run guidance window (Task → Add/Edit Guidance for Next Run).
 * Saving an empty text clears the note.
 */
export function NoteEditorApp({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [text, setText] = useState('');
  const [runsLeft, setRunsLeft] = useState(1);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Guidance for Next Run';
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        setMissing(true);
        return;
      }
      setTask(t);
      setText(t.note?.text ?? '');
      setRunsLeft(t.note?.runsLeft ?? 1);
      document.title = `${t.name} – Guidance`;
    });
    // Keep the draft; only track the task itself (rename, deletion).
    return window.looper.onEvent((e) => {
      if (e.type !== 'tasks') return;
      const t = e.tasks.find((x) => x.id === taskId);
      if (t) setTask(t);
      else setMissing(true);
    });
  }, [taskId]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This task no longer exists.</div>;
  if (!task) return <div className="empty">Loading…</div>;

  const doSave = async (): Promise<boolean> => {
    const trimmed = text.trim();
    if (trimmed && (!Number.isInteger(runsLeft) || runsLeft < 1)) {
      void window.looper.showError('Applies to next: must be a whole number of runs, at least 1.');
      return false;
    }
    setSaving(true);
    try {
      await window.looper.tasks.save({ ...task, note: trimmed ? { text: trimmed, runsLeft } : undefined });
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => { if (await doSave()) window.close(); };
  saveRef.current = save;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Guidance">
            <textarea autoFocus rows={7} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <NumberField
            label="Applies to next"
            suffix="runs"
            min={1}
            value={runsLeft}
            onChange={setRunsLeft}
          />
        </div>
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} saving={saving} />
    </div>
  );
}
