import { useEffect, useState } from 'react';
import { windowTitle } from '@shared/window-title';
import { EmptyWindow } from './components/ui';
import { GuidanceForm, guidanceNote } from './components/form-blocks';
import { TASKS, useLiveItem, useSave } from './components/hooks';

const TITLE = 'Guidance for Next Run';

/**
 * Standalone next-run guidance window (Task → Add/Edit Guidance for Next Run).
 * Saving an empty text clears the note.
 */
export function NoteEditorApp({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const [runsLeft, setRunsLeft] = useState(1);
  const saver = useSave();
  const { item: task, missing } = useLiveItem(TASKS, taskId, (t) => {
    setText(t.note?.text ?? '');
    setRunsLeft(t.note?.runsLeft ?? 1);
  });

  useEffect(() => {
    document.title = windowTitle(TITLE, task?.name);
  }, [task?.name]);

  if (missing || !task) return <EmptyWindow gone={missing && 'This task no longer exists.'} />;

  const save = () =>
    saver.save(async () => {
      const next = guidanceNote(text, runsLeft);
      if ('problem' in next) {
        void window.looper.showError(next.problem);
        return false;
      }
      await window.looper.tasks.save({ ...task, note: next.note });
    });

  return <GuidanceForm text={text} onText={setText} runsLeft={runsLeft} onRunsLeft={setRunsLeft} saving={saver.busy} onSave={save} />;
}
