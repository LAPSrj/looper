import { useEffect, useState } from 'react';
import type { Harness } from '@shared/types';
import { DEFAULT_MODELS, HARNESS_KINDS, harnessKindLabel, harnessOptions, sameModels } from '@shared/environments';
import { envToLine, joinTokens } from '@shared/cmdline';
import { CheckboxField, EmptyWindow, Field, FieldRow, FormGroup, SelectInput, TabBar, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { ConcurrencyLimit, parseArgsEnv } from './components/form-blocks';
import { saveSettings, useDialogKeys, useDiscardUnsaved, useLiveSettings, useSave } from './components/hooks';
import { SelectList, ListActions, ListButton } from './components/SelectList';
import { reportError } from './report-error';

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
  const { live: settings, missing } = useLiveSettings((s) => !!s.environments.find((e) => e.id === envId)?.harnesses.some((h) => h.id === harnessId));
  const [draft, setDraft] = useState<Harness | null>(null);
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [tab, setTab] = useState<HarnessTab>('general');
  const [selectedModel, setSelectedModel] = useState<number | null>(null);
  const saver = useSave();

  const savedRef = useDiscardUnsaved(isNew, () => window.looper.discardHarness(envId, harnessId));

  useEffect(() => {
    document.title = isNew ? 'New Harness' : 'Edit Harness';
  }, [isNew]);

  // The draft starts from the settings as they first arrive; the Models tab edits the live harness through its own editor window.
  useEffect(() => {
    if (!settings || draft) return;
    const harness = settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
    if (!harness) return;
    const copy = JSON.parse(JSON.stringify(harness)) as Harness;
    setDraft(copy);
    setArgsText(joinTokens(copy.args ?? []));
    setEnvText(envToLine(copy.env ?? {}));
  }, [settings, draft, envId, harnessId]);

  useDialogKeys({
    tabs: TABS.map(([id]) => id),
    tab,
    onTab: setTab,
  });

  if (missing || !settings || !draft) return <EmptyWindow gone={missing && 'This harness no longer exists.'} />;

  // Models live on the harness in settings (edited through their own window);
  // everything else is a draft applied on save.
  const live = settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
  const models = live?.models ?? DEFAULT_MODELS[draft.kind];
  const modelIdx = selectedModel !== null && selectedModel < models.length ? selectedModel : null;

  const patch = (p: Partial<Harness>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchOptions = (p: NonNullable<Harness['options']>) => setDraft((d) => (d ? { ...d, options: { ...d.options, ...p } } : d));

  // Takes the model it removes: the selected one for the button, the clicked row for the menu.
  const removeModel = async (at: number | null = modelIdx) => {
    if (at === null) return;
    const next = models.filter((_, i) => i !== at);
    const value = sameModels(next, DEFAULT_MODELS[draft.kind]) ? undefined : next;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? { ...h, models: value } : h)) } : e,
    );
    try {
      await window.looper.updateSettings({ environments });
      setSelectedModel(next.length ? Math.min(at, next.length - 1) : null);
    } catch (e) {
      reportError(e);
    }
  };

  const doSave = async () => {
    const parsed = parseArgsEnv({ label: 'Arguments', text: argsText }, { label: 'Environment variables', text: envText });
    if ('problem' in parsed) {
      void window.looper.showError(parsed.problem);
      return false;
    }
    const folded: Harness = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: parsed.args,
      env: parsed.env,
      models: live?.models,
    };
    folded.options = harnessOptions(folded);
    if (!folded.options) delete folded.options;
    if (!folded.models || sameModels(folded.models, DEFAULT_MODELS[folded.kind])) delete folded.models;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? folded : h)) } : e,
    );
    await saveSettings(settings, { environments });
    savedRef.current = true;
  };

  return (
    <div className="editor">
      <TabBar
        tabs={TABS}
        active={tab}
        onSelect={setTab}
        className="editor-tabs"
        panels={(id) => id === 'general' ? (
        <div className="form">
          <FormGroup>
            <FieldRow>
              <Field label="Name">
                <TextInput autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="Type">
                <SelectInput
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
                </SelectInput>
              </Field>
            </FieldRow>
            <Field label="Command" help={draft.kind === 'custom' ? 'Gets the prompt as its last argument.' : undefined}>
              <TextInput code value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
            </Field>
            <Field label="Default arguments">
              <TextInput code value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            </Field>
            <Field label="Environment variables">
              <TextInput code value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </Field>
          </FormGroup>
          <ConcurrencyLimit value={draft.maxConcurrentTasks} onChange={(max) => patch({ maxConcurrentTasks: max })} />
          {draft.kind !== 'custom' && (
            <FormGroup>
              <Field label={draft.kind === 'claude-code' ? 'Folder trust and MCP server dialogs' : 'Folder trust dialog'}>
                <SelectInput
                  value={draft.options?.autoTrustWorkspace === false ? 'manual' : 'auto'}
                  onChange={(e) => patchOptions({ autoTrustWorkspace: e.target.value === 'auto' ? undefined : false })}
                >
                  <option value="auto">Answer automatically (recommended)</option>
                  <option value="manual">Wait for user</option>
                </SelectInput>
              </Field>
              {draft.kind === 'claude-code' && (
                <>
                  <CheckboxField
                    label="Start new conversations with Remote Control"
                    checked={draft.options?.remoteControl === true}
                    onChange={(on) => patchOptions({ remoteControl: on || undefined })}
                  />
                  <CheckboxField
                    label="Close idle Remote Control conversations once their prompt cache expires"
                    checked={draft.options?.closeWhenCacheExpires !== false}
                    onChange={(on) => patchOptions({ closeWhenCacheExpires: on ? undefined : false })}
                  />
                </>
              )}
            </FormGroup>
          )}
        </div>
        ) : (
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
              menu={(_, i) => [
                { label: 'Edit…', run: () => void window.looper.openModelEditor(envId, harnessId, i) },
                { label: 'Duplicate', run: () => void window.looper.openModelEditor(envId, harnessId, undefined, i) },
                { label: 'Remove', destructive: true, run: () => void removeModel(i) },
              ]}
              onDelete={(_, i) => void removeModel(i)}
            />
            <ListActions
              item="Model"
              onAdd={() => void window.looper.openModelEditor(envId, harnessId)}
              onEdit={() => modelIdx !== null && void window.looper.openModelEditor(envId, harnessId, modelIdx)}
              editDisabled={modelIdx === null}
              // A New Model window starting from this model; nothing is added until Create.
              onDuplicate={() => modelIdx !== null && void window.looper.openModelEditor(envId, harnessId, undefined, modelIdx)}
              duplicateDisabled={modelIdx === null}
              onRemove={() => void removeModel()}
              removeDisabled={modelIdx === null}
            >
              {draft.kind !== 'custom' && <ListButton onClick={() => void window.looper.openModelUpdate(envId, harnessId)}>Update…</ListButton>}
            </ListActions>
          </div>
        )}
      />
      <WindowActions confirm={{ label: 'Save', run: () => saver.save(doSave) }} apply={{ run: () => void saver.apply(doSave) }} busy={saver.busy} />
    </div>
  );
}
