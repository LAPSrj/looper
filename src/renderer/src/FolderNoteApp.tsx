import { useEffect, useState } from 'react';
import type { Task, TaskFolder } from '@shared/types';
import { folderSubtree } from '@shared/folders';
import { EmptyWindow } from './components/ui';
import { GuidanceForm, guidanceNote } from './components/form-blocks';

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

  if (missing || !folder) return <EmptyWindow gone={missing && 'This folder no longer exists.'} />;
  if (tasks.length === 0) return <EmptyWindow gone="This folder has no tasks." />;

  const save = async () => {
    const next = guidanceNote(text, runsLeft);
    if ('problem' in next) {
      void window.looper.showError(next.problem);
      return;
    }
    setSaving(true);
    try {
      for (const task of tasks) {
        await window.looper.tasks.save({ ...task, note: next.note });
      }
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <GuidanceForm
      label={`Guidance for ${tasks.length === 1 ? 'the 1 task' : `all ${tasks.length} tasks`} in "${folder.name}"`}
      text={text}
      onText={setText}
      runsLeft={runsLeft}
      onRunsLeft={setRunsLeft}
      saving={saving}
      onSave={() => void save()}
    />
  );
}
