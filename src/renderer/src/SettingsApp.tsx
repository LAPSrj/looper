import { useEffect, useRef, useState } from 'react';
import type { Environment, Settings, Task } from '@shared/types';
import { describeEnvironment } from '@shared/environments';
import { Field, NumberField, TabBar, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { SelectList, ListActions } from './components/SelectList';

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

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close(), tabs: TABS.map(([id]) => id), tab, onTab: setTab });

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
      <TabBar tabs={TABS} active={tab} onSelect={setTab} className="editor-tabs" />
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
              <NumberField label="Minimum delay" suffix="s" min={0} disabled={!staggerEnabled} value={staggerMin} onChange={setStaggerMin} />
              <NumberField label="Maximum delay" suffix="s" min={1} disabled={!staggerEnabled} value={staggerMax} onChange={setStaggerMax} />
              <NumberField label="Minimum interval" suffix="s" min={0} disabled={!staggerEnabled} value={staggerInterval} onChange={setStaggerInterval} />
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={closeToTray} onChange={(e) => setCloseToTray(e.target.checked)} />
              Close to system tray
            </label>
          </div>
        )}

        {tab === 'environments' && (
          <div className="form env-tab">
            <SelectList
              items={envs}
              label="Environments"
              idPrefix="env"
              selectedKey={selected}
              itemKey={(e) => e.id}
              itemName={(e) => (
                <>
                  {e.name}
                  {live.defaultEnvironmentId === e.id && <span className="muted"> (default)</span>}
                </>
              )}
              itemSub={(e) => {
                const n = usedBy(e.id);
                return (
                  <>
                    {describeEnvironment(e)} · {e.harnesses.length === 1 ? '1 harness' : `${e.harnesses.length} harnesses`}
                    {n > 0 ? ` · ${n} task${n === 1 ? '' : 's'}` : ''}
                  </>
                );
              }}
              onSelect={(e) => setSelected(e.id)}
              onOpen={(e) => void window.looper.openEnvironmentEditor(e.id)}
            />
            <ListActions
              onAdd={() => void addEnv()}
              onEdit={() => env && void window.looper.openEnvironmentEditor(env.id)}
              editDisabled={!env}
              onDuplicate={() => void duplicateEnv()}
              duplicateDisabled={!env}
              onRemove={() => void removeEnv()}
              removeDisabled={!env || envs.length <= 1}
              removeTitle={envs.length <= 1 ? 'At least one environment is required' : undefined}
            />
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
            <SelectList
              items={templates}
              label="Templates"
              idPrefix="tpl"
              selectedKey={selectedTpl}
              itemKey={(t) => t.id}
              itemName={(t) => t.name}
              empty="No templates"
              onSelect={(t) => setSelectedTpl(t.id)}
              onOpen={(t) => void window.looper.openTemplateEditor(t.id)}
            />
            <ListActions
              onAdd={() => void window.looper.openTemplateEditor()}
              onEdit={() => tpl && void window.looper.openTemplateEditor(tpl.id)}
              editDisabled={!tpl}
              onDuplicate={() => void duplicateTpl()}
              duplicateDisabled={!tpl}
              onRemove={() => void removeTpl()}
              removeDisabled={!tpl}
            />
          </div>
        )}

      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} onApply={() => void apply()} saving={saving} />
    </div>
  );
}
