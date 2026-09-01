import type { Environment, Harness, HarnessModel, Settings, Task } from './types';

/** The environment a task runs in. Throws when the task names none that exists. */
export function resolveEnvironment(task: Task, settings: Settings): Environment {
  const env = settings.environments.find((e) => e.id === task.environmentId);
  if (!env) throw new Error(`task ${task.id}: unknown environment "${task.environmentId}" (see Settings → Environments)`);
  return env;
}

/** The harness the task's agent runs with: the named one, or the environment's first. */
export function resolveHarness(task: Task, env: Environment): Harness {
  const id = task.agent.harnessId;
  if (id) {
    const h = env.harnesses.find((x) => x.id === id);
    if (!h) throw new Error(`task ${task.id}: environment "${env.name}" has no harness "${id}"`);
    return h;
  }
  const first = env.harnesses[0];
  if (!first) throw new Error(`environment "${env.name}" has no harnesses`);
  return first;
}

/** The classifier always runs `claude -p`: the task's harness if it is Claude Code, else the environment's first one. */
export function resolveClassifierHarness(task: Task, env: Environment): Harness {
  const cls = task.classifier;
  if (cls?.harnessId) {
    const h = env.harnesses.find((h) => h.id === cls.harnessId);
    if (h) return h;
  }
  const own = resolveHarness(task, env);
  if (own.kind === 'claude-code') return own;
  const claude = env.harnesses.find((h) => h.kind === 'claude-code');
  if (!claude) {
    throw new Error(`classifier needs a Claude Code harness in environment "${env.name}" (see Settings → Environments)`);
  }
  return claude;
}

export function describeEnvironment(env: Environment): string {
  switch (env.kind) {
    case 'local':
      return 'Local Shell';
    case 'windows':
      return 'Windows (PowerShell)';
    case 'wsl':
      return env.distro ? `WSL – ${env.distro}` : 'WSL';
  }
}

export const ENVIRONMENT_KINDS: [Environment['kind'], string][] = [
  ['local', 'Local Shell'],
  ['wsl', 'WSL distro'],
  ['windows', 'Windows (PowerShell)'],
];

export function environmentKindLabel(kind: Environment['kind']): string {
  return ENVIRONMENT_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}

/** Which environment kinds this host can reach: its own shell, plus the bridge it has. */
export function availableEnvironmentKinds(host: string | undefined): Environment['kind'][] {
  const kinds: Environment['kind'][] = ['local'];
  if (host === 'windows') kinds.push('wsl');
  if (host === 'wsl') kinds.push('windows');
  return kinds;
}

/**
 * The path style an environment's cwd uses. `local` depends on the host; when
 * the host is unknown the flavor is undecidable and the caller should skip
 * path-style checks.
 */
export function pathFlavor(env: Environment, host?: string): 'posix' | 'windows' | undefined {
  if (env.kind === 'windows') return 'windows';
  if (env.kind === 'wsl') return 'posix';
  if (!host) return undefined;
  return host === 'windows' ? 'windows' : 'posix';
}

/** claude-code only: whether looper answers the workspace-trust dialog for this harness. */
export function autoTrustWorkspace(harness: Harness): boolean {
  return harness.options?.autoTrustWorkspace ?? true;
}

/** The main models of each CLI, by their unprefixed ids. */
export const DEFAULT_MODELS: Record<Harness['kind'], HarnessModel[]> = {
  'claude-code': [
    { id: 'fable', name: 'Fable' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ],
  codex: [
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  custom: [],
};

/** The models offered for a harness: its own preset list, or the kind's main models when unset. */
export function harnessModels(harness: Harness): HarnessModel[] {
  return harness.models ?? DEFAULT_MODELS[harness.kind];
}

/** Same preset lists, in the same order. */
export function sameModels(a: HarnessModel[], b: HarnessModel[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i].id && m.name === b[i].name);
}

export const HARNESS_KINDS: [Harness['kind'], string][] = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['custom', 'Custom'],
];

export function harnessKindLabel(kind: Harness['kind']): string {
  return HARNESS_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}
