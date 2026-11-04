import { useEffect, useRef, useState } from 'react';
import type { EngineEvent, TaskFolder } from '@shared/types';
import { EmptyWindow, Field } from './components/ui';
import { FolderOptions } from './components/form-blocks';
import { WindowActions } from './components/WindowActions';

/** The task list's folders or the Projects tab's: the calls and event each one's folders come with. */
const SCOPES = {
  tasks: {
    list: () => window.looper.folders.list(),
    add: (name: string, parentId?: string) => window.looper.folders.add(name, parentId),
    rename: (id: string, name: string) => window.looper.folders.rename(id, name),
    /** The folders an event carries, when it's about these. */
    foldersIn: (e: EngineEvent): TaskFolder[] | null => (e.type === 'folders' ? e.folders : null),
  },
  projects: {
    list: () => window.looper.projects.folders(),
    add: (name: string, parentId?: string) => window.looper.projects.addFolder(name, parentId),
    rename: (id: string, name: string) => window.looper.projects.renameFolder(id, name),
    foldersIn: (e: EngineEvent): TaskFolder[] | null => (e.type === 'project-folders' ? e.folders : null),
  },
} as const;

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
  scope?: keyof typeof SCOPES;
  folderId?: string;
  parentId?: string;
  moveProject?: string;
}) {
  const api = SCOPES[scope];
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [parent, setParent] = useState(parentId ?? '');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = folderId ? 'Rename Folder' : 'New Folder';
    if (!folderId) {
      void api.list().then(setFolders);
      return window.looper.onEvent((e) => {
        const list = api.foldersIn(e);
        if (!list) return;
        setFolders(list);
        // A deleted parent falls back to the top level.
        setParent((p) => (p && !list.some((x) => x.id === p) ? '' : p));
      });
    }
    void api.list().then((all) => {
      const f = all.find((x) => x.id === folderId);
      if (!f) {
        setMissing(true);
        return;
      }
      setName(f.name);
      setLoaded(true);
    });
    // Keep the draft; only track the folder itself (deletion).
    return window.looper.onEvent((e) => {
      const list = api.foldersIn(e);
      if (list && !list.some((x) => x.id === folderId)) setMissing(true);
    });
  }, [folderId, api]);

  // Renaming starts with the current name selected, so typing replaces it.
  useEffect(() => {
    if (loaded) nameRef.current?.select();
  }, [loaded]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (folderId) await api.rename(folderId, name);
      else {
        const folder = await api.add(name, parent || undefined);
        if (moveProject) {
          const projects = await window.looper.projects.list();
          await window.looper.projects.reorder(projects.map((p) => p.id), { [moveProject]: folder.id });
        }
      }
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };

  if (missing) return <EmptyWindow gone="This folder no longer exists." />;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Name">
            <input ref={nameRef} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!folderId && (
            <Field label="Parent folder">
              <select value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">Top level</option>
                <FolderOptions folders={folders} />
              </select>
            </Field>
          )}
        </div>
      </div>
      <WindowActions confirm={{ label: folderId ? 'Save' : 'Create', run: () => void save(), disabled: !name.trim() }} busy={saving} />
    </div>
  );
}
