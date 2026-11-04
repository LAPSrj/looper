import { useEffect, useState } from 'react';
import type { Environment } from '@shared/types';
import { AgentFields } from './components/RemoteFields';
import { EmptyWindow } from './components/ui';
import { WindowActions } from './components/WindowActions';

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

  if (!environments) return <EmptyWindow />;
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form setup-form">
          <AgentFields
            draft={{ environmentId: envId, harnessId, model: model || undefined, effort: effort || undefined, cwd }}
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
        </div>
      </div>
      <WindowActions confirm={{ label: 'Start', run: () => void start() }} busy={starting} />
    </div>
  );
}
