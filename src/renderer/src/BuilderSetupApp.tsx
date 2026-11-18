import { useEffect, useState } from 'react';
import type { Environment } from '@shared/types';
import { defaultEnvironment } from '@shared/environments';
import { AgentFields, offeredHarnesses } from './components/RemoteFields';
import { EmptyWindow, FormGroup } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useLiveSettings, useSave } from './components/hooks';

/** New Task with Agent: what the task builder runs with. Start turns this window into the conversation. */
export function BuilderSetupApp() {
  const { live, host } = useLiveSettings();
  const [envId, setEnvId] = useState<string | null>(null);
  const [harnessId, setHarnessId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [cwd, setCwd] = useState('');
  const saver = useSave();

  useEffect(() => {
    document.title = 'New Task with Agent';
  }, []);

  // It starts in the default environment, or the first with a Claude Code or Codex harness.
  useEffect(() => {
    if (!live || envId !== null) return;
    const env = defaultEnvironment(live, (e) => offeredHarnesses(e, 'agents').length > 0);
    if (env) pickEnvironment(env);
    else setEnvId('');
  }, [live, envId]);

  const environments = live?.environments;
  const env = environments?.find((e) => e.id === envId);
  const harnesses = offeredHarnesses(env, 'agents');
  const harness = harnesses.find((h) => h.id === harnessId);

  function pickEnvironment(next: Environment) {
    setEnvId(next.id);
    pickHarness(offeredHarnesses(next, 'agents')[0]?.id ?? '');
  }

  function pickHarness(id: string) {
    setHarnessId(id);
    setModel('');
    setEffort('');
  }

  const start = () => {
    if (!env || !harness) {
      void window.looper.showError('Choose an environment with a Claude Code or Codex harness.');
      return;
    }
    if (!cwd.trim()) {
      void window.looper.showError('Choose the working directory.');
      return;
    }
    // Start turns the window into the conversation, so it stays busy.
    saver.save(
      () =>
        window.looper.builder
          .start({
            environmentId: env.id,
            harnessId: harness.id,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            cwd: cwd.trim(),
          })
          .then(() => true),
      () => undefined,
    );
  };

  if (!environments) return <EmptyWindow />;
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form setup-form">
          <FormGroup>
            <AgentFields
              draft={{ environmentId: envId ?? '', harnessId, model: model || undefined, effort: effort || undefined, cwd }}
              environments={environments}
              host={host}
              harnesses="agents"
              onChange={(p) => {
                if ('environmentId' in p) setEnvId(p.environmentId ?? '');
                if ('harnessId' in p) setHarnessId(p.harnessId ?? '');
                if ('model' in p) setModel(p.model ?? '');
                if ('effort' in p) setEffort(p.effort ?? '');
                if ('cwd' in p) setCwd(p.cwd ?? '');
              }}
            />
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Start', run: start }} busy={saver.busy} />
    </div>
  );
}
