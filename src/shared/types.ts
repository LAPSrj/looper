import { z } from 'zod';

// ---------- Task definition ----------

export const ScheduleConfigSchema = z
  .object({
    cron: z.string().min(1),
    /** IANA timezone the cron slots are evaluated in. Unset = the computer's timezone. */
    timezone: z.string().min(1).optional(),
  })
  .strict();

export const WatcherConfigSchema = z
  .object({
    /**
     * Long-running command spawned in the task's environment/cwd; each
     * non-empty stdout line is one trigger event (JSON preferred). Exiting
     * means "restart me" (with backoff); stderr is diagnostics.
     */
    command: z.string().min(1),
    /** Collect events this long before starting the run, so a burst becomes one run. */
    debounceSec: z.number().nonnegative().default(5),
    /**
     * Start one catch-up run when watching starts cold (app launch, task
     * enabled, pause lifted, system wake, run window opening) — the check
     * re-derives whatever happened while nothing was watching. Never fires on
     * crash restarts.
     */
    runOnStart: z.boolean().default(false),
    /**
     * The watcher only runs within these hours: it is stopped when the window
     * closes and started again (cold) when it opens. A batch caught inside
     * the window that found no free slot is held and coalesces into one run
     * when a slot and the window are next open. Unset = all day.
     */
    activeHours: z
      .object({
        from: z.number().int().min(0).max(23),
        to: z.number().int().min(0).max(23),
      })
      .strict()
      .optional(),
    /** Days of the week runs may start on (0 = Sunday). Unset = every day. */
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    /** IANA timezone the hours/days are evaluated in. Unset = the computer's timezone. */
    timezone: z.string().min(1).optional(),
  })
  .strict();

/**
 * What starts this task's runs. One mode at a time (Task Scheduler's "Begin
 * the task"); the other mode's configuration is kept while unselected, like a
 * disabled step keeps its fields.
 */
export const TriggerSchema = z
  .object({
    /** manual = only Run Now; schedule = cron slots; watcher = the watcher's events. */
    mode: z.enum(['manual', 'schedule', 'watcher']).default('schedule'),
    schedule: ScheduleConfigSchema.optional(),
    watcher: WatcherConfigSchema.optional(),
    /**
     * End of the trigger (schedule and watcher modes): once `at` passes, the
     * task completes itself instead of running again. Off keeps the date but
     * never stops the task; unset = no end date was ever configured.
     */
    stopOn: z
      .object({
        enabled: z.boolean().default(true),
        at: z.string().min(1),
      })
      .optional(),
  })
  .strict();
export type Trigger = z.infer<typeof TriggerSchema>;

/** The task's cron schedule when the schedule trigger is selected, else null. */
export function scheduleOf(task: { trigger: Trigger }): { cron: string; timezone?: string } | null {
  return task.trigger.mode === 'schedule' && task.trigger.schedule ? task.trigger.schedule : null;
}

/** The task's watcher config when the events trigger is selected, else null. */
export function watcherOf(task: { trigger: Trigger }): z.infer<typeof WatcherConfigSchema> | null {
  return task.trigger.mode === 'watcher' && task.trigger.watcher ? task.trigger.watcher : null;
}

// ---------- Environments & harnesses ----------

/**
 * One entry of a harness's Model dropdown: `id` is the `--model` value, `name`
 * the label shown to the user. A bare string or a name-less entry means both.
 * `efforts` and `defaultEffort` make runs on this model predictable: the task
 * editor only offers the supported levels, and a task whose effort is Default
 * emits `defaultEffort` explicitly instead of inheriting the CLI's own state.
 */
