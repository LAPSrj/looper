import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Environment, Settings, Task } from '@shared/types';
import { describeEnvironment } from '@shared/environments';

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

type SettingsTab = 'general' | 'environments' | 'templates' | 'advanced';

const TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['environments', 'Environments'],
  ['templates', 'Templates'],
  ['advanced', 'Advanced'],
];

const rid = () => Math.random().toString(36).slice(2, 8);

/** Standalone settings window (File → Settings…). */
export function SettingsApp() {
  // Environments operate on the live settings (managed through their own editor
  // window and applied immediately); General/Advanced are a draft saved on OK.
  const [live, setLive] = useState<Settings | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [templates, setTemplates] = useState<Task[]>([]);
  const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [staggerEnabled, setStaggerEnabled] = useState<boolean | null>(null);
  const [staggerMin, setStaggerMin] = useState<number | null>(null);
  const [staggerMax, setStaggerMax] = useState<number | null>(null);
  const [staggerInterval, setStaggerInterval] = useState<number | null>(null);
  const [tasksFile, setTasksFile] = useState<string | undefined>(undefined);
  const [templatesFile, setTemplatesFile] = useState<string | undefined>(undefined);
  const [moveTasksOnSave, setMoveTasksOnSave] = useState(false);
  const [moveTemplatesOnSave, setMoveTemplatesOnSave] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTpl, setSelectedTpl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const initTasksFile = useRef<string | undefined>(undefined);
  const initTemplatesFile = useRef<string | undefined>(undefined);

  useEffect(() => {
    document.title = 'Settings';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setDataDir(info.dataDir);
      setDefaultEnvId((v) => v ?? info.settings.defaultEnvironmentId);
      setCloseToTray((v) => v ?? info.settings.closeToTray);
      setStaggerEnabled((v) => v ?? info.settings.staggerFirstRun.enabled);
      setStaggerMin((v) => v ?? info.settings.staggerFirstRun.minDelaySec);
      setStaggerMax((v) => v ?? info.settings.staggerFirstRun.maxDelaySec);
      setStaggerInterval((v) => v ?? info.settings.staggerFirstRun.minIntervalSec);
      setTasksFile((v) => v ?? info.settings.tasksFile);
      setTemplatesFile((v) => v ?? info.settings.templatesFile);
      initTasksFile.current ??= info.settings.tasksFile;
      initTemplatesFile.current ??= info.settings.templatesFile;
      setSelected((s) => s ?? info.settings.environments[0]?.id ?? null);
    });
    void window.looper.tasks.list().then(setTasks);
    void window.looper.templates.list().then((t) => {
      setTemplates(t);
      setSelectedTpl((s) => s ?? t[0]?.id ?? null);
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') {
        setLive(e.settings);
        setDefaultEnvId((v) => (v && e.settings.environments.some((x) => x.id === v) ? v : e.settings.defaultEnvironmentId));
        setSelected((s) => (s && e.settings.environments.some((x) => x.id === s) ? s : e.settings.environments[0]?.id ?? null));
      } else if (e.type === 'tasks') {
        setTasks(e.tasks);
      } else if (e.type === 'templates') {
        setTemplates(e.templates);
        setSelectedTpl((s) => (s && e.templates.some((t) => t.id === s) ? s : e.templates[0]?.id ?? null));
      }
    });
  }, []);

  // Dialog keys: Esc = cancel, Enter on an input or Ctrl+Enter anywhere = save,
  // Ctrl+Tab / Ctrl+PageDown|PageUp = cycle tabs.
  const saveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const order = TABS.map(([id]) => id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void saveRef.current();
        return;
      }
      const cycle = (dir: number) =>
        setTab((t) => order[(order.indexOf(t) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!live || defaultEnvId === null || closeToTray === null || staggerEnabled === null || staggerMin === null || staggerMax === null || staggerInterval === null) return <div className="empty">Loading…</div>;

  const envs = live.environments;
  const env = envs.find((e) => e.id === selected);
  const usedBy = (id: string) => tasks.filter((t) => t.environmentId === id).length;

  const addEnv = async () => {
    const created: Environment = {
      id: `env-${rid()}`,
      name: 'New environment',
      kind: 'local',
      harnesses: [{ id: `h-${rid()}`, name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} }],
    };
    try {
      await window.looper.updateSettings({ environments: [...envs, created] });
      setSelected(created.id);
      void window.looper.openEnvironmentEditor(created.id, true);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const duplicateEnv = async () => {
    if (!env) return;
    const copy: Environment = {
      ...JSON.parse(JSON.stringify(env)),
      id: `env-${rid()}`,
      name: `${env.name} (copy)`,
      harnesses: env.harnesses.map((h) => ({ ...h, id: `h-${rid()}` })),
    };
    try {
      await window.looper.updateSettings({ environments: [...envs, copy] });
      setSelected(copy.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const removeEnv = async () => {
    if (!env || envs.length <= 1) return;
    const n = usedBy(env.id);
    const warning = n > 0 ? ` ${n} task${n === 1 ? '' : 's'} still use${n === 1 ? 's' : ''} it and will fail until reassigned.` : '';
    if (!(await window.looper.confirm(`Remove environment "${env.name}"?${warning}`))) return;
    const rest = envs.filter((e) => e.id !== env.id);
    const patch: Partial<Settings> = { environments: rest };
    if (live.defaultEnvironmentId === env.id) patch.defaultEnvironmentId = rest[0].id;
    try {
      await window.looper.updateSettings(patch);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!envs.length) return;
    const idx = env ? envs.findIndex((x) => x.id === env.id) : -1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(envs.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = envs.length - 1;
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (env) void window.looper.openEnvironmentEditor(env.id);
        return;
      default:
        return;
    }
    e.preventDefault();
    setSelected(envs[next].id);
  };

  // ---------- Templates ----------

  const tpl = templates.find((t) => t.id === selectedTpl);

  const duplicateTpl = async () => {
    if (!tpl) return;
    const copy = {
      ...JSON.parse(JSON.stringify(tpl)),
      id: `${tpl.id}-${rid()}`,
      name: `${tpl.name} (copy)`,
    };
    delete copy.createdAt;
    delete copy.updatedAt;
    try {
      await window.looper.templates.save(copy);
      setSelectedTpl(copy.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const removeTpl = async () => {
    if (!tpl) return;
    if (!(await window.looper.confirm(`Remove template "${tpl.name}"?`))) return;
    try {
      await window.looper.templates.remove(tpl.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const onTplListKey = (e: React.KeyboardEvent) => {
    if (!templates.length) return;
    const idx = tpl ? templates.findIndex((x) => x.id === tpl.id) : -1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(templates.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = templates.length - 1;
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (tpl) void window.looper.openTemplateEditor(tpl.id);
        return;
      default:
        return;
    }
    e.preventDefault();
    setSelectedTpl(templates[next].id);
  };

  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id;

  // ---------- Store files ----------

  const defaultFile = (store: 'tasks' | 'templates') => dataDir + `\\${store}.json`;
  const jsonFilter = [{ name: 'JSON', extensions: ['json'] }];

  const browseStoreFile = async (store: 'tasks' | 'templates') => {
    const current = store === 'tasks' ? tasksFile : templatesFile;
    const picked = await window.looper.pickSaveFile({
      defaultPath: current ?? defaultFile(store),
      filters: jsonFilter,
    });
    if (!picked) return;
    const shouldMove = await window.looper.confirm(`Move existing ${store} to the new location?`);
    if (store === 'tasks') { setTasksFile(picked); setMoveTasksOnSave(shouldMove); }
    else { setTemplatesFile(picked); setMoveTemplatesOnSave(shouldMove); }
  };

  const resetStoreFile = async (store: 'tasks' | 'templates') => {
    const current = store === 'tasks' ? tasksFile : templatesFile;
    if (!current) return;
    const shouldMove = await window.looper.confirm(`Move ${store} back to the default location?`);
    if (store === 'tasks') { setTasksFile(undefined); setMoveTasksOnSave(shouldMove); }
    else { setTemplatesFile(undefined); setMoveTemplatesOnSave(shouldMove); }
  };

  // ---------- Save / Apply ----------

  const doSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const tasksFileChanged = tasksFile !== initTasksFile.current;
      const templatesFileChanged = templatesFile !== initTemplatesFile.current;
      if (tasksFileChanged && moveTasksOnSave) {
        await window.looper.moveStoreFile('tasks', tasksFile ?? defaultFile('tasks'));
      }
      if (templatesFileChanged && moveTemplatesOnSave) {
        await window.looper.moveStoreFile('templates', templatesFile ?? defaultFile('templates'));
      }
      await window.looper.updateSettings({
        defaultEnvironmentId: defaultEnvId,
        closeToTray,
        staggerFirstRun: {
          enabled: staggerEnabled,
          minDelaySec: staggerMin,
          maxDelaySec: staggerMax,
          minIntervalSec: staggerInterval,
        },
        tasksFile,
        templatesFile,
      });
      initTasksFile.current = tasksFile;
      initTemplatesFile.current = templatesFile;
      setMoveTasksOnSave(false);
      setMoveTemplatesOnSave(false);
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => { if (await doSave()) window.close(); };
  const apply = async () => { await doSave(); };
  saveRef.current = save;

  return (
    <div className="editor">
      <nav className="tabs editor-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="editor-body">
        {tab === 'general' && (
          <div className="form">
            <Field label="Default environment">
              <select autoFocus value={defaultEnvId} onChange={(e) => setDefaultEnvId(e.target.value)}>
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <label className="checkbox-field">
              <input type="checkbox" checked={staggerEnabled} onChange={(e) => setStaggerEnabled(e.target.checked)} />
              Stagger overdue tasks on startup
            </label>
            <div className={`stagger-fields${staggerEnabled ? '' : ' disabled'}`}>
              <Field label="Minimum delay">
                <div className="input-suffix">
                  <input
                    type="number"
                    min={0}
                    disabled={!staggerEnabled}
                    value={staggerMin}
                    onChange={(e) => setStaggerMin(Number(e.target.value))}
                  />
                  <span className="suffix">s</span>
                </div>
              </Field>
              <Field label="Maximum delay">
                <div className="input-suffix">
                  <input
                    type="number"
                    min={1}
                    disabled={!staggerEnabled}
                    value={staggerMax}
                    onChange={(e) => setStaggerMax(Number(e.target.value))}
                  />
                  <span className="suffix">s</span>
                </div>
              </Field>
              <Field label="Minimum interval">
                <div className="input-suffix">
                  <input
                    type="number"
                    min={0}
                    disabled={!staggerEnabled}
                    value={staggerInterval}
                    onChange={(e) => setStaggerInterval(Number(e.target.value))}
                  />
                  <span className="suffix">s</span>
                </div>
              </Field>
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={closeToTray} onChange={(e) => setCloseToTray(e.target.checked)} />
              Close to system tray
            </label>
          </div>
        )}

        {tab === 'environments' && (
          <div className="form env-tab">
            <ul
              className="env-list boxed"
              role="listbox"
              aria-label="Environments"
              tabIndex={0}
              onKeyDown={onListKey}
              aria-activedescendant={env ? `env-${env.id}` : undefined}
            >
              {envs.map((e) => {
                const n = usedBy(e.id);
                return (
                  <li
                    key={e.id}
                    id={`env-${e.id}`}
                    role="option"
                    aria-selected={e.id === selected}
                    className={`env-item ${e.id === selected ? 'selected' : ''}`}
                    onClick={() => setSelected(e.id)}
                    onDoubleClick={() => void window.looper.openEnvironmentEditor(e.id)}
                  >
                    <div className="env-item-name">
                      {e.name}
                      {live.defaultEnvironmentId === e.id && <span className="muted"> (default)</span>}
                    </div>
                    <div className="env-item-sub">
                      {describeEnvironment(e)} · {e.harnesses.length === 1 ? '1 harness' : `${e.harnesses.length} harnesses`}
                      {n > 0 ? ` · ${n} task${n === 1 ? '' : 's'}` : ''}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="env-actions">
              <button className="btn" onClick={() => void addEnv()}>
                Add…
              </button>
              <button className="btn" disabled={!env} onClick={() => env && void window.looper.openEnvironmentEditor(env.id)}>
                Edit…
              </button>
              <button className="btn" disabled={!env} onClick={() => void duplicateEnv()}>
                Duplicate
              </button>
              <button
                className="btn danger"
                disabled={!env || envs.length <= 1}
                title={envs.length <= 1 ? 'At least one environment is required' : undefined}
                onClick={() => void removeEnv()}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        {tab === 'advanced' && (
          <div className="form">
            <Field label="Tasks file">
              <div className="browse-row">
                <input type="text" readOnly value={tasksFile ?? defaultFile('tasks')} />
                <button className="btn" onClick={() => void browseStoreFile('tasks')}>Browse…</button>
                {tasksFile && <button className="btn" onClick={() => void resetStoreFile('tasks')}>Reset</button>}
              </div>
            </Field>
            <Field label="Templates file">
              <div className="browse-row">
                <input type="text" readOnly value={templatesFile ?? defaultFile('templates')} />
                <button className="btn" onClick={() => void browseStoreFile('templates')}>Browse…</button>
                {templatesFile && <button className="btn" onClick={() => void resetStoreFile('templates')}>Reset</button>}
              </div>
            </Field>
          </div>
        )}

        {tab === 'templates' && (
          <div className="form env-tab">
            <ul
              className="env-list boxed"
              role="listbox"
              aria-label="Templates"
              tabIndex={0}
              onKeyDown={onTplListKey}
              aria-activedescendant={tpl ? `tpl-${tpl.id}` : undefined}
            >
              {templates.length === 0 && (
                <li className="env-item muted" style={{ textAlign: 'center', cursor: 'default' }}>
                  No templates
                </li>
              )}
              {templates.map((t) => (
                <li
                  key={t.id}
                  id={`tpl-${t.id}`}
                  role="option"
                  aria-selected={t.id === selectedTpl}
                  className={`env-item ${t.id === selectedTpl ? 'selected' : ''}`}
                  onClick={() => setSelectedTpl(t.id)}
                  onDoubleClick={() => void window.looper.openTemplateEditor(t.id)}
                >
                  <div className="env-item-name">{t.name}</div>
                </li>
              ))}
            </ul>
            <div className="env-actions">
              <button className="btn" onClick={() => void window.looper.openTemplateEditor()}>
                Add…
              </button>
              <button className="btn" disabled={!tpl} onClick={() => tpl && void window.looper.openTemplateEditor(tpl.id)}>
                Edit…
              </button>
              <button className="btn" disabled={!tpl} onClick={() => void duplicateTpl()}>
                Duplicate
              </button>
              <button className="btn danger" disabled={!tpl} onClick={() => void removeTpl()}>
                Remove
              </button>
            </div>
          </div>
        )}

      </div>
      <div className="editor-footer">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
        <button className="btn" onClick={() => window.close()} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={() => void apply()} disabled={saving}>
          Apply
        </button>
      </div>
    </div>
  );
}
