import { useEffect, useState } from 'react';
import type { TaskFolder } from '@shared/types';
import { Field, FormGroup, SelectInput, TextInput } from './components/ui';
import { FolderOptions } from './components/form-blocks';
import { WindowActions } from './components/WindowActions';
import { RenameWindow } from './components/RenameWindow';
import { FOLDERS, useLiveItem, useSave, type ItemSource } from './components/hooks';

/** The task list's folders or the Projects tab's: the calls and event each one's folders come with. */
const SCOPES: Record<'tasks' | 'projects', ItemSource<TaskFolder> & { add: (name: string, parentId?: string) => Promise<TaskFolder>; rename: (id: string, name: string) => Promise<unknown> }> = {
  tasks: {
    ...FOLDERS,
    add: (name, parentId) => window.looper.folders.add(name, parentId),
    rename: (id, name) => window.looper.folders.rename(id, name),
  },
  projects: {
    list: () => window.looper.projects.folders(),
    from: (e) => (e.type === 'project-folders' ? e.folders : null),
    add: (name, parentId) => window.looper.projects.addFolder(name, parentId),
    rename: (id, name) => window.looper.projects.renameFolder(id, name),
  },
};

type Scope = keyof typeof SCOPES;

/**
 * Standalone folder-name window, for the task list's folders or the Projects
 * tab's (`scope`): New Folder (File menu, a list's or a folder's menu; New
 * Subfolder… presets the parent; `moveProject` goes into the new folder once
 * it's made) or, with a folderId, Rename Folder.
 */
export function FolderNameApp({
  scope = 'tasks',
  folderId,
  parentId,
  moveProject,
}: {
  scope?: Scope;
  folderId?: string;
  parentId?: string;
  moveProject?: string;
}) {
  const api = SCOPES[scope];
  if (folderId) {
    return (
      <RenameWindow
        title="Rename Folder"
        source={api}
        id={folderId}
        nameOf={(f) => f.name}
        rename={(name) => api.rename(folderId, name)}
        gone="This folder no longer exists."
      />
    );
  }
  return <NewFolder scope={scope} parentId={parentId} moveProject={moveProject} />;
}

function NewFolder({ scope, parentId, moveProject }: { scope: Scope; parentId?: string; moveProject?: string }) {
  const api = SCOPES[scope];
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState(parentId ?? '');
  const { items: folders } = useLiveItem(api, undefined);
  const saver = useSave();
  // A deleted parent falls back to the top level.
  const parent = chosen && folders && !folders.some((x) => x.id === chosen) ? '' : chosen;

  useEffect(() => {
    document.title = 'New Folder';
  }, []);

  const save = () => {
    if (!name.trim()) return;
    saver.save(async () => {
      const folder = await api.add(name, parent || undefined);
      if (moveProject) {
        const projects = await window.looper.projects.list();
        await window.looper.projects.reorder(projects.map((p) => p.id), { [moveProject]: folder.id });
      }
    });
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Name">
              <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Parent folder">
              <SelectInput value={parent} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Top level</option>
                <FolderOptions folders={folders ?? []} />
              </SelectInput>
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Create', run: save, disabled: !name.trim() }} busy={saver.busy} />
    </div>
  );
}
