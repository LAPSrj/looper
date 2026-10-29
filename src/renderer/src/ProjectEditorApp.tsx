import { useEffect, useRef, useState } from 'react';
import type { Environment, Project } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessKindLabel, harnessModels, pathFlavor } from '@shared/environments';
import { folderName } from '@shared/projects';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { EditorFooter, Field } from './components/ui';
import { useDialogKeys } from './components/hooks';

type Draft = Pick<Project, 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort' | 'permissionMode' | 'mode' | 'remote'>;

/** File → New Project, and a project's Edit Project…: modeless, like the task editor. */
export function ProjectEditorApp({ id }: { id?: string }) {
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The arguments and variables as typed, parsed on save like the task editor's.
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([window.looper.info(), window.looper.projects.list()]).then(([info, list]) => {
      setEnvironments(info.settings.environments);
      setHost(info.host);
      document.title = id ? (list.find((x) => x.id === id)?.name ?? 'Edit Project') : 'New Project';
      if (!id) {
        const env = info.settings.environments.find((e) => e.id === info.settings.defaultEnvironmentId) ?? info.settings.environments[0];
        setDraft({ name: '', environmentId: env?.id ?? '', harnessId: env?.harnesses[0]?.id, cwd: '', permissionMode: 'auto', mode: 'interactive', remote: false });
        return;
      }
      const p = list.find((x) => x.id === id);
      if (!p) {
        setMissing(true);
        return;
      }
      setProject(p);
      const { name, environmentId, harnessId, cwd, model, effort, permissionMode, mode, remote } = p;
      setDraft({ name, environmentId, harnessId, cwd, model, effort, permissionMode, mode, remote });
      setArgsText(joinTokens(p.extraArgs));
      setEnvText(envToLine(p.env));
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') setEnvironments(e.settings.environments);
      else if (e.type === 'projects' && id && !e.projects.some((p) => p.id === id)) setMissing(true);
    });
  }, [id]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This project no longer exists.</div>;
  if (!environments || !draft) return <div className="empty">Loading…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = env?.harnesses ?? [];
  const harness = harnesses.find((h) => h.id === draft.harnessId) ?? harnesses[0];
  const kind = harness && harness.kind !== 'custom' ? harness.kind : undefined;
  const models = harness ? harnessModels(harness) : [];
  const entry = models.find((m) => m.id === draft.model);
  const kindEfforts = kind ? EFFORT_LEVELS[kind] : [];
  const efforts = entry?.efforts ? kindEfforts.filter(([v]) => entry.efforts!.includes(v)) : kindEfforts;
  const defaultEffort = entry?.defaultEffort ? (kindEfforts.find(([v]) => v === entry.defaultEffort)?.[1] ?? entry.defaultEffort) : undefined;
  const modes = kind ? PERMISSION_MODES[kind] : [];

  const browse = async () => {
    const picked = await window.looper.pickDirectory({
      current: draft.cwd || undefined,
      flavor: env ? pathFlavor(env, host) : undefined,
      distro: env?.kind === 'wsl' ? env.distro : undefined,
    });
    if (picked) set({ cwd: picked, ...(draft.name.trim() ? {} : { name: folderName(picked) }) });
  };

  /** A harness of another kind has its own models, efforts and modes: the draft's go back to the defaults. */
  const pickHarness = (harnessId: string | undefined, envId = draft.environmentId) => {
    const nextEnv = environments.find((e) => e.id === envId);
    const h = nextEnv?.harnesses.find((x) => x.id === harnessId) ?? nextEnv?.harnesses[0];
    const k = h && h.kind !== 'custom' ? h.kind : undefined;
    const keepMode = !k || PERMISSION_MODES[k].some(([v]) => v === draft.permissionMode);
    set({ environmentId: envId, harnessId: h?.id, model: undefined, effort: undefined, ...(keepMode ? {} : { permissionMode: 'auto' }) });
  };

  const doSave = async (): Promise<boolean> => {
    const cwd = draft.cwd.trim();
    const name = draft.name.trim() || (cwd ? folderName(cwd) : '');
    if (!cwd) {
      void window.looper.showError('Choose the working directory.');
      return false;
    }
    const args = tokenize(argsText);
    const vars = lineToEnv(envText);
    if (!args.ok || typeof vars === 'string') {
      void window.looper.showError(!args.ok ? `Extra command-line arguments: ${args.error}` : `Extra environment variables: ${vars}`);
      return false;
    }
    setSaving(true);
    try {
      const saved = await window.looper.projects.save({
        ...(project ?? {}),
        ...draft,
        name,
        cwd,
        harnessId: harness?.id,
        extraArgs: args.tokens,
        env: vars,
      });
      setProject(saved);
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

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Name">
            <input autoFocus value={draft.name} placeholder={draft.cwd.trim() ? folderName(draft.cwd) : undefined} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Working directory">
            <div className="browse-row">
              <input className="mono" value={draft.cwd} onChange={(e) => set({ cwd: e.target.value })} />
              <button className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
          </Field>
          <div className="row">
            <Field label="Environment">
              <select value={draft.environmentId} onChange={(e) => pickHarness(undefined, e.target.value)}>
                {!env && <option value={draft.environmentId}>Unknown environment ({draft.environmentId || 'none'})</option>}
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Harness">
              <select value={harness?.id ?? ''} onChange={(e) => pickHarness(e.target.value)}>
                {!harnesses.length && <option value="">No harnesses in this environment</option>}
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({harnessKindLabel(h.kind)})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {kind && (
            <>
              <div className="row">
                <Field label="Model">
                  <select value={draft.model ?? ''} onChange={(e) => set({ model: e.target.value || undefined, effort: undefined })}>
                    <option value="">Default</option>
                    {draft.model && !entry && <option value={draft.model}>{draft.model}</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Effort">
                  <select value={draft.effort ?? ''} onChange={(e) => set({ effort: e.target.value || undefined })}>
                    <option value="">{defaultEffort ? `Default (${defaultEffort})` : 'Default'}</option>
                    {efforts.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}
          <div className="row">
            <Field label="Session type">
              <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Draft['mode'] })}>
                <option value="interactive">Interactive terminal (default)</option>
                <option value="headless">Headless{kind === 'codex' ? ' (codex exec)' : ''}</option>
              </select>
            </Field>
            {kind && (
              <Field label="Permission mode">
                <select value={draft.permissionMode} onChange={(e) => set({ permissionMode: e.target.value })}>
                  {modes.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div className="row">
            <Field label="Extra command-line arguments">
              <input className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            </Field>
            <Field label="Extra environment variables">
              <input className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </Field>
          </div>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.remote} onChange={(e) => set({ remote: e.target.checked })} />
            Keep a Remote Control conversation open
          </label>
        </div>
      </div>
      <EditorFooter
        primaryLabel={id ? 'Save' : 'Create'}
        onPrimary={() => void saveRef.current()}
        onCancel={() => window.close()}
        onApply={id ? () => void doSave() : undefined}
        saving={saving}
      />
    </div>
  );
}
