import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { folderName } from '@shared/projects';
import { windowTitle } from '@shared/window-title';
import { defaultEnvironment } from '@shared/environments';
import { envToLine, joinTokens } from '@shared/cmdline';
import { claudeArgsProblem } from '@shared/claude-args';
import { AgentFields } from './components/RemoteFields';
import { CheckboxField, EmptyWindow, Field, FieldRow, FormGroup, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { parseArgsEnv } from './components/form-blocks';
import { PROJECTS, useLiveItem, useLiveSettings, useSave } from './components/hooks';

type Draft = Pick<Project, 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort' | 'permissionMode' | 'mode' | 'remote'>;

/** File → New Project, and a project's Edit Project…: modeless, like the task editor. */
export function ProjectEditorApp({ id }: { id?: string }) {
  const { live, host } = useLiveSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  // The arguments and variables as typed, parsed on save like the task editor's.
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const saver = useSave();
  const { item: project, missing } = useLiveItem(PROJECTS, id, (p) => {
    document.title = windowTitle('Edit Project', p.name);
    const { name, environmentId, harnessId, cwd, model, effort, permissionMode, mode, remote } = p;
    setDraft({ name, environmentId, harnessId, cwd, model, effort, permissionMode, mode, remote });
    setArgsText(joinTokens(p.extraArgs));
    setEnvText(envToLine(p.env));
  });

  useEffect(() => {
    document.title = id ? 'Edit Project' : 'New Project';
  }, [id]);

  // A new project starts in the default environment.
  useEffect(() => {
    if (id || draft || !live) return;
    const env = defaultEnvironment(live);
    setDraft({ name: '', environmentId: env?.id ?? '', harnessId: env?.harnesses[0]?.id, cwd: '', permissionMode: 'auto', mode: 'interactive', remote: false });
  }, [id, draft, live]);

  if (missing || !live || !draft) return <EmptyWindow gone={missing && 'This project no longer exists.'} />;

  const environments = live.environments;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = env?.harnesses ?? [];
  const harness = harnesses.find((h) => h.id === draft.harnessId) ?? harnesses[0];

  const doSave = async () => {
    const cwd = draft.cwd.trim();
    const name = draft.name.trim() || (cwd ? folderName(cwd) : '');
    if (!cwd) {
      void window.looper.showError('Choose the working directory.');
      return false;
    }
    const parsed = parseArgsEnv({ label: 'Extra command-line arguments', text: argsText }, { label: 'Extra environment variables', text: envText });
    if ('problem' in parsed) {
      void window.looper.showError(parsed.problem);
      return false;
    }
    const argsProblem = harness?.kind === 'claude-code' ? claudeArgsProblem(parsed.args, 'Extra command-line arguments') : null;
    if (argsProblem) {
      void window.looper.showError(argsProblem);
      return false;
    }
    await window.looper.projects.save({
      ...(project ?? {}),
      ...draft,
      name,
      cwd,
      harnessId: harness?.id,
      extraArgs: parsed.args,
      env: parsed.env,
    });
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <AgentFields
              draft={draft}
              environments={environments}
              host={host}
              harnesses="any"
              namePlaceholder={draft.cwd.trim() ? folderName(draft.cwd) : undefined}
              onBrowsed={(picked) => (draft.name.trim() ? {} : { name: folderName(picked) })}
              onChange={set}
            />
          </FormGroup>
          <FormGroup>
            <FieldRow>
              <Field label="Extra command-line arguments">
                <TextInput code value={argsText} onChange={(e) => setArgsText(e.target.value)} />
              </Field>
              <Field label="Extra environment variables">
                <TextInput code value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </Field>
            </FieldRow>
          </FormGroup>
          <FormGroup>
            <CheckboxField label="Keep a Remote Control conversation open" checked={draft.remote} onChange={(on) => set({ remote: on })} />
          </FormGroup>
        </div>
      </div>
      <WindowActions
        draft={[draft, argsText, envText]}
        confirm={{ label: id ? 'Save' : 'Create', run: () => saver.save(doSave) }}
        apply={id ? { run: () => void saver.apply(doSave) } : undefined}
        busy={saver.busy}
      />
    </div>
  );
}
