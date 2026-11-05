import { useEffect, useRef, useState } from 'react';
import type { Environment, Settings, Task, TaskFolder } from '@shared/types';
import { describeEnvironment } from '@shared/environments';
import { CheckboxField, EmptyWindow, Field, FormGroup, InlineField, InputRow, NumberField, NumberInput, RadioField, SelectInput, StepFields, TabBar, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { FolderOptions } from './components/form-blocks';
import { rid } from './rid';
import { useDialogKeys } from './components/hooks';
import { useFitWindow } from './fit-window';
import { SelectList, ListActions } from './components/SelectList';

type SettingsTab = 'general' | 'chats' | 'rest' | 'environments' | 'advanced';

const TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['chats', 'Chats'],
  ['rest', 'Rest Mode'],
  ['environments', 'Environments'],
  ['advanced', 'Advanced'],
];

/** Standalone settings window (File → Settings…). */
export function SettingsApp() {
  // Environments operate on the live settings (managed through their own editor
  // window and applied immediately); General/Advanced are a draft saved on OK.
  const [live, setLive] = useState<Settings | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
  // '' = completed tasks stay where they are; loaded once, like the other drafts.
  const [completedFolderId, setCompletedFolderId] = useState<string | null>(null);
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [confirmQuitRuns, setConfirmQuitRuns] = useState<boolean | null>(null);
  const [confirmQuitWatchers, setConfirmQuitWatchers] = useState<boolean | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [startWithSystem, setStartWithSystem] = useState<boolean | null>(null);
  const [staggerEnabled, setStaggerEnabled] = useState<boolean | null>(null);
  const [staggerMin, setStaggerMin] = useState<number | null>(null);
  const [staggerMax, setStaggerMax] = useState<number | null>(null);
  const [staggerInterval, setStaggerInterval] = useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [host, setHost] = useState('');
  const [restMinSleep, setRestMinSleep] = useState<number | null>(null);
  const [restGrace, setRestGrace] = useState<number | null>(null);
  const [restDisarmOnWake, setRestDisarmOnWake] = useState<boolean | null>(null);
  const [engineLogDays, setEngineLogDays] = useState<number | null>(null);
  const [deleteCompleted, setDeleteCompleted] = useState<boolean | null>(null);
  const [completedDays, setCompletedDays] = useState<number | null>(null);
  const [binDays, setBinDays] = useState<number | null>(null);
  const [promptRunOptions, setPromptRunOptions] = useState<boolean | null>(null);
  const [builderView, setBuilderView] = useState<'chat' | 'terminal' | null>(null);
  const [terminal, setTerminal] = useState<Settings['terminal'] | null>(null);
  const [chats, setChats] = useState<Settings['chats'] | null>(null);
  const [tasksFile, setTasksFile] = useState<string | undefined>(undefined);
  const [templatesFile, setTemplatesFile] = useState<string | undefined>(undefined);
  const [moveTasksOnSave, setMoveTasksOnSave] = useState(false);
  const [moveTemplatesOnSave, setMoveTemplatesOnSave] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useFitWindow();
  const initTasksFile = useRef<string | undefined>(undefined);
  const initTemplatesFile = useRef<string | undefined>(undefined);
  const initStartWithSystem = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    document.title = 'Settings';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setDataDir(info.dataDir);
      setDefaultEnvId((v) => v ?? info.settings.defaultEnvironmentId);
      setCompletedFolderId((v) => v ?? info.settings.completedFolderId ?? '');
      setCloseToTray((v) => v ?? info.settings.closeToTray);
      setConfirmQuitRuns((v) => v ?? info.settings.confirmQuit.runs);
      setConfirmQuitWatchers((v) => v ?? info.settings.confirmQuit.watchers);
      setNotificationsEnabled((v) => v ?? info.settings.notificationsEnabled);
      setStaggerEnabled((v) => v ?? info.settings.staggerFirstRun.enabled);
      setStaggerMin((v) => v ?? info.settings.staggerFirstRun.minDelaySec);
      setStaggerMax((v) => v ?? info.settings.staggerFirstRun.maxDelaySec);
      setStaggerInterval((v) => v ?? info.settings.staggerFirstRun.minIntervalSec);
      setRetentionDays((v) => v ?? info.settings.runRetentionDays);
      setHost(info.host);
      setRestMinSleep((v) => v ?? info.settings.rest.minSleepMin);
      setRestGrace((v) => v ?? info.settings.rest.graceSec);
      setRestDisarmOnWake((v) => v ?? info.settings.rest.disarmOnUserWake);
      setEngineLogDays((v) => v ?? info.settings.engineLogRetentionDays);
      setDeleteCompleted((v) => v ?? info.settings.completedTaskRetention.enabled);
      setCompletedDays((v) => v ?? info.settings.completedTaskRetention.days);
      setBinDays((v) => v ?? info.settings.recycleBinDays);
      setPromptRunOptions((v) => v ?? info.settings.promptRunOptions);
      setBuilderView((v) => v ?? info.settings.builder.view);
      setTerminal((v) => v ?? info.settings.terminal);
      setChats((v) => v ?? info.settings.chats);
      setTasksFile((v) => v ?? info.settings.tasksFile);
      setTemplatesFile((v) => v ?? info.settings.templatesFile);
      initTasksFile.current ??= info.settings.tasksFile;
      initTemplatesFile.current ??= info.settings.templatesFile;
      setSelected((s) => s ?? info.settings.environments[0]?.id ?? null);
    });
    void window.looper.tasks.list().then(setTasks);
    void window.looper.folders.list().then(setFolders);
    void window.looper.getStartWithSystem().then((v) => {
      setStartWithSystem((s) => s ?? v);
      initStartWithSystem.current ??= v;
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') {
        setLive(e.settings);
        setDefaultEnvId((v) => (v && e.settings.environments.some((x) => x.id === v) ? v : e.settings.defaultEnvironmentId));
        setSelected((s) => (s && e.settings.environments.some((x) => x.id === s) ? s : e.settings.environments[0]?.id ?? null));
      } else if (e.type === 'tasks') {
        setTasks(e.tasks);
      } else if (e.type === 'folders') {
        setFolders(e.folders);
        setCompletedFolderId((v) => (v && !e.folders.some((f) => f.id === v) ? '' : v));
      }
    });
  }, []);

  const visibleTabs = host === 'windows' ? TABS : TABS.filter(([id]) => id !== 'rest');

  useDialogKeys({ tabs: visibleTabs.map(([id]) => id), tab, onTab: setTab });

  if (!live || defaultEnvId === null || completedFolderId === null || closeToTray === null || confirmQuitRuns === null || confirmQuitWatchers === null || notificationsEnabled === null || startWithSystem === null || staggerEnabled === null || staggerMin === null || staggerMax === null || staggerInterval === null || retentionDays === null || engineLogDays === null || deleteCompleted === null || completedDays === null || binDays === null || restMinSleep === null || restGrace === null || restDisarmOnWake === null || promptRunOptions === null || builderView === null || terminal === null || chats === null) return <EmptyWindow />;

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

  // Each command takes the environment it acts on (the selected one for a button, the clicked row for the menu).
  const duplicateEnv = async (from: Environment | undefined = env) => {
    if (!from) return;
    const copy: Environment = {
      ...JSON.parse(JSON.stringify(from)),
      id: `env-${rid()}`,
      name: `${from.name} (copy)`,
      harnesses: from.harnesses.map((h) => ({ ...h, id: `h-${rid()}` })),
    };
    try {
      await window.looper.updateSettings({ environments: [...envs, copy] });
      setSelected(copy.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const removeEnv = async (target: Environment | undefined = env) => {
    if (!target || envs.length <= 1) return;
    const n = usedBy(target.id);
    const warning = n > 0 ? ` ${n} task${n === 1 ? '' : 's'} still use${n === 1 ? 's' : ''} it and will fail until reassigned.` : '';
    if (!(await window.looper.confirm(`Remove environment "${target.name}"?${warning}`))) return;
    const rest = envs.filter((e) => e.id !== target.id);
    const patch: Partial<Settings> = { environments: rest };
    if (live.defaultEnvironmentId === target.id) patch.defaultEnvironmentId = rest[0].id;
    try {
      await window.looper.updateSettings(patch);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  // ---------- Store files ----------

  // The data dir's own separator: a POSIX host's path has no backslashes.
  const defaultFile = (store: 'tasks' | 'templates') => `${dataDir}${dataDir.includes('\\') ? '\\' : '/'}${store}.json`;
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
      if (startWithSystem !== initStartWithSystem.current) {
        await window.looper.setStartWithSystem(startWithSystem);
        initStartWithSystem.current = startWithSystem;
      }
      await window.looper.updateSettings({
        defaultEnvironmentId: defaultEnvId,
        completedFolderId: completedFolderId || undefined,
        closeToTray,
        confirmQuit: { runs: confirmQuitRuns, watchers: confirmQuitWatchers },
        notificationsEnabled,
        staggerFirstRun: {
          enabled: staggerEnabled,
          minDelaySec: staggerMin,
          maxDelaySec: staggerMax,
          minIntervalSec: staggerInterval,
        },
        tasksFile,
        templatesFile,
        runRetentionDays: retentionDays,
        engineLogRetentionDays: engineLogDays,
        completedTaskRetention: { enabled: deleteCompleted, days: completedDays },
        recycleBinDays: binDays,
        promptRunOptions,
        terminal,
        chats,
        builder: { view: builderView },
        rest: {
          minSleepMin: restMinSleep,
          graceSec: restGrace,
          disarmOnUserWake: restDisarmOnWake,
        },
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

  return (
    <div className="editor">
      <TabBar tabs={visibleTabs} active={tab} onSelect={setTab} className="editor-tabs" label="Settings" sections>
      <div className="editor-body">
        {tab === 'general' && (
          <div className="form">
            <FormGroup>
              <Field label="Default environment">
                <SelectInput autoFocus value={defaultEnvId} onChange={(e) => setDefaultEnvId(e.target.value)}>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Move completed tasks to folder">
                <SelectInput value={completedFolderId} onChange={(e) => setCompletedFolderId(e.target.value)}>
                  <option value="">Leave them where they are</option>
                  <FolderOptions folders={folders} />
                </SelectInput>
              </Field>
            </FormGroup>
            <FormGroup>
              <CheckboxField label="Stagger overdue tasks on startup" checked={staggerEnabled} onChange={setStaggerEnabled} />
              <StepFields row on={staggerEnabled}>
                <NumberField label="Minimum delay" suffix="s" min={0} value={staggerMin} onChange={setStaggerMin} />
                <NumberField label="Maximum delay" suffix="s" min={1} value={staggerMax} onChange={setStaggerMax} />
                <NumberField label="Minimum interval" suffix="s" min={0} value={staggerInterval} onChange={setStaggerInterval} />
              </StepFields>
            </FormGroup>
            <RadioField
              label="Open terminal sessions in"
              name="terminal"
              value={terminal}
              options={[
                ['looper', 'Looper'],
                ['system', 'Default terminal'],
              ]}
              onChange={setTerminal}
            />
            <FormGroup>
              <CheckboxField label="Show run options before manually running a task" checked={promptRunOptions} onChange={setPromptRunOptions} />
              <CheckboxField label="Show notifications" checked={notificationsEnabled} onChange={setNotificationsEnabled} />
              <CheckboxField label="Close to system tray" checked={closeToTray} onChange={setCloseToTray} />
              <CheckboxField label="Ask before quitting while tasks are running" checked={confirmQuitRuns} onChange={setConfirmQuitRuns} />
              <StepFields row on={confirmQuitRuns}>
                <CheckboxField label="Also while tasks are watching for events" checked={confirmQuitWatchers} onChange={setConfirmQuitWatchers} />
              </StepFields>
              <CheckboxField label="Start with the computer" checked={startWithSystem} onChange={setStartWithSystem} />
            </FormGroup>
          </div>
        )}

        {tab === 'chats' && (
          <div className="form">
            <FormGroup>
              <CheckboxField label="Show thinking expanded" checked={chats.expandThinking} onChange={(on) => setChats({ ...chats, expandThinking: on })} />
            </FormGroup>
            <FormGroup>
              <CheckboxField label="Ask before closing a conversation" checked={chats.confirmClose} onChange={(on) => setChats({ ...chats, confirmClose: on })} />
              <StepFields row on={chats.confirmClose}>
                <CheckboxField
                  label="Close conversations without asking once their cache has expired"
                  checked={chats.closeExpiredWithoutAsking}
                  onChange={(on) => setChats({ ...chats, closeExpiredWithoutAsking: on })}
                />
              </StepFields>
              <CheckboxField
                label="Stop the harness once a conversation’s cache expires"
                checked={chats.stopWhenCacheExpires}
                onChange={(on) => setChats({ ...chats, stopWhenCacheExpires: on })}
              />
            </FormGroup>
            <FormGroup>
              <CheckboxField
                label="Ask before sending a message once the cache has expired"
                checked={chats.confirmExpiredSend.enabled}
                onChange={(on) => setChats({ ...chats, confirmExpiredSend: { ...chats.confirmExpiredSend, enabled: on } })}
              />
              <StepFields on={chats.confirmExpiredSend.enabled}>
                <InlineField>
                  <CheckboxField
                    label="Only when the context is larger than"
                    checked={chats.confirmExpiredSend.onlyAbove}
                    onChange={(on) => setChats({ ...chats, confirmExpiredSend: { ...chats.confirmExpiredSend, onlyAbove: on } })}
                  />
                  {/* Thousands of tokens on screen; the setting stays in tokens, 1k at least. */}
                  <NumberInput
                    label="Context size"
                    suffix="k tokens"
                    min={1}
                    disabled={!chats.confirmExpiredSend.onlyAbove}
                    value={chats.confirmExpiredSend.aboveTokens / 1000}
                    onChange={(n) => setChats({ ...chats, confirmExpiredSend: { ...chats.confirmExpiredSend, aboveTokens: Math.round(n * 1000) } })}
                    onBlur={() =>
                      chats.confirmExpiredSend.aboveTokens < 1000 &&
                      setChats({ ...chats, confirmExpiredSend: { ...chats.confirmExpiredSend, aboveTokens: 1000 } })
                    }
                  />
                </InlineField>
              </StepFields>
            </FormGroup>
            <FormGroup>
              <CheckboxField
                label="Continue chats once the usage limit resets"
                checked={chats.continueAfterLimit}
                onChange={(on) => setChats({ ...chats, continueAfterLimit: on })}
              />
              <InlineField>
                <CheckboxField
                  label="Don’t continue once the cache has expired and the context is larger than"
                  checked={chats.skipExpiredContinue.enabled}
                  onChange={(on) => setChats({ ...chats, skipExpiredContinue: { ...chats.skipExpiredContinue, enabled: on } })}
                />
                <NumberInput
                  label="Context size for continuing"
                  suffix="k tokens"
                  min={0}
                  disabled={!chats.skipExpiredContinue.enabled}
                  value={chats.skipExpiredContinue.aboveTokens / 1000}
                  onChange={(n) => setChats({ ...chats, skipExpiredContinue: { ...chats.skipExpiredContinue, aboveTokens: Math.max(0, Math.round(n * 1000)) } })}
                />
              </InlineField>
            </FormGroup>
          </div>
        )}

        {tab === 'rest' && (
          <div className="form">
            <FormGroup>
              <NumberField label="Minimum sleep" suffix="min" min={1} value={restMinSleep} onChange={setRestMinSleep} />
              <NumberField label="Wait before sleeping" suffix="s" min={1} value={restGrace} onChange={setRestGrace} />
              <CheckboxField label="Turn off when the computer is woken manually" checked={restDisarmOnWake} onChange={setRestDisarmOnWake} />
            </FormGroup>
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
              menu={(e) => [
                { label: 'Edit…', run: () => void window.looper.openEnvironmentEditor(e.id) },
                { label: 'Duplicate', run: () => void duplicateEnv(e) },
                { label: 'Remove', destructive: true, enabled: envs.length > 1, run: () => void removeEnv(e) },
              ]}
              onDelete={(e) => void removeEnv(e)}
            />
            <ListActions
              item="Environment"
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
            <FormGroup>
              <Field label="Tasks file">
                <InputRow>
                  <TextInput type="text" readOnly value={tasksFile ?? defaultFile('tasks')} />
                  <button className="btn" onClick={() => void browseStoreFile('tasks')}>Browse…</button>
                  {tasksFile && <button className="btn" onClick={() => void resetStoreFile('tasks')}>Reset</button>}
                </InputRow>
              </Field>
              <Field label="Templates file">
                <InputRow>
                  <TextInput type="text" readOnly value={templatesFile ?? defaultFile('templates')} />
                  <button className="btn" onClick={() => void browseStoreFile('templates')}>Browse…</button>
                  {templatesFile && <button className="btn" onClick={() => void resetStoreFile('templates')}>Reset</button>}
                </InputRow>
              </Field>
            </FormGroup>
            <FormGroup>
              <NumberField label="Run log retention" suffix="days" min={1} value={retentionDays} onChange={setRetentionDays} />
              <NumberField label="Engine log retention" suffix="days" min={1} value={engineLogDays} onChange={setEngineLogDays} />
            </FormGroup>
            <FormGroup>
              <CheckboxField label="Move completed tasks to the Recycle Bin" checked={deleteCompleted} onChange={setDeleteCompleted} />
              <StepFields row on={deleteCompleted}>
                <NumberField label="After" suffix="days" min={1} value={completedDays} onChange={setCompletedDays} />
              </StepFields>
              <NumberField label="Delete tasks in the Recycle Bin after" suffix="days" min={1} value={binDays} onChange={setBinDays} />
            </FormGroup>
            <RadioField
              label="Show conversations with the agent in"
              name="builder-view"
              value={builderView}
              options={[
                ['chat', 'Chat window'],
                ['terminal', 'Terminal'],
              ]}
              onChange={setBuilderView}
            />
          </div>
        )}

      </div>
      </TabBar>
      <WindowActions confirm={{ label: 'Save', run: () => void save() }} apply={{ run: () => void apply() }} busy={saving} />
    </div>
  );
}
