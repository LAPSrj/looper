import { useEffect, useState } from 'react';
import { changeLabels, sourceLabel, type VersionSummary } from '@shared/versions';
import { windowTitle } from '@shared/window-title';
import { ListActions, ListButton, SelectList } from './components/SelectList';
import { WindowActions } from './components/WindowActions';
import { TASKS, useLiveItem } from './components/hooks';
import { keptSelection } from './components/selection';
import { fmtDateTime } from './format';
import { subscribe } from './events';
import { restoreVersion, useBuilderOpen } from './version-restore';

/** Version History window (Task → Version History…): a task's saved versions, newest first. */
export function VersionHistoryApp({ taskId }: { taskId: string }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const { item: task } = useLiveItem(TASKS, taskId);

  useEffect(() => {
    document.title = windowTitle('Version History', task?.name);
  }, [task?.name]);

  useEffect(() => {
    const loadVersions = () =>
      void window.looper.versions.list(taskId).then((list) => {
        const newestFirst = [...list].reverse();
        setVersions(newestFirst);
        setSelected((s) => keptSelection(s, newestFirst, (v) => v.n));
      });
    loadVersions();
    return subscribe((e) => {
      if (e.type === 'versions' && e.taskId === taskId) loadVersions();
    });
  }, [taskId]);

  // With a task builder open on the task, a version is loaded into it (unsaved, undoable) instead of restored.
  const builderOpen = useBuilderOpen(taskId);

  const version = versions.find((v) => v.n === selected);
  const current = versions[0]?.n;

  const view = (target = version) => {
    if (target) void window.looper.versions.openDetail(taskId, target.n, false);
  };
  const compare = (target = version) => {
    if (target) void window.looper.versions.openDetail(taskId, target.n, true);
  };
  const restore = (target = version) => {
    if (target && (builderOpen || target.n !== current)) void restoreVersion(taskId, target);
  };

  const subOf = (v: VersionSummary): string => {
    const labels = changeLabels(v.changed);
    const what = v.n === 1 && labels.length === 0 ? 'First version' : labels.length > 0 ? `Changed: ${labels.join(', ')}` : '';
    return [fmtDateTime(v.ts), sourceLabel(v.source, v.restoredFrom), what].filter(Boolean).join(' · ');
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={versions}
            label="Versions"
            idPrefix="version"
            selectedKey={selected === null ? null : String(selected)}
            itemKey={(v) => String(v.n)}
            itemName={(v) => (v.n === current ? `Version ${v.n} (current)` : `Version ${v.n}`)}
            itemSub={subOf}
            empty="No versions yet. A version is saved each time the task's definition changes."
            onSelect={(v) => setSelected(v.n)}
            onOpen={(v) => void window.looper.versions.openDetail(taskId, v.n, false)}
            menu={(v) => [
              { label: 'View…', run: () => view(v) },
              { label: 'Compare with Current…', enabled: v.n !== current, run: () => compare(v) },
              { label: builderOpen ? 'Edit with Agent' : 'Restore', enabled: builderOpen || v.n !== current, separator: true, run: () => void restore(v) },
            ]}
            autoFocus
          />
          <ListActions>
            <ListButton row disabled={!version} onClick={() => view()}>
              View…
            </ListButton>
            <ListButton row disabled={!version || version.n === current} onClick={() => compare()}>
              Compare with Current…
            </ListButton>
            {builderOpen ? (
              <ListButton row disabled={!version} onClick={() => void restore()}>
                Edit with Agent
              </ListButton>
            ) : (
              <ListButton row disabled={!version || version.n === current} onClick={() => void restore()}>
                Restore
              </ListButton>
            )}
          </ListActions>
        </div>
      </div>
      <WindowActions close />
    </div>
  );
}
