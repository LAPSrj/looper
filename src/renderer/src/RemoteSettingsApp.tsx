import { useEffect, useRef, useState } from 'react';
import type { RemoteHelper, RemoteProject, Settings, Task } from '@shared/types';
import { EditorFooter, Field } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { ListActions, SelectList } from './components/SelectList';
import { claudeHarnesses } from './components/RemoteFields';

const rid = () => Math.random().toString(36).slice(2, 8);

/**
 * Advanced → Remote Control → Settings. The helper and project lists are
 * managed live through their own editor windows; Start with Looper is a
 * draft saved with Save or Apply.
 */
export function RemoteSettingsApp() {
  const [live, setLive] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [startWithLooper, setStartWithLooper] = useState<boolean | null>(null);
  const [helper, setHelper] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Remote Control';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setStartWithLooper((v) => v ?? info.settings.remote.startWithLooper);
      setHelper((s) => s ?? info.settings.remote.helpers[0]?.id ?? null);
      setProject((s) => s ?? info.settings.remote.projects[0]?.id ?? null);
    });
    void window.looper.tasks.list().then(setTasks);
    void window.looper.remote.state().then((s) => setProblems(s.problems));
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') setLive(e.settings);
      else if (e.type === 'tasks') setTasks(e.tasks);
      else if (e.type === 'remote') setProblems(e.state.problems);
    });
  }, []);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (!live || startWithLooper === null) return <div className="empty">Loading…</div>;

  const r = live.remote;
  const helpers = r.helpers;
  const projects = r.projects;
  const selHelper = helpers.find((h) => h.id === helper);
  const selProject = projects.find((p) => p.id === project);
  const taskOf = (p: RemoteProject) => (p.kind === 'task' ? tasks.find((t) => t.id === p.taskId) : undefined);
  const projectName = (p: RemoteProject) => (p.kind === 'folder' ? p.name : (p.name ?? taskOf(p)?.name ?? `Task ${p.taskId} (deleted)`));
  const envName = (id: string) => live.environments.find((e) => e.id === id)?.name ?? id;

  const update = async (remote: Settings['remote']) => {
    try {
      await window.looper.updateSettings({ remote });
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  /** Where a new helper or folder project starts: the default environment, or the first with a Claude Code harness. */
  const defaultEnvId = () => {
    const def = live.environments.find((e) => e.id === live.defaultEnvironmentId);
    return (claudeHarnesses(def).length ? def : live.environments.find((e) => claudeHarnesses(e).length))?.id ?? live.defaultEnvironmentId;
  };

  const addHelper = async () => {
    const h: RemoteHelper = { id: `h-${rid()}`, name: 'Helper', environmentId: defaultEnvId(), cwd: '', permissionMode: 'auto', idleRestartMin: 60 };
    await update({ ...r, helpers: [...helpers, h] });
    setHelper(h.id);
    void window.looper.remote.openHelperEditor(h.id, true);
  };
  const duplicateHelper = async () => {
    if (!selHelper) return;
    const copy: RemoteHelper = { ...selHelper, id: `h-${rid()}`, name: `${selHelper.name} (copy)` };
    await update({ ...r, helpers: [...helpers, copy] });
    setHelper(copy.id);
  };
  const removeHelper = async () => {
    if (!selHelper) return;
    if (!(await window.looper.confirm(`Remove helper "${selHelper.name}"?`))) return;
    await update({ ...r, helpers: helpers.filter((h) => h.id !== selHelper.id) });
    setHelper(helpers.find((h) => h.id !== selHelper.id)?.id ?? null);
  };

  const addFolder = async () => {
    const p: RemoteProject = { kind: 'folder', id: `p-${rid()}`, name: 'Project', environmentId: defaultEnvId(), cwd: '', permissionMode: 'auto', keepReady: false };
    await update({ ...r, projects: [...projects, p] });
    setProject(p.id);
    void window.looper.remote.openProjectEditor(p.id, true);
  };
  const removeProject = async () => {
    if (!selProject) return;
    if (!(await window.looper.confirm(`Remove project "${projectName(selProject)}"?`))) return;
    await update({ ...r, projects: projects.filter((p) => p.id !== selProject.id) });
    setProject(projects.find((p) => p.id !== selProject.id)?.id ?? null);
  };

  const doSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await window.looper.updateSettings({ remote: { ...live.remote, startWithLooper } });
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = async () => {
    if (await doSave()) window.close();
  };

  /** A row's second line: where it runs, then why it has no conversation when Remote Control can't start one. */
  const sub = (where: string, key: string, extra?: string) => [where, extra, problems[key]].filter(Boolean).join(' · ');

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <label className="checkbox-field">
            <input type="checkbox" autoFocus checked={startWithLooper} onChange={(e) => setStartWithLooper(e.target.checked)} />
            Start with Looper
          </label>
          <Field label="Helpers">
            <SelectList
              items={helpers}
              label="Helpers"
              idPrefix="helper"
              selectedKey={helper}
              itemKey={(h) => h.id}
              itemName={(h) => h.name}
              itemSub={(h) => sub(`${envName(h.environmentId)} · ${h.cwd || 'no working directory'}`, `helper:${h.id}`)}
              empty="No helpers"
              onSelect={(h) => setHelper(h.id)}
              onOpen={(h) => void window.looper.remote.openHelperEditor(h.id)}
            />
          </Field>
          <ListActions
            onAdd={() => void addHelper()}
            onEdit={() => selHelper && void window.looper.remote.openHelperEditor(selHelper.id)}
            editDisabled={!selHelper}
            onDuplicate={() => void duplicateHelper()}
            duplicateDisabled={!selHelper}
            onRemove={() => void removeHelper()}
            removeDisabled={!selHelper}
          />
          <Field label="Projects">
            <SelectList
              items={projects}
              label="Projects"
              idPrefix="project"
              selectedKey={project}
              itemKey={(p) => p.id}
              itemName={(p) => projectName(p)}
              itemSub={(p) =>
                sub(
                  p.kind === 'folder'
                    ? `${envName(p.environmentId)} · ${p.cwd || 'no working directory'}`
                    : `Task${p.name && taskOf(p) ? ` ${taskOf(p)!.name}` : ''} · ${taskOf(p)?.cwd ?? ''}`,
                  `project:${p.id}`,
                  p.keepReady ? 'keeps an empty conversation ready' : undefined,
                )
              }
              empty="No projects"
              onSelect={(p) => setProject(p.id)}
              onOpen={(p) => void window.looper.remote.openProjectEditor(p.id)}
            />
          </Field>
          <div className="env-actions">
            <button className="btn" onClick={() => window.looper.remote.showAddTaskMenu()}>
              Add Task…
            </button>
            <button className="btn" onClick={() => void addFolder()}>
              Add Folder…
            </button>
            <button className="btn" disabled={!selProject} onClick={() => selProject && void window.looper.remote.openProjectEditor(selProject.id)}>
              Edit…
            </button>
            <button className="btn danger" disabled={!selProject} onClick={() => void removeProject()}>
              Remove
            </button>
          </div>
        </div>
      </div>
      <EditorFooter onPrimary={() => void saveRef.current()} onCancel={() => window.close()} onApply={() => void doSave()} saving={saving} />
    </div>
  );
}
