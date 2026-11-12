import { z } from 'zod';

// Without generating a parser per schema: making them cost 38 ms of the main process's start, for parses that
// take microseconds either way. The windows' CSP rules the generated ones out already.
z.config({ jitless: true });
import { AddonLocalRunSchema } from './addons';
import type { BuilderState } from './builder';
import type { ChatState } from './chat';
import type { RemoteState } from './remote';
import type { RemoteAccessState } from './remote-access';
import type { SessionActivity, SessionsState } from './sessions';

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
    /**
     * An event whose `looper_related_id` matches a run in flight goes to that run's agent
     * instead of starting a run, and one with a new id gets a run of its own.
     * Watcher lines and the check's output carry the id. Whatever can't reach
     * the agent waits for the next run.
     */
    sendRelatedEvents: z.boolean().default(false),
  })
  .strict();
export type Trigger = z.infer<typeof TriggerSchema>;

/** The field of a watcher line or a check's output that says which events are related. */
export const RELATED_ID_FIELD = 'looper_related_id';

/** The related id in a parsed line or check output, as a string; undefined when it has none. */
export function relatedIdIn(value: unknown): string | undefined {
  const id = (value as Record<string, unknown> | null | undefined)?.[RELATED_ID_FIELD];
  if (typeof id === 'number') return String(id);
  return typeof id === 'string' && id ? id : undefined;
}

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
/** Environment variables. Launchers write the names unquoted (`export NAME=…`), so only plain names pass. */
export const EnvVarsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'variable names may only use letters, digits and _, and not start with a digit'),
  z.string(),
  { error: (issue) => (issue.code === 'invalid_key' ? issue.issues[0]?.message : undefined) },
);

export const HarnessSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(['claude-code', 'codex', 'custom']).default('claude-code'),
  /** Command or full path inside the environment. Quote it yourself if it contains spaces. */
  command: z.string().min(1),
  /** Arguments always added before the prompt. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables for this harness's runs (e.g. two installs on different accounts). */
  env: EnvVarsSchema.default({}),
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
       * for you unless this is false. For claude it also approves the folder's project MCP
       * servers (.mcp.json), whose dialog would block the same way.
       */
      autoTrustWorkspace: z.boolean().optional(),
      /**
       * claude-code. Chats and Looper terminals that start on this harness while
       * Remote Control is turned on start with it, so the Claude app can drive
       * them, and Remote Control lists them with its conversations.
       */
      remoteControl: z.boolean().optional(),
      /**
       * claude-code. A Remote Control conversation it keeps open, or one a helper
       * opened, on this harness ends once it sits idle until its prompt cache
       * expires (it can be resumed). Unset = on.
       */
      closeWhenCacheExpires: z.boolean().optional(),
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
    /** Headless answers via structured output; interactive runs in a terminal and answers via `looper-classify`. */
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
    /** Replaces the harness's command for the agent (e.g. a wrapper script). Unset = the harness's command. */
    command: z.string().min(1).optional(),
    /** Appended verbatim to the harness command line, after the project's (`projectArgs`). */
    extraArgs: z.array(z.string()).default([]),
    mode: z.enum(['interactive', 'headless']).default('interactive'),
    /** claude-code and codex: continue one conversation across runs instead of starting fresh each run. */
    session: z.enum(['fresh', 'continue']).default('fresh'),
    /** session 'continue': start a new conversation after this many runs on the same one. */
    sessionMaxRuns: z.number().int().positive().default(10),
    /**
     * claude-code and codex: once the agent's context passes this many
     * thousand tokens, Looper asks it to restart, and the run continues in a
     * new conversation with the agent's handoff. Unset = no limit.
     */
    contextLimitK: z.number().int().positive().optional(),
    /** contextLimitK: how many restarts one run may make. */
    maxRestarts: z.number().int().nonnegative().default(3),
    /** claude: passed as --permission-mode; codex: mapped to its sandbox/approval flags. Empty string omits the flags. */
    permissionMode: z.string().default('auto'),
    maxRuntimeMin: z.number().positive().default(120),
    /** Minutes the agent may sit idle (turn finished, no `looper-done`) before the run ends / is held. */
    idleGraceMin: z.number().positive().default(3),
    onIdleTimeout: z.enum(['finish', 'hold']).default('finish'),
    /**
     * The agent may ask the user a question with `looper-ask`, as a last
     * resort. The command waits up to `waitMin` for the answer; without one,
     * the agent goes on and picks the run's final status itself.
     */
    ask: z
      .object({
        allowed: z.boolean().default(false),
        waitMin: z.number().positive().default(5),
      })
      .strict()
      .prefault({}),
    /**
     * The agent may start agents in other folders with `looper-delegate`.
     * Each one is a run of its own, and its result comes back to this run's
     * agent, which can't finish while one is still going.
     */
    delegate: z
      .object({
        allowed: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
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
    /** Also send the end notification when the run failed only because the machine's environment (WSL) could not start a step. */
    environmentErrors: z.boolean().default(false),
  })
  .strict()
  .prefault({});
