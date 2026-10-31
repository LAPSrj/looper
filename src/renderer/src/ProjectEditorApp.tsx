import { useEffect, useRef, useState } from 'react';
import type { Environment, Project } from '@shared/types';
import { folderName } from '@shared/projects';
import { windowTitle } from '@shared/window-title';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { AgentFields } from './components/RemoteFields';
import { EditorFooter, Field } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { useFitWindow } from './fit-window';

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
  useFitWindow();

  useEffect(() => {
    void Promise.all([window.looper.info(), window.looper.projects.list()]).then(([info, list]) => {
      setEnvironments(info.settings.environments);
      setHost(info.host);
      document.title = id ? windowTitle('Edit Project', list.find((x) => x.id === id)?.name) : 'New Project';
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
          <AgentFields
            draft={draft}
            environments={environments}
            host={host}
            harnesses="any"
            namePlaceholder={draft.cwd.trim() ? folderName(draft.cwd) : undefined}
            onBrowsed={(picked) => (draft.name.trim() ? {} : { name: folderName(picked) })}
            onChange={set}
          />
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
