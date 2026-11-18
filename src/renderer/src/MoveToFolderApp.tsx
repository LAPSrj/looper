import { useEffect, useState } from 'react';
import { SelectList } from './components/SelectList';
import { EmptyWindow, Field, FormGroup, InputRow, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { folderChoices } from './components/form-blocks';
import { FOLDERS, TASKS, useLiveItem, useSave } from './components/hooks';
import { keptSelection } from './components/selection';
import { reportError } from './report-error';

/** Root pseudo-folder: moving here clears the task's folderId. */
const TOP_LEVEL = '';

/** Standalone move-to-folder window (Task → Move to Folder…). */
export function MoveToFolderApp({ taskId }: { taskId: string }) {
  const [chosen, setChosen] = useState<string>(TOP_LEVEL);
  const [newName, setNewName] = useState('');
  const saver = useSave();
  const { item: task, missing } = useLiveItem(TASKS, taskId, (t) => {
    setChosen(t.folderId ?? TOP_LEVEL);
    document.title = `Move "${t.name}" to Folder`;
  });
  const folders = useLiveItem(FOLDERS, undefined).items;

  useEffect(() => {
    document.title = 'Move to Folder';
  }, []);

  const items: { id: string; name: string }[] = [{ id: TOP_LEVEL, name: 'Top level' }, ...folderChoices(folders ?? [])];
  // A deleted folder falls back to the top level.
  const selected = folders ? (keptSelection(chosen, items, (f) => f.id) ?? TOP_LEVEL) : chosen;

  const move = () => {
    if (task) saver.save(() => window.looper.tasks.save({ ...task, folderId: selected || undefined }).then(() => true));
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const folder = await window.looper.folders.add(name);
      setNewName('');
      setChosen(folder.id);
    } catch (e) {
      reportError(e);
    }
  };

  if (missing) return <EmptyWindow gone="This task no longer exists." />;

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
              onSelect={(f) => setChosen(f.id)}
              onOpen={move}
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
      <WindowActions confirm={{ label: 'Move', run: move, disabled: !task }} busy={saver.busy} />
    </div>
  );
}