export const HarnessModelSchema = z
  .union([
    z.string().min(1),
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      /** Effort levels this model accepts, in display order. Unset = the kind's full list. */
      efforts: z.array(z.string().min(1)).min(1).optional(),
      /** Effort emitted when the task's effort is Default. Unset = omit the flag (the CLI decides). */
      defaultEffort: z.string().min(1).optional(),
    }),
  ])
  .transform((m): { id: string; name: string; efforts?: string[]; defaultEffort?: string } =>
    typeof m === 'string'
      ? { id: m, name: m }
      : { id: m.id, name: m.name ?? m.id, efforts: m.efforts, defaultEffort: m.defaultEffort },
  );
export type HarnessModel = z.output<typeof HarnessModelSchema>;

/**
 * A harness is one installed agent CLI inside an environment. `claude-code`
 * and `codex` get full integration: model and permission flags, idle detection
 * and the final report (claude via its Stop hook, codex via its notify hook),
 * rolling conversations, structured classifier output, folder-trust
 * auto-answer, and a headless mode (`claude -p` / `codex exec`). `custom` is
 * invoked as `command [args…] "<prompt>"` and ends via the done command,
 * process exit or the max runtime. The `looper-done` helper is on PATH for
 * every harness.
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
  /** Max tasks active at once on this harness. Unset = unlimited. */
  maxConcurrentTasks: z.number().int().positive().optional(),
  /** Kind-specific behavior switches. */
  options: z
    .object({
      /**
       * claude-code and codex. Interactive claude asks "do you trust this folder?" (codex: "do
       * you trust the contents of this directory?") the first time it runs in a directory and
       * blocks until answered. The task's cwd was chosen deliberately, so looper answers "yes"
       * for you unless this is false.
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
  /** Max tasks active at once in this environment. Unset = unlimited. */
  maxConcurrentTasks: z.number().int().positive().optional(),
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

export const CheckSchema = z
  .object({
    /** Off keeps the configuration but skips the step (the agent always runs). */
    enabled: z.boolean().default(true),
    command: z.string().min(1),
    timeoutSec: z.number().positive().default(60),
  })
  .strict();

export const ClassifierSchema = z
  .object({
    /** Off keeps the configuration but skips the step. */
    enabled: z.boolean().default(true),
    harnessId: z.string().min(1).optional(),
    model: z.string().min(1).default('haiku'),
    prompt: z.string().min(1),
    /** Headless answers via structured output; interactive runs in the terminal tab and answers via `looper-classify`. */
    mode: z.enum(['interactive', 'headless']).default('headless'),
    timeoutSec: z.number().positive().default(180),
  })
  .strict();

export const AgentSchema = z
  .object({
    /** Harness from the task's environment; empty = the environment's first harness. */
    harnessId: z.string().min(1).optional(),
    model: z.string().optional(),
    /** claude: passed as --effort; codex: as -c model_reasoning_effort=. Unset = the CLI's own default. */
    effort: z.string().min(1).optional(),
    prompt: z.string().min(1),
    /** Appended verbatim to the harness command line. */
    extraArgs: z.array(z.string()).default([]),
    mode: z.enum(['interactive', 'headless']).default('interactive'),
    /** claude-code and codex: continue one conversation across runs instead of starting fresh each run. */
    session: z.enum(['fresh', 'continue']).default('fresh'),
    /** session 'continue': start a new conversation after this many runs on the same one. */
    sessionMaxRuns: z.number().int().positive().default(10),
    /** claude: passed as --permission-mode; codex: mapped to its sandbox/approval flags. Empty string omits the flags. */
    permissionMode: z.string().default('auto'),
    maxRuntimeMin: z.number().positive().default(120),
    /** Minutes the agent may sit idle (turn finished, no `looper-done`) before the run ends / is held. */
    idleGraceMin: z.number().positive().default(3),
    onIdleTimeout: z.enum(['finish', 'hold']).default('finish'),
  })
  .strict();

/**
 * Which system notifications (toasts) a task sends. The `end` levels nest so a
 * cycle's end sends at most one notification: `error` = errors only; `warning`
 * = errors and warnings; `end` = any end except no-action; `all` = every end.
 * A more specific end event (usage limit, auto-pause, completion) replaces the
 * plain end notification when its own switch is on, and falls through to `end`
 * when off.
 */
export const TaskNotificationsSchema = z
  .object({
    /** A cycle started (the check step included). */
    runStart: z.boolean().default(false),
    /** The agent step started. */
    agentStart: z.boolean().default(false),
    end: z.enum(['off', 'error', 'warning', 'end', 'all']).default('warning'),
    /** The agent went idle and is holding for a human. */
    held: z.boolean().default(false),
    /** The task auto-paused after consecutive errors. */
    autoPaused: z.boolean().default(false),
    /** The task is finished for good (the agent completed it, or its deadline passed). */
    completed: z.boolean().default(false),
    /** A run hit the usage limit and waits for the reset. */
    usageLimit: z.boolean().default(false),
    /** Also send the end notification when the run failed only because the computer was offline. */
    networkErrors: z.boolean().default(false),
  })
  .strict()
  .default({});
export type TaskNotifications = z.infer<typeof TaskNotificationsSchema>;

/**
 * One-off guidance for a task's next run(s): appended to both the classifier
 * and the agent prompt, and consumed per run whose agent actually received it
 * (a run that ends as an
 * engine `error` — spawn failure, usage limit — or is stopped by the user
 * never consumes a charge).
 */
export const NoteSchema = z
  .object({
    text: z.string().min(1),
    runsLeft: z.number().int().positive().default(1),
  })
  .strict();
export type Note = z.infer<typeof NoteSchema>;

/**
 * What happens when a task is finished for good. A completed task keeps its
 * whole definition but never runs again (`enabled` is forced off), is moved to
 * the global completed-tasks folder when one is set, and is deleted once the
 * global completed-task retention runs out.
 */
export const CompletionSchema = z
  .object({
    /**
     * The task may be completed at all: by hand from the Task menu, and by the
     * agent through `looper-complete`. Off = the Complete action is disabled
     * and the agent's helper is never created.
     */
    allowed: z.boolean().default(false),
  })
  .strict()
  .default({});
export type Completion = z.infer<typeof CompletionSchema>;

/** A sidebar folder grouping tasks. Tasks reference it via `folderId`; folders nest via `parentId`. */
export const TaskFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Parent folder. Unset = top level. */
  parentId: z.string().min(1).optional(),
});
export type TaskFolder = z.infer<typeof TaskFolderSchema>;

