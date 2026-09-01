import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Environment, Harness, Settings } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { ENVIRONMENT_KINDS, availableEnvironmentKinds, harnessKindLabel } from '@shared/environments';

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

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

  // Dialog keys: Esc = cancel, Enter on an input or Ctrl+Enter anywhere = save,
  // Ctrl+Tab / Ctrl+PageDown|PageUp = cycle tabs.
  const keysRef = useRef({ tabs, tab });
  keysRef.current = { tabs, tab };
  const saveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void saveRef.current();
        return;
      }
      const order = keysRef.current.tabs.map(([id]) => id);
      const cycle = (dir: number) =>
        setTab(order[(order.indexOf(keysRef.current.tab) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const onListKey = (e: React.KeyboardEvent) => {
    if (!harnesses.length) return;
    const idx = harness ? harnesses.findIndex((x) => x.id === harness.id) : -1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(harnesses.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = harnesses.length - 1;
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (harness) void window.looper.openHarnessEditor(envId, harness.id);
        return;
      default:
        return;
    }
    e.preventDefault();
    setSelected(harnesses[next].id);
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
      <nav className="tabs editor-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab ${shown === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
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
            <ul
              className="env-list boxed"
              role="listbox"
              aria-label="Harnesses"
              tabIndex={0}
              onKeyDown={onListKey}
              aria-activedescendant={harness ? `harness-${harness.id}` : undefined}
            >
              {harnesses.map((h) => (
                <li
                  key={h.id}
                  id={`harness-${h.id}`}
                  role="option"
                  aria-selected={h.id === selected}
                  className={`env-item ${h.id === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(h.id)}
                  onDoubleClick={() => void window.looper.openHarnessEditor(envId, h.id)}
                >
                  <div className="env-item-name">{h.name}</div>
                  <div className="env-item-sub">{harnessKindLabel(h.kind)}</div>
                </li>
              ))}
            </ul>
            <div className="env-actions">
              <button className="btn" onClick={() => void addHarness()}>
                Add…
              </button>
              <button
                className="btn"
                disabled={!harness}
                onClick={() => harness && void window.looper.openHarnessEditor(envId, harness.id)}
              >
                Edit…
              </button>
              <button className="btn" disabled={!harness} onClick={() => void duplicateHarness()}>
                Duplicate
              </button>
              <button
                className="btn danger"
                disabled={!harness || harnesses.length <= 1}
                title={harnesses.length <= 1 ? 'At least one harness is required' : undefined}
                onClick={() => void removeHarness()}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        {shown === 'advanced' && (
          <div className="form">
            {posixShell && (
              <Field label="Shell">
                <input
                  autoFocus
                  className="mono"
                  value={draft.shell ?? ''}
                  placeholder="bash -lic"
                  onChange={(e) => patch({ shell: e.target.value || undefined })}
                />
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
      <div className="editor-footer">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
        <button className="btn" onClick={() => window.close()} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={() => void apply()} disabled={saving}>
          Apply
        </button>
      </div>
    </div>
  );
}
