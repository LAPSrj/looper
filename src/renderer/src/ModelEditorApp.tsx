import { useEffect, useState } from 'react';
import type { Harness, HarnessModel, Settings } from '@shared/types';
import { DEFAULT_MODELS, EFFORT_LEVELS, harnessModels, sameModels } from '@shared/environments';
import { EmptyWindow, Field, FormGroup, SelectInput, TextInput, CheckboxChoices } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useLiveSettings, useSave } from './components/hooks';

function findHarness(settings: Settings, envId: string, harnessId: string): Harness | undefined {
  return settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
}

/** Standalone model editor window (Harness → Models → Add/Edit). No index = add. */
export function ModelEditorApp({ envId, harnessId, index, copyOf }: { envId: string; harnessId: string; index?: number; copyOf?: number }) {
  const { live: settings, missing } = useLiveSettings((s) => {
    const harness = findHarness(s, envId, harnessId);
    return !!harness && (index === undefined || index < harnessModels(harness).length);
  });
  const [loaded, setLoaded] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  // Effort levels the model offers ([] until the harness kind is known) and
  // the level a task's Default resolves to ('' = omit the flag, CLI decides).
  const [efforts, setEfforts] = useState<string[]>([]);
  const [defaultEffort, setDefaultEffort] = useState('');
  const saver = useSave();
  const isNew = index === undefined;

  useEffect(() => {
    document.title = isNew ? 'New Model' : 'Edit Model';
  }, [isNew]);

  // The fields start from the settings as they first arrive.
  useEffect(() => {
    if (!settings || loaded) return;
    setLoaded(true);
    const harness = findHarness(settings, envId, harnessId);
    if (!harness) return;
    const kindLevels = harness.kind === 'custom' ? [] : EFFORT_LEVELS[harness.kind];
    if (index !== undefined) {
      const model = harnessModels(harness)[index];
      if (!model) return;
      setId(model.id);
      setName(model.name);
      setEfforts(model.efforts ?? kindLevels.map(([v]) => v));
      setDefaultEffort(model.defaultEffort ?? '');
    } else if (copyOf !== undefined && harnessModels(harness)[copyOf]) {
      // Duplicate: a new model that starts as a copy; its id must be changed before Create.
      const model = harnessModels(harness)[copyOf];
      setId(model.id);
      setName(`${model.name} (copy)`);
      setEfforts(model.efforts ?? kindLevels.map(([v]) => v));
      setDefaultEffort(model.defaultEffort ?? '');
    } else {
      // New entries start fully offered with an explicit Medium default, so
      // runs are predictable out of the box; "CLI default" is a deliberate choice.
      setEfforts(kindLevels.map(([v]) => v));
      setDefaultEffort(kindLevels.some(([v]) => v === 'medium') ? 'medium' : '');
    }
  }, [settings, loaded, envId, harnessId, index, copyOf]);

  if (missing || !settings) return <EmptyWindow gone={missing && 'This model no longer exists.'} />;

  const kind = findHarness(settings, envId, harnessId)?.kind ?? 'claude-code';
  const kindLevels = kind === 'custom' ? [] : EFFORT_LEVELS[kind];
  const setLevels = (next: string[]) => {
    setEfforts(next);
    if (!next.includes(defaultEffort)) setDefaultEffort('');
  };

  const doSave = async () => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      void window.looper.showError('Model id is required.');
      return false;
    }
    // Gone: `missing` shows it.
    const harness = findHarness(settings, envId, harnessId);
    if (!harness) return false;
    const list = harnessModels(harness).slice();
    // Task and project pickers find a model by its id, so each id appears once.
    if (list.some((m, i) => m.id === trimmedId && i !== index)) {
      void window.looper.showError('A model with this id already exists.');
      return false;
    }
    // The full kind list is stored as unset, and the order is the kind's, not click order.
    const ordered = kindLevels.map(([v]) => v).filter((v) => efforts.includes(v));
    const entry: HarnessModel = {
      id: trimmedId,
      name: name.trim() || trimmedId,
      efforts: kindLevels.length === 0 || ordered.length === kindLevels.length ? undefined : ordered,
      defaultEffort: defaultEffort || undefined,
    };
    if (index === undefined) list.push(entry);
    else if (index < list.length) list[index] = entry;
    else return false;
    const models = sameModels(list, DEFAULT_MODELS[harness.kind]) ? undefined : list;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? { ...h, models } : h)) } : e,
    );
    await window.looper.updateSettings({ environments });
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Model id">
              <TextInput autoFocus code value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label="Display name">
              <TextInput value={name} placeholder={id.trim() || undefined} onChange={(e) => setName(e.target.value)} />
            </Field>
          </FormGroup>
          {kindLevels.length > 0 && (
            <FormGroup>
              <Field label="Effort levels">
                <CheckboxChoices options={kindLevels} value={efforts} onChange={setLevels} label="Effort levels" />
              </Field>
              <Field label="Default effort">
                <SelectInput value={defaultEffort} onChange={(e) => setDefaultEffort(e.target.value)}>
                  <option value="">CLI default</option>
                  {kindLevels
                    .filter(([value]) => efforts.includes(value))
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </SelectInput>
              </Field>
            </FormGroup>
          )}
        </div>
      </div>
      <WindowActions draft={loaded ? [id, name, efforts, defaultEffort] : null} confirm={{ label: isNew ? 'Create' : 'Save', run: () => saver.save(doSave) }} busy={saver.busy} />
    </div>
  );
}