export type TaskNotifications = z.infer<typeof TaskNotificationsSchema>;

/**
 * One-off guidance for a task's next run(s): appended to both the classifier
 * and the agent prompt, written to the run dir for every step
 * (LOOPER_NOTE_FILE), and consumed per run whose agent actually received it
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
 * the global completed-tasks folder when one is set, and goes to the Recycle
 * Bin once the global completed-task retention runs out.
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
  .prefault({});
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
  /**
   * The project the task belongs to. Unset, unknown, or with `cwd` set to
   * another folder: the store files the task under the project of `cwd` in
   * `environmentId`, creating it when there is none.
   */
  projectId: z.string().min(1).optional(),
  /** Off: `environmentId` follows the project's environment. */
  overrideEnvironment: z.boolean().default(false),
  /** Off: the agent's harness, session type, model, effort and permission mode follow the project's. */
  overrideAgent: z.boolean().default(false),
  /** Environment (from Settings) the task runs in: the project's unless `overrideEnvironment`. */
  environmentId: z.string().min(1),
  /** Working directory in the environment's native form (/home/... or C:\...): always the project's folder. */
  cwd: z.string().min(1),
  /** Extra environment variables for every step of this task (check, classifier, agent), on top of the project's (`projectEnv`). Override the harness's. */
  env: EnvVarsSchema.default({}),
  /** The project's environment variables, copied in by the store; the task's own `env` wins on the same name. */
  projectEnv: EnvVarsSchema.default({}),
  /** The project's extra command-line arguments, copied in by the store; the agent's own `extraArgs` follow them. */
  projectArgs: z.array(z.string()).default([]),
  /** Unset or disabled = no check step: every scheduled slot goes straight to the agent. */
  check: CheckSchema.optional(),
  classifier: ClassifierSchema.optional(),
  agent: AgentSchema,
  backoff: z
    .object({ maxConsecutiveErrors: z.number().int().positive().default(5) })
    .strict()
    .prefault({}),
  /** Cycles of this task that may be in flight at once; 1 = a due slot while a run is active is skipped. */
  maxConcurrentRuns: z.number().int().positive().default(1),
  notifications: TaskNotificationsSchema,
  note: NoteSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict();

export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

/**
 * A deleted task waiting in the Recycle Bin. The definition is kept as it was
 * and only checked again on restore, so a task whose environment went away
 * while it sat in the bin is still listed (restoring it reports why it can't).
 */
export interface RecycleBinEntry {
  task: Task;
  deletedAt: string;
}

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

/** Which tasks a task list shows. A pane offers only the filters that can change its contents (see shared/panes). */
export const TaskFilterSchema = z.object({
  showDisabled: z.boolean().default(true),
  showCompleted: z.boolean().default(true),
  showScheduled: z.boolean().default(true),
  showManual: z.boolean().default(true),
  showWatcher: z.boolean().default(true),
});
export type TaskFilter = z.infer<typeof TaskFilterSchema>;

/** A task list's options: its filters, and how it shows folders. */
export const TaskListOptionsSchema = TaskFilterSchema.extend({
  /** Off: the list shows its tasks straight, without folder rows. */
  showFolders: z.boolean().default(true),
  /** Hide a folder none of whose tasks this list shows. */
  hideEmptyFolders: z.boolean().default(false),
});
export type TaskListOptions = z.infer<typeof TaskListOptionsSchema>;

/** One pane of the multiple-pane sidebar. */
export const SidebarPaneSchema = TaskListOptionsSchema.extend({
  visible: z.boolean().default(true),
  collapsed: z.boolean().default(false),
  /** Share of the sidebar's height among the open panes. */
  weight: z.number().positive().default(1),
});
export type SidebarPane = z.infer<typeof SidebarPaneSchema>;

