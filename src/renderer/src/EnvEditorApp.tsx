import { useEffect, useRef, useState } from 'react';
import type { Environment, Harness, Settings } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { DEFAULT_SHELL, ENVIRONMENT_KINDS, SHELL_PRESETS, availableEnvironmentKinds, harnessKindLabel } from '@shared/environments';
import { Field, TabBar, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { SelectList, ListActions } from './components/SelectList';

type EnvTab = 'general' | 'harnesses' | 'advanced';

const rid = () => Math.random().toString(36).slice(2, 8);

function newHarness(): Harness {
  return { id: `h-${rid()}`, name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} };
}

/** The environment's own fields; harnesses are managed live through their own editor window. */
type EnvDraft = Pick<Environment, 'name' | 'kind' | 'distro' | 'shell' | 'mountPrefix'>;

/** Standalone environment editor window (Settings → Environments → Add/Edit). */
export function EnvEditorApp({ envId, isNew }: { envId: string; isNew?: boolean }) {
  const [live, setLive] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<EnvDraft | null>(null);
  const [tab, setTab] = useState<EnvTab>('general');
  const [host, setHost] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [distros, setDistros] = useState<string[]>([]);
  const [detectedPrefix, setDetectedPrefix] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  /** "Custom" chosen in the Shell dropdown; the free-text field shows regardless of its value. */
  const [customShell, setCustomShell] = useState(false);

  // Create-on-add: a new environment already exists in settings so this window
  // could open; closing without saving removes it again.
  const savedRef = useRef(false);
  useEffect(() => {
    if (!isNew) return;
    const onUnload = () => {
      if (!savedRef.current) window.looper.discardEnvironment(envId);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [isNew, envId]);

  useEffect(() => {
    document.title = isNew ? 'New Environment' : 'Edit Environment';
    void window.looper.listWslDistros().then(setDistros);
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setHost(info.host);
      const env = info.settings.environments.find((e) => e.id === envId);
      if (!env) {
        setMissing(true);
        return;
      }
      const { name, kind, distro, shell, mountPrefix } = env;
      setDraft({ name, kind, distro, shell, mountPrefix });
      setCustomShell(!!shell && !SHELL_PRESETS.some(([cmd]) => cmd === shell));
      setSelected(env.harnesses[0]?.id ?? null);
      if (!isNew) document.title = env.name;
    });
    return window.looper.onEvent((e) => {
      if (e.type !== 'settings') return;
      setLive(e.settings);
      if (!e.settings.environments.some((x) => x.id === envId)) setMissing(true);
    });
  }, [envId, isNew]);

  // The placeholder of the mount-prefix field shows the distro's real automount root.
  const draftKind = draft?.kind;
  const draftDistro = draft?.distro;
  useEffect(() => {
    if (!draftKind || draftKind === 'local') return;
    let stale = false;
    setDetectedPrefix(undefined);
    void window.looper.detectWslMountPrefix(draftKind === 'wsl' ? draftDistro : undefined).then((p) => {
      if (!stale) setDetectedPrefix(p);
    });
    return () => {
      stale = true;
    };
  }, [draftKind, draftDistro]);

  const env = live?.environments.find((e) => e.id === envId);
  const isBridge = draft ? draft.kind !== 'local' : false;
  const posixShell = draft ? draft.kind === 'wsl' || (draft.kind === 'local' && host !== 'windows') : false;
  const hasAdvanced = isBridge || posixShell;
  const tabs: [EnvTab, string][] = [
    ['general', 'General'],
    ['harnesses', 'Harnesses'],
    ...(hasAdvanced ? ([['advanced', 'Advanced']] as [EnvTab, string][]) : []),
  ];

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({
    onSave: () => void saveRef.current(),
    onCancel: () => window.close(),
    tabs: tabs.map(([id]) => id),
    tab,
    onTab: setTab,
  });

  if (missing) return <div className="empty">This environment no longer exists.</div>;
  if (!live || !draft || !env) return <div className="empty">Loading…</div>;

  const kinds = availableEnvironmentKinds(host);
  if (!kinds.includes(draft.kind)) kinds.push(draft.kind); // keep an unreachable kind editable
  const harnesses = env.harnesses;
  const harness = harnesses.find((h) => h.id === selected);
  const shown = tabs.some(([id]) => id === tab) ? tab : 'general';

  const patch = (p: Partial<EnvDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const saveHarnesses = async (next: Harness[]) => {
    const environments = live.environments.map((e) => (e.id === envId ? { ...e, harnesses: next } : e));
    try {
      await window.looper.updateSettings({ environments });
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const addHarness = async () => {
    const h = newHarness();
    await saveHarnesses([...harnesses, h]);
    setSelected(h.id);
    void window.looper.openHarnessEditor(envId, h.id, true);
  };
  const duplicateHarness = async () => {
    if (!harness) return;
    const copy: Harness = { ...JSON.parse(JSON.stringify(harness)), id: `h-${rid()}`, name: `${harness.name} (copy)` };
    await saveHarnesses([...harnesses, copy]);
    setSelected(copy.id);
  };
  const removeHarness = async () => {
    if (!harness || harnesses.length <= 1) return;
    if (!(await window.looper.confirm(`Remove harness "${harness.name}"?`))) return;
    await saveHarnesses(harnesses.filter((h) => h.id !== harness.id));
    setSelected(harnesses.find((h) => h.id !== harness.id)?.id ?? null);
  };

  const doSave = async (): Promise<boolean> => {
    const folded: Environment = {
      ...env,
      name: draft.name.trim(),
      kind: draft.kind,
      distro: draft.kind === 'wsl' ? draft.distro?.trim() || undefined : undefined,
      shell: posixShell ? draft.shell?.trim() || undefined : undefined,
      mountPrefix: isBridge ? draft.mountPrefix?.trim() || undefined : undefined,
    };
    const environments = live.environments.map((e) => (e.id === envId ? folded : e));
    const parsed = SettingsSchema.safeParse({ ...live, environments });
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
      <TabBar tabs={tabs} active={shown} onSelect={setTab} className="editor-tabs" />
      <div className="editor-body">
        {shown === 'general' && (
          <div className="form">
            <Field label="Name">
              <input autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="Type">
              <select value={draft.kind} onChange={(e) => patch({ kind: e.target.value as Environment['kind'] })}>
                {ENVIRONMENT_KINDS.filter(([k]) => kinds.includes(k)).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {draft.kind === 'wsl' && (
              <Field label="WSL distro">
                {distros.length > 0 ? (
                  <select value={draft.distro ?? ''} onChange={(e) => patch({ distro: e.target.value || undefined })}>
                    <option value="">Default distro</option>
                    {draft.distro && !distros.includes(draft.distro) && (
                      <option value={draft.distro}>{draft.distro} (not installed)</option>
                    )}
                    {distros.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={draft.distro ?? ''} onChange={(e) => patch({ distro: e.target.value || undefined })} />
                )}
              </Field>
            )}
          </div>
        )}

        {shown === 'harnesses' && (
          <div className="form env-tab">
            <SelectList
              items={harnesses}
              label="Harnesses"
              idPrefix="harness"
              selectedKey={selected}
              itemKey={(h) => h.id}
              itemName={(h) => h.name}
              itemSub={(h) => harnessKindLabel(h.kind)}
              onSelect={(h) => setSelected(h.id)}
              onOpen={(h) => void window.looper.openHarnessEditor(envId, h.id)}
            />
            <ListActions
              onAdd={() => void addHarness()}
              onEdit={() => harness && void window.looper.openHarnessEditor(envId, harness.id)}
              editDisabled={!harness}
              onDuplicate={() => void duplicateHarness()}
              duplicateDisabled={!harness}
              onRemove={() => void removeHarness()}
              removeDisabled={!harness || harnesses.length <= 1}
              removeTitle={harnesses.length <= 1 ? 'At least one harness is required' : undefined}
            />
          </div>
        )}

        {shown === 'advanced' && (
          <div className="form">
            {posixShell && (
              <Field label="Shell">
                <select
                  autoFocus
                  value={customShell ? 'custom' : (draft.shell ?? DEFAULT_SHELL)}
                  onChange={(e) => {
                    if (e.target.value === 'custom') {
                      setCustomShell(true);
                    } else {
                      setCustomShell(false);
                      patch({ shell: e.target.value === DEFAULT_SHELL ? undefined : e.target.value });
                    }
                  }}
                >
                  {SHELL_PRESETS.map(([cmd, label]) => (
                    <option key={cmd} value={cmd}>
                      {label}
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
                {customShell && (
                  <input
                    autoFocus
                    className="mono"
                    value={draft.shell ?? ''}
                    placeholder={DEFAULT_SHELL}
                    onChange={(e) => patch({ shell: e.target.value || undefined })}
                  />
                )}
              </Field>
            )}
            {isBridge && (
              <Field label="Windows drive mount prefix">
                <input
                  autoFocus={!posixShell}
                  className="mono"
                  value={draft.mountPrefix ?? ''}
                  placeholder={detectedPrefix ?? '/mnt'}
                  onChange={(e) => patch({ mountPrefix: e.target.value || undefined })}
                />
              </Field>
            )}
          </div>
        )}
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} onApply={() => void apply()} saving={saving} />
    </div>
  );
}
