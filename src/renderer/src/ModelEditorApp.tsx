import { useEffect, useState } from 'react';
import type { Harness, HarnessModel, Settings } from '@shared/types';
import { DEFAULT_MODELS, EFFORT_LEVELS, harnessModels, sameModels } from '@shared/environments';
import { EmptyWindow, Field, ToggleButtons } from './components/ui';
import { WindowActions } from './components/WindowActions';

function findHarness(settings: Settings, envId: string, harnessId: string): Harness | undefined {
  return settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
}

/** Standalone model editor window (Harness → Models → Add/Edit). No index = add. */
export function ModelEditorApp({ envId, harnessId, index, copyOf }: { envId: string; harnessId: string; index?: number; copyOf?: number }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  // Effort levels the model offers ([] until the harness kind is known) and
  // the level a task's Default resolves to ('' = omit the flag, CLI decides).
  const [efforts, setEfforts] = useState<string[]>([]);
  const [defaultEffort, setDefaultEffort] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const isNew = index === undefined;

  useEffect(() => {
    document.title = isNew ? 'New Model' : 'Edit Model';
    void window.looper.info().then((info) => {
      setSettings(info.settings);
      const harness = findHarness(info.settings, envId, harnessId);
      if (!harness) {
        setMissing(true);
        return;
      }
      const kindLevels = harness.kind === 'custom' ? [] : EFFORT_LEVELS[harness.kind];
      if (index !== undefined) {
        const model = harnessModels(harness)[index];
        if (!model) {
          setMissing(true);
          return;
        }
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
    });
    return window.looper.onEvent((e) => {
      if (e.type !== 'settings') return;
      setSettings(e.settings);
      const harness = findHarness(e.settings, envId, harnessId);
      if (!harness || (index !== undefined && index >= harnessModels(harness).length)) setMissing(true);
    });
  }, [envId, harnessId, index, isNew, copyOf]);

  if (missing || !settings) return <EmptyWindow gone={missing && 'This model no longer exists.'} />;

  const kind = findHarness(settings, envId, harnessId)?.kind ?? 'claude-code';
  const kindLevels = kind === 'custom' ? [] : EFFORT_LEVELS[kind];
  const setLevels = (next: string[]) => {
    setEfforts(next);
    if (!next.includes(defaultEffort)) setDefaultEffort('');
  };

  const doSave = async (): Promise<boolean> => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      void window.looper.showError('Model id is required.');
      return false;
    }
    const harness = findHarness(settings, envId, harnessId);
    if (!harness) {
      setMissing(true);
      return false;
    }
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
    else {
      setMissing(true);
      return false;
    }
    const models = sameModels(list, DEFAULT_MODELS[harness.kind]) ? undefined : list;
    const environments = settings.environments.map((e) =>
      e.id === envId ? { ...e, harnesses: e.harnesses.map((h) => (h.id === harnessId ? { ...h, models } : h)) } : e,
    );
    setSaving(true);
    try {
      await window.looper.updateSettings({ environments });
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => { if (await doSave()) window.close(); };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Model id">
            <input autoFocus className="mono" value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label="Display name">
            <input value={name} placeholder={id.trim() || undefined} onChange={(e) => setName(e.target.value)} />
          </Field>
          {kindLevels.length > 0 && (
            <>
              <Field label="Effort levels">
                <ToggleButtons options={kindLevels} value={efforts} onChange={setLevels} label="Effort levels" />
              </Field>
              <Field label="Default effort">
                <select value={defaultEffort} onChange={(e) => setDefaultEffort(e.target.value)}>
                  <option value="">CLI default</option>
                  {kindLevels
                    .filter(([value]) => efforts.includes(value))
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          )}
        </div>
      </div>
      <WindowActions confirm={{ label: isNew ? 'Create' : 'Save', run: () => void save() }} busy={saving} />
    </div>
  );
}
