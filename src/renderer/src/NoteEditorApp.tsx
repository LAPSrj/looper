import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { EmptyWindow } from './components/ui';
import { GuidanceForm, guidanceNote } from './components/form-blocks';
import { subscribe } from './events';

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
    return subscribe((e) => {
      if (e.type !== 'tasks') return;
      const t = e.tasks.find((x) => x.id === taskId);
      if (t) setTask(t);
      else setMissing(true);
    });
  }, [taskId]);

  if (missing || !task) return <EmptyWindow gone={missing && 'This task no longer exists.'} />;

  const doSave = async (): Promise<boolean> => {
    const next = guidanceNote(text, runsLeft);
    if ('problem' in next) {
      void window.looper.showError(next.problem);
      return false;
    }
    setSaving(true);
    try {
      await window.looper.tasks.save({ ...task, note: next.note });
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => { if (await doSave()) window.close(); };

  return <GuidanceForm text={text} onText={setText} runsLeft={runsLeft} onRunsLeft={setRunsLeft} saving={saving} onSave={() => void save()} />;
}
