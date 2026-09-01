import { z } from 'zod';

// ---------- Task definition ----------

export const ScheduleSchema = z.object({ cron: z.string().min(1) }).strict();

// ---------- Environments & harnesses ----------

/**
 * One entry of a harness's Model dropdown: `id` is the `--model` value, `name`
 * the label shown to the user. A bare string or a name-less entry means both.
 */
export const HarnessModelSchema = z
  .union([z.string().min(1), z.object({ id: z.string().min(1), name: z.string().min(1).optional() })])
  .transform((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name ?? m.id }));
export type HarnessModel = z.output<typeof HarnessModelSchema>;

/**
 * A harness is one installed agent CLI inside an environment. `claude-code`
 * gets full integration (model / permission-mode flags, injected system
 * prompt, idle Stop hook, workspace-trust auto-answer). `codex` and `custom`
 * are invoked as `command [args…] "<prompt>"`; codex additionally gets the
 * `exec` subcommand in headless mode and a `--model` flag when the task sets
 * one. The `looper-done` helper is on PATH for every harness.
 */
export const HarnessSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['claude-code', 'codex', 'custom']).default('claude-code'),
  /** Command or full path inside the environment. Quote it yourself if it contains spaces. */
  command: z.string().min(1),
  /** Arguments always added before the prompt. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables for this harness's runs (e.g. two installs on different accounts). */
  env: z.record(z.string()).default({}),
  /** Models offered in the task editor's Model dropdown. Unset = the kind's main models. */
  models: z.array(HarnessModelSchema).optional(),
  /** Kind-specific behavior switches. */
  options: z
    .object({
      /**
       * claude-code only. Interactive claude asks "do you trust this folder?" the first time it
       * runs in a directory and blocks until answered. The task's cwd was chosen deliberately,
       * so looper answers "yes" for you unless this is false.
       */
      autoTrustWorkspace: z.boolean().optional(),
    })
    .optional(),
});
export type Harness = z.infer<typeof HarnessSchema>;

/**
 * A place where checks and agents run: the local shell, or a bridge to
 * another world. A bridge owns everything about the crossing — how to spawn
 * into it and how it sees the host's files.
 *
 * `local` = the native shell of the machine looper runs on (bash/zsh on
 * Linux/mac/WSL, PowerShell on Windows).
 * `wsl` = a WSL distro (`distro`, or the default one), reachable from a
 * Windows host through `wsl.exe`.
 * `windows` = native Windows (PowerShell), reachable from inside WSL through
 * interop (`powershell.exe`).
 */
export const EnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['local', 'wsl', 'windows']),
  /** wsl only: distro name; empty = the system default distro. */
  distro: z.string().optional(),
  /** local (POSIX hosts) and wsl: shell + flags used to source the launcher. Default: "bash -lic". */
  shell: z.string().optional(),
  /** wsl/windows bridges: where Windows drives are mounted inside WSL. Default: /mnt. */
  mountPrefix: z.string().optional(),
  harnesses: z.array(HarnessSchema).min(1),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * The out-of-the-box environments for a given host: always the local shell,
 * plus the bridge the host can actually reach (WSL from Windows, Windows from
 * WSL). Without a host only the local environment is produced.
 */
export function defaultEnvironments(host?: string): Environment[] {
  const claude = (): Harness => ({
    id: 'claude',
    name: 'Claude Code',
    kind: 'claude-code',
    command: 'claude',
    args: [],
    env: {},
  });
  const envs: Environment[] = [{ id: 'local', name: 'Local Shell', kind: 'local', harnesses: [claude()] }];
  if (host === 'windows') envs.push({ id: 'wsl', name: 'WSL', kind: 'wsl', harnesses: [claude()] });
  if (host === 'wsl') envs.push({ id: 'windows', name: 'Windows (PowerShell)', kind: 'windows', harnesses: [claude()] });
  return envs;
}

export const CheckSchema = z.object({
  command: z.string().min(1),
  timeoutSec: z.number().positive().default(60),
});

export const ClassifierSchema = z.object({
  harnessId: z.string().min(1).optional(),
  model: z.string().min(1).default('haiku'),
  prompt: z.string().min(1),
  timeoutSec: z.number().positive().default(180),
});

