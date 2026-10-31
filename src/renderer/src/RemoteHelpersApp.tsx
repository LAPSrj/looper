import { useEffect, useState } from 'react';
import type { RemoteHelper, Settings } from '@shared/types';
import { useDialogKeys } from './components/hooks';
import { ListActions, SelectList } from './components/SelectList';
import { claudeHarnesses } from './components/RemoteFields';

const rid = () => Math.random().toString(36).slice(2, 8);

/**
 * Advanced → Remote Control → Helpers. The list is managed live through the
 * helper editor windows, so the window only closes. Projects keep
 * conversations open through their own Edit Project window.
 */
export function RemoteHelpersApp() {
  const [live, setLive] = useState<Settings | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [helper, setHelper] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Helpers';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setHelper((s) => s ?? info.settings.remote.helpers[0]?.id ?? null);
    });
    void window.looper.remote.state().then((s) => setProblems(s.problems));
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') setLive(e.settings);
      else if (e.type === 'remote') setProblems(e.state.problems);
    });
  }, []);

  useDialogKeys({ onCancel: () => window.close() });

  if (!live) return <div className="empty">Loading…</div>;

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
  // Each command takes the helper it acts on (the selected one for a button, the clicked row for the menu).
  const duplicateHelper = async (from: RemoteHelper | undefined = selHelper) => {
    if (!from) return;
    const copy: RemoteHelper = { ...from, id: `h-${rid()}`, name: `${from.name} (copy)` };
    await update({ ...r, helpers: [...helpers, copy] });
    setHelper(copy.id);
  };
  const removeHelper = async (target: RemoteHelper | undefined = selHelper) => {
    if (!target) return;
    if (!(await window.looper.confirm(`Remove helper "${target.name}"?`))) return;
    await update({ ...r, helpers: helpers.filter((h) => h.id !== target.id) });
    setHelper(helpers.find((h) => h.id !== target.id)?.id ?? null);
  };

  /** A row's second line: where it runs, then why it has no conversation when Remote Control can't start one. */
  const sub = (where: string, key: string) => [where, problems[key]].filter(Boolean).join(' · ');

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
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
            autoFocus
            menu={(h) => [
              { label: 'Edit…', run: () => void window.looper.remote.openHelperEditor(h.id) },
              { label: 'Duplicate', run: () => void duplicateHelper(h) },
              { label: 'Remove', run: () => void removeHelper(h) },
            ]}
            onDelete={(h) => void removeHelper(h)}
          />
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
      <div className="editor-footer">
        <button className="btn" onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}