// `.strict()` throughout: an unknown key is a typo or a misremembered field
// name, and silently stripping it would ship a task that quietly lacks the
// setting the author thought they set (e.g. `allowCompletion` instead of
// `completion.allowed`).
export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'letters, digits, - and _ only'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /**
   * Set = the task is finished for good: when it entered that state. The store
   * keeps `enabled` false while it is set, so every scheduling guard that reads
   * `enabled` parks a completed task without knowing about completion at all.
   */
  completedAt: z.string().optional(),
  /** Why it completed: the agent's reason, the deadline, or the user. */
  completedReason: z.string().optional(),
  completion: CompletionSchema,
  /** Sidebar folder the task is filed under. Unset = top level. */
  folderId: z.string().min(1).optional(),
  trigger: TriggerSchema,
  /** Environment (from Settings) the task runs in. */
  environmentId: z.string().min(1),
  /** Working directory in the environment's native form (/home/... or C:\...). */
  cwd: z.string().min(1),
  /** Extra environment variables for every step of this task (check, classifier, agent). Override the harness's. */
  env: z.record(z.string()).default({}),
  /** Unset or disabled = no check step: every scheduled slot goes straight to the agent. */
  check: CheckSchema.optional(),
  classifier: ClassifierSchema.optional(),
  agent: AgentSchema,
  backoff: z
    .object({ maxConsecutiveErrors: z.number().int().positive().default(5) })
    .strict()
    .default({}),
  /** Cycles of this task that may be in flight at once; 1 = a due slot while a run is active is skipped. */
  maxConcurrentRuns: z.number().int().positive().default(1),
  notifications: TaskNotificationsSchema,
  note: NoteSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict();

