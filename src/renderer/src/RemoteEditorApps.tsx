import { useEffect, useRef, useState } from 'react';
import type { RemoteFolderProject, RemoteHelper, RemoteProject, Settings, Task } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { EditorFooter, Field, NumberField } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { RemoteFolderFields, draftProblem, foldDraft, isClaudeTask, type RemoteFolderDraft } from './components/RemoteFields';

/**
 * Save a changed Remote Control settings block through the full settings
 * schema, so a bad value is reported before anything is written. True when saved.
 */
async function saveRemote(live: Settings, remote: Settings['remote']): Promise<boolean> {
  const parsed = SettingsSchema.safeParse({ ...live, remote });
  if (!parsed.success) {
    void window.looper.showError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
    return false;
  }
  try {
    await window.looper.updateSettings({ remote: parsed.data.remote });
    return true;
  } catch (e) {
    void window.looper.showError((e as Error).message);
    return false;
  }
}

/**
 * Create-on-add: a new entry already exists in the settings so its window
 * could open; closing the window without Create removes it again.
 */
function useDiscardUnsaved(kind: 'helper' | 'project', id: string, isNew?: boolean) {
  const savedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    const onUnload = () => {
      if (!savedRef.current) window.looper.remote.discard(kind, id);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [kind, id, isNew]);
  return savedRef;
}

/** The settings, kept current; `missing` once the entry is gone from them. */
function useLiveSettings(found: (s: Settings) => boolean) {
  const [live, setLive] = useState<Settings | null>(null);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const foundRef = useRef(found);
  foundRef.current = found;
  useEffect(() => {
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setHost(info.host);
      if (!foundRef.current(info.settings)) setMissing(true);
    });
    return window.looper.onEvent((e) => {
      if (e.type !== 'settings') return;
      setLive(e.settings);
      if (!foundRef.current(e.settings)) setMissing(true);
    });
  }, []);
  return { live, host, missing };
}

