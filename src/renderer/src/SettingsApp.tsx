import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '@shared/types';

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

/** Standalone settings window (File → Settings…). */
export function SettingsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Settings — Looper';
    void window.looper.info().then((info) => setSettings(info.settings));
  }, []);

  if (!settings) return <div className="empty">Loading…</div>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));

  const save = async () => {
    setSaving(true);
    try {
      await window.looper.updateSettings(settings);
      window.close();
    } catch (e) {
      setErrors([(e as Error).message]);
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="form">
        <section>
          <h3>Environment</h3>
          <div className="row">
            <Field label="Default environment" help="Preselected for new tasks.">
              <select
                value={settings.defaultTarget}
                onChange={(e) => set('defaultTarget', e.target.value as Settings['defaultTarget'])}
              >
                <option value="wsl">WSL / Linux shell</option>
                <option value="windows">Windows (PowerShell)</option>
              </select>
            </Field>
            <Field
              label="Default WSL distro"
              help="Used when a task doesn't name one, and preselected in the task editor. Empty = the system default distro."
            >
              <input
                value={settings.defaultDistro ?? ''}
                onChange={(e) => set('defaultDistro', e.target.value || undefined)}
              />
            </Field>
          </div>
        </section>

        <section>
          <h3>Claude</h3>
          <Field
            label="Claude command"
            help={
              <>
                Command or full path used to launch claude inside the task's environment — e.g. <code>claude</code> or{' '}
                <code>/home/me/.local/bin/claude</code>. Quote it yourself if the path contains spaces.
              </>
            }
          >
            <input className="mono" value={settings.claudeCommand} onChange={(e) => set('claudeCommand', e.target.value)} />
          </Field>
          <Field
            label="Workspace trust dialog"
            help="Interactive claude asks whether to trust a directory the first time it runs there. Since the task's directory was chosen deliberately, Looper can answer yes for you."
          >
            <select
              value={settings.autoTrustWorkspace ? 'auto' : 'manual'}
              onChange={(e) => set('autoTrustWorkspace', e.target.value === 'auto')}
            >
              <option value="auto">Answer automatically (recommended)</option>
              <option value="manual">Leave it to me in the terminal</option>
            </select>
          </Field>
        </section>

        <details className="advanced">
          <summary>Advanced settings</summary>
          <div className="row">
            <Field label="Windows drive mount prefix" help="Where Windows drives appear inside WSL. Almost always /mnt.">
              <input className="mono" value={settings.wslMountPrefix} onChange={(e) => set('wslMountPrefix', e.target.value)} />
            </Field>
            <Field label="First check delay (seconds)" help="Wait after startup before tasks run their first check.">
              <input
                type="number"
                min={0}
                value={settings.startDelaySec}
                onChange={(e) => set('startDelaySec', Number(e.target.value))}
              />
            </Field>
          </div>
        </details>
        <p className="help">Changes apply immediately; already-running agent sessions keep their current configuration.</p>
      </div>
      <div className="editor-footer">
        <button className="btn" onClick={() => window.close()} disabled={saving}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
      </div>
    </div>
  );
}
