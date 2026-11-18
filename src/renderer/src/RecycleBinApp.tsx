import { useEffect, useState } from 'react';
import type { RecycleBinEntry } from '@shared/types';
import { ListActions, ListButton, SelectList } from './components/SelectList';
import { WindowActions } from './components/WindowActions';
import { fmtDateTime } from './format';
import { subscribe } from './events';
import { keptSelection } from './components/selection';
import { reportError } from './report-error';

/** Recycle Bin window (File → Recycle Bin…): deleted tasks to restore or delete for good. */
export function RecycleBinApp() {
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Recycle Bin';
    const apply = (list: RecycleBinEntry[]) => {
      setEntries(list);
      setSelected((s) => keptSelection(s, list, (e) => e.task.id));
    };
    void window.looper.recycleBin.list().then(apply);
    return subscribe((e) => {
      if (e.type === 'recycleBin') apply(e.entries);
    });
  }, []);

  const entry = entries.find((e) => e.task.id === selected);

  const restore = async (target = entry) => {
    if (!target) return;
    try {
      await window.looper.recycleBin.restore(target.task.id);
    } catch (e) {
      reportError(e);
    }
  };

  const remove = async (target = entry) => {
    if (!target) return;
    if (!(await window.looper.confirm(`Permanently delete "${target.task.name}"? Its run history is deleted too.`))) return;
    try {
      await window.looper.recycleBin.delete(target.task.id);
    } catch (e) {
      reportError(e);
    }
  };

  const empty = async () => {
    const n = entries.length;
    if (!n) return;
    const what = n === 1 ? `"${entries[0].task.name}"` : `these ${n} tasks`;
    if (!(await window.looper.confirm(`Permanently delete ${what}? Their run history is deleted too.`))) return;
    await window.looper.recycleBin.empty();
  };

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
            menu={(e) => [
              { label: 'Restore', run: () => void restore(e) },
              { label: 'Delete', destructive: true, run: () => void remove(e) },
            ]}
            onDelete={(e) => void remove(e)}
            autoFocus
          />
          <ListActions>
            <ListButton row disabled={!entry} onClick={() => void restore()}>
              Restore
            </ListButton>
            <ListButton row danger disabled={!entry} onClick={() => void remove()}>
              Delete
            </ListButton>
            <ListButton danger disabled={!entries.length} onClick={() => void empty()}>
              Empty Recycle Bin
            </ListButton>
          </ListActions>
        </div>
      </div>
      <WindowActions close />
    </div>
  );
}