/** Advanced → Remote Control → Settings → Helpers → Add/Edit. */
export function RemoteHelperEditorApp({ id, isNew }: { id: string; isNew?: boolean }) {
  const { live, host, missing } = useLiveSettings((s) => s.remote.helpers.some((h) => h.id === id));
  const [draft, setDraft] = useState<(RemoteFolderDraft & Pick<RemoteHelper, 'idleRestartMin' | 'instructions'>) | null>(null);
  const [saving, setSaving] = useState(false);
  const savedRef = useDiscardUnsaved('helper', id, isNew);

  useEffect(() => {
    if (!live || draft) return;
    const h = live.remote.helpers.find((x) => x.id === id);
    if (!h) return;
    const { name, environmentId, harnessId, cwd, model, effort, idleRestartMin, instructions } = h;
    setDraft({ name, environmentId, harnessId, cwd, model, effort, idleRestartMin, instructions });
    document.title = isNew ? 'New Helper' : h.name;
  }, [live, draft, id, isNew]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This helper no longer exists.</div>;
  if (!live || !draft) return <div className="empty">Loading…</div>;

  const doSave = async (): Promise<boolean> => {
    const problem = draftProblem(draft, live.environments);
    if (problem) {
      void window.looper.showError(problem);
      return false;
    }
    const { idleRestartMin, instructions, ...fields } = draft;
    const helpers = live.remote.helpers.map((h) => (h.id === id ? { ...h, ...foldDraft(fields, live.environments), idleRestartMin, instructions } : h));
    setSaving(true);
    const ok = await saveRemote(live, { ...live.remote, helpers });
    setSaving(false);
    if (ok) savedRef.current = true;
    return ok;
  };
  saveRef.current = async () => {
    if (await doSave()) window.close();
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <RemoteFolderFields
            draft={draft}
            environments={live.environments}
            host={host}
            onChange={(p) => setDraft((d) => (d ? { ...d, ...p } : d))}
          />
          <NumberField
            label="Restart when idle for"
            suffix="min"
            min={1}
            value={draft.idleRestartMin}
            onChange={(n) => setDraft((d) => (d ? { ...d, idleRestartMin: n } : d))}
          />
          <Field label="Instructions">
            <textarea rows={5} value={draft.instructions} onChange={(e) => setDraft((d) => (d ? { ...d, instructions: e.target.value } : d))} />
          </Field>
        </div>
      </div>
      <EditorFooter
        primaryLabel={isNew ? 'Create' : 'Save'}
        onPrimary={() => void saveRef.current()}
        onCancel={() => window.close()}
        onApply={isNew ? undefined : () => void doSave()}
        saving={saving}
      />
    </div>
  );
}

/** Advanced → Remote Control → Settings → Projects → Add Folder/Edit. */
export function RemoteProjectEditorApp({ id, isNew }: { id: string; isNew?: boolean }) {
  const { live, host, missing } = useLiveSettings((s) => s.remote.projects.some((p) => p.id === id));
  const [kind, setKind] = useState<RemoteProject['kind'] | null>(null);
  const [draft, setDraft] = useState<RemoteFolderDraft | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [taskId, setTaskId] = useState('');
  /** A task project's session name; empty = the task's name. */
  const [sessionName, setSessionName] = useState('');
  const [saving, setSaving] = useState(false);
  const savedRef = useDiscardUnsaved('project', id, isNew);

  useEffect(() => {
    if (!live || kind) return;
    const p = live.remote.projects.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    if (p.kind === 'folder') {
      const { name, environmentId, harnessId, cwd, model, effort, permissionMode } = p;
      setDraft({ name, environmentId, harnessId, cwd, model, effort, permissionMode });
      document.title = isNew ? 'New Project' : p.name;
    } else {
      setTaskId(p.taskId);
      setSessionName(p.name ?? '');
      void window.looper.tasks.list().then((list) => {
        setTasks(list);
        document.title = p.name ?? list.find((x) => x.id === p.taskId)?.name ?? 'Edit Project';
      });
    }
  }, [live, kind, id, isNew]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This project no longer exists.</div>;
  if (!live || !kind || (kind === 'folder' && !draft) || (kind === 'task' && !tasks)) return <div className="empty">Loading…</div>;

  // The task dropdown: Claude Code tasks no other project has, and the project's own task whatever it is.
  const taken = new Set(live.remote.projects.flatMap((p) => (p.kind === 'task' && p.id !== id ? [p.taskId] : [])));
  const choices = (tasks ?? []).filter((t) => t.id === taskId || (!taken.has(t.id) && isClaudeTask(t, live.environments)));
  const task = (tasks ?? []).find((t) => t.id === taskId);

  const doSave = async (): Promise<boolean> => {
    let next: RemoteProject[];
    if (kind === 'folder' && draft) {
      const problem = draftProblem(draft, live.environments);
      if (problem) {
        void window.looper.showError(problem);
        return false;
      }
      const fields = foldDraft(draft, live.environments);
      const folded: Omit<RemoteFolderProject, 'id' | 'kind'> = { ...fields, permissionMode: fields.permissionMode ?? 'auto' };
      next = live.remote.projects.map((p) => (p.id === id && p.kind === 'folder' ? { ...p, ...folded } : p));
    } else {
      if (!task) {
        void window.looper.showError('Choose a task.');
        return false;
      }
      const name = sessionName.trim() || undefined;
      next = live.remote.projects.map((p) => (p.id === id && p.kind === 'task' ? { kind: 'task', id, taskId, ...(name ? { name } : {}) } : p));
    }
    setSaving(true);
    const ok = await saveRemote(live, { ...live.remote, projects: next });
    setSaving(false);
    if (ok) savedRef.current = true;
    return ok;
  };
  saveRef.current = async () => {
    if (await doSave()) window.close();
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          {kind === 'folder' && draft ? (
            <RemoteFolderFields
              draft={draft}
              environments={live.environments}
              host={host}
              onChange={(p) => setDraft((d) => (d ? { ...d, ...p } : d))}
            />
          ) : (
            <>
              <Field label="Task">
                <select autoFocus value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  {!task && <option value={taskId}>Deleted task ({taskId})</option>}
                  {choices.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name">
                <input value={sessionName} placeholder={task?.name} onChange={(e) => setSessionName(e.target.value)} />
              </Field>
            </>
          )}
        </div>
      </div>
      <EditorFooter
        primaryLabel={isNew ? 'Create' : 'Save'}
        onPrimary={() => void saveRef.current()}
        onCancel={() => window.close()}
        onApply={isNew ? undefined : () => void doSave()}
        saving={saving}
      />
    </div>
  );
}
