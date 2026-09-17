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

/**
 * The classifier needs a harness with structured output — Claude Code
 * (--json-schema) or Codex (--output-schema): the named one, else the task's
 * own harness when it qualifies, else the environment's first one that does.
 */
export function resolveClassifierHarness(task: Task, env: Environment): Harness {
  const cls = task.classifier;
  if (cls?.harnessId) {
    const h = env.harnesses.find((h) => h.id === cls.harnessId);
    if (h) return h;
  }
  const own = resolveHarness(task, env);
  if (own.kind !== 'custom') return own;
  const capable = env.harnesses.find((h) => h.kind !== 'custom');
  if (!capable) {
    throw new Error(
      `classifier needs a Claude Code or Codex harness in environment "${env.name}" (see Settings → Environments)`,
    );
  }
  return capable;
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

/**
 * Shell + flags that source the launcher on POSIX targets. The default is an
 * interactive login shell: it reads ~/.bashrc, so tools whose installers only
 * edit that file (nvm, bun) resolve without any profile changes. Without a
 * terminal bash warns about job control; the engine drops those two lines.
 */
export const DEFAULT_SHELL = 'bash -lic';

/** Shell presets offered in the environment editor: [command, label]. */
export const SHELL_PRESETS: [string, string][] = [
  [DEFAULT_SHELL, 'Same as your terminal'],
  ['bash -lc', 'Basic shell, without your terminal setup'],
];

/** claude-code and codex: whether looper answers the folder-trust dialog for this harness. */
export function autoTrustWorkspace(harness: Harness): boolean {
  return harness.options?.autoTrustWorkspace ?? true;
}

/**
 * The main models of each CLI, by their unprefixed ids. Every entry carries an
 * explicit default effort, so out-of-the-box runs never inherit whatever
 * effort the user's own CLI happens to be set to.
 */
export const DEFAULT_MODELS: Record<Harness['kind'], HarnessModel[]> = {
  'claude-code': [
    { id: 'fable', name: 'Fable', defaultEffort: 'medium' },
    { id: 'opus', name: 'Opus', defaultEffort: 'medium' },
    { id: 'sonnet', name: 'Sonnet', defaultEffort: 'medium' },
    { id: 'haiku', name: 'Haiku', defaultEffort: 'medium' },
  ],
  codex: [
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', defaultEffort: 'medium' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', defaultEffort: 'medium' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', defaultEffort: 'medium' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', defaultEffort: 'medium' },
    { id: 'gpt-5.5', name: 'GPT-5.5', defaultEffort: 'medium' },
  ],
  custom: [],
};

/**
 * The permission modes offered per harness kind: [stored value, label]. Claude
 * Code values go through --permission-mode verbatim; codex values map to its
 * sandbox/approval flags (see codexPermissionArgs). '' omits every flag.
 */
export const PERMISSION_MODES: Record<Exclude<Harness['kind'], 'custom'>, [string, string][]> = {
  'claude-code': [
    ['auto', 'Auto'],
    ['acceptEdits', 'Accept edits'],
    ['manual', 'Manual'],
    ['dontAsk', "Don't ask"],
    ['plan', 'Plan mode'],
    ['bypassPermissions', 'Bypass'],
    ['', 'None'],
  ],
  codex: [
    ['auto', 'Auto'],
    ['read-only', 'Read-only sandbox'],
    ['workspace-write', 'Workspace-write sandbox'],
    ['danger-full-access', 'Full access'],
    ['bypassPermissions', 'Bypass'],
    ['', 'None'],
  ],
};

/**
 * The effort levels offered per harness kind: [stored value, label]. Claude
 * Code values go through --effort verbatim; codex values through
 * `-c model_reasoning_effort=`. Unset omits the flag (the CLI's own default).
 */
export const EFFORT_LEVELS: Record<Exclude<Harness['kind'], 'custom'>, [string, string][]> = {
  'claude-code': [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
  ],
  codex: [
    ['minimal', 'Minimal'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
  ],
};

/**
 * The codex flags for a task's permission mode. 'auto' routes approvals
 * through codex's automatic review in the workspace-write sandbox; the sandbox
 * values pin that sandbox (never asking, since nobody is watching — the
 * interactive CLI would otherwise stop on every approval; codex exec never
 * asks and rejects -a); 'bypassPermissions' turns everything off. --sandbox
 * and --approve-for-me are mutually exclusive, so each mode emits only one of
 * them. Unknown values (a claude mode left on a switched task) emit nothing.
 */
export function codexPermissionArgs(mode: string | undefined, interactive: boolean): string[] {
  switch (mode) {
    case 'auto':
      return ['--approve-for-me'];
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return interactive ? ['--sandbox', mode, '-a', 'never'] : ['--sandbox', mode];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    default:
      return [];
  }
}

/** The models offered for a harness: its own preset list, or the kind's main models when unset. */
export function harnessModels(harness: Harness): HarnessModel[] {
  return harness.models ?? DEFAULT_MODELS[harness.kind];
}

/** Same preset lists, in the same order — effort configuration included. */
export function sameModels(a: HarnessModel[], b: HarnessModel[]): boolean {
  const sameEfforts = (x?: string[], y?: string[]): boolean =>
    x === undefined ? y === undefined : y !== undefined && x.length === y.length && x.every((v, i) => v === y[i]);
  return (
    a.length === b.length &&
    a.every(
      (m, i) =>
        m.id === b[i].id &&
        m.name === b[i].name &&
        m.defaultEffort === b[i].defaultEffort &&
        sameEfforts(m.efforts, b[i].efforts),
    )
  );
}

/**
 * The effort a run emits: the task's own pin, else the model entry's
 * configured default, else none (the flag is omitted and the CLI decides —
 * only tasks on a custom/unknown model id or no model at all land there).
 */
export function resolveEffort(agent: { model?: string; effort?: string }, harness: Harness): string | undefined {
  if (agent.effort) return agent.effort;
  if (!agent.model) return undefined;
  return harnessModels(harness).find((m) => m.id === agent.model)?.defaultEffort;
}

export const HARNESS_KINDS: [Harness['kind'], string][] = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['custom', 'Custom'],
];

export function harnessKindLabel(kind: Harness['kind']): string {
  return HARNESS_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}
