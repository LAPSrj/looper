import { useEffect, useState } from 'react';
import type { Environment } from '@shared/types';
import { EFFORT_LEVELS, harnessModels, pathFlavor } from '@shared/environments';
import { Field, EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

/** New Task with Agent: what the task builder runs with. Start turns this window into the conversation. */
export function BuilderSetupApp() {
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [envId, setEnvId] = useState('');
  const [harnessId, setHarnessId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [cwd, setCwd] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.title = 'New Task with Agent';
    void window.looper.info().then((i) => {
      setEnvironments(i.settings.environments);
      setHost(i.host);
      const env =
        i.settings.environments.find((e) => e.id === i.settings.defaultEnvironmentId && e.harnesses.some((h) => h.kind !== 'custom')) ??
        i.settings.environments.find((e) => e.harnesses.some((h) => h.kind !== 'custom'));
      if (env) pickEnvironment(env);
    });
  }, []);

  const env = environments?.find((e) => e.id === envId);
  const harnesses = env?.harnesses.filter((h) => h.kind !== 'custom') ?? [];
  const harness = harnesses.find((h) => h.id === harnessId);
  const models = harness ? harnessModels(harness) : [];
  const modelEntry = models.find((m) => m.id === model);
  const kindEfforts = harness && harness.kind !== 'custom' ? EFFORT_LEVELS[harness.kind] : [];
  const efforts = modelEntry?.efforts ? kindEfforts.filter(([v]) => modelEntry.efforts!.includes(v)) : kindEfforts;
  const defaultEffort = modelEntry?.defaultEffort
    ? (kindEfforts.find(([v]) => v === modelEntry.defaultEffort)?.[1] ?? modelEntry.defaultEffort)
    : undefined;

  function pickEnvironment(next: Environment) {
    setEnvId(next.id);
    const h = next.harnesses.find((x) => x.kind !== 'custom');
    pickHarness(h?.id ?? '');
  }

  function pickHarness(id: string) {
    setHarnessId(id);
    setModel('');
    setEffort('');
  }

  const browse = async () => {
    const picked = await window.looper.pickDirectory({
      current: cwd || undefined,
      flavor: env ? pathFlavor(env, host) : undefined,
      distro: env?.kind === 'wsl' ? env.distro : undefined,
    });
    if (picked) setCwd(picked);
  };

  const start = async () => {
    if (starting) return;
    if (!env || !harness) {
      void window.looper.showError('Choose an environment with a Claude Code or Codex harness.');
      return;
    }
    if (!cwd.trim()) {
      void window.looper.showError('Choose the working directory.');
      return;
    }
    setStarting(true);
    try {
      await window.looper.builder.start({
        environmentId: env.id,
        harnessId: harness.id,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        cwd: cwd.trim(),
      });
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setStarting(false);
    }
  };

  useDialogKeys({ onSave: start, onCancel: () => window.close() });

  if (!environments) return <div className="empty">Loading…</div>;
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form setup-form">
          <Field label="Environment">
            <select
              value={envId}
              onChange={(e) => {
                const next = environments.find((x) => x.id === e.target.value);
                if (next) pickEnvironment(next);
              }}
            >
              {environments.map((e) => (
                <option key={e.id} value={e.id} disabled={!e.harnesses.some((h) => h.kind !== 'custom')}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Harness">
            <select value={harnessId} onChange={(e) => pickHarness(e.target.value)}>
              {harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field label="Model">
              <select
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort('');
                }}
              >
                <option value="">Default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effort">
              <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">{defaultEffort ? `Default (${defaultEffort})` : 'Default'}</option>
                {efforts.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Working directory">
            <div className="browse-row">
              <input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} autoFocus />
              <button className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
          </Field>
        </div>
      </div>
      <EditorFooter primaryLabel="Start" onPrimary={() => void start()} onCancel={() => window.close()} saving={starting} />
    </div>
  );
}
