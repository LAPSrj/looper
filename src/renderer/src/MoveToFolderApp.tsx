import { useEffect, useState } from 'react';
import type { Task, TaskFolder } from '@shared/types';
import { SelectList } from './components/SelectList';
import { EmptyWindow, Field, FormGroup, InputRow, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { folderChoices } from './components/form-blocks';
import { subscribe } from './events';

/** Root pseudo-folder: moving here clears the task's folderId. */
const TOP_LEVEL = '';

/** Standalone move-to-folder window (Task → Move to Folder…). */
export function MoveToFolderApp({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [selected, setSelected] = useState<string>(TOP_LEVEL);
  const [newName, setNewName] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Move to Folder';
    void window.looper.tasks.list().then((tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        setMissing(true);
        return;
      }
      setTask(t);
      setSelected(t.folderId ?? TOP_LEVEL);
      document.title = `Move "${t.name}" to Folder`;
    });
    void window.looper.folders.list().then(setFolders);
    return subscribe((e) => {
      if (e.type === 'tasks') {
        const t = e.tasks.find((x) => x.id === taskId);
        if (t) setTask(t);
        else setMissing(true);
      } else if (e.type === 'folders') {
        setFolders(e.folders);
        setSelected((s) => (s === TOP_LEVEL || e.folders.some((f) => f.id === s) ? s : TOP_LEVEL));
      }
    });
  }, [taskId]);

  const move = async () => {
    if (!task) return;
    setSaving(true);
    try {
      await window.looper.tasks.save({ ...task, folderId: selected || undefined });
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const folder = await window.looper.folders.add(name);
      setNewName('');
      setSelected(folder.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  if (missing) return <EmptyWindow gone="This task no longer exists." />;

  const items: { id: string; name: string }[] = [
    { id: TOP_LEVEL, name: 'Top level' },
    ...folderChoices(folders),
  ];

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="picker-body">
          <Field label="Folder">
            <SelectList
              items={items}
              label="Folders"
              idPrefix="fld"
              selectedKey={selected}
              itemKey={(f) => f.id}
              itemName={(f) => f.name}
              onSelect={(f) => setSelected(f.id)}
              onOpen={() => void move()}
              autoFocus
            />
          </Field>
          <FormGroup>
            <Field label="New folder">
              <InputRow>
                <TextInput
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      void createFolder();
                    }
                  }}
                />
                <button className="btn" disabled={!newName.trim()} onClick={() => void createFolder()}>
                  Create
                </button>
              </InputRow>
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Move', run: () => void move(), disabled: !task }} busy={saving} />
    </div>
  );
}
