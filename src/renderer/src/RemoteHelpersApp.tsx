import { useEffect, useState } from 'react';
import type { RemoteHelper, Settings } from '@shared/types';
import { defaultEnvironment } from '@shared/environments';
import { ListActions, SelectList } from './components/SelectList';
import { claudeHarnesses } from './components/RemoteFields';
import { EmptyWindow } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useLiveSettings } from './components/hooks';
import { keptSelection } from './components/selection';
import { rid } from '@shared/rid';
import { subscribe } from './events';
import { reportError } from './report-error';

/**
 * Advanced → Remote Control → Helpers. The list is managed live through the
 * helper editor windows, so the window only closes. Projects keep
 * conversations open through their own Edit Project window.
 */
export function RemoteHelpersApp() {
  const { live } = useLiveSettings();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [chosen, setHelper] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Helpers';
    void window.looper.remote.state().then((s) => setProblems(s.problems));
    return subscribe((e) => {
      if (e.type === 'remote') setProblems(e.state.problems);
    });
  }, []);

  if (!live) return <EmptyWindow />;

  const r = live.remote;
  const helpers = r.helpers;
  const helper = keptSelection(chosen, helpers, (h) => h.id);
  const selHelper = helpers.find((h) => h.id === helper);
  const envName = (id: string) => live.environments.find((e) => e.id === id)?.name ?? id;

  const update = async (remote: Settings['remote']) => {
    try {
      await window.looper.updateSettings({ remote });
    } catch (e) {
      reportError(e);
    }
  };

  /** Where a new helper starts: the default environment, or the first with a Claude Code harness. */
  const defaultEnvId = () => defaultEnvironment(live, (e) => claudeHarnesses(e).length > 0)?.id ?? live.defaultEnvironmentId;

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
              { label: 'Remove', destructive: true, run: () => void removeHelper(h) },
            ]}
            onDelete={(h) => void removeHelper(h)}
          />
          <ListActions
            item="Helper"
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
      <WindowActions close />
    </div>
  );
}