export const ViewSchema = z.object({
  toolbar: z.boolean().default(true),
  statusBar: z.boolean().default(true),
  /** The main window's tabs: below the toolbar, down its left side, or above the status bar. */
  tabs: z
    .object({
      position: z.enum(['top', 'left', 'bottom']).default('left'),
      /** At the top or bottom: each tab shows its icon before its name. */
      icons: z.boolean().default(true),
      /** On the left: each tab shows its name below its icon. */
      labels: z.boolean().default(true),
    })
    .prefault({}),
  taskList: z.enum(['standard', 'compact']).default('standard'),
  /** One task list, or the Tasks / Goals / Watchers panes stacked. */
  sidebar: z.enum(['single', 'multiple']).default('single'),
  /** What a phone's Tasks tab lists (its Filter button): everything, or one of the desktop's panes. */
  phoneTaskKind: z.enum(['all', 'tasks', 'goals', 'watchers']).default('all'),
  single: TaskListOptionsSchema.extend({ visible: z.boolean().default(true) }).prefault({}),
  panes: z
    .object({
      tasks: SidebarPaneSchema.prefault({}),
      goals: SidebarPaneSchema.prefault({ showCompleted: false }),
      watchers: SidebarPaneSchema.prefault({}),
    })
    .prefault({}),
  /** The Projects tab's list. */
  projectsPane: z
    .object({
      /** The list's groups: none, the folder the projects' folders are in, or the harness their sessions start with. */
      groupBy: z.enum(['none', 'folder', 'harness']).default('none'),
    })
    .prefault({}),
  /** Addons whose buttons the main toolbar leaves out (View → "<Addon> Toolbar"), by addon id. */
  hiddenAddonToolbars: z.array(z.string()).default([]),
  /** The Needs attention rows Clear took off the dashboards, by attentionKey; a row's key leaves once the row itself is gone. */
  attentionCleared: z.array(z.string()).default([]),
  /** On: folders start open and opening one opens its whole subtree. Off: folders start closed. */
  autoOpenFolders: z.boolean().default(true),
  /** View → Task Runs: what the Runs tabs and the dashboards' Recent runs leave out. */
  runFilter: z
    .object({
      /** Runs the scheduler skipped or deferred, or whose steps Run Options skipped. */
      hideSkipped: z.boolean().default(false),
      /** Runs whose check or classifier found nothing to do. */
      hideNoAction: z.boolean().default(false),
    })
    .prefault({}),
  /** The Chats window's View menu, and the project groups closed in its list (by project id or group name). */
  sessions: z
    .object({
      toolbar: z.boolean().default(true),
      activityPane: z.boolean().default(true),
      statusBar: z.boolean().default(true),
      /** The list also shows the agents of task runs in flight. */
      showRuns: z.boolean().default(false),
      /** A single chat's window (Open in New Window) shows the activity pane. */
      windowActivityPane: z.boolean().default(false),
      /** A single chat's window shows the toolbar. */
      windowToolbar: z.boolean().default(true),
      /** A single chat's window shows the status bar. */
      windowStatusBar: z.boolean().default(true),
      collapsed: z.array(z.string()).default([]),
      /** The dashboard's cards shown at twice their size, by session id. */
      bigCards: z.array(z.string()).default([]),
      /** The dashboard's cards in the order they were dragged to, by session id. */
      cardOrder: z.array(z.string()).default([]),
      /** The dashboard's column widths dragged to, from the first column, in pixels (0: automatic); more columns fill the rest. */
      cardColumns: z.array(z.number().min(0)).default([]),
      /** The dashboard's row heights dragged to, from the top, in pixels (0: automatic). */
      cardRows: z.array(z.number().min(0)).default([]),
      /** The sessions waiting for the user show first: the list's Waiting for you group, and the dashboard's first cards. */
      waitingFirst: z.boolean().default(true),
    })
    .prefault({}),
  /** The History window's View menu. */
  history: z
    .object({
      groupBy: z.enum(['date', 'folder']).default('date'),
      /** The list shows task runs too. */
      showRuns: z.boolean().default(true),
    })
    .prefault({}),
});
export type View = z.infer<typeof ViewSchema>;

/** A folder in an environment, and the harness and settings sessions there start with. */
const SessionPlaceShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  environmentId: z.string().min(1),
  /** Unset = the environment's first harness (a helper: its first Claude Code one). */
  harnessId: z.string().min(1).optional(),
  /** Working directory in the environment's native form. */
  cwd: z.string().default(''),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  /** A PERMISSION_MODES value; '' passes no mode. */
  permissionMode: z.string().default('auto'),
};

