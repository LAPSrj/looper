import { useEffect, useRef, useState } from 'react';
import type { RemoteHelper, Settings } from '@shared/types';
import { EditorFooter, Field } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { ListActions, SelectList } from './components/SelectList';
import { claudeHarnesses } from './components/RemoteFields';

const rid = () => Math.random().toString(36).slice(2, 8);

/**
 * Advanced → Remote Control → Settings. The helper list is managed live
 * through its editor windows; the checkboxes are a draft saved with Save or
 * Apply. Projects keep conversations open through their own Edit Project window.
 */
export function RemoteSettingsApp() {
  const [live, setLive] = useState<Settings | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [startWithLooper, setStartWithLooper] = useState<boolean | null>(null);
  const [closeExpired, setCloseExpired] = useState<boolean | null>(null);
  const [helper, setHelper] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Remote Control';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setStartWithLooper((v) => v ?? info.settings.remote.startWithLooper);
      setCloseExpired((v) => v ?? info.settings.remote.closeWhenCacheExpires);
      setHelper((s) => s ?? info.settings.remote.helpers[0]?.id ?? null);
    });
    void window.looper.remote.state().then((s) => setProblems(s.problems));
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') setLive(e.settings);
      else if (e.type === 'remote') setProblems(e.state.problems);
    });
  }, []);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (!live || startWithLooper === null || closeExpired === null) return <div className="empty">Loading…</div>;

  const r = live.remote;
  const helpers = r.helpers;
  const selHelper = helpers.find((h) => h.id === helper);
  const envName = (id: string) => live.environments.find((e) => e.id === id)?.name ?? id;

  const update = async (remote: Settings['remote']) => {
    try {
      await window.looper.updateSettings({ remote });
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  /** Where a new helper starts: the default environment, or the first with a Claude Code harness. */
  const defaultEnvId = () => {
    const def = live.environments.find((e) => e.id === live.defaultEnvironmentId);
    return (claudeHarnesses(def).length ? def : live.environments.find((e) => claudeHarnesses(e).length))?.id ?? live.defaultEnvironmentId;
  };

  const addHelper = async () => {
    const h: RemoteHelper = { id: `h-${rid()}`, name: 'Helper', environmentId: defaultEnvId(), cwd: '', instructions: '', idleRestartMin: 10 };
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

  const doSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await window.looper.updateSettings({ remote: { ...live.remote, startWithLooper, closeWhenCacheExpires: closeExpired } });
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
  const sub = (where: string, key: string) => [where, problems[key]].filter(Boolean).join(' · ');

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <label className="checkbox-field">
            <input type="checkbox" autoFocus checked={startWithLooper} onChange={(e) => setStartWithLooper(e.target.checked)} />
            Start with Looper
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={closeExpired} onChange={(e) => setCloseExpired(e.target.checked)} />
            Close idle conversations once their prompt cache expires
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
        </div>
      </div>
      <EditorFooter onPrimary={() => void saveRef.current()} onCancel={() => window.close()} onApply={() => void doSave()} saving={saving} />
    </div>
  );
}
