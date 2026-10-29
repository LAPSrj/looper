import { useEffect, useRef, useState } from 'react';
import { environmentsFor, sideName, type AddonInfo, type AddonLocalRun, type AddonSide } from '@shared/addons';
import type { Environment } from '@shared/types';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';
import { EditorFooter, Field } from './components/ui';

const STATUS: Record<AddonInfo['status'], string> = { starting: 'Starting', running: 'Running', stopped: 'Stopped' };

/** Advanced → Addons…: the installed addons. Install, Start/Stop, Restart and Remove apply at once. */
export function AddonsApp() {
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Addons';
    void window.looper.addons.list().then((list) => {
      setAddons(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    });
    return window.looper.addons.onEvent((e) => {
      if (e.type !== 'addons') return;
      setAddons(e.addons);
      setSelected((s) => (s && e.addons.some((a) => a.id === s) ? s : (e.addons[0]?.id ?? null)));
    });
  }, []);

  useDialogKeys({ onCancel: () => window.close() });

  const addon = addons.find((a) => a.id === selected);
  // Stop shows while it runs; Start otherwise, which also brings back one that stopped on its own.
  const running = addon?.status === 'running' || addon?.status === 'starting';

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={addons}
            label="Addons"
            idPrefix="addon"
            selectedKey={selected}
            itemKey={(a) => a.id}
            itemName={(a) => `${a.name} ${a.version}`}
            itemSub={(a) => STATUS[a.status]}
            empty="No addons"
            onSelect={(a) => setSelected(a.id)}
            onOpen={(a) => void window.looper.addons.edit(a.id)}
          />
          <div className="env-actions">
            <button className="btn" onClick={() => void window.looper.addons.install()}>
              Install…
            </button>
            <button className="btn" disabled={!addon} onClick={() => addon && void window.looper.addons.edit(addon.id)}>
              Edit…
            </button>
            <button className="btn" disabled={!addon} onClick={() => addon && void window.looper.addons.setEnabled(addon.id, !running)}>
              {running ? 'Stop' : 'Start'}
            </button>
            <button className="btn" disabled={!addon?.enabled} onClick={() => addon && void window.looper.addons.restart(addon.id)}>
              Restart
            </button>
            <button className="btn danger" disabled={!addon} onClick={() => addon && void window.looper.addons.remove(addon.id)}>
              Remove
            </button>
          </div>
          {addon && (
            <dl className="props addon-details">
              {addon.description && (
                <>
                  <dt>Description</dt>
                  <dd>{addon.description}</dd>
                </>
              )}
              <dt>Runs</dt>
              <dd className="mono addon-wrap">{addon.run}</dd>
              {addon.localRun && (
                <>
                  <dt />
                  <dd className="muted">Changed in Edit…</dd>
                </>
              )}
              <dt>Panes</dt>
              <dd>{addon.panes.map((p) => p.title).join(', ') || 'None'}</dd>
              {addon.error && (
                <>
                  <dt>Stopped</dt>
                  <dd className="mono addon-wrap">{addon.error}</dd>
                </>
              )}
            </dl>
          )}
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

interface RunDraft {
  environmentId: string;
  command: string;
  cwd: string;
  env: string;
}

const toDraft = (environmentId: string | undefined, r: { command: string[]; cwd?: string; env?: Record<string, string> }): RunDraft => ({
  environmentId: environmentId ?? '',
  command: joinTokens(r.command),
  cwd: r.cwd ?? '',
  env: envToLine(r.env ?? {}),
});

/** The draft as this user's run settings, or why it can't be one. */
function fromDraft(d: RunDraft, side: AddonSide): AddonLocalRun | string {
  if (!d.environmentId) return `Environment: add one that runs ${sideName(side)} programs in Settings → Environments.`;
  const cmd = tokenize(d.command);
  if (!cmd.ok) return `Command: ${cmd.error}`;
  if (!cmd.tokens.length) return 'Command: enter the program to run.';
  const env = lineToEnv(d.env);
  if (typeof env === 'string') return `Environment variables: ${env}`;
  return {
    environmentId: d.environmentId,
    command: cmd.tokens,
    ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Advanced → Addons… → Edit…: where and how this user's Looper runs the addon. */
export function AddonEditApp({ addonId }: { addonId: string }) {
  const [addon, setAddon] = useState<AddonInfo | null | undefined>(undefined);
  const [draft, setDraft] = useState<RunDraft | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([window.looper.addons.list(), window.looper.info()]).then(([list, info]) => {
      const a = list.find((x) => x.id === addonId) ?? null;
      setAddon(a);
      if (!a) return;
      setEnvironments(environmentsFor(a.ownRun.on, info.settings.environments, info.host));
      setDraft(toDraft(a.environmentId, a.localRun ?? a.ownRun));
      document.title = a.name;
    });
  }, [addonId]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (addon === null) return <div className="empty">This addon is no longer installed.</div>;
  if (!addon || !draft) return <div className="empty">Loading…</div>;

  const patch = (p: Partial<RunDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const run = fromDraft(draft, addon.ownRun.on);
  const defaults = toDraft(addon.defaultEnvironmentId, addon.ownRun);
  const isDefault = JSON.stringify(draft) === JSON.stringify(defaults);

  const doSave = async (): Promise<boolean> => {
    if (typeof run === 'string') {
      void window.looper.showError(run);
      return false;
    }
    setSaving(true);
    try {
      // The addon's own settings are saved as no change, so a new version's settings apply.
      await window.looper.addons.setRun(addon.id, isDefault ? null : run);
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (await doSave()) window.close();
  };
  saveRef.current = save;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          {/* Only the environments that run programs on the addon's side (Settings → Environments). */}
          <Field label="Environment">
            <select value={draft.environmentId} onChange={(e) => patch({ environmentId: e.target.value })}>
              {environments.length === 0 && <option value="">No environment runs {sideName(addon.ownRun.on)} programs</option>}
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Command">
            <input autoFocus className="mono" value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
          </Field>
          <Field label="Working folder">
            <input className="mono" value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
          </Field>
          <Field label="Environment variables">
            <input className="mono" value={draft.env} placeholder="NAME=value" onChange={(e) => patch({ env: e.target.value })} />
          </Field>
          <div className="env-actions">
            <button className="btn" disabled={isDefault} onClick={() => setDraft(defaults)}>
              Restore Defaults
            </button>
          </div>
        </div>
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} onApply={() => void doSave()} saving={saving} />
    </div>
  );
}
