import { useEffect, useRef, useState } from 'react';
import type { Harness, Settings } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { DEFAULT_MODELS, HARNESS_KINDS, harnessKindLabel, sameModels } from '@shared/environments';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { Field, NumberField, TabBar, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { SelectList, ListActions } from './components/SelectList';

const DEFAULT_COMMANDS: Record<Harness['kind'], string> = {
  'claude-code': 'claude',
  codex: 'codex',
  custom: '',
};

type HarnessTab = 'general' | 'models';

const TABS: [HarnessTab, string][] = [
  ['general', 'General'],
  ['models', 'Models'],
];

/** Standalone harness editor window (Environment → Harnesses → Add/Edit). */
export function HarnessEditorApp({ envId, harnessId, isNew }: { envId: string; harnessId: string; isNew?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Harness | null>(null);
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [tab, setTab] = useState<HarnessTab>('general');
  const [selectedModel, setSelectedModel] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Create-on-add: a new harness already exists in settings so this window
  // could open; closing without saving removes it again.
  const savedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    const onUnload = () => {
      if (!savedRef.current) window.looper.discardHarness(envId, harnessId);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [isNew, envId, harnessId]);

  useEffect(() => {
    document.title = isNew ? 'New Harness' : 'Edit Harness';
    void window.looper.info().then((info) => {
      setSettings(info.settings);
      const harness = info.settings.environments
        .find((e) => e.id === envId)
        ?.harnesses.find((h) => h.id === harnessId);
      if (!harness) {
        setMissing(true);
        return;
      }
      const copy = JSON.parse(JSON.stringify(harness)) as Harness;
      setDraft(copy);
      setArgsText(joinTokens(copy.args ?? []));
      setEnvText(envToLine(copy.env ?? {}));
      if (!isNew) document.title = copy.name;
    });
    // The Models tab edits the live harness through its own editor window.
    return window.looper.onEvent((e) => {
      if (e.type !== 'settings') return;
      setSettings(e.settings);
      if (!e.settings.environments.find((x) => x.id === envId)?.harnesses.some((h) => h.id === harnessId)) {
        setMissing(true);
      }
    });
  }, [envId, harnessId, isNew]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({
    onSave: () => void saveRef.current(),
    onCancel: () => window.close(),
    tabs: TABS.map(([id]) => id),
    tab,
    onTab: setTab,
  });

  if (missing) return <div className="empty">This harness no longer exists.</div>;
  if (!settings || !draft) return <div className="empty">Loading…</div>;

  // Models live on the harness in settings (edited through their own window);
  // everything else is a draft applied on save.
  const live = settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
  const models = live?.models ?? DEFAULT_MODELS[draft.kind];
  const modelIdx = selectedModel !== null && selectedModel < models.length ? selectedModel : null;

  const patch = (p: Partial<Harness>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const removeModel = async () => {
    if (modelIdx === null) return;
    const next = models.filter((_, i) => i !== modelIdx);
    const value = sameModels(next, DEFAULT_MODELS[draft.kind]) ? undefined : next;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? { ...h, models: value } : h)) } : e,
    );
    try {
      await window.looper.updateSettings({ environments });
      setSelectedModel(next.length ? Math.min(modelIdx, next.length - 1) : null);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const doSave = async (): Promise<boolean> => {
    const parsedArgs = tokenize(argsText);
    if (!parsedArgs.ok) {
      void window.looper.showError(`Arguments: ${parsedArgs.error}`);
      return false;
    }
    const parsedEnv = lineToEnv(envText);
    if (typeof parsedEnv === 'string') {
      void window.looper.showError(`Environment variables: ${parsedEnv}`);
      return false;
    }
    const folded: Harness = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: parsedArgs.tokens,
      env: parsedEnv,
      models: live?.models,
    };
    if (folded.kind === 'custom' || folded.options?.autoTrustWorkspace !== false) delete folded.options;
    if (!folded.models || sameModels(folded.models, DEFAULT_MODELS[folded.kind])) delete folded.models;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? folded : h)) } : e,
    );
    const parsed = SettingsSchema.safeParse({ ...settings, environments });
    if (!parsed.success) {
      void window.looper.showError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
      return false;
    }
    setSaving(true);
    try {
      await window.looper.updateSettings({ environments: parsed.data.environments });
      savedRef.current = true;
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
          <div className="row">
            <Field label="Name">
              <input autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="Type">
              <select
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as Harness['kind'];
                  const p: Partial<Harness> = { kind };
                  // Only swap command and name while they still are another kind's defaults.
                  if (Object.values(DEFAULT_COMMANDS).includes(draft.command.trim()) && DEFAULT_COMMANDS[kind]) {
                    p.command = DEFAULT_COMMANDS[kind];
                  }
                  if (HARNESS_KINDS.some(([, label]) => label === draft.name.trim())) {
                    p.name = harnessKindLabel(kind);
                  }
                  patch(p);
                }}
              >
                {HARNESS_KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Command" help={draft.kind === 'custom' ? 'Gets the prompt as its last argument.' : undefined}>
            <input className="mono" value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
          </Field>
          <Field label="Default arguments">
            <input className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
          </Field>
          <Field label="Shell environment variables">
            <input className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} />
          </Field>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={draft.maxConcurrentTasks !== undefined}
              onChange={(e) => patch({ maxConcurrentTasks: e.target.checked ? 1 : undefined })}
            />
            Limit concurrent tasks
          </label>
          {draft.maxConcurrentTasks !== undefined && (
            <NumberField
              label="Maximum concurrent tasks"
              suffix="tasks"
              min={1}
              value={draft.maxConcurrentTasks}
              onChange={(n) => patch({ maxConcurrentTasks: n })}
            />
          )}
          {draft.kind !== 'custom' && (
            <Field label="Folder trust dialog">
              <select
                value={draft.options?.autoTrustWorkspace === false ? 'manual' : 'auto'}
                onChange={(e) =>
                  patch({ options: e.target.value === 'auto' ? undefined : { autoTrustWorkspace: false } })
                }
              >
                <option value="auto">Answer automatically (recommended)</option>
                <option value="manual">Wait for user</option>
              </select>
            </Field>
          )}
        </div>
        )}
        {tab === 'models' && (
          <div className="form env-tab">
            <SelectList
              items={models}
              label="Models"
              idPrefix="model"
              selectedKey={modelIdx !== null ? String(modelIdx) : null}
              itemKey={(_, i) => String(i)}
              itemName={(m) => m.name}
              itemSub={(m) => m.id}
              onSelect={(_, i) => setSelectedModel(i)}
              onOpen={(_, i) => void window.looper.openModelEditor(envId, harnessId, i)}
            />
            <ListActions
              onAdd={() => void window.looper.openModelEditor(envId, harnessId)}
              onEdit={() => modelIdx !== null && void window.looper.openModelEditor(envId, harnessId, modelIdx)}
              editDisabled={modelIdx === null}
              onRemove={() => void removeModel()}
              removeDisabled={modelIdx === null}
            >
              {draft.kind !== 'custom' && (
                <button className="btn" onClick={() => void window.looper.openModelUpdate(envId, harnessId)}>
                  Update…
                </button>
              )}
            </ListActions>
          </div>
        )}
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} onApply={() => void apply()} saving={saving} />
    </div>
  );
}
