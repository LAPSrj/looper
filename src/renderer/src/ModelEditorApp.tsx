import { useEffect, useRef, useState } from 'react';
import type { Harness, HarnessModel, Settings } from '@shared/types';
import { DEFAULT_MODELS, harnessModels, sameModels } from '@shared/environments';
import { Field, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

function findHarness(settings: Settings, envId: string, harnessId: string): Harness | undefined {
  return settings.environments.find((e) => e.id === envId)?.harnesses.find((h) => h.id === harnessId);
}

/** Standalone model editor window (Harness → Models → Add/Edit). No index = add. */
export function ModelEditorApp({ envId, harnessId, index }: { envId: string; harnessId: string; index?: number }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
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
      if (index !== undefined) {
        const model = harnessModels(harness)[index];
        if (!model) {
          setMissing(true);
          return;
        }
        setId(model.id);
        setName(model.name);
        document.title = model.name;
      }
    });
    return window.looper.onEvent((e) => {
      if (e.type !== 'settings') return;
      setSettings(e.settings);
      const harness = findHarness(e.settings, envId, harnessId);
      if (!harness || (index !== undefined && index >= harnessModels(harness).length)) setMissing(true);
    });
  }, [envId, harnessId, index, isNew]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This model no longer exists.</div>;
  if (!settings) return <div className="empty">Loading…</div>;

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
    const entry: HarnessModel = { id: trimmedId, name: name.trim() || trimmedId };
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
  saveRef.current = save;

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
        </div>
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} saving={saving} />
    </div>
  );
}
