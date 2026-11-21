import { useEffect, useState } from 'react';
import { folderSubtree } from '@shared/folders';
import { plural } from '@shared/format';
import { windowTitle } from '@shared/window-title';
import { EmptyWindow } from './components/ui';
import { guidanceNote } from '@shared/guidance';
import { GuidanceForm } from './components/form-blocks';
import { FOLDERS, TASKS, useLiveItem, useSave } from './components/hooks';

const TITLE = 'Guidance for Next Runs';

/**
 * Next-run guidance for every task in a folder — nested folders included
 * (folder context menu → Add Guidance for Next Runs…). Saving replaces each
 * member task's note; saving an empty text clears them all.
 */
export function FolderNoteApp({ folderId }: { folderId: string }) {
  const [text, setText] = useState('');
  const [runsLeft, setRunsLeft] = useState(1);
  const saver = useSave();
  // Keep the draft; only track membership and the folder itself (rename, deletion).
  const { item: folder, items: allFolders, missing } = useLiveItem(FOLDERS, folderId);
  const allTasks = useLiveItem(TASKS, undefined).items;

  useEffect(() => {
    document.title = windowTitle(TITLE, folder?.name);
  }, [folder?.name]);

  if (missing || !folder || !allFolders || !allTasks) return <EmptyWindow gone={missing && 'This folder no longer exists.'} />;
  const subtree = folderSubtree(allFolders, folderId);
  const tasks = allTasks.filter((t) => t.folderId && subtree.has(t.folderId));
  if (tasks.length === 0) return <EmptyWindow gone="This folder has no tasks." />;

  const save = () =>
    saver.save(async () => {
      const next = guidanceNote(text, runsLeft);
      if ('problem' in next) {
        void window.looper.showError(next.problem);
        return false;
      }
      for (const task of tasks) {
        await window.looper.tasks.save({ ...task, note: next.note });
      }
    });

  return (
    <GuidanceForm
      label={`Guidance for ${tasks.length === 1 ? 'the' : 'all'} ${plural(tasks.length, 'task')} in "${folder.name}"`}
      text={text}
      onText={setText}
      runsLeft={runsLeft}
      onRunsLeft={setRunsLeft}
      saving={saver.busy}
      onSave={save}
    />
  );
}