export const AgentSchema = z.object({
  /** Harness from the task's environment; empty = the environment's first harness. */
  harnessId: z.string().min(1).optional(),
  model: z.string().optional(),
  prompt: z.string().min(1),
  /** Appended verbatim to the harness command line. */
  extraArgs: z.array(z.string()).default([]),
  mode: z.enum(['interactive', 'headless']).default('interactive'),
  /** Passed as --permission-mode. Empty string omits the flag. */
  permissionMode: z.string().default('auto'),
  maxRuntimeMin: z.number().positive().default(120),
  /** Minutes the agent may sit idle (turn finished, no `looper-done`) before the run ends / is held. */
  idleGraceMin: z.number().positive().default(3),
  onIdleTimeout: z.enum(['finish', 'hold']).default('finish'),
});

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'id: letters, digits, - and _ only'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  /** Environment (from Settings) the task runs in. */
  environmentId: z.string().min(1),
  /** Working directory in the environment's native form (/home/... or C:\...). */
  cwd: z.string().min(1),
  check: CheckSchema,
  classifier: ClassifierSchema.optional(),
  agent: AgentSchema,
  backoff: z
    .object({ maxConsecutiveErrors: z.number().int().positive().default(5) })
    .default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

export type Template = Task;
export type TemplateInput = TaskInput;

// ---------- Settings ----------

export const SettingsSchema = z.object({
  /** Where checks and agents can run, each with its own harness list. */
  environments: z.array(EnvironmentSchema).min(1).default(() => defaultEnvironments()),
  /** Environment preselected for new tasks. */
  defaultEnvironmentId: z.string().min(1).default('local'),
  tickMs: z.number().int().positive().default(1000),
  inboxPollMs: z.number().int().positive().default(2000),
  signalPollMs: z.number().int().positive().default(1000),
  /** Stagger overdue tasks on startup so they don't all fire at once. */
  staggerFirstRun: z.object({
    enabled: z.boolean().default(true),
    minDelaySec: z.number().nonnegative().default(60),
    maxDelaySec: z.number().positive().default(600),
    minIntervalSec: z.number().nonnegative().default(30),
  }).default({}),
  /** Bytes of live terminal output kept per task for late-attaching UIs. */
  outputBufferBytes: z.number().int().positive().default(262144),
  /** Custom file path for the tasks store. Undefined = <dataDir>/tasks.json. */
  tasksFile: z.string().min(1).optional(),
  /** Custom file path for the templates store. Undefined = <dataDir>/templates.json. */
  templatesFile: z.string().min(1).optional(),
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: z.boolean().default(false),
}).superRefine((s, ctx) => {
  const envIds = new Set<string>();
  for (const env of s.environments) {
    if (envIds.has(env.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['environments'], message: `duplicate environment id "${env.id}"` });
    }
    envIds.add(env.id);
    const harnessIds = new Set<string>();
    for (const h of env.harnesses) {
      if (harnessIds.has(h.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environments'],
          message: `environment "${env.name}": duplicate harness id "${h.id}"`,
        });
      }
      harnessIds.add(h.id);
    }
  }
  if (!envIds.has(s.defaultEnvironmentId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultEnvironmentId'],
      message: `unknown environment "${s.defaultEnvironmentId}"`,
    });
  }
  if (s.staggerFirstRun.enabled && s.staggerFirstRun.minDelaySec > s.staggerFirstRun.maxDelaySec) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['staggerFirstRun', 'minDelaySec'],
      message: 'min delay must be ≤ max delay',
    });
  }
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------- Runtime ----------

export type TaskState =
  | 'idle'
  | 'checking'
  | 'classifying'
  | 'running'
  | 'paused'
  | 'disabled';

export interface TaskRuntime {
  taskId: string;
  state: TaskState;
  /** Agent finished a turn without signalling done and the task is configured to hold. */
  held: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: string | null;
  consecutiveErrors: number;
  currentRunId: string | null;
  pausedReason: string | null;
}

export type RunPhase = 'check' | 'classify' | 'agent' | 'skip' | 'system';

export type RunResult =
  | 'act'
  | 'noop'
  | 'error'
  | 'skipped'
  | 'started'
  | 'done'
  | 'idle-timeout'
  | 'max-runtime'
  | 'exited'
  | 'stopped'
  | 'interrupted'
  | 'held';

export interface RunRecord {
  ts: string;
  taskId: string;
  runId: string;
  phase: RunPhase;
  result: RunResult;
  durationMs?: number;
  exitCode?: number | null;
  summary?: string;
  error?: string;
  stdoutTail?: string;
  detail?: Record<string, unknown>;
}

export interface CheckOutput {
  act: boolean;
  summary?: string;
  context?: unknown;
}

export interface InboxCommand {
  op: 'run' | 'pause' | 'resume' | 'stop' | 'remove' | 'enable' | 'disable';
  taskId: string;
  reason?: string;
}

// ---------- Engine events (also the IPC contract) ----------

export type EngineEvent =
  | { type: 'runtime'; runtime: TaskRuntime }
  | { type: 'record'; record: RunRecord }
  | { type: 'agent:data'; taskId: string; runId: string; data: string }
  | { type: 'agent:end'; taskId: string; runId: string }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'templates'; templates: Template[] }
  | { type: 'settings'; settings: Settings };
