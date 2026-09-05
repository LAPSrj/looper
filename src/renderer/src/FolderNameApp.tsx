import { useEffect, useState } from 'react';
import type { TaskFolder } from '@shared/types';
import { folderTree } from '@shared/folders';
import { Field, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

/**
 * Standalone folder-name window: New Folder (File menu / task list context
 * menu / a folder's New Subfolder…, which presets the parent) or, with a
 * folderId, Rename Folder (folder context menu).
 */
export function FolderNameApp({ folderId, parentId }: { folderId?: string; parentId?: string }) {
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [parent, setParent] = useState(parentId ?? '');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = folderId ? 'Rename Folder' : 'New Folder';
    if (!folderId) {
      void window.looper.folders.list().then(setFolders);
      return window.looper.onEvent((e) => {
        if (e.type !== 'folders') return;
        setFolders(e.folders);
        // A deleted parent falls back to the top level.
        setParent((p) => (p && !e.folders.some((x) => x.id === p) ? '' : p));
      });
    }
    void window.looper.folders.list().then((all) => {
      const f = all.find((x) => x.id === folderId);
      if (!f) {
        setMissing(true);
        return;
      }
      setName(f.name);
      document.title = `Rename "${f.name}"`;
    });
    // Keep the draft; only track the folder itself (deletion).
    return window.looper.onEvent((e) => {
      if (e.type === 'folders' && !e.folders.some((x) => x.id === folderId)) setMissing(true);
    });
  }, [folderId]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (folderId) await window.looper.folders.rename(folderId, name);
      else await window.looper.folders.add(name, parent || undefined);
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };

  useDialogKeys({ onSave: () => void save(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This folder no longer exists.</div>;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!folderId && (
            <Field label="Parent folder">
              <select value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value=""></option>
                {folderTree(folders).map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {' '.repeat(depth * 3) + folder.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </div>
      <EditorFooter
        primaryLabel={folderId ? 'Save' : 'Create'}
        onPrimary={() => void save()}
        onCancel={() => window.close()}
        saving={saving}
        primaryDisabled={!name.trim()}
      />
    </div>
  );
}
