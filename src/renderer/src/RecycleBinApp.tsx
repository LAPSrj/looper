import { useEffect, useRef, useState } from 'react';
import type { RecycleBinEntry } from '@shared/types';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';
import { fmtDateTime } from './format';

/** Recycle Bin window (File → Recycle Bin…): deleted tasks to restore or delete for good. */
export function RecycleBinApp() {
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Recycle Bin';
    const apply = (list: RecycleBinEntry[]) => {
      setEntries(list);
      setSelected((s) => (s && list.some((e) => e.task.id === s) ? s : list[0]?.task.id ?? null));
    };
    void window.looper.recycleBin.list().then(apply);
    return window.looper.onEvent((e) => {
      if (e.type === 'recycleBin') apply(e.entries);
    });
  }, []);

  useDialogKeys({ onCancel: () => window.close() });

  const entry = entries.find((e) => e.task.id === selected);

  const restore = async () => {
    if (!entry) return;
    try {
      await window.looper.recycleBin.restore(entry.task.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!entry) return;
    if (!(await window.looper.confirm(`Permanently delete "${entry.task.name}"? Its run history is deleted too.`))) return;
    try {
      await window.looper.recycleBin.delete(entry.task.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const empty = async () => {
    const n = entries.length;
    if (!n) return;
    const what = n === 1 ? `"${entries[0].task.name}"` : `these ${n} tasks`;
    if (!(await window.looper.confirm(`Permanently delete ${what}? Their run history is deleted too.`))) return;
    await window.looper.recycleBin.empty();
  };

  // The context menu acts on the row it opened on, which is selected by then.
  const actions = useRef({ restore, remove });
  actions.current = { restore, remove };
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'bin-restore') void actions.current.restore();
        else if (e.type === 'bin-delete') void actions.current.remove();
      }),
    [],
  );

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={entries}
            label="Deleted tasks"
            idPrefix="bin"
            selectedKey={selected}
            itemKey={(e) => e.task.id}
            itemName={(e) => e.task.name}
            itemSub={(e) => `Deleted ${fmtDateTime(e.deletedAt)}`}
            empty="The Recycle Bin is empty"
            onSelect={(e) => setSelected(e.task.id)}
            onContextMenu={() => window.looper.showRecycleBinContextMenu()}
          />
          <div className="env-actions">
            <button className="btn" disabled={!entry} onClick={() => void restore()}>
              Restore
            </button>
            <button className="btn danger" disabled={!entry} onClick={() => void remove()}>
              Delete
            </button>
            <button className="btn danger" disabled={!entries.length} onClick={() => void empty()}>
              Empty Recycle Bin
            </button>
          </div>
        </div>
      </div>
      <div className="editor-footer">
        <button className="btn" onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}
