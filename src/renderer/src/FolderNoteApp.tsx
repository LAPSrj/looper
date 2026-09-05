import { useEffect, useRef, useState } from 'react';
import type { Task, TaskFolder } from '@shared/types';
import { folderSubtree } from '@shared/folders';
import { Field, NumberField, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

/**
 * Next-run guidance for every task in a folder — nested folders included
 * (folder context menu → Add Guidance for Next Runs…). Saving replaces each
 * member task's note; saving an empty text clears them all.
 */
export function FolderNoteApp({ folderId }: { folderId: string }) {
  const [folder, setFolder] = useState<TaskFolder | null>(null);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allFolders, setAllFolders] = useState<TaskFolder[]>([]);
  const [text, setText] = useState('');
  const [runsLeft, setRunsLeft] = useState(1);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Guidance for Next Runs';
    void window.looper.folders.list().then((folders) => {
      setAllFolders(folders);
      const f = folders.find((x) => x.id === folderId);
      if (!f) {
        setMissing(true);
        return;
      }
      setFolder(f);
      document.title = `${f.name} – Guidance`;
    });
    void window.looper.tasks.list().then(setAllTasks);
    // Keep the draft; only track membership and the folder itself (rename, deletion).
    return window.looper.onEvent((e) => {
      if (e.type === 'tasks') setAllTasks(e.tasks);
      else if (e.type === 'folders') {
        setAllFolders(e.folders);
        const f = e.folders.find((x) => x.id === folderId);
        if (f) setFolder(f);
        else setMissing(true);
      }
    });
  }, [folderId]);

  const subtree = folderSubtree(allFolders, folderId);
  const tasks = allTasks.filter((t) => t.folderId && subtree.has(t.folderId));

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This folder no longer exists.</div>;
  if (!folder) return <div className="empty">Loading…</div>;
  if (tasks.length === 0) return <div className="empty">This folder has no tasks.</div>;

  const save = async () => {
    const trimmed = text.trim();
    if (trimmed && (!Number.isInteger(runsLeft) || runsLeft < 1)) {
      void window.looper.showError('Applies to next: must be a whole number of runs, at least 1.');
      return;
    }
    setSaving(true);
    try {
      for (const task of tasks) {
        await window.looper.tasks.save({ ...task, note: trimmed ? { text: trimmed, runsLeft } : undefined });
      }
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };
  saveRef.current = save;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label={`Guidance for ${tasks.length === 1 ? 'the 1 task' : `all ${tasks.length} tasks`} in "${folder.name}"`}>
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
