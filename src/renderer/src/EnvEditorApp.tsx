import { useEffect, useState } from 'react';
import type { Environment, Harness } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { REPORT_INPUT, issueLines } from '@shared/issues';
import { DEFAULT_SHELL, ENVIRONMENT_KINDS, SHELL_PRESETS, availableEnvironmentKinds, harnessKindLabel } from '@shared/environments';
import { EmptyWindow, Field, TabBar } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { ConcurrencyLimit } from './components/form-blocks';
import { useDialogKeys, useDiscardUnsaved, useLiveSettings } from './components/hooks';
import { useFitWindow } from './fit-window';
import { SelectList, ListActions } from './components/SelectList';
import { rid } from './rid';

type EnvTab = 'general' | 'harnesses' | 'advanced';

function newHarness(): Harness {
  return { id: `h-${rid()}`, name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} };
}

/** The environment's own fields; harnesses are managed live through their own editor window. */
type EnvDraft = Pick<Environment, 'name' | 'kind' | 'distro' | 'shell' | 'mountPrefix' | 'maxConcurrentTasks'>;

/** Standalone environment editor window (Settings → Environments → Add/Edit). */
export function EnvEditorApp({ envId, isNew }: { envId: string; isNew?: boolean }) {
  const { live, host, missing } = useLiveSettings((s) => s.environments.some((e) => e.id === envId));
  const [draft, setDraft] = useState<EnvDraft | null>(null);
  const [tab, setTab] = useState<EnvTab>('general');
  const [selected, setSelected] = useState<string | null>(null);
  const [distros, setDistros] = useState<string[]>([]);
  const [detectedPrefix, setDetectedPrefix] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  /** "Custom" chosen in the Shell dropdown; the free-text field shows regardless of its value. */
  const [customShell, setCustomShell] = useState(false);
  useFitWindow();

  const savedRef = useDiscardUnsaved(isNew, () => window.looper.discardEnvironment(envId));

  useEffect(() => {
    document.title = isNew ? 'New Environment' : 'Edit Environment';
    void window.looper.listWslDistros().then(setDistros);
  }, [isNew]);

  // The draft starts from the settings as they first arrive; harnesses stay live.
  useEffect(() => {
    if (!live || draft) return;
    const env = live.environments.find((e) => e.id === envId);
    if (!env) return;
    const { name, kind, distro, shell, mountPrefix, maxConcurrentTasks } = env;
    setDraft({ name, kind, distro, shell, mountPrefix, maxConcurrentTasks });
    setCustomShell(!!shell && !SHELL_PRESETS.some(([cmd]) => cmd === shell));
    setSelected(env.harnesses[0]?.id ?? null);
  }, [live, draft, envId]);

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

  useDialogKeys({
    tabs: tabs.map(([id]) => id),
    tab,
    onTab: setTab,
  });

  if (missing || !live || !draft || !env) return <EmptyWindow gone={missing && 'This environment no longer exists.'} />;

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
  // Each command takes the harness it acts on (the selected one for a button, the clicked row for the menu).
  const duplicateHarness = async (from: Harness | undefined = harness) => {
    if (!from) return;
    const copy: Harness = { ...JSON.parse(JSON.stringify(from)), id: `h-${rid()}`, name: `${from.name} (copy)` };
    await saveHarnesses([...harnesses, copy]);
    setSelected(copy.id);
  };
  const removeHarness = async (target: Harness | undefined = harness) => {
    if (!target || harnesses.length <= 1) return;
    if (!(await window.looper.confirm(`Remove harness "${target.name}"?`))) return;
    await saveHarnesses(harnesses.filter((h) => h.id !== target.id));
    setSelected(harnesses.find((h) => h.id !== target.id)?.id ?? null);
  };

  const doSave = async (): Promise<boolean> => {
    const folded: Environment = {
      ...env,
      name: draft.name.trim(),
      kind: draft.kind,
      distro: draft.kind === 'wsl' ? draft.distro?.trim() || undefined : undefined,
      shell: posixShell ? draft.shell?.trim() || undefined : undefined,
      mountPrefix: isBridge ? draft.mountPrefix?.trim() || undefined : undefined,
      maxConcurrentTasks: draft.maxConcurrentTasks,
    };
    const environments = live.environments.map((e) => (e.id === envId ? folded : e));
    const parsed = SettingsSchema.safeParse({ ...live, environments }, REPORT_INPUT);
    if (!parsed.success) {
      void window.looper.showError(issueLines(parsed.error));
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
            <ConcurrencyLimit value={draft.maxConcurrentTasks} onChange={(max) => patch({ maxConcurrentTasks: max })} />
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
              menu={(h) => [
                { label: 'Edit…', run: () => void window.looper.openHarnessEditor(envId, h.id) },
                { label: 'Duplicate', run: () => void duplicateHarness(h) },
                { label: 'Remove', destructive: true, enabled: harnesses.length > 1, run: () => void removeHarness(h) },
              ]}
              onDelete={(h) => void removeHarness(h)}
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
      <WindowActions confirm={{ label: 'Save', run: () => void save() }} apply={{ run: () => void apply() }} busy={saving} />
    </div>
  );
}
