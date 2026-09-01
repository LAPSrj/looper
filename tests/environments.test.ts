import { describe, expect, it } from 'vitest';
import {
  autoTrustWorkspace,
  availableEnvironmentKinds,
  harnessModels,
  pathFlavor,
  resolveClassifierHarness,
  resolveEnvironment,
  resolveHarness,
} from '../src/shared/environments';
import { validateTask } from '../src/shared/validate';
import { createTarget, BashTarget, WindowsTarget } from '../src/engine/target';
import {
  HarnessSchema,
  SettingsSchema,
  TaskSchema,
  defaultEnvironments,
  type Environment,
  type Task,
} from '../src/shared/types';

const codex = { id: 'codex', name: 'Codex', kind: 'codex' as const, command: 'codex', args: ['--full-auto'], env: {} };
const claude2 = {
  id: 'claude-2',
  name: 'Claude (beta)',
  kind: 'claude-code' as const,
  command: '/opt/claude-beta',
  args: [],
  env: {},
};

function envWith(harnesses: Environment['harnesses'], kind: Environment['kind'] = 'wsl'): Environment {
  return { id: 'ubuntu', name: 'Ubuntu', kind, distro: kind === 'wsl' ? 'Ubuntu' : undefined, harnesses };
}

function task(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 't1',
    name: 'T',
    schedule: { cron: '*/10 * * * *' },
    environmentId: 'ubuntu',
    cwd: '/tmp',
    check: { command: 'true' },
    agent: { prompt: 'p' },
    ...overrides,
  });
}

describe('defaults & settings schema', () => {
  it('defaults are host-aware: local everywhere, plus the reachable bridge', () => {
    expect(defaultEnvironments().map((e) => e.id)).toEqual(['local']);
    expect(defaultEnvironments('windows').map((e) => e.id)).toEqual(['local', 'wsl']);
    expect(defaultEnvironments('wsl').map((e) => e.id)).toEqual(['local', 'windows']);
    expect(defaultEnvironments('mac').map((e) => e.id)).toEqual(['local']);
  });

  it('parses empty settings into a lone local environment', () => {
    const s = SettingsSchema.parse({});
    expect(s.environments.map((e) => e.id)).toEqual(['local']);
    expect(s.defaultEnvironmentId).toBe('local');
    expect(s.environments[0].harnesses[0]).toMatchObject({ kind: 'claude-code', command: 'claude' });
  });

  it('rejects duplicate environment ids and a dangling default', () => {
    const dup = defaultEnvironments('windows').map((e) => ({ ...e, id: 'same' }));
    expect(SettingsSchema.safeParse({ environments: dup, defaultEnvironmentId: 'same' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ defaultEnvironmentId: 'nope' }).success).toBe(false);
  });

  it('rejects an environment without harnesses', () => {
    const envs = [{ ...defaultEnvironments()[0], harnesses: [] }];
    expect(SettingsSchema.safeParse({ environments: envs, defaultEnvironmentId: 'local' }).success).toBe(false);
  });

  it('offers each host its own kinds', () => {
    expect(availableEnvironmentKinds('windows')).toEqual(['local', 'wsl']);
    expect(availableEnvironmentKinds('wsl')).toEqual(['local', 'windows']);
    expect(availableEnvironmentKinds('linux')).toEqual(['local']);
  });
});

