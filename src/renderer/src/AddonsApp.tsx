import { useEffect, useState } from 'react';
import { environmentsFor, sideName, type AddonInfo, type AddonLocalRun, type AddonRun } from '@shared/addons';
import { envToLine, joinTokens } from '@shared/cmdline';
import { PropertyList } from './components/PropertyList';
import { ListActions, ListButton, SelectList } from './components/SelectList';
import { EmptyWindow, Field, FormGroup, SelectInput, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { parseArgsEnv } from './components/form-blocks';
import { useLiveSettings, useSave } from './components/hooks';
import { keptSelection } from './components/selection';
import { useAddonList } from './live-state';

const STATUS: Record<AddonInfo['status'], string> = { starting: 'Starting', running: 'Running', stopped: 'Stopped' };

/** Advanced → Addons…: the installed addons. Install, Start/Stop, Restart and Remove apply at once. */
export function AddonsApp() {
  const { addons } = useAddonList();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Addons';
  }, []);

  useEffect(() => {
    setSelected((s) => keptSelection(s, addons, (a) => a.id));
  }, [addons]);

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
            autoFocus
            menu={(a) => {
              const on = a.status === 'running' || a.status === 'starting';
              return [
                { label: 'Edit…', run: () => void window.looper.addons.edit(a.id) },
                { label: on ? 'Stop' : 'Start', run: () => void window.looper.addons.setEnabled(a.id, !on) },
                { label: 'Restart', enabled: a.enabled, run: () => void window.looper.addons.restart(a.id) },
                { label: 'Remove', destructive: true, run: () => void window.looper.addons.remove(a.id) },
              ];
            }}
            onDelete={(a) => void window.looper.addons.remove(a.id)}
          />
          <ListActions>
            <ListButton onClick={() => void window.looper.addons.install()}>Install…</ListButton>
            <ListButton row disabled={!addon} onClick={() => addon && void window.looper.addons.edit(addon.id)}>
              Edit…
            </ListButton>
            <ListButton row disabled={!addon} onClick={() => addon && void window.looper.addons.setEnabled(addon.id, !running)}>
              {running ? 'Stop' : 'Start'}
            </ListButton>
            <ListButton row disabled={!addon?.enabled} onClick={() => addon && void window.looper.addons.restart(addon.id)}>
              Restart
            </ListButton>
            <ListButton row danger disabled={!addon} onClick={() => addon && void window.looper.addons.remove(addon.id)}>
              Remove
            </ListButton>
          </ListActions>
          {addon && (
            <PropertyList
              className="props addon-details"
              rows={{ title: addon.name }}
              items={[
                !!addon.description && { label: 'Description', value: addon.description },
                { label: 'Runs', value: addon.run, className: 'mono addon-wrap', note: addon.localRun ? 'Changed in Edit…' : undefined },
                { label: 'Panes', value: addon.panes.map((p) => p.title).join(', ') || 'None' },
                !!addon.error && { label: 'Stopped', value: addon.error, className: 'addon-wrap', tone: 'error' },
              ]}
            />
          )}
        </div>
      </div>
      <WindowActions close />
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

/** The draft as this user's run settings, or why it can't be one. A `looper` addon runs with Looper's own Node, in no environment. */
function fromDraft(d: RunDraft, side: AddonRun['on']): AddonLocalRun | string {
  if (side !== 'looper' && !d.environmentId) return `Environment: add one that runs ${sideName(side)} programs in Settings → Environments.`;
  const parsed = parseArgsEnv({ label: 'Command', text: d.command }, { label: 'Environment variables', text: d.env });
  if ('problem' in parsed) return parsed.problem;
  if (!parsed.args.length) return 'Command: enter the program to run.';
  return {
    ...(side !== 'looper' && d.environmentId ? { environmentId: d.environmentId } : {}),
    command: parsed.args,
    ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
    ...(Object.keys(parsed.env).length ? { env: parsed.env } : {}),
  };
}

/** Advanced → Addons… → Edit…: where and how this user's Looper runs the addon. */
export function AddonEditApp({ addonId }: { addonId: string }) {
  const { addons, loaded } = useAddonList();
  const addon = loaded ? (addons.find((x) => x.id === addonId) ?? null) : undefined;
  const [draft, setDraft] = useState<RunDraft | null>(null);
  const { live, host } = useLiveSettings();
  const saver = useSave();

  // The draft starts from the addon as first found; later list changes don't reset it.
  useEffect(() => {
    if (addon) setDraft((d) => d ?? toDraft(addon.environmentId, addon.localRun ?? addon.ownRun));
  }, [addon]);

  useEffect(() => {
    document.title = 'Edit Addon';
  }, []);

  if (!addon || !draft || !live || host === undefined) return <EmptyWindow gone={addon === null && 'This addon is no longer installed.'} />;

  const side = addon.ownRun.on;
  const environments = side === 'looper' ? [] : environmentsFor(side, live.environments, host);
  const patch = (p: Partial<RunDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const run = fromDraft(draft, side);
  const defaults = toDraft(addon.defaultEnvironmentId, addon.ownRun);
  const isDefault = JSON.stringify(draft) === JSON.stringify(defaults);

  const doSave = async () => {
    if (typeof run === 'string') {
      void window.looper.showError(run);
      return false;
    }
    // The addon's own settings are saved as no change, so a new version's settings apply.
    await window.looper.addons.setRun(addon.id, isDefault ? null : run);
  };
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            {/* Only the environments that run programs on the addon's side (Settings → Environments); a `looper` addon runs with Looper's own Node. */}
            {side !== 'looper' && (
              <Field label="Environment">
                <SelectInput value={draft.environmentId} onChange={(e) => patch({ environmentId: e.target.value })}>
                  {environments.length === 0 && <option value="">No environment runs {sideName(side)} programs</option>}
                  {environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            )}
            <Field label="Command">
              <TextInput autoFocus code value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
            </Field>
            <Field label="Working directory">
              <TextInput code value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
            </Field>
            <Field label="Environment variables">
              <TextInput code value={draft.env} placeholder="NAME=value" onChange={(e) => patch({ env: e.target.value })} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions
        confirm={{ label: 'Save', run: () => saver.save(doSave) }}
        apply={{ run: () => void saver.apply(doSave) }}
        extras={[{ id: 'restore-defaults', label: 'Restore Defaults', disabled: isDefault, run: () => setDraft(defaults) }]}
        busy={saver.busy}
      />
    </div>
  );
}
