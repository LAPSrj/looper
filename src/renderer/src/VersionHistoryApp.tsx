import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { changeLabels, sourceLabel, type VersionSummary } from '@shared/versions';
import { ListActions, ListButton, SelectList } from './components/SelectList';
import { WindowActions } from './components/WindowActions';
import { fmtDateTime } from './format';
import { subscribe } from './events';

/** Version History window (Task → Version History…): a task's saved versions, newest first. */
export function VersionHistoryApp({ taskId }: { taskId: string }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const loadTask = () =>
      void window.looper.tasks.list().then((tasks) => {
        const t = tasks.find((x) => x.id === taskId) ?? null;
        setTask(t);
        document.title = t ? `Version History – ${t.name}` : 'Version History';
      });
    const loadVersions = () =>
      void window.looper.versions.list(taskId).then((list) => {
        const newestFirst = [...list].reverse();
        setVersions(newestFirst);
        setSelected((s) => (s !== null && newestFirst.some((v) => v.n === s) ? s : (newestFirst[0]?.n ?? null)));
      });
    loadTask();
    loadVersions();
    return subscribe((e) => {
      if (e.type === 'versions' && e.taskId === taskId) loadVersions();
      else if (e.type === 'tasks') loadTask();
    });
  }, [taskId]);

  // With a task builder open on the task, a version is loaded into it (unsaved, undoable) instead of restored.
  const [builderOpen, setBuilderOpen] = useState(false);
  useEffect(() => {
    const check = () => void window.looper.builder.forTask(taskId).then((id) => setBuilderOpen(id !== null));
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [taskId]);

  const version = versions.find((v) => v.n === selected);
  const current = versions[0]?.n;

  const view = (target = version) => {
    if (target) void window.looper.versions.openDetail(taskId, target.n, false);
  };
  const compare = (target = version) => {
    if (target) void window.looper.versions.openDetail(taskId, target.n, true);
  };
  const restore = async (target = version) => {
    if (target && builderOpen) {
      try {
        await window.looper.builder.loadVersion(taskId, target.n);
      } catch (e) {
        void window.looper.showError((e as Error).message);
      }
      return;
    }
    if (!target || !task || target.n === current) return;
    const files = target.files.length > 0 ? ' and the files it recorded' : '';
    if (!(await window.looper.confirm(`Restore version ${target.n} of "${task.name}"? Its definition${files} replace the current ones, and the restore is saved as a new version.`))) return;
    try {
      await window.looper.versions.restore(taskId, target.n);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
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