export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

export const TemplateSchema = TaskSchema.extend({
  name: z.string(),
  trigger: TriggerSchema.extend({ schedule: ScheduleConfigSchema.extend({ cron: z.string() }).optional() }),
  environmentId: z.string(),
  cwd: z.string(),
  check: CheckSchema.extend({ command: z.string() }).optional(),
  classifier: ClassifierSchema.extend({ prompt: z.string() }).optional(),
  agent: AgentSchema.extend({ prompt: z.string() }),
});

export type Template = Task;
export type TemplateInput = TaskInput;

// ---------- Settings ----------

export const SettingsSchema = z.object({
  /** Where checks and agents can run, each with its own harness list. */
  environments: z.array(EnvironmentSchema).min(1).default(() => defaultEnvironments()),
  /** Environment preselected for new tasks. */
  defaultEnvironmentId: z.string().min(1).default('local'),
  /** Sidebar folder every task is moved into as it completes. Unset = completed tasks stay put. */
  completedFolderId: z.string().min(1).optional(),
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
  /** Days a run's records and output are kept before being deleted. */
  runRetentionDays: z.number().int().positive().default(30),
  /** Days engine.log entries are kept before being pruned. */
  engineLogRetentionDays: z.number().int().positive().default(10),
  /** Delete a completed task (and its run history) once it has been completed this long. */
  completedTaskRetention: z
    .object({
      enabled: z.boolean().default(true),
      days: z.number().int().positive().default(10),
    })
    .default({}),
  /** Custom file path for the tasks store. Undefined = <dataDir>/tasks.json. */
  tasksFile: z.string().min(1).optional(),
  /** Custom file path for the templates store. Undefined = <dataDir>/templates.json. */
  templatesFile: z.string().min(1).optional(),
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: z.boolean().default(false),
  /** Master switch for system notifications; per-task selection is on the task. */
  notificationsEnabled: z.boolean().default(true),
  /** Show a step-selection window before a manual Run Now starts. */
  promptRunOptions: z.boolean().default(false),
  /** Rest Mode: sleep the computer between runs and wake it for the next one (Windows only). */
  rest: z.object({
    /** Earliest the wake timer may fire, counted from the moment the computer goes to sleep. */
    minSleepMin: z.number().positive().default(30),
    /** How long every task must have been quiet before the computer is put to sleep. */
    graceSec: z.number().positive().default(60),
    /** Turn Rest Mode off when something other than the wake timer wakes the computer. */
    disarmOnUserWake: z.boolean().default(true),
  }).default({}),
  /** Main-window view options (View menu). */
  view: z.object({
    toolbar: z.boolean().default(true),
    statusBar: z.boolean().default(true),
    taskList: z.enum(['standard', 'compact']).default('standard'),
    showDisabledTasks: z.boolean().default(true),
    showCompletedTasks: z.boolean().default(true),
    showScheduledTasks: z.boolean().default(true),
    showManualTasks: z.boolean().default(true),
    showWatcherTasks: z.boolean().default(true),
    /** On: folders start open and opening one opens its whole subtree. Off: folders start closed. */
    autoOpenFolders: z.boolean().default(true),
    hideNoActionRuns: z.boolean().default(false),
  }).default({}),
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
  | 'disabled'
  | 'completed';

/**
 * Steps a manual run was told to skip (the Run Options window). Only a manual
 * run ever carries them; a step the task doesn't have enabled is unaffected.
 */
export interface RunSkips {
  check?: boolean;
  classifier?: boolean;
  agent?: boolean;
}

/** One cycle of a task that is in flight; a task may have up to `maxConcurrentRuns` of them. */
export interface ActiveRun {
  runId: string;
  state: 'checking' | 'classifying' | 'running';
  /** Agent finished a turn without signalling done and the task is configured to hold. */
  held: boolean;
  startedAt: number;
  trigger: 'timer' | 'manual' | 'watcher';
}

/**
 * A task's live state. `runs` is the truth; `state`, `currentRunId` and `held`
 * are the aggregate the task list and menus read:
 * - `state` = the most advanced active run (`running` > `classifying` >
 *   `checking`), or idle/paused/disabled/completed when nothing is in flight;
 * - `currentRunId` = the newest active run, null when none;
 * - `held` = any active run is held.
 */
export interface TaskRuntime {
  taskId: string;
  state: TaskState;
  /** Any active run is holding for a human. */
  held: boolean;
  /** Cycles in flight, oldest first. Empty when the task is idle/paused/disabled/completed. */
  runs: ActiveRun[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** Outcome of the last cycle (success, warning, error, noop, ...). */
  lastResult: RunResult | null;
  /** One line about the last cycle: the run's headline, the check summary, or the error. */
  lastDetail: string | null;
  consecutiveErrors: number;
  currentRunId: string | null;
  pausedReason: string | null;
  /** Events trigger only: the watcher process is up, waiting to respawn, or not wanted (null). */
  watcher: 'watching' | 'restarting' | null;
  /** Rolling conversation (agent.session 'continue'): the id runs resume, and how many runs used it. */
  session: { id: string; runs: number } | null;
}

export type RestPhase = 'off' | 'waiting' | 'countdown' | 'sleeping';

export interface RestState {
  armed: boolean;
  /** off | waiting (tasks active) | countdown (quiet, sleep pending) | sleeping. */
  phase: RestPhase;
  /** Epoch ms when the computer will be put to sleep (countdown phase only). */
  sleepAt: number | null;
  /** Epoch ms the wake timer is set for; null = nothing scheduled, sleep without a wake. */
  wakeAt: number | null;
}

export type RunPhase = 'watcher' | 'check' | 'classify' | 'agent' | 'result' | 'skip' | 'system';

export type RunResult =
  | 'act'
  | 'noop'
  | 'error'
  | 'skipped'
  | 'started'
  | 'done'
  | 'success'
  | 'warning'
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
  /** One line: the check summary, the classifier reason, or the run's headline (`result` phase). */
  summary?: string;
  /** The agent's final message (`result` phase) or the full prompt it was given (`agent` `started`). Markdown. */
  body?: string;
  error?: string;
  /** The error was a network failure: no connection, DNS, refused, timed out. */
  network?: boolean;
  /** The error happened because the computer slept through the run, not because the task failed. */
  slept?: boolean;
  stdoutTail?: string;
  detail?: Record<string, unknown>;
}

export interface CheckOutput {
  act: boolean;
  summary?: string;
  context?: unknown;
}

export interface InboxCommand {
  op: 'run' | 'pause' | 'resume' | 'stop' | 'remove' | 'enable' | 'disable' | 'complete' | 'reopen';
  taskId: string;
  reason?: string;
}

// ---------- Engine events (also the IPC contract) ----------

/** What a `notify` event is about; it decides where a click on the toast lands. */
export type NotifyKind = 'run-start' | 'agent-start' | 'held' | 'end' | 'auto-paused' | 'usage-limit' | 'completed';

export type EngineEvent =
  | { type: 'runtime'; runtime: TaskRuntime }
  | { type: 'record'; record: RunRecord }
  | { type: 'agent:data'; taskId: string; runId: string; data: string }
  | { type: 'agent:end'; taskId: string; runId: string }
  | { type: 'notify'; taskId: string; runId: string; kind: NotifyKind; title: string; body: string }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'folders'; folders: TaskFolder[]; layout: Record<string, string[]> }
  | { type: 'templates'; templates: Template[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'rest'; rest: RestState; disarmReason?: 'user-wake' };
