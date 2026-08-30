import { z } from 'zod';

// ---------- Task definition ----------

export const ScheduleSchema = z.union([
  z.object({ every: z.string().min(1) }).strict(),
  z.object({ cron: z.string().min(1) }).strict(),
]);

/**
 * `wsl` = a Linux bash environment. From a Windows host that is a WSL distro
 * (`distro`, or the default one). When looper itself runs inside WSL/Linux it
 * is simply the local shell.
 * `windows` = native Windows (PowerShell). From a WSL host this goes through
 * interop (`powershell.exe`).
 */
export const TargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('wsl'),
    distro: z.string().optional(),
    /** Shell + flags used to source the launcher. Default: "bash -lic". */
    shell: z.string().optional(),
  }),
  z.object({ kind: z.literal('windows') }),
]);

export const CheckSchema = z.object({
  command: z.string().min(1),
  timeoutSec: z.number().positive().default(60),
});

export const ClassifierSchema = z.object({
  model: z.string().min(1).default('haiku'),
  prompt: z.string().min(1),
  timeoutSec: z.number().positive().default(180),
  maxBudgetUsd: z.number().positive().default(0.1),
});

export const AgentSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  /** Appended verbatim to the `claude` command line. */
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
  target: TargetSchema,
  /** Working directory in the target's native form (/home/... or C:\...). */
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
export type Target = z.infer<typeof TargetSchema>;

// ---------- Settings ----------

export const SettingsSchema = z.object({
  /** Environment preselected for new tasks. */
  defaultTarget: z.enum(['wsl', 'windows']).default('wsl'),
  /** WSL distro used when a task does not name one (Windows host only). */
  defaultDistro: z.string().optional(),
  /** Where Windows drives are mounted inside WSL. */
  wslMountPrefix: z.string().default('/mnt'),
  claudeCommand: z.string().default('claude'),
  tickMs: z.number().int().positive().default(1000),
  inboxPollMs: z.number().int().positive().default(2000),
  signalPollMs: z.number().int().positive().default(1000),
  /** Delay before the first check of each task after startup / creation. */
  startDelaySec: z.number().nonnegative().default(5),
  /** Bytes of live terminal output kept per task for late-attaching UIs. */
  outputBufferBytes: z.number().int().positive().default(262144),
  /**
   * Interactive claude asks "do you trust this folder?" the first time it runs in a
   * directory and blocks until answered. The task's cwd was chosen deliberately, so
   * looper answers "yes" for you. Set false to answer it yourself in the terminal.
   */
  autoTrustWorkspace: z.boolean().default(true),
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

export interface LogLine {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

// ---------- Engine events (also the IPC contract) ----------

export type EngineEvent =
  | { type: 'runtime'; runtime: TaskRuntime }
  | { type: 'record'; record: RunRecord }
  | { type: 'agent:data'; taskId: string; runId: string; data: string }
  | { type: 'agent:end'; taskId: string; runId: string }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'log'; line: LogLine };