describe('resolution', () => {
  const settings = SettingsSchema.parse({ environments: [envWith([codex, claude2])], defaultEnvironmentId: 'ubuntu' });

  it('resolves the environment by id and throws on unknown ids', () => {
    expect(resolveEnvironment(task(), settings).name).toBe('Ubuntu');
    expect(() => resolveEnvironment(task({ environmentId: 'gone' }), settings)).toThrow(/unknown environment/);
  });

  it('resolves the named harness, defaulting to the first', () => {
    const env = envWith([codex, claude2]);
    expect(resolveHarness(task(), env).id).toBe('codex');
    const t = task();
    t.agent.harnessId = 'claude-2';
    expect(resolveHarness(t, env).id).toBe('claude-2');
    t.agent.harnessId = 'missing';
    expect(() => resolveHarness(t, env)).toThrow(/no harness/);
  });

  it('classifier falls back to a claude-code harness, and demands one', () => {
    expect(resolveClassifierHarness(task(), envWith([codex, claude2])).id).toBe('claude-2');
    expect(() => resolveClassifierHarness(task(), envWith([codex]))).toThrow(/Claude Code harness/);
  });

  it('harness trust switch defaults on and can be turned off', () => {
    expect(autoTrustWorkspace(claude2)).toBe(true);
    expect(autoTrustWorkspace({ ...claude2, options: { autoTrustWorkspace: false } })).toBe(false);
  });

  it('offers the kind main models unless the harness sets its own', () => {
    expect(harnessModels(claude2).map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(harnessModels(codex).every((m) => m.id.startsWith('gpt-'))).toBe(true);
    const own = [{ id: 'claude-opus-4-5', name: 'Opus 4.5' }];
    expect(harnessModels({ ...claude2, models: own })).toEqual(own);
    expect(harnessModels({ ...claude2, models: [] })).toEqual([]);
  });

  it('normalizes model presets: bare strings and name-less entries become {id, name}', () => {
    const h = HarnessSchema.parse({ ...claude2, models: ['opus', { id: 'gpt-5.1' }, { id: 'x', name: 'X' }] });
    expect(h.models).toEqual([
      { id: 'opus', name: 'opus' },
      { id: 'gpt-5.1', name: 'gpt-5.1' },
      { id: 'x', name: 'X' },
    ]);
  });
});

describe('path flavor & target creation', () => {
  it('local follows the host, bridges are fixed', () => {
    const local = envWith([claude2], 'local');
    expect(pathFlavor(local, 'windows')).toBe('windows');
    expect(pathFlavor(local, 'wsl')).toBe('posix');
    expect(pathFlavor(local)).toBeUndefined();
    expect(pathFlavor(envWith([claude2], 'wsl'), 'windows')).toBe('posix');
    expect(pathFlavor(envWith([claude2], 'windows'), 'wsl')).toBe('windows');
  });

  const settingsFor = (env: Environment) =>
    SettingsSchema.parse({ environments: [env], defaultEnvironmentId: env.id });

  it('maps kind × host to the right target', () => {
    const local = envWith([claude2], 'local');
    expect(createTarget(task(), { host: 'wsl', settings: settingsFor(local) })).toBeInstanceOf(BashTarget);
    expect(createTarget(task(), { host: 'windows', settings: settingsFor(local) })).toBeInstanceOf(WindowsTarget);
    expect(createTarget(task(), { host: 'windows', settings: settingsFor(envWith([claude2], 'wsl')) })).toBeInstanceOf(
      BashTarget,
    );
    expect(createTarget(task(), { host: 'wsl', settings: settingsFor(envWith([claude2], 'windows')) })).toBeInstanceOf(
      WindowsTarget,
    );
    expect(() => createTarget(task(), { host: 'linux', settings: settingsFor(envWith([claude2], 'wsl')) })).toThrow(
      /Windows host/,
    );
  });

  it('honours a per-environment mount prefix', () => {
    const env: Environment = { ...envWith([claude2], 'wsl'), mountPrefix: '/drives' };
    const target = createTarget(task(), { host: 'windows', settings: settingsFor(env) });
    expect(target.toTargetPath('C:\\data\\x')).toBe('/drives/c/data/x');
  });
});

describe('validateTask with environments', () => {
  const environments = [envWith([codex, claude2])];

  it('accepts a valid reference and checks cwd style against the environment', () => {
    expect(validateTask(task(), environments).ok).toBe(true);
    const winCwd = validateTask(task({ cwd: 'C:\\repo' }), environments);
    expect(winCwd).toMatchObject({ ok: false });
    if (!winCwd.ok) expect(winCwd.errors[0]).toMatch(/POSIX path/);
  });

  it('checks a local environment against the host, and skips when the host is unknown', () => {
    const local = [envWith([claude2], 'local')];
    expect(validateTask(task({ cwd: 'C:\\repo' }), local, 'windows').ok).toBe(true);
    expect(validateTask(task({ cwd: 'C:\\repo' }), local, 'wsl').ok).toBe(false);
    expect(validateTask(task({ cwd: 'C:\\repo' }), local).ok).toBe(true);
  });

  it('rejects unknown environment and harness references', () => {
    const badEnv = validateTask(task({ environmentId: 'gone' }), environments);
    expect(badEnv.ok).toBe(false);
    const t = task();
    t.agent.harnessId = 'missing';
    const badHarness = validateTask(t, environments);
    expect(badHarness.ok).toBe(false);
    if (!badHarness.ok) expect(badHarness.errors[0]).toMatch(/no harness/);
  });

  it('requires environmentId', () => {
    const v = validateTask({ ...task(), environmentId: undefined });
    expect(v.ok).toBe(false);
  });
});
