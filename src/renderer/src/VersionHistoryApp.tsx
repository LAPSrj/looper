import { useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/types';
import { changeLabels, sourceLabel, type VersionSummary } from '@shared/versions';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';
import { fmtDateTime } from './format';

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
    return window.looper.onEvent((e) => {
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

  useDialogKeys({ onCancel: () => window.close() });

  const version = versions.find((v) => v.n === selected);
  const current = versions[0]?.n;

  const view = () => {
    if (version) void window.looper.versions.openDetail(taskId, version.n, false);
  };
  const compare = () => {
    if (version) void window.looper.versions.openDetail(taskId, version.n, true);
  };
  const restore = async () => {
    if (version && builderOpen) {
      try {
        await window.looper.builder.loadVersion(taskId, version.n);
      } catch (e) {
        void window.looper.showError((e as Error).message);
      }
      return;
    }
    if (!version || !task || version.n === current) return;
    const files = version.files.length > 0 ? ' and the files it recorded' : '';
    if (!(await window.looper.confirm(`Restore version ${version.n} of "${task.name}"? Its definition${files} replace the current ones, and the restore is saved as a new version.`))) return;
    try {
      await window.looper.versions.restore(taskId, version.n);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  // The context menu acts on the row it opened on, which is selected by then.
  const actions = useRef({ view, compare, restore });
  actions.current = { view, compare, restore };
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'version-view') actions.current.view();
        else if (e.type === 'version-compare') actions.current.compare();
        else if (e.type === 'version-restore') void actions.current.restore();
      }),
    [],
  );

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
            onContextMenu={() => window.looper.showVersionContextMenu({ builder: builderOpen })}
          />
          <div className="env-actions">
            <button className="btn" disabled={!version} onClick={view}>
              View…
            </button>
            <button className="btn" disabled={!version} onClick={compare}>
              Compare with Current…
            </button>
            {builderOpen ? (
              <button className="btn" disabled={!version} onClick={() => void restore()}>
                Edit with Agent
              </button>
            ) : (
              <button className="btn" disabled={!version || version.n === current} onClick={() => void restore()}>
                Restore
              </button>
            )}
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