/**
 * A project: a folder that tasks run in and sessions open in. Its environment
 * and its agent settings (harness, session type, model, effort, permission
 * mode) are the defaults of its tasks, which can override them; its chats,
 * terminals and Remote Control conversations start with the same harness,
 * model, effort and permission mode.
 */
export const ProjectSchema = z
  .object({
    ...SessionPlaceShape,
    cwd: z.string().min(1),
    /** Its tasks' session type; sessions are always interactive. */
    mode: z.enum(['interactive', 'headless']).default('interactive'),
    /** Appended to the harness command line of its tasks' agents and its sessions; a task's own follow them. */
    extraArgs: z.array(z.string()).default([]),
    /** Environment variables for its tasks' steps and its sessions; a task's own win on the same name. */
    env: EnvVarsSchema.default({}),
    /** Remote Control keeps a conversation open here while it runs. */
    remote: z.boolean().default(false),
    /** The Projects tab's folder it's in (ProjectFolder); unset: the top level. */
    folderId: z.string().min(1).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

/** A folder of the Projects tab's list, which the user makes to keep projects together: the same as a task folder, nesting included. */
export const ProjectFolderSchema = TaskFolderSchema;
export type ProjectFolder = TaskFolder;

/**
 * A helper: a conversation Looper keeps open so the user can ask it, from the
 * Claude app, to open sessions in other folders (`looper-remote`). It runs
 * apart from the user's Claude Code setup and the folder's (no settings files,
 * CLAUDE.md, skills or MCP servers), with only `ls` and `looper-remote`
 * allowed, so it has no permission mode of its own. Once it has been idle
 * this long, Looper replaces it with a fresh, empty one, so the next request
 * starts clean.
 */
const { permissionMode: _helpersHaveNone, ...RemoteHelperShape } = SessionPlaceShape;
export const RemoteHelperSchema = z
  .object({
    ...RemoteHelperShape,
    /** Appended to Looper's own instructions for the helper. */
    instructions: z.string().default(''),
    idleRestartMin: z.number().positive().default(10),
  })
  .strict();
export type RemoteHelper = z.infer<typeof RemoteHelperSchema>;

export const RemoteSettingsSchema = z
  .object({
    /** Turned on: Remote Control runs now and every time Looper starts. */
    enabled: z.boolean().default(false),
    helpers: z.array(RemoteHelperSchema).default([]),
  })
  .prefault({});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

/** A machine name on the tailnet: the start of its ts.net address. */
export const TailnetHostnameSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'use lowercase letters, digits and hyphens');

/**
 * Advanced → Remote Access: Looper's UI served to other devices. The server
 * listens on 127.0.0.1 only; each source makes it reachable (tailscale: an
 * HTTPS address on the user's tailnet; local: this computer's browser only).
 *
 * Not strict: loadSettings replaces the whole file with defaults when any
 * part fails, so a field an older Looper wrote (`provider`) is dropped here
 * rather than costing every other setting.
 */
export const RemoteAccessSettingsSchema = z
  .object({
    /** Turned on (Advanced → Remote Access → Turn On): it starts with Looper too, once a source is chosen. */
    enabled: z.boolean().default(false),
    /** How devices reach it; none = not set up yet (Turn On opens Set Up). */
    sources: z
      .array(z.enum(['tailscale', 'local']))
      .refine((s) => new Set(s).size === s.length, 'list each source once')
      .default([]),
    /** The name paired devices show for this computer; '' = the OS computer name. */
    name: z.string().max(64, 'use at most 64 characters').default(''),
    /** The machine name on the tailnet: the start of its ts.net address. */
    hostname: TailnetHostnameSchema.default('looper'),
    /** The 127.0.0.1 port the server listens on; 0 = a free one, which the first start then saves here. */
    port: z.number().int().min(0).max(65535).default(0),
  })
  .prefault({});
export type RemoteAccessSettings = z.infer<typeof RemoteAccessSettingsSchema>;

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
  }).prefault({}),
  /** Days a run's records and output are kept before being deleted. */
  runRetentionDays: z.number().int().positive().default(30),
  /** Days engine.log entries are kept before being pruned. */
  engineLogRetentionDays: z.number().int().positive().default(10),
  /** Move a completed task to the Recycle Bin once it has been completed this long. */
  completedTaskRetention: z
    .object({
      enabled: z.boolean().default(true),
      days: z.number().int().positive().default(10),
    })
    .prefault({}),
  /** Days a task stays in the Recycle Bin before it is deleted for good, along with its run history. */
  recycleBinDays: z.number().int().positive().default(30),
  /** Custom file path for the tasks store. Undefined = <dataDir>/tasks.json. */
  tasksFile: z.string().min(1).optional(),
  /** Custom file path for the templates store. Undefined = <dataDir>/templates.json. */
  templatesFile: z.string().min(1).optional(),
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: z.boolean().default(false),
  /** Ask before quitting when it would stop something. */
  confirmQuit: z
    .object({
      /** Runs in flight (check, classifier or agent): quitting stops them. */
      runs: z.boolean().default(true),
      /** Tasks whose watcher is up: quitting stops it until Looper starts again. Only asked while `runs` is on. */
      watchers: z.boolean().default(false),
    })
    .prefault({}),
  /** Master switch for system notifications; per-task selection is on the task. */
  notificationsEnabled: z.boolean().default(true),
  /** Show a step-selection window before a manual Run Now starts. */
  promptRunOptions: z.boolean().default(false),
  /**
   * Where Open Project in Terminal and Continue in Terminal open the session:
   * looper = a Looper terminal window; system = the system's default terminal.
   */
  terminal: z.enum(['looper', 'system']).default('looper'),
  /** Where the task builder (New Task with Agent, Edit with Agent) shows the conversation. */
  builder: z
    .object({
      /** chat = Looper's message view; terminal = the harness's own interactive session. */
      view: z.enum(['chat', 'terminal']).default('chat'),
    })
    .prefault({}),
  /** Rest Mode: sleep the computer between runs and wake it for the next one (Windows only). */
  rest: z.object({
    /** Earliest the wake timer may fire, counted from the moment the computer goes to sleep. */
    minSleepMin: z.number().positive().default(30),
    /** How long every task must have been quiet before the computer is put to sleep. */
    graceSec: z.number().positive().default(60),
    /** Turn Rest Mode off when something other than the wake timer wakes the computer. */
    disarmOnUserWake: z.boolean().default(true),
  }).prefault({}),
  /** Advanced → Prevent Sleep → While a Session Is Working: keep the computer awake while a chat, terminal or task agent works. */
  preventSleepWhileWorking: z.boolean().default(false),
  /** Settings → Chats. */
  chats: z
    .object({
      /** Thinking blocks show open, outside the tool-call groups. */
      expandThinking: z.boolean().default(false),
      /** Close Conversation asks first; off, it closes at once unless the agent is working or waiting on a permission answer. */
      confirmClose: z.boolean().default(false),
      /** With confirmClose, Close Conversation doesn't ask once the prompt cache of the agent's last reply has expired. */
      closeExpiredWithoutAsking: z.boolean().default(false),
      /** An idle chat's or terminal session's agent stops once its prompt cache expires; the next message (or key) starts it again on the conversation. */
      stopWhenCacheExpires: z.boolean().default(false),
      /** A new chat starts with Continue When Limit Resets on. */
      continueAfterLimit: z.boolean().default(false),
      /** Continue When Limit Resets doesn't send once the prompt cache has expired and the context is over `aboveTokens`; at 0, whatever its size. */
      skipExpiredContinue: z
        .object({
          enabled: z.boolean().default(false),
          aboveTokens: z.number().int().nonnegative().default(0),
        })
        .prefault({}),
      /** Ask before a chat's message goes to an agent whose prompt cache has expired, which re-reads the whole context at full price. */
      confirmExpiredSend: z
        .object({
          enabled: z.boolean().default(false),
          /** Only while the conversation's context is over `aboveTokens`. */
          onlyAbove: z.boolean().default(true),
          aboveTokens: z.number().int().positive().default(200_000),
        })
        .prefault({}),
      /** What a compacted conversation sends the agent (shared/compact.ts): tokens for tool results, and the most for the whole text. */
      compaction: z
        .object({
          resultTokens: z.union([z.literal(20_000), z.literal(35_000), z.literal(50_000)]).default(35_000),
          maxTotalTokens: z.number().int().positive().default(90_000),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Main-window view options (View menu). */
  view: ViewSchema.prefault({}),
  /** Addons stopped in Advanced → Addons…, by id: they don't start with Looper and show nothing. */
  disabledAddons: z.array(z.string()).default([]),
  /** How the user changed where and how an addon runs (Advanced → Addons… → Edit…), by id. */
  addonRuns: z.record(z.string(), AddonLocalRunSchema).default({}),
  /** Advanced → Remote Control: the conversations it keeps open for the Claude app. */
  remote: RemoteSettingsSchema,
  remoteAccess: RemoteAccessSettingsSchema,
}).superRefine((s, ctx) => {
  const envIds = new Set<string>();
  for (const env of s.environments) {
    if (envIds.has(env.id)) {
      ctx.addIssue({ code: 'custom', path: ['environments'], message: `duplicate environment id "${env.id}"` });
    }
    envIds.add(env.id);
    const harnessIds = new Set<string>();
    for (const h of env.harnesses) {
      if (harnessIds.has(h.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['environments'],
          message: `environment "${env.name}": duplicate harness id "${h.id}"`,
        });
      }
      harnessIds.add(h.id);
    }
  }
  if (!envIds.has(s.defaultEnvironmentId)) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultEnvironmentId'],
      message: `unknown environment "${s.defaultEnvironmentId}"`,
    });
  }
  if (s.staggerFirstRun.enabled && s.staggerFirstRun.minDelaySec > s.staggerFirstRun.maxDelaySec) {
    ctx.addIssue({
      code: 'custom',
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
  /** The question the agent asked with `looper-ask` and is waiting on an answer to. */
  question: string | null;
  startedAt: number;
  trigger: 'timer' | 'manual' | 'watcher';
  /** The related events this run handles (trigger.sendRelatedEvents): later ones with this id go to its agent. */
  relatedId?: string;
  /** A delegated agent (TaskRuntime.children): the run whose agent started it. */
  parentRunId?: string;
  /** A delegated agent: the title its parent gave it. */
  title?: string;
  /** A delegated agent: its folder, in its environment's path form. */
  folder?: string;
  /** A delegated agent that hasn't started yet: why it waits. */
  waiting?: string;
}

/**
 * A task's live state. `runs` is the truth; `state`, `currentRunId` and `held`
 * are the aggregate the task list and menus read:
 * - `state` = the most advanced active run (`running` > `classifying` >
 *   `checking`), or idle/paused/disabled/completed when nothing is in flight;
 * - `currentRunId` = the newest active run, null when none;
 * - `held` = any active run is held;
 * - `asking` = any active run's agent is waiting on an answer to its question.
 */
export interface TaskRuntime {
  taskId: string;
  state: TaskState;
  /** Any active run is holding for a human. */
  held: boolean;
  /** Any active run's agent is waiting on an answer to its question. */
  asking: boolean;
  /** Cycles in flight, oldest first. Empty when the task is idle/paused/disabled/completed. */
  runs: ActiveRun[];
  /**
   * Agents the runs' agents started in other folders (looper-delegate), in
   * flight or waiting to start, oldest first. They're runs of this task too,
   * but don't count toward its state or its Simultaneous runs.
   */
  children: ActiveRun[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** The run that set lastResult. */
  lastRunId: string | null;
  /** Outcome of the last cycle (success, warning, error, noop, ...). */
  lastResult: RunResult | null;
  /** One line about the last cycle: the run's headline, the check summary, or the error. */
  lastDetail: string | null;
  consecutiveErrors: number;
  currentRunId: string | null;
  pausedReason: string | null;
  /** Events trigger only: the watcher process is up, waiting to respawn, or not wanted (null). */
  watcher: 'watching' | 'restarting' | null;
  /** Events trigger only: when the watcher last reported events, null = never. */
  lastEventAt: number | null;
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

/** Advanced → Prevent Sleep: how long its timer keeps the computer awake, in minutes, or until turned off. */
export type PreventSleepTimer = 'off' | 30 | 60 | 120 | 'until-off';

export interface PreventSleepState {
  /** The timer's choice; it lasts for this run of Looper. */
  timer: PreventSleepTimer;
  /** Epoch ms the timer runs out; null when it's off or on until turned off. */
  until: number | null;
  /** The computer is kept awake now: by the timer, or by a session working (While a Session Is Working). */
  active: boolean;
}

/**
 * `guidance`: text the user sent the running agent (sent, delivered, or
 * undelivered when it never got there). `events`: related trigger events sent
 * to the running agent, the same way. `question`: the agent asked the user
 * something (sent), the user answered (delivered), or nobody answered in
 * time (undelivered). `chat` and `terminal`: a chat or
 * terminal window opened or closed on the run (result the same as the phase,
 * detail.event 'opened' or 'closed'). `delegate`: on a delegated agent's own
 * run, who started it (detail.parentRunId); on the run that started it
 * (detail.childRunId), the agent started, how it ended, and its result
 * delivered or undelivered.
 */
export type RunPhase =
  | 'watcher'
  | 'check'
  | 'classify'
  | 'agent'
  | 'guidance'
  | 'events'
  | 'question'
  | 'delegate'
  | 'result'
  | 'skip'
  | 'system'
  | 'chat'
  | 'terminal';

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
  | 'held'
  | 'restarted'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'chat'
  | 'terminal';

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
  /** The error was the machine's environment failing to start a step (WSL unreachable, wsl.exe missing). */
  environment?: boolean;
  /** The error happened because the computer slept through the run, not because the task failed. */
  slept?: boolean;
  stdoutTail?: string;
  detail?: Record<string, unknown>;
  /** The task's version (Version History) when the record was written. */
  taskVersion?: number;
}

export interface CheckOutput {
  act: boolean;
  summary?: string;
  context?: unknown;
  relatedId?: string;
}

export interface InboxCommand {
  op: 'run' | 'pause' | 'resume' | 'stop' | 'remove' | 'enable' | 'disable' | 'complete' | 'reopen' | 'guide';
  taskId: string;
  reason?: string;
  /** run: one trigger event, a line like a watcher's. */
  event?: string;
  /** guide: the run to send the guidance to; unset = the task's newest run in flight. */
  runId?: string;
  /** guide: the guidance text. */
  text?: string;
}

// ---------- Engine events (also the IPC contract) ----------

/** What a `notify` event is about; it decides where a click on the toast lands. */
export type NotifyKind = 'run-start' | 'agent-start' | 'held' | 'question' | 'end' | 'auto-paused' | 'usage-limit' | 'completed';

export type EngineEvent =
  | { type: 'runtime'; runtime: TaskRuntime }
  | { type: 'record'; record: RunRecord }
  | { type: 'agent:data'; taskId: string; runId: string; data: string }
  /** A chat's running "!" command: its output so far (the newest part once it's long), sent as it comes in batches. */
  | { type: 'chat:command'; chatId: string; id: string; stdout: string; stderr: string }
  /** problem: the run ended with an error or warning; a click opens its run window on the report. */
  | { type: 'notify'; taskId: string; runId: string; kind: NotifyKind; title: string; body: string; problem?: boolean }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'projects'; projects: Project[] }
  /** The Projects tab's folders or their order changed. */
  | { type: 'project-folders'; folders: ProjectFolder[]; layout: Record<string, string[]> }
  | { type: 'recycleBin'; entries: RecycleBinEntry[] }
  | { type: 'folders'; folders: TaskFolder[]; layout: Record<string, string[]> }
  | { type: 'templates'; templates: Template[] }
  /** A task's version history changed (a version was added, or the history was deleted). */
  | { type: 'versions'; taskId: string }
  /** A task builder's chat, draft or tests changed. */
  | { type: 'builder'; state: BuilderState }
  /** Terminal output of a task builder in the terminal view. */
  | { type: 'builder:data'; id: string; data: string }
  /** A task chat's conversation, status or permission requests changed. */
  | { type: 'chat'; state: ChatState }
  /** Output of a terminal session in a Looper terminal window, and its end. */
  | { type: 'terminal:data'; id: string; data: string }
  | { type: 'terminal:end'; id: string }
  /** The Sessions window's list changed: a session's status, why it waits, its latest line; or the usage limits. */
  | { type: 'sessions'; state: SessionsState }
  /** The background work, subagents or (terminal session) conversation of the session the Sessions window shows. */
  | { type: 'session:activity'; activity: SessionActivity }
  /** The projects whose folder is in a git repository changed. */
  | { type: 'git-repos'; ids: string[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'rest'; rest: RestState; disarmReason?: 'user-wake' }
  | { type: 'prevent-sleep'; state: PreventSleepState }
  /** Remote Control started or stopped, or one of its conversations changed. */
  | { type: 'remote'; state: RemoteState }
  /** Remote Access started, stopped or changed status, or its paired devices changed. */
  | { type: 'remote-access'; state: RemoteAccessState };
