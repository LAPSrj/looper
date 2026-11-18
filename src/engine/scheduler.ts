import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import type {
  ActiveRun,
  EngineEvent,
  NotifyKind,
  RunPhase,
  RunRecord,
  RunResult,
  RunSkips,
  Settings,
  Task,
  TaskRuntime,
} from '../shared/types';
import { RELATED_ID_FIELD, scheduleOf, watcherOf } from '../shared/types';
import { cronTz, runWindowOpen } from '../shared/cron';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { capFirst, formatDateTime, resultLabel } from '../shared/format';
import { isSessionRun } from '../shared/runs';
import { detectSystemLocale, type HostKind } from './host';
import { errMsg, type Logger } from './log';
import { readRunSessionId } from './messages';
import { looksLikeEnvironmentError } from './network';
import { createTarget } from './target';
import { runCheck as defaultRunCheck } from './steps/check';
import { classifyPrompt, runClassify as defaultRunClassify, type ClassifyResult } from './steps/classify';
import {
  agentPrompt,
  endAgentSession,
  readCompleteSignal,
  startAgent as defaultStartAgent,
  type AgentCallbacks,
  type AgentEnd,
  type DoneStatus,
} from './steps/agent';
import { headlineOf, RESTART_STATUS, type SessionHandle } from './steps/session';
import { AGENT_DELEGATE, DELEGATE_BUSY_FILE, DELEGATE_DIR, type RunContext } from './steps/common';
import {
  DELEGATE_FILE,
  EVENTS_FILE,
  relatedIdOfLine,
  GUIDANCE_FILE,
  queueDelegateMessage,
  queueEvents,
  queueGuidance,
  takeDelegateMessages,
  takeEvents,
  takePendingGuidance,
} from './guidance';
import {
  absolutePath,
  claudeBusyIn,
  DELEGATE_USAGE,
  delegateTask,
  parseDelegateArgs,
  questionEntry,
  resultEntry,
  type StartArgs,
} from './delegates';
import { delegateMessage, eventsMessage, guidanceMessage } from '../shared/messages';
import { sameFolder } from '../shared/projects';
import type { Project } from '../shared/types';
import type { Target } from './target';
import { newRunId, type RunStore } from './store/runs';
import { fileExists, writeText } from './store/fsutil';
import type { StateStore } from './store/state';
import type { TaskStore } from './store/tasks';
import { WatcherPool } from './watchers';

export interface SchedulerSteps {
  runCheck: typeof defaultRunCheck;
  runClassify: typeof defaultRunClassify;
  startAgent: typeof defaultStartAgent;
}

export interface SchedulerDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  tasks: TaskStore;
  runs: RunStore;
  state: StateStore;
  log: Logger;
  steps?: Partial<SchedulerSteps>;
  now?: () => number;
  /** The task's current version (Version History), stamped on its run records. */
  taskVersion?: (taskId: string) => number | undefined;
  /** The projects: a delegated agent in a project's folder runs with the project's settings. */
  projects?: () => readonly Project[];
  /** Why a delegated agent must wait for its folder (another session is working there), or null. Default: ask `claude agents`. */
  folderBusy?: (task: Task) => Promise<string | null>;
  /** A run's agent ended: Claude Code had no usable login (`worked` false), or it had one. */
  onLogin?: (task: Task, worked: boolean) => void;
}

/** How often a delegated agent waiting for its folder asks again whether a session outside Looper is working there. */
const FOLDER_PROBE_MS = 15_000;

/** An agent a run's agent started in another folder (looper-delegate). */
interface Child {
  /** Its entry in the parent task's runtime (`children`). */
  run: ActiveRun;
  /** The parent's task: the child's run is that task's too. */
  taskId: string;
  parentRunId: string;
  parentTaskName: string;
  /** The parent's target: paths in the parent's messages are in its form. */
  parentTarget: Target;
  /** What it runs as (see delegateTask). */
  task: Task;
  runDir: string;
  brief: string;
  stopper: { controller: AbortController; reason: string };
  started: boolean;
  /** When `claude agents` was last asked about its folder, and whether it's being asked now. */
  probedAt: number;
  probing: boolean;
}

const ACTIVE: ReadonlySet<TaskRuntime['state']> = new Set(['checking', 'classifying', 'running']);

/** Stop reason of runs cut short because the system is suspending. */
const SLEEP_STOP_REASON = 'computer went to sleep';
/** Work due at (or cut short by) a sleep waits this long past the wake, so the network can come back first. */
const RESUME_GRACE_MS = 20_000;
/** Watcher event lines a task may carry into its next run; past it the oldest are dropped. */
const MAX_PENDING_EVENTS = 1000;
/** Waits before each retry of a scheduled run the machine failed (offline, WSL unavailable); the last repeats. */
const MACHINE_RETRY_MS = [2, 5, 15, 30].map((min) => min * 60_000);
/** In a run's folder: the related id it handles, so a chat that opens it again gets that id's events. */
const RELATED_ID_FILE = 'related-id';
/** In a run's folder: the session that writes its report after a chat it was opened in closes, kept apart from the run's own conversation. */
const REPORT_DIR = 'report';

/** What the agent of a chat a run was opened in is told when the chat closes. */
function reportPrompt(runId: string): string {
  return (
    `This conversation went on with Looper's run ${runId}, and it's ending. Write that run's report now, without starting any new work: ` +
    'run looper-done with the status of the whole run, the work done in this conversation included, then write the report as your final message.'
  );
}

/**
 * A scheduled run the machine failed, owed a retry before the next regular
 * slot. The steps that already passed are kept, so the retry starts at the
 * one that failed: a check with side effects (a sync that pushes) never runs
 * twice for one slot.
 */
interface MachineRetry {
  /** 1 for the first retry. */
  attempt: number;
  /** The failed run's detail, for the retry's run log. */
  reason: string;
  check?: { summary?: string; context?: unknown; relatedId?: string };
  classified: boolean;
}

/** Trigger events waiting for a run: one batch per task, or with sendRelatedEvents one per related id. */
interface PendingEvents {
  /** Unset = the events that have no id, which coalesce into one run. */
  relatedId?: string;
  trigger: ActiveRun['trigger'];
  lines: string[];
  /** They came out of a check, which told only once: the run that takes them doesn't run it again. */
  checked?: boolean;
  /** One item of a check's list without a related id: it never joins another batch, so it gets a run of its own. */
  own?: boolean;
}

/** What the scheduler needs of the chat a run is open in (Continue in Chat). */
export interface ChatLink {
  /** Hand related events to the chat's agent; false when the chat can't take them. */
  deliver(lines: string[]): boolean;
  /** When the chat went idle (its agent's turn ended, nothing running or waiting), or null while it isn't. */
  idleSince(): number | null;
  /** The conversation the chat goes on with. */
  sessionId(): string | undefined;
  /** Stop: the chat's agent ends its turn. */
  stop(): Promise<void>;
  /** The agent's process ends so the report can go on with the conversation, and messages wait; false when the chat isn't idle. */
  holdForReport(): Promise<boolean>;
  /** The report is written: whether a message came meanwhile. */
  reportWritten(): boolean;
  /** Close the chat for good. */
  close(): Promise<void>;
}

/** A run open in a chat: the chat, since when the run is open in it, and whether its idle limit is closing it. */
interface ChatHold {
  link: ChatLink;
  heldAt: number;
  closing?: boolean;
}

/** How a cycle relates to sendRelatedEvents. */
interface CycleEvents {
  relatedId?: string;
  checked?: boolean;
  /** A slot past the task's cap: it only runs the check, to see where its event goes. */
  overCap?: boolean;
}

/** A check's answer as a trigger event line. */
function checkEventLine(relatedId: string | undefined, summary: string | undefined, context: unknown): string {
  return JSON.stringify({ ...(relatedId !== undefined ? { [RELATED_ID_FIELD]: relatedId } : {}), summary, context });
}

/** What the check said about the events it produced, for a run that takes them without checking again. */
function checkOutputOf(lines: readonly string[]): { summary?: string; context?: unknown } {
  const said = lines.flatMap((line) => {
    try {
      const v: unknown = JSON.parse(line);
      const told = v !== null && typeof v === 'object' && ('summary' in v || 'context' in v);
      return told ? [v as { summary?: string; context?: unknown }] : [];
    } catch {
      return [];
    }
  });
  const summary = said.map((s) => s.summary).filter(Boolean).join('\n');
  const context = said.length > 1 ? said.map((s) => s.context) : said[0]?.context;
  return { summary: summary || undefined, context };
}

/** How far along a run is; the task's aggregate state is its most advanced run. */
const ADVANCE: Record<ActiveRun['state'], number> = { checking: 0, classifying: 1, running: 2 };

/** The newest run in flight (runs are appended in start order). */
function newestRun(rt: TaskRuntime | undefined): ActiveRun | undefined {
  return rt && rt.runs.length ? rt.runs[rt.runs.length - 1] : undefined;
}

/** What starts the task's runs, in a run's terms. */
function triggerOf(task: Task): ActiveRun['trigger'] {
  return scheduleOf(task) ? 'timer' : watcherOf(task) ? 'watcher' : 'manual';
}

/**
 * Where a task rests with nothing in flight and no pause: completed outranks
 * disabled, since a completed task is always disabled too.
 */
function parkedState(task: Task | undefined): TaskRuntime['state'] {
  return task?.completedAt ? 'completed' : 'disabled';
}

export class Scheduler extends EventEmitter {
  private readonly runtimes = new Map<string, TaskRuntime>();
  /** The live harness session of each run: the agent, or the interactive classifier. Keyed by run id. */
  private readonly agents = new Map<string, SessionHandle>();
  /** Per active cycle (by run id): aborting kills whatever step is running (check, classifier). */
  private readonly cycleStops = new Map<string, { controller: AbortController; reason: string }>();
  /** Tasks whose deferral (concurrency limit) has been logged, to log once per wait. */
  private readonly deferLogged = new Set<string>();
  /** Per task: the usage-limit reset a run reported, pending until its last sibling finishes. */
  private readonly limitWaits = new Map<string, number>();
  /** Runs stopped mid-flight because the system suspended (by run id). */
  private readonly sleptRuns = new Set<string>();
  /** Per run with guidance waiting for its agent: the poll that records the delivery. */
  private readonly guidanceWatches = new Map<string, NodeJS.Timeout>();
  /** Per run with related events waiting for its agent: the poll that records the delivery. */
  private readonly eventWatches = new Map<string, NodeJS.Timeout>();
  /** Per run with its delegated agents' messages waiting for its agent: the poll that records the delivery. */
  private readonly delegateWatches = new Map<string, NodeJS.Timeout>();
  /** The delegated agents in flight or waiting to start, by their run id. */
  private readonly children = new Map<string, Child>();
  /**
   * Headless runs whose agent ended its turn to wait for the agents it
   * started: no session is live, but guidance and events still wait for it,
   * and the next session takes them.
   */
  private readonly waitingRuns = new Set<string>();
  /** Headless runs whose turn Stop in their message box ended: their session's end isn't the run's. */
  private readonly turnStops = new Set<string>();
  /** Tasks owed a fresh run: a system sleep cut their run short, so the slot's work never happened. */
  private readonly sleepOwed = new Set<string>();
  /** Per task: the retry a machine-failed scheduled run is owed (see MachineRetry). */
  private readonly machineRetries = new Map<string, MachineRetry>();
  /** Trigger event lines waiting for a run slot or for the agent of the run they relate to, per task. */
  private readonly pendingEvents = new Map<string, PendingEvents[]>();
  /**
   * Tasks owed a runOnStart catch-up: watching started cold (app launch,
   * enable, pause lifted, system wake, run window opening) and the check
   * should re-derive what was missed. Settled by the next watcher run,
   * whatever triggers it.
   */
  private readonly catchUpOwed = new Set<string>();
  /** Watcher tasks whose run window was closed at the last tick; reopening starts watching cold. */
  private readonly windowClosed = new Set<string>();
  /** Per run opened in a chat, by run id: the chat it's open in. */
  private readonly chatLinks = new Map<string, ChatHold>();
  /** Per run open in a chat that Stop stopped: why, for the record once the chat ends. */
  private readonly chatStops = new Map<string, string>();
  /** Runs that were open in a chat when Looper quit, by run id, until the chat opens again and takes its run back. */
  private readonly chatRestores = new Map<string, ActiveRun>();
  private readonly steps: SchedulerSteps;
  private readonly watchers: WatcherPool;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly d: SchedulerDeps) {
    super();
    this.steps = {
      runCheck: d.steps?.runCheck ?? defaultRunCheck,
      runClassify: d.steps?.runClassify ?? defaultRunClassify,
      startAgent: d.steps?.startAgent ?? defaultStartAgent,
    };
    this.now = d.now ?? (() => Date.now());
    this.watchers = new WatcherPool({
      dataDir: d.dataDir,
      host: d.host,
      settings: d.settings,
      log: d.log,
      now: this.now,
      onEvents: (taskId, lines) => this.onWatcherEvents(taskId, lines),
      onState: (taskId, state) => {
        const rt = this.runtimes.get(taskId);
        if (!rt) return;
        rt.watcher = state;
        this.emitRuntime(rt);
      },
      onCrashLoop: (taskId, detail) => this.onWatcherCrashLoop(taskId, detail),
    });
  }

  // ---------- lifecycle ----------

  start(): void {
    const previous = this.d.state.load();
    const tasks = this.d.tasks.list();
    const now = this.now();

    const overdue = new Set<string>();
    for (const task of tasks) {
      if (!task.enabled) continue;
      const prev = previous[task.id];
      if (this.isOverdue(task, prev?.lastRunAt ?? null, now)) {
        overdue.add(task.id);
      }
    }

    const delays = this.computeStartDelays(tasks.filter((t) => overdue.has(t.id)));
    tasks.forEach((task) => {
      const prev = previous[task.id];
      // Nothing survives a restart: every run the snapshot had in flight is
      // gone. A snapshot without `runs` is stale runtime state, not history.
      for (const run of prev?.runs ?? []) {
        // A chat survives the restart: it opens again and takes its run back (holdInChat).
        if (run.chat && run.report !== 'writing') {
          this.chatRestores.set(run.runId, run);
          continue;
        }
        this.record(task.id, run.runId, 'system', 'interrupted', {
          summary: run.chat ? 'looper restarted while the agent wrote the report' : `looper restarted while ${run.state}`,
        });
      }
      for (const run of prev?.children ?? []) {
        this.record(task.id, run.runId, 'system', 'interrupted', {
          summary: `looper restarted while ${run.waiting ? 'it waited to start' : 'running'}`,
        });
      }
      const rt = this.initRuntime(task, delays.get(task.id) ?? 0, prev);
      if (task.enabled && !overdue.has(task.id)) {
        rt.nextRunAt = this.computeNext(task, now);
        this.emitRuntime(rt);
      }
    });
    // Watchers start once the runtimes exist, so their first state report lands on one.
    for (const task of tasks) {
      this.syncWatcher(task);
      if (this.watcherDesired(task) && watcherOf(task)?.runOnStart) this.catchUpOwed.add(task.id);
    }
    this.d.tasks.on('change', (task: Task, kind: 'create' | 'update' | 'remove', previous?: Task) =>
      this.onTaskChange(task, kind, previous),
    );
    this.persist();
    this.timer = setInterval(() => this.tick(), this.d.settings.tickMs);
    this.d.log.info(`scheduler started with ${tasks.length} task(s), ${overdue.size} overdue`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const cycle of this.cycleStops.values()) {
      cycle.reason = 'looper shutting down';
      cycle.controller.abort();
    }
    const stops = [...this.agents.values()].map((h) =>
      h.stop('stopped', 'looper shutting down').catch(() => undefined),
    );
    await Promise.all([...stops, this.watchers.stopAll()]);
    this.d.state.flush();
  }

  // ---------- queries ----------

  list(): TaskRuntime[] {
    return [...this.runtimes.values()];
  }

  get(taskId: string): TaskRuntime | undefined {
    return this.runtimes.get(taskId);
  }

  // ---------- commands ----------

  runNow(taskId: string, skips?: RunSkips): boolean {
    return this.startManual(taskId, skips);
  }

  /**
   * Continue a finished run's conversation: a manual cycle that skips check
   * and classifier and resumes that run's session with `guidance` as the whole
   * prompt. A rolling conversation (agent.session 'continue') follows it: the
   * continuation books onto the resumed id like any resumed run.
   */
  continueRun(taskId: string, fromRunId: string, guidance: string, relatedId?: string): boolean {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    if (rt.runs.some((r) => r.runId === fromRunId) || rt.children.some((r) => r.runId === fromRunId)) throw new Error('This run is still active.');
    if (this.d.runs.summaries(taskId).some((s) => s.runId === fromRunId && s.parentRunId)) {
      throw new Error('A delegated agent ran in a folder of its own, so its conversation is not continued as a run of this task.');
    }
    const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
    if (kind !== 'claude-code' && kind !== 'codex') {
      throw new Error('Only Claude Code and Codex conversations can be continued.');
    }
    const sessionId = readRunSessionId(this.d.runs.runDir(taskId, fromRunId), kind);
    if (!sessionId) throw new Error('No conversation was recorded for this run.');
    return this.startManual(taskId, undefined, { fromRunId, sessionId, prompt: guidance, relatedId });
  }

  /**
   * One trigger event from outside (the `run` command's `event`): it starts a
   * run or goes to the run it relates to, like a watcher's, lifting a pause
   * like any manual run. A task that can't take it says so, so the event
   * isn't dropped without a word.
   */
  receiveEvent(taskId: string, event: string): void {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    if (!task.enabled || task.completedAt) throw new Error('This task is disabled or completed, so it takes no events.');
    const lines = event.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('The event is empty.');
    this.liftPause(task, rt);
    rt.lastEventAt = this.now();
    this.emitRuntime(rt);
    this.holdEvents(task, lines, { trigger: 'manual' });
    this.flushEvents(task);
  }

  /** Whether the run takes guidance now: its agent is running on Claude Code or Codex, or waits on an answer to its question. */
  canGuideRun(taskId: string, runId: string): boolean {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    const run = rt?.runs.find((r) => r.runId === runId) ?? rt?.children.find((r) => r.runId === runId);
    const handle = this.agents.get(runId);
    const runTask = this.children.get(runId)?.task ?? task;
    if (!runTask || run?.state !== 'running' || run.chat) return false;
    if (this.waitingRuns.has(runId)) return true;
    return !!handle && (handle.question !== null || this.takesGuidance(runTask));
  }

  /**
   * Send guidance to a run in flight (without a run id, the task's newest).
   * While the agent waits on an answer to its question, the text is the
   * answer. Otherwise it waits in the run dir until the agent picks it up
   * (engine/guidance.ts); whatever the agent never got continues the
   * conversation in a new run once this one ends (see `settleGuidance`).
   */
  sendGuidance(taskId: string, runId: string | undefined, text: string): void {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    const trimmed = text.trim();
    if (!trimmed) throw new Error('The guidance is empty.');
    const run = runId ? (rt.runs.find((r) => r.runId === runId) ?? rt.children.find((r) => r.runId === runId)) : newestRun(rt);
    if (!run) throw new Error('This run has already ended. Use Continue with Guidance… to continue its conversation.');
    if (run.chat) throw new Error('This run goes on in a chat. Write to its agent there.');
    const handle = this.agents.get(run.runId);
    if (run.state !== 'running' || (!handle && !this.waitingRuns.has(run.runId))) throw new Error('The agent of this run has not started yet.');
    if (handle?.answer(trimmed)) {
      this.setQuestion(rt, run.runId, null);
      this.record(taskId, run.runId, 'question', 'delivered', { summary: headlineOf(trimmed), body: trimmed });
      return;
    }
    if (!this.takesGuidance(this.children.get(run.runId)?.task ?? task)) throw new Error('Only Claude Code and Codex runs take guidance.');
    const runDir = this.d.runs.runDir(taskId, run.runId);
    queueGuidance(runDir, trimmed);
    this.record(taskId, run.runId, 'guidance', 'sent', { summary: headlineOf(trimmed), body: trimmed });
    this.watchGuidance(taskId, run.runId, runDir);
    handle?.deliverGuidance();
  }

  /** The run's agent isn't in a turn: an interactive session at its prompt, or a headless run waiting for its next message. */
  turnOver(runId: string): boolean {
    return this.waitingRuns.has(runId) || !!this.agents.get(runId)?.turnOver;
  }

  /**
   * Stop in a run's message box: the agent's turn ends and the run goes on,
   * as a chat's does; the guidance waiting goes in at once (Send Now). An
   * interactive session gets Esc. A headless one's turn is its process, so
   * the session ends, and the run waits for the next guidance to resume the
   * conversation with (`runAgent`). Stop Task still ends the whole run.
   */
  async stopTurn(taskId: string, runId: string): Promise<void> {
    const rt = this.runtimes.get(taskId);
    const run = rt?.runs.find((r) => r.runId === runId) ?? rt?.children.find((r) => r.runId === runId);
    const handle = this.agents.get(runId);
    const task = this.children.get(runId)?.task ?? this.d.tasks.get(taskId);
    if (!run || run.state !== 'running' || run.chat || !handle || !task) return;
    if (task.agent.mode !== 'headless') {
      handle.stopTurn();
      return;
    }
    this.turnStops.add(runId);
    await handle.stop('stopped', 'the user stopped the turn');
  }

  /** Take back the guidance still waiting for the run's agent (Edit, Cancel); null when the agent has it already. */
  unqueueGuidance(taskId: string, runId: string): string | null {
    const runDir = this.d.runs.runDir(taskId, runId);
    const text = takePendingGuidance(runDir);
    const watch = this.guidanceWatches.get(runId);
    if (text === null) return null;
    if (watch) {
      clearInterval(watch);
      this.guidanceWatches.delete(runId);
    }
    this.record(taskId, runId, 'guidance', 'undelivered', { summary: 'taken back before the agent read it', body: text });
    return text;
  }

  private takesGuidance(task: Task): boolean {
    try {
      const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
      return kind === 'claude-code' || kind === 'codex';
    } catch {
      return false;
    }
  }

  /** Record the delivery once the waiting guidance is gone from the run dir. */
  private watchGuidance(taskId: string, runId: string, runDir: string): void {
    this.watchDelivery(this.guidanceWatches, path.join(runDir, GUIDANCE_FILE), taskId, runId, 'guidance', 'the agent got the guidance');
  }

  private watchDelivery(
    watches: Map<string, NodeJS.Timeout>,
    file: string,
    taskId: string,
    runId: string,
    phase: RunPhase,
    summary: string,
  ): void {
    if (watches.has(runId)) return;
    const timer = setInterval(() => {
      if (fileExists(file)) return;
      clearInterval(timer);
      watches.delete(runId);
      this.record(taskId, runId, phase, 'delivered', { summary });
    }, this.d.settings.signalPollMs);
    watches.set(runId, timer);
  }

  /**
   * Leave related events for a run's agent, handed over the way guidance is.
   * False when it can't take them yet or at all (the agent hasn't started, a
   * harness without hooks): they stay pending, for this agent or the next run.
   */
  private sendEvents(task: Task, run: ActiveRun, lines: string[]): boolean {
    // A run open in a chat: they go to the chat's agent as a message. Once it's stopped, or writing the report, they wait for the next run.
    if (run.chat) {
      if (run.report === 'writing' || run.report === 'stopped' || !this.chatLinks.get(run.runId)?.link.deliver(lines)) return false;
      this.record(task.id, run.runId, 'events', 'sent', {
        summary: `${lines.length} event(s), to chat ${run.chat}`,
        body: '```\n' + lines.join('\n') + '\n```',
      });
      return true;
    }
    const handle = this.agents.get(run.runId);
    if (run.state !== 'running' || (!handle && !this.waitingRuns.has(run.runId)) || !this.takesGuidance(task)) return false;
    const runDir = this.d.runs.runDir(task.id, run.runId);
    try {
      queueEvents(runDir, lines);
    } catch (e) {
      this.d.log.error(`[${task.id}] cannot leave events for run ${run.runId}: ${errMsg(e)}`);
      return false;
    }
    this.record(task.id, run.runId, 'events', 'sent', {
      summary: `${lines.length} event(s)`,
      body: '```\n' + lines.join('\n') + '\n```',
    });
    this.watchDelivery(this.eventWatches, path.join(runDir, EVENTS_FILE), task.id, run.runId, 'events', 'the agent got the events');
    handle?.deliverGuidance();
    return true;
  }

  /** The run is over: related events its agent never got go to the next run. */
  private settleEvents(task: Task, runId: string, runDir: string): void {
    const watch = this.eventWatches.get(runId);
    if (watch) {
      clearInterval(watch);
      this.eventWatches.delete(runId);
    }
    const lines = takeEvents(runDir);
    if (lines === null) {
      if (watch) this.record(task.id, runId, 'events', 'delivered', { summary: 'the agent got the events' });
      return;
    }
    this.record(task.id, runId, 'events', 'undelivered', {
      summary: 'the run ended before the agent read them; they go to the next run',
      body: '```\n' + lines.join('\n') + '\n```',
    });
    // A check told about these once already, and won't again.
    this.holdEvents(task, lines, { trigger: triggerOf(task), checked: !!scheduleOf(task) });
  }

  /**
   * The run is over: guidance the agent never got is taken out of the run dir.
   * Returned (to continue the conversation with) when the agent simply
   * finished before reading it; a run that was stopped, failed, ran out of
   * time, or whose task is paused keeps it in its log only.
   */
  private settleGuidance(taskId: string, runId: string, runDir: string, end: AgentEnd | undefined): string | null {
    const watch = this.guidanceWatches.get(runId);
    if (watch) {
      clearInterval(watch);
      this.guidanceWatches.delete(runId);
    }
    const text = takePendingGuidance(runDir);
    if (text === null) {
      if (watch) this.record(taskId, runId, 'guidance', 'delivered', { summary: 'the agent got the guidance' });
      return null;
    }
    let why: string | null = null;
    if (!end || end.reason === 'stopped') why = 'the run was stopped';
    else if (end.reason === 'error' || end.network || end.environment || end.sessionLost) why = 'the run ended with an error';
    else if (end.reason !== 'done') why = `the run ended without the agent finishing (${resultLabel(end.reason).toLowerCase()})`;
    else if (this.runtimes.get(taskId)?.pausedReason) why = 'the task is paused';
    if (why) {
      this.record(taskId, runId, 'guidance', 'undelivered', { summary: `not delivered: ${why}`, body: text });
      return null;
    }
    this.record(taskId, runId, 'guidance', 'undelivered', {
      summary: 'the agent finished before reading it; continuing the conversation in a new run',
      body: text,
    });
    return text;
  }

  // ---------- runs opened in a chat (Continue in Chat) ----------

  /**
   * A finished run of a task opened in a chat: it's in flight again while the
   * chat is open, so the events related to it go to the chat's agent
   * (`deliver`), and the others wait or start runs as they would while it ran.
   * A chat's or terminal session's run, a delegated agent's, and a run still
   * in flight stay as they are.
   */
  holdInChat(taskId: string, runId: string, chatId: string, link: ChatLink): void {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt || this.stopping) return;
    if (rt.runs.some((r) => r.runId === runId) || rt.children.some((r) => r.runId === runId)) return;
    const summary = this.d.runs.summaries(taskId).find((s) => s.runId === runId);
    if (!summary || summary.parentRunId || isSessionRun(summary)) return;
    const saved = this.chatRestores.get(runId);
    this.chatRestores.delete(runId);
    let run: ActiveRun;
    if (saved?.chat === chatId) run = { ...saved, state: 'running', held: false, question: null };
    else {
      let relatedId: string | undefined;
      try {
        relatedId = fs.readFileSync(path.join(this.d.runs.runDir(taskId, runId), RELATED_ID_FILE), 'utf8') || undefined;
      } catch {
        /* the run handled no related id */
      }
      run = { runId, state: 'running', held: false, question: null, startedAt: this.now(), trigger: 'manual', chat: chatId, ...(relatedId !== undefined ? { relatedId } : {}) };
    }
    rt.runs.push(run);
    this.chatLinks.set(runId, { link, heldAt: this.now() });
    this.d.log.info(`[${taskId}] run ${runId} goes on in chat ${chatId}`);
    this.recompute(rt);
    this.emitRuntime(rt);
    this.persist();
    this.flushEvents(task);
  }

  /**
   * A message reached the agent of the chat a run is open in: the chat's end
   * writes the run's report. After Stop, it takes the run up again.
   */
  chatTalked(taskId: string, chatId: string): void {
    const run = this.runtimes.get(taskId)?.runs.find((r) => r.chat === chatId);
    if (!run || run.report === 'owed' || run.report === 'writing') return;
    run.report = 'owed';
    this.chatStops.delete(run.runId);
    this.persist();
  }

  /**
   * The chat a run was open in closed. After Stop the run ends as stopped.
   * When a message reached its agent, the agent writes the run's report in
   * the background, going on with the chat's conversation (`sessionId`), and
   * the run ends with it. Otherwise the run ends as it was before the chat
   * opened it.
   */
  releaseChat(taskId: string, chatId: string, sessionId: string | undefined): void {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    const run = rt?.runs.find((r) => r.chat === chatId);
    if (!rt || !run || run.report === 'writing') return;
    this.chatLinks.delete(run.runId);
    if (task && run.report === 'stopped') {
      this.endStopped(task, rt, run);
      return;
    }
    if (!task || run.report !== 'owed' || !sessionId || this.stopping) {
      this.dropRun(rt, run.runId);
      return;
    }
    run.report = 'writing';
    this.emitRuntime(rt);
    this.persist();
    void this.writeReport(task, rt, run, sessionId);
  }

  /**
   * The chats of the task's runs that have been idle past the limit close:
   * Settings → Chats' idle limit for runs in a chat, else the task's own.
   * A chat whose run owes its report has the agent write it first.
   */
  private idleChats(task: Task, rt: TaskRuntime): void {
    const { runIdle } = this.d.settings.chats;
    const limitMs = (runIdle.enabled ? runIdle.minutes : task.agent.idleGraceMin) * 60_000;
    for (const run of rt.runs) {
      const held = this.chatLinks.get(run.runId);
      if (!run.chat || !held || held.closing || run.report === 'writing') continue;
      const since = held.link.idleSince();
      if (since === null || this.now() - Math.max(since, held.heldAt) < limitMs) continue;
      held.closing = true;
      this.d.log.info(`[${task.id}] chat ${run.chat} of run ${run.runId} reached its idle limit`);
      void this.idleOut(task, rt, run, held).catch((e: Error) => this.d.log.error(`[${task.id}] cannot close chat ${run.chat}: ${e.message}`));
    }
  }

  private async idleOut(task: Task, rt: TaskRuntime, run: ActiveRun, held: ChatHold): Promise<void> {
    const { link } = held;
    const sessionId = link.sessionId();
    // Stopped, or nothing said: the chat's close ends the run (releaseChat).
    if (run.report !== 'owed' || !sessionId) return link.close();
    run.report = 'writing';
    this.emitRuntime(rt);
    this.persist();
    if (!(await link.holdForReport())) {
      // A message came first: the chat goes on, and its next idle spell counts.
      run.report = 'owed';
      held.closing = false;
      this.emitRuntime(rt);
      this.persist();
      return;
    }
    await this.writeReport(task, rt, run, sessionId);
    // A message that came while the report was written takes the run up again, in the same chat.
    if (link.reportWritten()) {
      this.holdInChat(task.id, run.runId, run.chat!, link);
      this.chatTalked(task.id, run.chat!);
    } else await link.close();
  }

  /** Stop on a run open in a chat, and the chat ended: the run ends as stopped, without a report. */
  private endStopped(task: Task, rt: TaskRuntime, run: ActiveRun): void {
    const reason = this.chatStops.get(run.runId) ?? 'stopped by user';
    this.chatStops.delete(run.runId);
    this.record(task.id, run.runId, 'system', 'started', { summary: `went on in chat ${run.chat}`, detail: { chat: run.chat } });
    this.record(task.id, run.runId, 'system', 'stopped', { summary: reason });
    this.record(task.id, run.runId, 'result', 'stopped', { summary: reason });
    this.finishCycle(task.id, rt, run.runId, false, 'stopped', reason);
  }

  /** A run open in a chat ends as it was: nothing is recorded, and the task's last result stays. */
  private dropRun(rt: TaskRuntime, runId: string): void {
    this.chatLinks.delete(runId);
    this.chatStops.delete(runId);
    const at = rt.runs.findIndex((r) => r.runId === runId);
    if (at < 0) return;
    rt.runs.splice(at, 1);
    this.recompute(rt);
    const fresh = this.d.tasks.get(rt.taskId);
    if (!fresh) {
      if (rt.runs.length === 0) this.forget(rt.taskId);
    } else if (rt.runs.length === 0) {
      this.park(fresh, rt, rt.lastDetail ?? '');
    }
    this.emitRuntime(rt);
    this.persist();
  }

  /**
   * The report of a run whose chat ends: a headless session goes on with
   * the chat's conversation and ends with looper-done and the report, as the
   * run's own agent would. Its files are in the run's REPORT_DIR, so the run's
   * conversation stays the one it shows.
   */
  private async writeReport(task: Task, rt: TaskRuntime, run: ActiveRun, sessionId: string): Promise<void> {
    const { runId } = run;
    const runDir = path.join(this.d.runs.runDir(task.id, runId), REPORT_DIR);
    const wasCompleted = !!task.completedAt;
    const stopper = { controller: new AbortController(), reason: 'stopped by user' };
    this.cycleStops.set(runId, stopper);
    let errored = false;
    let network = false;
    let environment = false;
    let outcome: RunResult = 'error';
    let detail = '';
    let retryAtMs: number | undefined;
    this.record(task.id, runId, 'system', 'started', { summary: `went on in chat ${run.chat}; writing the report`, detail: { chat: run.chat } });
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(runDir, 'bin'), { recursive: true });
      // In the background, and only the report: no terminal to hold for a human, no agents of its own, no context restart.
      const reportTask: Task = {
        ...task,
        agent: { ...task.agent, mode: 'headless', contextLimitK: undefined, delegate: { ...task.agent.delegate, allowed: false } },
      };
      const ctx: RunContext = {
        task: reportTask,
        runId,
        runDir,
        target: createTarget(task, { host: this.d.host, settings: this.d.settings }),
        settings: this.d.settings,
        host: this.d.host,
        log: this.d.log,
        dataDir: this.d.dataDir,
        signal: stopper.controller.signal,
        promptOverride: reportPrompt(runId),
        agentSession: { id: sessionId, resume: true },
        vars: { task: task.name, taskId: task.id, runId, trigger: run.trigger },
      };
      this.record(task.id, runId, 'agent', 'started', { summary: 'writing the report', body: agentPrompt(ctx) });
      const end = await this.runAgent(reportTask, rt, ctx);
      if (end.login) this.d.onLogin?.(task, false);
      else if (!end.network && !end.environment && end.reason !== 'stopped') this.d.onLogin?.(task, true);
      outcome = end.doneStatus ?? end.reason;
      this.record(task.id, runId, 'agent', outcome, {
        durationMs: end.durationMs,
        exitCode: end.exitCode,
        network: end.network,
        environment: end.environment,
      });
      if (end.headline || end.body) this.record(task.id, runId, 'result', outcome, { summary: end.headline, body: end.body });
      errored = end.reason === 'error' || end.doneStatus === 'error' || !!end.network || !!end.environment;
      network = !!end.network;
      environment = !!end.environment;
      detail = end.headline ?? '';
      retryAtMs = end.retryAtMs;
      this.applyCompleteSignal(task, runId, runDir, end);
    } catch (e) {
      errored = true;
      environment = looksLikeEnvironmentError(errMsg(e));
      detail = errMsg(e);
      this.d.log.error(`[${task.id}] the report of run ${runId} failed: ${errMsg(e)}`);
      this.record(task.id, runId, 'system', 'error', { error: errMsg(e), environment: environment || undefined });
    } finally {
      this.agents.delete(runId);
      this.cycleStops.delete(runId);
      this.chatLinks.delete(runId);
      this.finishCycle(task.id, rt, runId, errored, outcome, detail, retryAtMs, network, wasCompleted, false, environment);
    }
  }

  // ---------- delegated agents (looper-delegate) ----------

  /** The task a delegated agent in flight or waiting to start runs as (see delegateTask). */
  childTask(runId: string): Task | undefined {
    return this.children.get(runId)?.task;
  }

  /** The delegated agents a run's agent started that are in flight or waiting to start, oldest first. */
  private childrenOf(taskId: string, parentRunId: string): ActiveRun[] {
    return this.runtimes.get(taskId)?.children.filter((r) => r.parentRunId === parentRunId) ?? [];
  }

  /** A looper-delegate call from the agent of run `ctx`: the text the command prints and its exit code. */
  private async delegateRequest(task: Task, ctx: RunContext, args: string[], cwd: string): Promise<{ text: string; code: number }> {
    const req = parseDelegateArgs(args);
    if ('error' in req) return { text: `${AGENT_DELEGATE}: ${req.error}\n${DELEGATE_USAGE}`, code: 2 };
    try {
      switch (req.op) {
        case 'start':
          return { text: this.startDelegate(task, ctx, cwd, req.start), code: 0 };
        case 'list':
          return { text: this.listDelegates(task.id, ctx.runId), code: 0 };
        case 'tell':
          return { text: this.tellDelegate(task.id, ctx.runId, req.id, req.text), code: 0 };
        case 'stop':
          return { text: await this.stopDelegate(task.id, ctx.runId, req.id), code: 0 };
      }
    } catch (e) {
      return { text: `${AGENT_DELEGATE}: ${errMsg(e)}`, code: 1 };
    }
  }

  /** Start: the agent's run, waiting for its folder until pumpChildren starts it. Throws with the reason it can't. */
  private startDelegate(task: Task, ctx: RunContext, cwd: string, start: StartArgs): string {
    const rt = this.must(task.id);
    if (!rt.runs.some((r) => r.runId === ctx.runId)) throw new Error('this run is ending');
    const windows = ctx.target.kind === 'windows';
    const hostOf = (p: string): string => {
      try {
        return ctx.target.toHostPath(p);
      } catch {
        throw new Error(`Looper can't reach ${p}`);
      }
    };
    const folder = absolutePath(windows, cwd, start.folder);
    if (sameFolder(folder, task.cwd)) throw new Error(`${folder} is your own folder, so do that work yourself`);
    let isDir = false;
    try {
      isDir = fs.statSync(hostOf(folder)).isDirectory();
    } catch (e) {
      if (errMsg(e).startsWith("Looper can't")) throw e;
    }
    if (!isDir) throw new Error(`there is no folder ${folder}`);
    const briefFile = absolutePath(windows, cwd, start.briefFile);
    let brief: string;
    try {
      brief = fs.readFileSync(hostOf(briefFile), 'utf8');
    } catch (e) {
      if (errMsg(e).startsWith("Looper can't")) throw e;
      throw new Error(`can't read the brief ${briefFile}`);
    }
    if (!brief.trim()) throw new Error(`the brief ${briefFile} is empty`);
    const childTask = delegateTask(task, this.d.settings, this.d.projects?.() ?? [], folder, start);
    const runId = newRunId(new Date(this.now()));
    const runDir = this.d.runs.createRunDir(task.id, runId);
    writeText(path.join(runDir, 'brief.md'), brief);
    const run: ActiveRun = {
      runId,
      state: 'checking',
      held: false,
      question: null,
      startedAt: this.now(),
      trigger: 'manual',
      parentRunId: ctx.runId,
      title: start.title,
      folder,
      waiting: 'waiting to start',
    };
    const stopper = { controller: new AbortController(), reason: 'stopped by user' };
    this.children.set(runId, {
      run,
      taskId: task.id,
      parentRunId: ctx.runId,
      parentTaskName: task.name,
      parentTarget: ctx.target,
      task: childTask,
      runDir,
      brief,
      stopper,
      started: false,
      probedAt: 0,
      probing: false,
    });
    // Stop Task on the agent's run reaches it before it starts too.
    this.cycleStops.set(runId, stopper);
    rt.children.push(run);
    const detail = { title: start.title, folder };
    this.record(task.id, runId, 'delegate', 'started', { summary: `started by run ${ctx.runId}`, body: brief, detail: { ...detail, parentRunId: ctx.runId } });
    this.record(task.id, ctx.runId, 'delegate', 'started', { summary: `${start.title} in ${folder}`, body: brief, detail: { ...detail, childRunId: runId } });
    this.syncDelegateBusy(task.id, ctx.runId);
    this.emitRuntime(rt);
    this.persist();
    this.pumpChildren(rt);
    return `${runId}\nStarted "${start.title}" in ${folder} as ${runId}. It begins once no other session is working in that folder, and its result reaches you when it ends.`;
  }

  private listDelegates(taskId: string, parentRunId: string): string {
    const runs = this.childrenOf(taskId, parentRunId);
    if (!runs.length) return 'No agent you started is running or waiting to start.';
    const state = (r: ActiveRun) => (r.waiting ? `waiting: ${r.waiting}` : r.question !== null ? 'asking you a question' : 'running');
    return runs.map((r) => `${r.runId}  ${state(r)}  "${r.title}"  ${r.folder}`).join('\n');
  }

  /** One of the run's own delegated agents in flight; throws for any other id. */
  private ownChild(taskId: string, parentRunId: string, id: string): Child {
    const child = this.children.get(id);
    if (!child || child.taskId !== taskId || child.parentRunId !== parentRunId) {
      throw new Error(`no agent ${id} you started is running or waiting to start (${AGENT_DELEGATE} list shows them)`);
    }
    return child;
  }

  /** Tell: guidance for the agent, or the answer to its question. */
  private tellDelegate(taskId: string, parentRunId: string, id: string, text: string): string {
    const child = this.ownChild(taskId, parentRunId, id);
    if (!this.agents.has(id)) {
      // Not started, or its session still starting: its hooks hand it over with the first step it takes.
      queueGuidance(child.runDir, text);
      this.record(taskId, id, 'guidance', 'sent', { summary: headlineOf(text), body: text });
      if (!child.started) return `${id} hasn't started yet, and gets this once it does.`;
      this.watchGuidance(taskId, id, child.runDir);
      return `${id} is starting, and gets this with its first step.`;
    }
    const answers = child.run.question !== null;
    this.sendGuidance(taskId, id, text);
    return answers ? `${id} got your answer.` : `${id} gets this with its next step.`;
  }

  private async stopDelegate(taskId: string, parentRunId: string, id: string): Promise<string> {
    const child = this.ownChild(taskId, parentRunId, id);
    child.stopper.reason = 'stopped by the agent that started it';
    await this.stopTask(taskId, child.stopper.reason, id);
    if (!child.started) this.endChild(child, 'stopped', child.stopper.reason);
    return `Stopping ${id}. Its result reaches you when it has ended, like any other.`;
  }

  /** The busy file that makes looper-done refuse (and lets the turn end) while the run's agents are going. */
  private syncDelegateBusy(taskId: string, parentRunId: string): void {
    // A run that ended has nobody to refuse: settleDelegate removed its file.
    if (!this.runtimes.get(taskId)?.runs.some((r) => r.runId === parentRunId)) return;
    const file = path.join(this.d.runs.runDir(taskId, parentRunId), DELEGATE_DIR, DELEGATE_BUSY_FILE);
    const runs = this.childrenOf(taskId, parentRunId);
    try {
      if (!runs.length) fs.rmSync(file, { force: true });
      else {
        writeText(
          file,
          `looper-done refused: these agents you started are still going: ${runs.map((r) => `${r.runId} ("${r.title}")`).join(', ')}. ` +
            `End your turn to wait for their results (Looper brings each one in), or stop one with ${AGENT_DELEGATE} stop <id>.\n`,
        );
      }
    } catch (e) {
      this.d.log.error(`[${taskId}] cannot write the delegated agents' busy file: ${errMsg(e)}`);
    }
  }

  /**
   * Start the task's delegated agents whose folders are free: no Looper run
   * there, none of the environment's or harness's caps reached, and no
   * session `claude agents` reports working there (asked again every
   * FOLDER_PROBE_MS while it waits). Agents waiting for one folder start in
   * the order they were asked for.
   */
  private pumpChildren(rt: TaskRuntime): void {
    if (this.stopping) return;
    for (const run of [...rt.children]) {
      const child = this.children.get(run.runId);
      if (!child || child.started || child.probing) continue;
      if (child.stopper.controller.signal.aborted) {
        this.endChild(child, 'stopped', child.stopper.reason);
        continue;
      }
      const block = this.childBlock(child);
      if (block) {
        this.setWaiting(rt, child, block);
        continue;
      }
      if (child.probedAt && this.now() - child.probedAt < FOLDER_PROBE_MS) continue;
      child.probing = true;
      child.probedAt = this.now();
      void this.folderBusy(child.task)
        .catch((e: Error) => {
          this.d.log.warn(`[${child.taskId}] cannot ask whether a session is working in ${child.task.cwd}: ${e.message}`);
          return null;
        })
        .then((busy) => {
          child.probing = false;
          if (this.stopping || child.started || !this.children.has(run.runId) || child.stopper.controller.signal.aborted) return;
          const why = busy ?? this.childBlock(child);
          if (why) this.setWaiting(rt, child, why);
          else void this.runChild(child, rt);
        });
    }
  }

  private folderBusy(task: Task): Promise<string | null> {
    if (this.d.folderBusy) return this.d.folderBusy(task);
    const env = resolveEnvironment(task, this.d.settings);
    return claudeBusyIn(env, resolveHarness(task, env), this.d.host, task.cwd);
  }

  /** Why a delegated agent can't start yet by what Looper itself runs, or null. */
  private childBlock(child: Child): string | null {
    const folder = child.task.cwd;
    for (const rt of this.runtimes.values()) {
      const t = this.d.tasks.get(rt.taskId);
      if (!t || !sameFolder(t.cwd, folder)) continue;
      // A run whose agent waits for agents of its own isn't working there now: two runs that started agents in each other's folders would wait forever.
      if (rt.runs.some((r) => !this.childrenOf(rt.taskId, r.runId).length)) return `a run of "${t.name}" is working in that folder`;
    }
    let first = true;
    for (const c of this.children.values()) {
      if (c === child) {
        first = false;
        continue;
      }
      if (!sameFolder(c.task.cwd, folder)) continue;
      if (c.started) return `"${c.run.title}" (${c.run.runId}) is working in that folder`;
      if (first) return `"${c.run.title}" (${c.run.runId}) waits for that folder too, and goes first`;
    }
    return this.concurrencyBlock(child.task, child);
  }

  private setWaiting(rt: TaskRuntime, child: Child, reason: string): void {
    if (child.run.waiting === reason) return;
    child.run.waiting = reason;
    this.d.log.info(`[${child.taskId}] delegated agent ${child.run.runId} waits: ${reason}`);
    this.emitRuntime(rt);
  }

  /** The delegated agent's own run: its agent step, whose end goes to the parent. */
  private async runChild(child: Child, rt: TaskRuntime): Promise<void> {
    const { run } = child;
    child.started = true;
    run.state = 'running';
    delete run.waiting;
    this.emitRuntime(rt);
    this.persist();
    const ctx: RunContext = {
      task: child.task,
      runId: run.runId,
      runDir: child.runDir,
      target: createTarget(child.task, { host: this.d.host, settings: this.d.settings }),
      settings: this.d.settings,
      host: this.d.host,
      log: this.d.log,
      dataDir: this.d.dataDir,
      signal: child.stopper.controller.signal,
      promptOverride: child.brief,
      vars: { task: child.task.name, taskId: child.taskId, runId: run.runId, trigger: 'manual' },
      delegatedBy: { taskName: child.parentTaskName, runId: child.parentRunId, title: run.title ?? child.task.name },
    };
    this.record(child.taskId, run.runId, 'agent', 'started', { summary: run.title, body: agentPrompt(ctx) });
    let end: AgentEnd & { doneStatus?: DoneStatus };
    try {
      end = await this.runAgent(child.task, rt, ctx, {
        // Its questions go to the agent that started it, not to the user.
        onQuestion: (question) => {
          this.setQuestion(rt, run.runId, question);
          this.record(child.taskId, run.runId, 'question', 'sent', { summary: headlineOf(question), body: question });
          this.toParent(child, questionEntry(run.runId, run.title ?? child.task.name, question, child.task.agent.ask.waitMin));
        },
        onNoAnswer: () => {
          this.setQuestion(rt, run.runId, null);
          this.record(child.taskId, run.runId, 'question', 'undelivered', {
            summary: `no answer within ${Number(child.task.agent.ask.waitMin.toFixed(2))} min`,
          });
        },
      });
    } catch (e) {
      this.d.log.error(`[${child.taskId}] delegated agent ${run.runId} failed: ${errMsg(e)}`);
      end = { reason: 'error', exitCode: null, headline: errMsg(e), durationMs: 0, wasHeld: false };
    } finally {
      this.agents.delete(run.runId);
    }
    const outcome: RunResult = end.doneStatus ?? end.reason;
    this.record(child.taskId, run.runId, 'agent', outcome, {
      durationMs: end.durationMs,
      exitCode: end.exitCode,
      network: end.network,
      environment: end.environment,
    });
    if (end.headline || end.body) this.record(child.taskId, run.runId, 'result', outcome, { summary: end.headline, body: end.body });
    const watch = this.guidanceWatches.get(run.runId);
    if (watch) {
      clearInterval(watch);
      this.guidanceWatches.delete(run.runId);
    }
    const left = takePendingGuidance(child.runDir);
    if (left !== null) this.record(child.taskId, run.runId, 'guidance', 'undelivered', { summary: 'not delivered: the agent ended first', body: left });
    this.endChild(child, outcome, end.headline, end.body);
  }

  /** Leave a delegated agent's result or question for its parent's agent; false when the parent's run has ended. */
  private toParent(child: Child, entry: string): boolean {
    const rt = this.runtimes.get(child.taskId);
    if (!rt?.runs.some((r) => r.runId === child.parentRunId)) return false;
    const dir = this.d.runs.runDir(child.taskId, child.parentRunId);
    try {
      queueDelegateMessage(dir, entry);
    } catch (e) {
      this.d.log.error(`[${child.taskId}] cannot leave a message for run ${child.parentRunId}: ${errMsg(e)}`);
      return false;
    }
    this.watchDelivery(
      this.delegateWatches,
      path.join(dir, DELEGATE_FILE),
      child.taskId,
      child.parentRunId,
      'delegate',
      'the agent got the messages from the agents it started',
    );
    this.agents.get(child.parentRunId)?.deliverGuidance();
    return true;
  }

  /** The delegated agent is over (or was stopped before it started): its result goes to its parent. */
  private endChild(child: Child, outcome: RunResult, headline?: string, body?: string): void {
    const { run } = child;
    if (!this.children.delete(run.runId)) return;
    this.cycleStops.delete(run.runId);
    const rt = this.runtimes.get(child.taskId);
    if (rt) {
      const at = rt.children.indexOf(run);
      if (at >= 0) rt.children.splice(at, 1);
    }
    if (!child.started) {
      this.record(child.taskId, run.runId, 'system', outcome, { summary: `ended before it started: ${headline ?? resultLabel(outcome)}` });
      const left = takePendingGuidance(child.runDir);
      if (left !== null) this.record(child.taskId, run.runId, 'guidance', 'undelivered', { summary: 'not delivered: the agent never started', body: left });
    }
    this.syncDelegateBusy(child.taskId, child.parentRunId);
    const title = run.title ?? child.task.name;
    let runFolder = child.runDir;
    try {
      runFolder = child.parentTarget.toTargetPath(child.runDir);
    } catch {
      /* the host path is all there is */
    }
    const entry = resultEntry({
      id: run.runId,
      title,
      folder: run.folder ?? child.task.cwd,
      outcome,
      headline,
      body,
      transcript: this.transcriptOf(child),
      runFolder,
      others: this.childrenOf(child.taskId, child.parentRunId).map((r) => r.runId),
    });
    this.record(child.taskId, child.parentRunId, 'delegate', outcome, {
      summary: `${title}: ${headline ?? resultLabel(outcome)}`,
      body,
      detail: { childRunId: run.runId, title, folder: run.folder },
    });
    if (!this.toParent(child, entry)) {
      this.record(child.taskId, child.parentRunId, 'delegate', 'undelivered', {
        summary: `${title}: not delivered, because the run had ended`,
        detail: { childRunId: run.runId },
      });
    }
    if (rt) {
      this.emitRuntime(rt);
      this.persist();
      this.pumpChildren(rt);
    }
  }

  /** The transcript the delegated agent's session recorded, in its parent's path form when there is one. */
  private transcriptOf(child: Child): string | undefined {
    let own: string;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(child.runDir, 'session.json'), 'utf8')) as { transcript_path?: unknown };
      if (typeof s.transcript_path !== 'string') return undefined;
      own = s.transcript_path;
    } catch {
      return undefined;
    }
    try {
      const host = createTarget(child.task, { host: this.d.host, settings: this.d.settings }).toHostPath(own);
      return child.parentTarget.toTargetPath(host);
    } catch {
      return own;
    }
  }

  /** The run is over: the agents it started are stopped (or taken off the queue). */
  private stopChildrenOf(taskId: string, runId: string, reason: string): void {
    for (const c of [...this.children.values()]) {
      if (c.taskId !== taskId || c.parentRunId !== runId) continue;
      c.stopper.reason = reason;
      if (c.started) void this.stopTask(taskId, reason, c.run.runId);
      else this.endChild(c, 'stopped', reason);
    }
  }

  /** The run is over: its delegated agents' messages its agent never read are recorded as such. */
  private settleDelegate(taskId: string, runId: string, runDir: string): void {
    const watch = this.delegateWatches.get(runId);
    if (watch) {
      clearInterval(watch);
      this.delegateWatches.delete(runId);
    }
    const text = takeDelegateMessages(runDir);
    if (text === null) {
      if (watch) this.record(taskId, runId, 'delegate', 'delivered', { summary: 'the agent got the messages from the agents it started' });
    } else {
      this.record(taskId, runId, 'delegate', 'undelivered', { summary: 'not delivered: the run ended before its agent read them', body: text });
    }
    fs.rmSync(path.join(runDir, DELEGATE_DIR, DELEGATE_BUSY_FILE), { force: true });
  }

  /**
   * Resolves once the run's agent has something to read (a delegated agent's
   * result or question, the user's guidance, a related event), its delegated
   * agents are all over, the time is up, or the run is stopped.
   */
  /** A resumed session's prompt: whatever waits for the agent, in the order its hooks would hand it over; null when nothing does. */
  private takeWaiting(runDir: string): string | null {
    const guidance = takePendingGuidance(runDir);
    const events = takeEvents(runDir);
    const messages = takeDelegateMessages(runDir);
    const parts = [
      ...(guidance !== null ? [guidanceMessage(guidance)] : []),
      ...(events !== null ? [eventsMessage(events)] : []),
      ...(messages !== null ? [delegateMessage([messages])] : []),
    ];
    return parts.length ? parts.join('\n\n') : null;
  }

  /** Wait for guidance, events or a delegated agent's message for a run without a session: true once one waits. */
  private waitForMessage(runDir: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + Math.max(0, timeoutMs);
    const waiting = [DELEGATE_FILE, GUIDANCE_FILE, EVENTS_FILE].map((f) => path.join(runDir, f));
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const came = waiting.some(fileExists);
        if (came || signal?.aborted || this.stopping || Date.now() >= until) {
          clearInterval(timer);
          resolve(came);
        }
      }, this.d.settings.signalPollMs);
    });
  }

  private waitForChildren(taskId: string, runId: string, runDir: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + Math.max(0, timeoutMs);
    const waiting = [DELEGATE_FILE, GUIDANCE_FILE, EVENTS_FILE].map((f) => path.join(runDir, f));
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (
          signal?.aborted ||
          this.stopping ||
          waiting.some(fileExists) ||
          !this.childrenOf(taskId, runId).length ||
          Date.now() >= until
        ) {
          clearInterval(timer);
          resolve();
        }
      }, this.d.settings.signalPollMs);
    });
  }

  /** The shared manual start: lift a pause, honor the caps, run the cycle. */
  private startManual(
    taskId: string,
    skips?: RunSkips,
    continuation?: { fromRunId: string; sessionId: string; prompt: string; relatedId?: string },
  ): boolean {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    this.liftPause(task, rt);
    if (rt.runs.length >= task.maxConcurrentRuns) {
      this.record(taskId, rt.currentRunId ?? '-', 'skip', 'skipped', {
        summary: `manual run ignored: ${this.atCapReason(rt, task)}`,
      });
      return false;
    }
    const block = this.concurrencyBlock(task);
    if (block) {
      this.record(taskId, rt.currentRunId ?? '-', 'skip', 'skipped', {
        summary: `manual run ignored: ${block}`,
      });
      return false;
    }
    void this.runCycle(task, 'manual', undefined, undefined, skips, continuation);
    return true;
  }

  /** A manual run lifts a pause — parked, or still pending behind runs in flight. */
  private liftPause(task: Task, rt: TaskRuntime): void {
    if (rt.state === 'paused' || rt.state === 'disabled' || rt.state === 'completed' || rt.pausedReason) {
      rt.pausedReason = null;
      rt.consecutiveErrors = 0;
      if (!ACTIVE.has(rt.state)) rt.state = 'idle';
      // The lifted pause revives the trigger too: a watcher task starts watching again.
      this.syncWatcher(task);
    }
  }

  /**
   * Finish a task for good: it stops being scheduled, moves to the completed
   * tasks folder when one is set, and is deleted once the completed-task
   * retention runs out. Everything else follows from the store write (see
   * `onTaskChange`).
   *
   * Someone asking for this — a menu click, the inbox, the agent — needs the
   * task's "Allow this task to be marked completed" option; the task's own
   * schedule end date is self-authorizing and passes `force`.
   */
  completeTask(taskId: string, reason: string, opts: { force?: boolean } = {}): void {
    const task = this.d.tasks.get(taskId);
    if (!task || task.completedAt) return;
    if (!opts.force && !task.completion.allowed) {
      this.d.log.warn(`[${taskId}] completion refused: the task does not allow being marked completed`);
      return;
    }
    try {
      this.d.tasks.patch(taskId, { completedAt: new Date(this.now()).toISOString(), completedReason: reason });
    } catch (e) {
      this.d.log.error(`[${taskId}] cannot complete the task: ${errMsg(e)}`);
    }
  }

  /** Undo a completion: the task is enabled again and its schedule resumes. */
  reopenTask(taskId: string): void {
    const task = this.d.tasks.get(taskId);
    if (!task?.completedAt) return;
    try {
      this.d.tasks.patch(taskId, { completedAt: undefined, completedReason: undefined, enabled: true });
    } catch (e) {
      this.d.log.error(`[${taskId}] cannot reopen the task: ${errMsg(e)}`);
    }
  }

  pause(taskId: string, reason = 'paused by user'): void {
    const rt = this.must(taskId);
    rt.pausedReason = reason;
    this.machineRetries.delete(taskId);
    if (rt.state === 'idle' || rt.state === 'disabled') {
      rt.state = 'paused';
      rt.nextRunAt = null;
    }
    // A paused task has no trigger at all: the watcher goes down with the pause.
    void this.watchers.stop(taskId);
    // While active: takes effect when the cycle ends.
    this.emitRuntime(rt);
  }

  resume(taskId: string): void {
    const rt = this.must(taskId);
    const task = this.d.tasks.get(taskId);
    rt.pausedReason = null;
    rt.consecutiveErrors = 0;
    if (rt.state === 'paused') {
      if (task?.enabled) {
        rt.state = 'idle';
        rt.nextRunAt = scheduleOf(task) ? this.now() + 1000 : null;
      } else {
        rt.state = parkedState(task);
      }
    }
    if (task) {
      this.syncWatcher(task);
      // Watching resumes cold: the pause may have swallowed events.
      if (this.watcherDesired(task) && watcherOf(task)?.runOnStart) this.catchUpOwed.add(task.id);
    }
    this.emitRuntime(rt);
  }

  /**
   * Stop a cycle wherever it is: a running check or classifier is killed, an
   * agent is ended. Without a run id the newest run in flight is stopped.
   */
  async stopTask(taskId: string, reason = 'stopped by user', runId?: string): Promise<boolean> {
    const rt = this.runtimes.get(taskId);
    const target = runId ?? newestRun(rt)?.runId;
    if (!target) return false;
    // A run open in a chat: its chat's agent ends its turn, and the chat stays for a correction. If none comes before
    // the chat ends (its idle limit, or Close), the run ends as stopped.
    const inChat = rt?.runs.find((r) => r.runId === target && r.chat && r.report !== 'writing');
    if (rt && inChat) {
      inChat.report = 'stopped';
      this.chatStops.set(target, reason);
      this.emitRuntime(rt);
      this.persist();
      await this.chatLinks.get(target)?.link.stop();
      return true;
    }
    const h = this.agents.get(target);
    if (h) {
      await h.stop('stopped', reason);
      return true;
    }
    const cycle = this.cycleStops.get(target);
    if (cycle && !cycle.controller.signal.aborted) {
      cycle.reason = reason;
      cycle.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * The system is suspending. A run in flight cannot survive it — its child
   * processes and WSL sessions die, or come back broken at the wake with hours
   * of phantom "runtime" — so every non-held run is stopped now, silently, and
   * its task is owed a fresh run. A held run stays: it is parked waiting for a
   * human, and killing it would throw away their session.
   */
  onSuspend(): void {
    // Watchers die with the machine exactly like a run does; they come back at `onResume`.
    this.watchers.suspend();
    for (const rt of this.runtimes.values()) {
      for (const run of [...rt.runs]) {
        // A run open in a chat isn't the slot's work: its chat handles the sleep.
        if (run.held || run.chat) continue;
        this.sleptRuns.add(run.runId);
        this.sleepOwed.add(rt.taskId);
        void this.stopTask(rt.taskId, SLEEP_STOP_REASON, run.runId);
      }
    }
  }

  /**
   * The system woke up. Anything already due — slots that passed while asleep,
   * re-runs owed by `onSuspend` — would fire on the very next tick and race the
   * network coming back, which is the exact failure the run just died of. Due
   * work is pushed a grace into the future instead, staggered a second apart.
   */
  onResume(): void {
    const now = this.now();
    let n = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.nextRunAt !== null && rt.nextRunAt <= now + RESUME_GRACE_MS) {
        rt.nextRunAt = now + RESUME_GRACE_MS + n++ * 1000;
        this.emitRuntime(rt);
      }
    }
    if (n) this.persist();
    // The watchers get the same grace: respawning into a network that is not
    // back yet is the failure they would otherwise crash-loop on.
    setTimeout(() => {
      if (this.stopping) return;
      this.watchers.resume();
      // The sleep was a blind spot; runOnStart tasks owe a catch-up look.
      for (const task of this.d.tasks.list()) {
        if (this.watcherDesired(task) && watcherOf(task)?.runOnStart) this.catchUpOwed.add(task.id);
      }
    }, RESUME_GRACE_MS);
  }

  // ---------- internals ----------

  /**
   * The aggregate the UI reads, recomputed from the runs in flight. Leaves
   * `state` alone when nothing is in flight: idle/paused/disabled is the
   * caller's decision.
   */
  private recompute(rt: TaskRuntime): void {
    let front: ActiveRun | undefined;
    for (const run of rt.runs) if (!front || ADVANCE[run.state] > ADVANCE[front.state]) front = run;
    if (front) rt.state = front.state;
    rt.currentRunId = newestRun(rt)?.runId ?? null;
    rt.held = rt.runs.some((r) => r.held);
    rt.asking = rt.runs.some((r) => r.question !== null);
  }

  /** Move one run to its next step and republish the aggregate. */
  private setRunState(rt: TaskRuntime, runId: string, state: ActiveRun['state']): void {
    const run = rt.runs.find((r) => r.runId === runId);
    if (!run) return;
    run.state = state;
    this.recompute(rt);
    this.emitRuntime(rt);
    this.persist();
  }

  /** A run started/stopped holding for a human; the task is held while any run is. */
  private setHeld(rt: TaskRuntime, runId: string, held: boolean): void {
    const run = rt.runs.find((r) => r.runId === runId);
    if (!run) return;
    run.held = held;
    this.recompute(rt);
    this.emitRuntime(rt);
  }

  /** A run's agent asked the user (or a delegated agent its parent) a question, or it was settled: null; the task is asking while any run is. */
  private setQuestion(rt: TaskRuntime, runId: string, question: string | null): void {
    const run = rt.runs.find((r) => r.runId === runId) ?? rt.children.find((r) => r.runId === runId);
    if (!run || run.question === question) return;
    run.question = question;
    this.recompute(rt);
    this.emitRuntime(rt);
  }

  /** Why a start was refused at the cap; a cap of 1 keeps the plain wording. */
  private atCapReason(rt: TaskRuntime, task: Task): string {
    return task.maxConcurrentRuns === 1
      ? `task is ${rt.state}`
      : `${rt.runs.length} run(s) already active`;
  }

  private must(taskId: string): TaskRuntime {
    const rt = this.runtimes.get(taskId);
    if (!rt) throw new Error(`unknown task ${taskId}`);
    return rt;
  }

  private isOverdue(task: Task, lastRunAt: number | null, now: number): boolean {
    const schedule = scheduleOf(task);
    if (!schedule) return false;
    // A task that never ran is owed only the slots since it was created, so a
    // restart doesn't run a task scheduled for a later date early.
    const from = lastRunAt ?? Date.parse(task.createdAt ?? '');
    if (Number.isNaN(from)) return true;
    try {
      const next = new Cron(schedule.cron, cronTz(schedule.timezone)).nextRun(new Date(from));
      return next !== null && next.getTime() <= now;
    } catch {
      return false;
    }
  }

  private initRuntime(task: Task, delayMs: number, prev?: TaskRuntime): TaskRuntime {
    const rt: TaskRuntime = {
      taskId: task.id,
      state: task.enabled ? 'idle' : parkedState(task),
      held: false,
      asking: false,
      runs: [],
      children: [],
      // Only a cron schedule has a next slot; manual and watcher tasks never do.
      nextRunAt: task.enabled && scheduleOf(task) ? this.now() + delayMs : null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastRunId: prev?.lastRunId ?? null,
      lastResult: prev?.lastResult ?? null,
      lastDetail: prev?.lastDetail ?? null,
      consecutiveErrors: 0,
      currentRunId: null,
      pausedReason: null,
      watcher: null,
      lastEventAt: prev?.lastEventAt ?? null,
      session: prev?.session ?? null,
    };
    this.runtimes.set(task.id, rt);
    this.emitRuntime(rt);
    return rt;
  }

  private computeStartDelays(tasks: Task[]): Map<string, number> {
    const { staggerFirstRun: stagger } = this.d.settings;
    const result = new Map<string, number>();

    if (!stagger.enabled) {
      tasks.forEach((t, i) => result.set(t.id, i * 1000));
      return result;
    }

    const minMs = stagger.minDelaySec * 1000;
    const rangeMs = (stagger.maxDelaySec - stagger.minDelaySec) * 1000;
    const intervalMs = stagger.minIntervalSec * 1000;

    const entries = tasks
      .filter((t) => t.enabled)
      .map((t) => ({ id: t.id, delay: minMs + Math.random() * rangeMs }));

    entries.sort((a, b) => a.delay - b.delay);

    for (let i = 1; i < entries.length; i++) {
      if (entries[i].delay - entries[i - 1].delay < intervalMs) {
        entries[i].delay = entries[i - 1].delay + intervalMs;
      }
    }

    for (const e of entries) result.set(e.id, e.delay);
    return result;
  }

  private onTaskChange(task: Task, kind: 'create' | 'update' | 'remove', previous?: Task): void {
    this.emitEvent({ type: 'tasks', tasks: this.d.tasks.list() });
    if (kind === 'remove') {
      const gone = this.runtimes.get(task.id);
      // A run open in a chat has no task left to end as: it's let go, and the chat goes on as a chat.
      for (const run of [...(gone?.runs ?? [])]) {
        if (run.chat && run.report !== 'writing') this.dropRun(gone!, run.runId);
        else void this.stopTask(task.id, 'task removed', run.runId);
      }
      void this.watchers.stop(task.id);
      this.pendingEvents.delete(task.id);
      this.catchUpOwed.delete(task.id);
      this.windowClosed.delete(task.id);
      this.deferLogged.delete(task.id);
      this.machineRetries.delete(task.id);
      if (gone && !ACTIVE.has(gone.state)) {
        this.runtimes.delete(task.id);
        this.persist();
      }
      return;
    }
    const rt = this.runtimes.get(task.id);
    if (!rt) {
      const newRt = this.initRuntime(task, 0);
      if (task.enabled) {
        newRt.nextRunAt = this.computeNext(task, this.now());
        this.emitRuntime(newRt);
      }
      this.syncWatcher(task);
      // A brand-new watcher task starts cold; its check may have a backlog.
      if (this.watcherDesired(task) && watcherOf(task)?.runOnStart) this.catchUpOwed.add(task.id);
      this.persist();
      return;
    }
    // A rolling conversation lives in one place: a different cwd, environment or
    // harness cannot continue it, so such an edit drops it and the next run starts fresh.
    if (
      rt.session &&
      previous &&
      (previous.cwd !== task.cwd ||
        previous.environmentId !== task.environmentId ||
        previous.agent.harnessId !== task.agent.harnessId)
    ) {
      rt.session = null;
    }
    // An edit keeps a pending retry, but the steps it saved may no longer
    // match the task: the retry runs every step again.
    const retry = this.machineRetries.get(task.id);
    if (retry) {
      retry.check = undefined;
      retry.classified = false;
    }
    // Whoever set it — the agent, a deadline, the inbox, the editor — this is
    // where completing a task takes effect.
    if (previous && !previous.completedAt && task.completedAt) this.onCompleted(task, rt);
    // The trigger follows the edit right away, even with runs in flight: a task
    // that stopped being watched must not collect more events while it finishes.
    const prevWatcher = previous ? watcherOf(previous) : null;
    const wasWatched =
      !!previous &&
      previous.enabled &&
      !previous.completedAt &&
      !!prevWatcher &&
      runWindowOpen(prevWatcher, this.now());
    this.syncWatcher(task);
    // Watching began with this edit (enabled, reopened, switched to the events
    // trigger, or a window edit that opened it): a cold start, so the catch-up
    // applies.
    if (!wasWatched && this.watcherDesired(task) && watcherOf(task)?.runOnStart) {
      this.catchUpOwed.add(task.id);
    }
    if (ACTIVE.has(rt.state)) return; // applied when the cycle finishes
    if (!task.enabled) {
      rt.state = parkedState(task);
      rt.nextRunAt = null;
    } else if (rt.state === 'disabled' || rt.state === 'completed') {
      rt.state = 'idle';
      rt.nextRunAt = this.computeNext(task, this.now());
    } else if (
      rt.state === 'idle' &&
      JSON.stringify(previous?.trigger) !== JSON.stringify(task.trigger)
    ) {
      // Includes a switch away from the schedule, which leaves no next slot at all.
      rt.nextRunAt = this.computeNext(task, this.now());
    }
    this.emitRuntime(rt);
    this.persist();
  }

  /**
   * The task just became completed: it stops being scheduled (its `enabled` is
   * already false), its rolling conversation is over, and a pending pause is
   * moot. The toast is left to the cycle's own end notification while a run is
   * still in flight, so a cycle never sends two.
   */
  private onCompleted(task: Task, rt: TaskRuntime): void {
    rt.session = null;
    rt.pausedReason = null;
    rt.consecutiveErrors = 0;
    const reason = task.completedReason ?? 'completed';
    this.d.log.info(`[${task.id}] task completed: ${reason}`);
    this.record(task.id, rt.currentRunId ?? '-', 'system', 'done', { summary: `Task completed: ${reason}` });
    if (rt.runs.length === 0 && task.notifications.completed) {
      this.notify(task, rt.currentRunId ?? '-', 'completed', `Completed: ${capFirst(reason)}`);
    }
  }

  /**
   * The trigger has run past its end date and the task has not completed on
   * its own. A manual task has no end date to reach — nothing runs it but the
   * user; a schedule and a watcher both stop on theirs.
   */
  private scheduleEnded(task: Task, now: number): boolean {
    const stopOn = task.trigger.stopOn;
    if (!stopOn?.enabled || task.trigger.mode === 'manual' || task.completedAt) return false;
    const ms = Date.parse(stopOn.at);
    return !Number.isNaN(ms) && ms <= now;
  }

  /**
   * A schedule that reached its end date without the task ever running in it
   * (the app was closed or the machine asleep through every slot) gets one
   * run before it completes. Only a slot that fell between the task's
   * creation and the end date counts, and only an enabled, unpaused task.
   */
  private owesFinalRun(task: Task, rt: TaskRuntime, endMs: number): boolean {
    if (!task.enabled || rt.pausedReason || !scheduleOf(task)) return false;
    const createdMs = Date.parse(task.createdAt ?? '');
    if (Number.isNaN(createdMs)) return false;
    if (rt.lastRunAt !== null && rt.lastRunAt >= createdMs) return false;
    const firstSlot = this.computeNext(task, createdMs);
    return firstSlot !== null && firstSlot <= endMs;
  }

  private computeNext(task: Task, from: number): number | null {
    const schedule = scheduleOf(task);
    if (!schedule) return null;
    try {
      const next = new Cron(schedule.cron, cronTz(schedule.timezone)).nextRun(new Date(from));
      return next ? next.getTime() : null;
    } catch (e) {
      this.d.log.error(`[${task.id}] bad schedule: ${errMsg(e)}`);
      return null;
    }
  }

  /**
   * A watcher is wanted while the task is enabled, unfinished, not paused, on
   * the events trigger and inside its run window: outside the window nothing
   * watches at all, so no events accumulate overnight.
   */
  private watcherDesired(task: Task): boolean {
    const watcher = watcherOf(task);
    return (
      task.enabled &&
      !task.completedAt &&
      !!watcher &&
      runWindowOpen(watcher, this.now()) &&
      !this.runtimes.get(task.id)?.pausedReason
    );
  }

  /**
   * The run window gates the watcher process itself: it goes down when the
   * window closes and comes back when it reopens — a cold start, so the
   * runOnStart catch-up applies. Only the transitions act (called every tick).
   */
  private syncWatcherWindow(task: Task): void {
    const watcher = watcherOf(task);
    if (!watcher) {
      this.windowClosed.delete(task.id);
      return;
    }
    const open = runWindowOpen(watcher, this.now());
    if (open === !this.windowClosed.has(task.id)) return;
    if (open) {
      this.windowClosed.delete(task.id);
      this.syncWatcher(task);
      if (this.watcherDesired(task) && watcher.runOnStart) this.catchUpOwed.add(task.id);
    } else {
      this.windowClosed.add(task.id);
      this.syncWatcher(task);
    }
  }

  /**
   * Start, stop or respawn the task's watcher process; the pool decides
   * whether a change means a respawn.
   */
  private syncWatcher(task: Task): void {
    if (this.stopping) return;
    if (this.watcherDesired(task)) this.watchers.sync(task);
    else void this.watchers.stop(task.id);
  }

  private tick(): void {
    if (this.stopping) return;
    const now = this.now();
    for (const task of this.d.tasks.list()) {
      const rt = this.runtimes.get(task.id);
      if (!rt) continue;
      if (rt.children.length) this.pumpChildren(rt);
      if (rt.runs.some((r) => r.chat)) this.idleChats(task, rt);
      // The schedule's end date, checked before the due-slot guard so it also
      // reaches a task that is paused or disabled but still scheduled.
      if (this.scheduleEnded(task, now)) {
        const endMs = Date.parse(task.trigger.stopOn!.at);
        // The final run started after the end date: it may still complete the task itself.
        if (rt.runs.some((r) => r.startedAt >= endMs)) continue;
        if (this.owesFinalRun(task, rt, endMs)) {
          // Due through the normal path below, so the startup stagger, the
          // wake grace and the concurrency limits still apply. A next slot
          // that is just the schedule's regular one (a year away for a dated
          // task) is brought forward.
          const regular = this.computeNext(task, now);
          if (rt.nextRunAt === null || (regular !== null && rt.nextRunAt >= regular)) {
            rt.nextRunAt = now;
            this.emitRuntime(rt);
          }
        } else {
          this.completeTask(
            task.id,
            `stopped running on ${formatDateTime(task.trigger.stopOn!.at, detectSystemLocale())}`,
            { force: true },
          );
          continue;
        }
      }
      // The watcher follows its run window: stopped at the close, restarted
      // at the open (which owes the runOnStart catch-up below).
      this.syncWatcherWindow(task);
      // A batch of watcher events that found no free slot when it arrived,
      // then the runOnStart catch-up (an events run settles the debt too).
      if (this.pendingEvents.has(task.id)) this.flushEvents(task);
      if (this.catchUpOwed.has(task.id)) this.flushCatchUp(task);
      if (rt.nextRunAt === null || rt.nextRunAt > now) continue;
      try {
        // A slot may start another cycle while earlier ones are still going,
        // up to the task's cap; past it the slot is skipped, never queued.
        const room = rt.runs.length < task.maxConcurrentRuns;
        if (ACTIVE.has(rt.state) && (rt.pausedReason || !task.enabled)) {
          // Paused or disabled with runs in flight: the last run to finish
          // parks the task, and no slot may start another one until then.
          rt.nextRunAt = null;
          this.emitRuntime(rt);
        } else if (room && (rt.state === 'idle' || ACTIVE.has(rt.state))) {
          const block = this.concurrencyBlock(task);
          if (block) {
            // Stay due; retried every tick until a slot frees up.
            if (!this.deferLogged.has(task.id)) {
              this.deferLogged.add(task.id);
              this.d.log.info(`[${task.id}] run deferred: ${block}`);
            }
            continue;
          }
          this.deferLogged.delete(task.id);
          void this.runCycle(task, 'timer');
        } else if (
          ACTIVE.has(rt.state) &&
          task.trigger.sendRelatedEvents &&
          task.check?.enabled &&
          !rt.runs.some((r) => r.state === 'checking')
        ) {
          // Only the check knows whether this slot's event belongs to a run in flight.
          void this.runCycle(task, 'timer', undefined, undefined, undefined, undefined, { overCap: true });
        } else if (ACTIVE.has(rt.state)) {
          this.record(task.id, rt.currentRunId ?? '-', 'skip', 'skipped', {
            summary: `scheduled run skipped: ${this.atCapReason(rt, task)}`,
          });
          rt.nextRunAt = this.computeNext(task, now);
          this.emitRuntime(rt);
        }
      } catch (e) {
        this.d.log.error(`[${task.id}] tick failed: ${errMsg(e)}`);
      }
    }
  }

  /**
   * Environment/harness concurrency limits: the reason a start must wait, or
   * null when free to start. Every run counts against its environment's limit
   * (and its agent harness's) for its whole cycle — checking, classifying,
   * running — including the other runs of the task that wants to start. A
   * delegated agent counts once it has started, except that a run's first
   * one on the run's own environment and harness takes the run's slot: the
   * run waits on it. `candidate`: the delegated agent that wants to start.
   */
  private concurrencyBlock(task: Task, candidate?: Child): string | null {
    const env = this.d.settings.environments.find((e) => e.id === task.environmentId);
    if (!env) return null;
    const harnessId = task.agent.harnessId ?? env.harnesses[0]?.id;
    const harness = env.harnesses.find((h) => h.id === harnessId);
    const envLimit = env.maxConcurrentTasks;
    const harnessLimit = harness?.maxConcurrentTasks;
    if (envLimit === undefined && harnessLimit === undefined) return null;
    const harnessOf = (t: Task) => t.agent.harnessId ?? this.d.settings.environments.find((e) => e.id === t.environmentId)?.harnesses[0]?.id;
    /** Whether a delegated agent runs where its parent's run counts, so it can take that run's slot. */
    const sameSlot = (c: Child) => {
      const parent = this.d.tasks.get(c.taskId);
      return !!parent && parent.environmentId === c.task.environmentId && harnessOf(parent) === harnessOf(c.task);
    };
    const slotTaken = new Set<string>();
    for (const c of this.children.values()) {
      if (c.started && !slotTaken.has(c.parentRunId) && sameSlot(c)) slotTaken.add(c.parentRunId);
    }
    if (candidate && !slotTaken.has(candidate.parentRunId) && sameSlot(candidate)) return null;
    let envActive = 0;
    let harnessActive = 0;
    const count = (t: Task, active: number) => {
      if (t.environmentId !== env.id || !active) return;
      envActive += active;
      if (harnessOf(t) === harnessId) harnessActive += active;
    };
    for (const t of this.d.tasks.list()) count(t, this.runtimes.get(t.id)?.runs.length ?? 0);
    // A delegated agent counts where it runs, once it has started, unless it took its parent's slot.
    const freeRide = new Set<string>();
    for (const c of this.children.values()) {
      if (!c.started) continue;
      if (slotTaken.has(c.parentRunId) && !freeRide.has(c.parentRunId) && sameSlot(c)) freeRide.add(c.parentRunId);
      else count(c.task, 1);
    }
    if (envLimit !== undefined && envActive >= envLimit) {
      return `environment "${env.name}" is at its limit of ${envLimit} concurrent task${envLimit === 1 ? '' : 's'}`;
    }
    if (harnessLimit !== undefined && harnessActive >= harnessLimit) {
      return `harness "${harness!.name}" is at its limit of ${harnessLimit} concurrent task${harnessLimit === 1 ? '' : 's'}`;
    }
    return null;
  }

  /**
   * A debounced batch from the task's watcher. Events a task cannot act on —
   * disabled, completed, paused, gone — are dropped where they arrive: they
   * describe a moment that has passed, and holding them would fire a stale run
   * whenever the task came back.
   */
  private onWatcherEvents(taskId: string, lines: string[]): void {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt || !task.enabled || task.completedAt || rt.pausedReason) return;
    rt.lastEventAt = this.now();
    this.emitRuntime(rt);
    this.holdEvents(task, lines, { trigger: 'watcher' });
    this.flushEvents(task);
  }

  /**
   * Keep event lines until `flushEvents` can place them: all in one batch, or
   * with sendRelatedEvents one batch per related id (`relatedId`, or each line's own).
   */
  private holdEvents(
    task: Task,
    lines: readonly string[],
    from: Pick<PendingEvents, 'relatedId' | 'trigger' | 'checked' | 'own'>,
  ): void {
    if (!this.d.tasks.get(task.id)) return;
    const groups = this.pendingEvents.get(task.id) ?? [];
    for (const line of lines) {
      const relatedId = task.trigger.sendRelatedEvents ? (from.relatedId ?? relatedIdOfLine(line)) : undefined;
      const own = relatedId === undefined && from.own;
      let group = own ? undefined : groups.find((g) => g.relatedId === relatedId && !g.own);
      if (!group) {
        group = { relatedId, trigger: from.trigger, lines: [], ...(own ? { own } : {}) };
        groups.push(group);
      }
      if (from.checked) group.checked = true;
      group.lines.push(line);
      if (group.lines.length > MAX_PENDING_EVENTS) group.lines.splice(0, group.lines.length - MAX_PENDING_EVENTS);
    }
    this.pendingEvents.set(task.id, groups);
  }

  /**
   * Place what's waiting. A batch related to a run in flight goes to its agent
   * as soon as it can take it; any other batch becomes one run. At the
   * concurrency cap a batch stays pending and keeps growing until a slot frees
   * up (retried every tick): events coalesce into the next run, they never
   * queue runs.
   */
  private flushEvents(task: Task): void {
    const rt = this.runtimes.get(task.id);
    const pending = this.pendingEvents.get(task.id);
    if (!rt || !pending?.length) return;
    if (rt.pausedReason || !task.enabled || task.completedAt) {
      this.pendingEvents.delete(task.id);
      return;
    }
    const placed = (group: PendingEvents) => pending.splice(pending.indexOf(group), 1);
    for (const group of [...pending]) {
      const relatedId = task.trigger.sendRelatedEvents ? group.relatedId : undefined;
      const owner = relatedId !== undefined ? rt.runs.find((r) => r.relatedId === relatedId) : undefined;
      if (owner) {
        if (this.sendEvents(task, owner, group.lines)) placed(group);
        continue;
      }
      const block = this.watcherBlock(task, rt);
      if (block) {
        if (!this.deferLogged.has(task.id)) {
          this.deferLogged.add(task.id);
          this.d.log.info(`[${task.id}] watcher run deferred: ${block}`);
        }
        continue;
      }
      this.deferLogged.delete(task.id);
      placed(group);
      // Whatever happened while nothing was watching rides along in this run.
      this.catchUpOwed.delete(task.id);
      void this.runCycle(task, group.trigger, group.lines, undefined, undefined, undefined, { relatedId, checked: group.checked });
    }
    if (!pending.length) this.pendingEvents.delete(task.id);
  }

  /** Why a watcher run may not start right now (run window, caps), or null. */
  private watcherBlock(task: Task, rt: TaskRuntime): string | null {
    const watcher = watcherOf(task);
    if (watcher && !runWindowOpen(watcher, this.now())) return 'outside its run window';
    if (rt.runs.length >= task.maxConcurrentRuns) return this.atCapReason(rt, task);
    return this.concurrencyBlock(task);
  }

  /**
   * The runOnStart catch-up: one event-less watcher run so the check can
   * re-derive whatever happened while nothing was watching. Waits out the run
   * window and the caps like any other watcher run (retried every tick), and
   * is settled by any watcher run that starts first.
   */
  private flushCatchUp(task: Task): void {
    const rt = this.runtimes.get(task.id);
    if (!rt) return;
    if (rt.pausedReason || !task.enabled || task.completedAt || !watcherOf(task)) {
      this.catchUpOwed.delete(task.id);
      return;
    }
    if (this.pendingEvents.has(task.id)) return; // the events run will settle it
    if (this.watcherBlock(task, rt)) return;
    this.catchUpOwed.delete(task.id);
    void this.runCycle(task, 'watcher', undefined, 'catch-up: watching started');
  }

  /**
   * The task's watcher cannot stay up. Nothing is left to trigger the task, so
   * it is paused like a run that errored too many times in a row — which also
   * takes the watcher entry down for good.
   */
  private onWatcherCrashLoop(taskId: string, detail: string): void {
    const task = this.d.tasks.get(taskId);
    if (!this.runtimes.has(taskId)) {
      void this.watchers.stop(taskId);
      return;
    }
    this.record(taskId, '-', 'system', 'error', { summary: detail });
    const reason = `auto-paused: ${detail}`;
    this.d.log.warn(`[${taskId}] ${reason}`);
    this.pause(taskId, reason);
    if (task?.notifications.autoPaused) this.notify(task, '-', 'auto-paused', capFirst(reason));
  }

  private async runCycle(
    task: Task,
    trigger: ActiveRun['trigger'],
    events?: string[],
    /** Event-less watcher run (runOnStart): recorded so the log says why it fired. */
    catchUpNote?: string,
    /** Steps the Run Options window switched off; manual runs only. */
    skips?: RunSkips,
    /** Continuation of a finished run: resume its conversation with this prompt; check/classifier never run. */
    continuation?: { fromRunId: string; sessionId: string; prompt: string; relatedId?: string },
    related: CycleEvents = {},
  ): Promise<void> {
    const rt = this.runtimes.get(task.id);
    if (!rt || (rt.runs.length >= task.maxConcurrentRuns && !related.overCap)) return;
    // Any new cycle takes the place of a pending retry; only the retry's own
    // slot (a timer run) starts where the failed run stopped. A slot past the
    // cap is no such cycle, as it starts no agent.
    const pendingRetry = related.overCap ? undefined : this.machineRetries.get(task.id);
    if (!related.overCap) this.machineRetries.delete(task.id);
    const retry = trigger === 'timer' ? pendingRetry : undefined;
    const runId = newRunId(new Date(this.now()));
    let runDir: string;
    try {
      runDir = this.d.runs.createRunDir(task.id, runId);
    } catch (e) {
      this.d.log.error(`[${task.id}] cannot create run dir: ${errMsg(e)}`);
      rt.consecutiveErrors += 1;
      rt.nextRunAt = this.computeNext(task, this.now());
      if (events?.length) this.holdEvents(task, events, { relatedId: related.relatedId, trigger, checked: related.checked });
      return;
    }

    // The task as it stood when the cycle started; what completes during it is the news.
    const wasCompleted = !!task.completedAt;
    const relatedId = related.relatedId ?? continuation?.relatedId ?? retry?.check?.relatedId;
    rt.runs.push({ runId, state: 'checking', held: false, question: null, startedAt: this.now(), trigger, relatedId });
    rt.lastRunAt = this.now();
    // Advanced once, here: finishCycle only recomputes it when the task goes idle.
    rt.nextRunAt = task.enabled ? this.computeNext(task, this.now()) : null;
    this.recompute(rt);
    this.emitRuntime(rt);
    this.persist();

    // The batch that triggered this run, kept with the run: on disk for the
    // agent (LOOPER_EVENTS_FILE) and in the run log for the user.
    if (events?.length) {
      const text = events.join('\n') + '\n';
      try {
        writeText(path.join(runDir, 'events.jsonl'), text);
      } catch (e) {
        this.d.log.error(`[${task.id}] cannot write the trigger events: ${errMsg(e)}`);
      }
      this.record(task.id, runId, trigger === 'watcher' ? 'watcher' : 'system', 'act', {
        summary: `${events.length} event(s)`,
        body: '```\n' + events.join('\n') + '\n```',
      });
    } else if (catchUpNote) {
      this.record(task.id, runId, 'watcher', 'act', { summary: catchUpNote });
    }
    if (retry) {
      const reused = [retry.check && 'check', retry.classified && 'classifier'].filter(Boolean);
      this.record(task.id, runId, 'system', 'started', {
        summary: `retry ${retry.attempt} after: ${retry.reason}${
          reused.length ? `; ${reused.join(' and ')} already passed, not run again` : ''
        }`,
      });
    }

    // A step the Run Options window switched off does not run at all, whatever
    // the task has configured. A continuation run goes straight to the agent:
    // its gates already passed when the run it continues started. A retry
    // skips the steps that passed in the run it retries.
    const checkedEvents = related.checked && events ? checkOutputOf(events) : undefined;
    const willCheck = !continuation && !!task.check?.enabled && !skips?.check && !retry?.check && !checkedEvents;
    const willClassify = !continuation && !!task.classifier?.enabled && !skips?.classifier && !retry?.classified;
    /** The steps that passed, kept for a retry should the machine fail this run. */
    let passedCheck = retry?.check ?? (checkedEvents && { ...checkedEvents, relatedId });
    let passedClassify = !!retry?.classified;
    // Only steps the task actually has are worth naming; the rest of the run
    // log would otherwise report a skip of something that never ran anyway.
    const skipped: string[] = [];
    if (skips?.check && task.check?.enabled) skipped.push('check');
    if (skips?.classifier && task.classifier?.enabled) skipped.push('classifier');
    if (skips?.agent) skipped.push('agent');
    if (skipped.length) {
      this.record(task.id, runId, 'skip', 'skipped', {
        summary: `skipped by run options: ${skipped.join(', ')}`,
      });
    }

    // Without a gate step the run goes straight to the agent: one toast, not two.
    const gated = willCheck || willClassify;
    if (task.notifications.runStart && !related.overCap && (gated || !task.notifications.agentStart)) {
      this.notify(task, runId, 'run-start', 'Run started');
    }

    let errored = false;
    /** The error above was the computer being offline, not the task failing. */
    let network = false;
    /** The error above was the machine's environment (WSL) failing to start a step, not the task failing. */
    let environment = false;
    /** What the detail of an error the machine caused starts with. */
    const machinePrefix = (): string =>
      slept ? 'slept through the run: ' : network ? 'no network: ' : environment ? 'environment unavailable: ' : '';
    /** The run spanned a system sleep: the machine's fault too, and the slot's work never happened. */
    let slept = false;
    let outcome: RunResult = 'noop';
    let detail = 'nothing to do';
    let retryAtMs: number | undefined;
    const stopper = { controller: new AbortController(), reason: 'stopped by user' };
    this.cycleStops.set(runId, stopper);
    const stopped = (): boolean => stopper.controller.signal.aborted;
    /** How the agent step ended; unset when the cycle never got there (or it threw). */
    let agentEnd: AgentEnd | undefined;
    /** Guidance the agent never got, to continue its conversation with once the cycle is over. */
    let guidanceLeft: string | null = null;
    /** The related id a continuation of this run goes on handling. */
    let relatedIdLeft: string | undefined;
    try {
      const ctx: RunContext = {
        task,
        runId,
        runDir,
        target: createTarget(task, { host: this.d.host, settings: this.d.settings }),
        settings: this.d.settings,
        host: this.d.host,
        log: this.d.log,
        dataDir: this.d.dataDir,
        signal: stopper.controller.signal,
        promptOverride: continuation?.prompt,
        // A continuation's prompt is the guidance itself, never the note.
        note: continuation ? undefined : task.note?.text,
        vars: {
          task: task.name,
          taskId: task.id,
          runId,
          trigger,
          ...(events?.length ? { events: events.join('\n') } : {}),
        },
      };

      // No check step configured (or disabled): every slot goes straight to classifier/agent.
      let go = true;
      let checkSummary: string | undefined = continuation ? `continuing run ${continuation.fromRunId}` : undefined;
      if (passedCheck) {
        ctx.vars.summary = passedCheck.summary ?? '';
        ctx.vars.context = passedCheck.context;
        checkSummary = passedCheck.summary;
      }
      if (willCheck) {
        const check = await this.steps.runCheck(ctx);
        if (stopped()) {
          go = false;
          outcome = 'stopped';
          detail = stopper.reason;
          this.record(task.id, runId, 'check', 'stopped', { durationMs: check.durationMs, summary: stopper.reason });
        } else {
          this.record(task.id, runId, 'check', check.status, {
            durationMs: check.durationMs,
            exitCode: check.exitCode,
            summary: check.summary,
            error: check.error,
            network: check.network,
            environment: check.environment,
            slept: check.slept,
            stdoutTail: check.stdoutTail,
          });
          if (check.status === 'error') {
            errored = true;
            network = !!check.network;
            environment = !!check.environment;
            slept = !!check.slept;
            go = false;
            outcome = 'error';
            detail = `${machinePrefix()}check error: ${check.error}`;
          } else if (check.status === 'noop') {
            go = false;
            detail = check.summary ?? 'nothing to do';
          } else {
            ctx.vars.summary = check.summary ?? '';
            ctx.vars.context = check.context;
            checkSummary = check.summary;
            passedCheck = { summary: check.summary, context: check.context };
            if (task.trigger.sendRelatedEvents) {
              const run = rt.runs.find((r) => r.runId === runId)!;
              const checkId = run.relatedId ? undefined : check.relatedId;
              const others = rt.runs.filter((r) => r.runId !== runId);
              const owner = checkId !== undefined ? others.find((r) => r.relatedId === checkId) : undefined;
              if (owner || others.length >= task.maxConcurrentRuns) {
                this.holdEvents(task, [checkEventLine(checkId, check.summary, check.context), ...(events ?? [])], {
                  relatedId: checkId,
                  trigger: triggerOf(task),
                  checked: true,
                });
                go = false;
                detail = owner ? `goes to run ${owner.runId}` : 'waits for a free run';
                this.record(task.id, runId, 'result', 'noop', { summary: detail, body: `# Agent not started\n\nThe check's event ${detail}.` });
              } else if (checkId !== undefined) {
                run.relatedId = checkId;
                passedCheck.relatedId = checkId;
                this.emitRuntime(rt);
              }
            }
            if (check.more) {
              const trig = triggerOf(task);
              for (const item of check.more) {
                this.holdEvents(task, [checkEventLine(item.relatedId, item.summary, item.context)], {
                  trigger: trig,
                  checked: true,
                  own: true,
                });
              }
              this.record(task.id, runId, 'system', 'act', {
                summary: `the check listed ${check.more.length} more item(s), each in a run of its own`,
              });
              this.flushEvents(task);
            }
          }
        }
      }
      if (go && willClassify) {
        this.setRunState(rt, runId, 'classifying');
        this.record(task.id, runId, 'classify', 'started', { summary: checkSummary, body: classifyPrompt(ctx) });
        const cls = await this.runClassifier(task, ctx);
        if (stopped() || cls.status === 'stopped') {
          go = false;
          outcome = 'stopped';
          detail = stopper.reason;
          this.record(task.id, runId, 'classify', 'stopped', { durationMs: cls.durationMs, summary: stopper.reason });
        } else {
          this.record(task.id, runId, 'classify', cls.status, {
            durationMs: cls.durationMs,
            exitCode: cls.exitCode,
            summary: cls.reason,
            body: cls.body,
            error: cls.error,
            network: cls.network,
            environment: cls.environment,
            slept: cls.slept,
            detail: cls.costUsd !== undefined ? { costUsd: cls.costUsd } : undefined,
          });
          if (cls.status === 'error') {
            errored = true;
            network = !!cls.network;
            environment = !!cls.environment;
            slept = !!cls.slept;
            go = false;
            outcome = 'error';
            detail = `${machinePrefix()}classifier error: ${cls.error}`;
            retryAtMs = cls.retryAtMs;
          } else if (cls.status === 'noop') {
            go = false;
            detail = `classifier: ${cls.reason ?? 'no'}`;
            const why = cls.reason || 'The classifier found nothing to do.';
            this.record(task.id, runId, 'result', 'noop', { summary: why, body: `# Agent not started\n\n${why}` });
          } else {
            passedClassify = true;
          }
        }
      }
      // A stop between steps (or during a step that still returned cleanly).
      if (go && stopped()) {
        go = false;
        outcome = 'stopped';
        detail = stopper.reason;
      }
      // The gates passed but the Run Options window switched the agent off: the
      // cycle ends here, with whatever the check had to say.
      if (go && skips?.agent) {
        go = false;
        detail = checkSummary ? `agent step skipped: ${checkSummary}` : 'agent step skipped';
      }
      if (go) {
        this.setRunState(rt, runId, 'running');
        if (continuation) {
          ctx.agentSession = { id: continuation.sessionId, resume: true };
          this.d.log.info(
            `[${task.id}] agent resumes conversation ${continuation.sessionId}, continuing run ${continuation.fromRunId}`,
          );
        } else {
          ctx.agentSession = this.rollingSession(task, rt);
          if (ctx.agentSession) {
            this.d.log.info(
              `[${task.id}] agent ${
                ctx.agentSession.resume
                  ? `resumes conversation ${ctx.agentSession.id} (run ${(rt.session?.runs ?? 0) + 1} of ${task.agent.sessionMaxRuns})`
                  : `starts conversation ${ctx.agentSession.id}`
              }`,
            );
          }
        }
        const handled = rt.runs.find((r) => r.runId === runId)?.relatedId;
        if (handled !== undefined) {
          try {
            writeText(path.join(runDir, RELATED_ID_FILE), handled);
          } catch (e) {
            this.d.log.error(`[${task.id}] cannot write the run's related id: ${errMsg(e)}`);
          }
        }
        this.record(task.id, runId, 'agent', 'started', { summary: checkSummary, body: agentPrompt(ctx) });
        if (task.notifications.agentStart) {
          this.notify(task, runId, 'agent-start', checkSummary ? `Agent started: ${checkSummary}` : 'Agent started');
        }
        const end = await this.runAgent(task, rt, ctx);
        agentEnd = end;
        // An agent that never got an answer from the API says nothing about the login.
        if (end.login) this.d.onLogin?.(task, false);
        else if (!end.network && !end.environment && end.reason !== 'stopped') this.d.onLogin?.(task, true);
        // A done run's outcome is the status the agent reported via looper-done;
        // every other end keeps its mechanism (idle-timeout, exited, ...).
        outcome = end.doneStatus ?? end.reason;
        this.record(task.id, runId, 'agent', outcome, {
          durationMs: end.durationMs,
          exitCode: end.exitCode,
          network: end.network,
          environment: end.environment,
          detail: { wasHeld: end.wasHeld },
        });
        if (end.headline || end.body) {
          this.record(task.id, runId, 'result', outcome, { summary: end.headline, body: end.body });
        }
        // A session the network took down (banner, exit, or a timer that fired
        // mid-retry) failed whatever mechanism ended it.
        if (end.reason === 'error' || end.doneStatus === 'error' || end.network || end.environment) {
          errored = true;
          network = !!end.network;
          environment = !!end.environment;
        }
        // A missing login says what it is: it's no more the environment's being unavailable than the task's failing.
        detail = end.login ? (end.headline ?? '') : `${machinePrefix()}${end.headline ?? ''}`;
        retryAtMs = end.retryAtMs;
        // codex assigns its own thread id on a fresh run; book it once
        // reported. Only a rolling-conversation task books at all — a
        // continuation on a 'fresh' task is one-off and leaves no session.
        const booked =
          task.agent.session === 'continue'
            ? (ctx.agentSession ?? (end.sessionId ? { id: end.sessionId, resume: false } : undefined))
            : undefined;
        if (booked) this.rollSession(task, rt, booked, end);
        this.applyCompleteSignal(task, runId, ctx.runDir, end);
        if (ctx.note && end.reason !== 'error' && end.reason !== 'stopped' && !end.network) {
          this.consumeNote(task.id, ctx.note);
        }
      }
    } catch (e) {
      errored = true;
      outcome = 'error';
      // A step whose process could not even be spawned (an interactive pty
      // with wsl.exe gone mid-update) throws instead of ending.
      environment = looksLikeEnvironmentError(errMsg(e));
      detail = `${machinePrefix()}${errMsg(e)}`;
      this.d.log.error(`[${task.id}] run ${runId} failed: ${errMsg(e)}`);
      this.record(task.id, runId, 'system', 'error', { error: errMsg(e), environment: environment || undefined });
    } finally {
      this.agents.delete(runId);
      this.cycleStops.delete(runId);
      guidanceLeft = this.settleGuidance(task.id, runId, runDir, agentEnd);
      this.settleEvents(task, runId, runDir);
      // The agents it started have nobody left to report to.
      this.stopChildrenOf(task.id, runId, 'the run that started it ended');
      this.settleDelegate(task.id, runId, runDir);
      relatedIdLeft = rt.runs.find((r) => r.runId === runId)?.relatedId;
      // Cut short by the system suspending, or a step that provably spanned a
      // sleep: either way the machine went down mid-run and the task is owed
      // a fresh run once it is back up.
      if (this.sleptRuns.delete(runId)) slept = true;
      if (slept) this.sleepOwed.add(task.id);
      // A scheduled run the machine failed is owed a retry; finishCycle
      // decides whether it comes before the next regular slot.
      else if (trigger === 'timer' && errored && (network || environment) && !this.stopping) {
        this.machineRetries.set(task.id, {
          attempt: (retry?.attempt ?? 0) + 1,
          reason: detail,
          check: passedCheck,
          classified: passedClassify,
        });
      }
      this.finishCycle(task.id, rt, runId, errored, outcome, detail, retryAtMs, network, wasCompleted, slept, environment);
    }
    if (guidanceLeft !== null && !this.stopping) {
      try {
        this.continueRun(task.id, runId, guidanceLeft, relatedIdLeft);
      } catch (e) {
        this.record(task.id, runId, 'guidance', 'error', { summary: `cannot continue the conversation: ${errMsg(e)}` });
      }
    }
  }

  /**
   * The agent called `looper-complete`: finish the task for good. A task that
   * doesn't allow it is never given the helper, so a signal from one is a
   * leftover or a hand-written file — recorded and ignored, not silently
   * obeyed. A run the user stopped never completes either: their stop outranks
   * whatever the agent said on its way out.
   */
  private applyCompleteSignal(task: Task, runId: string, runDir: string, end: AgentEnd): void {
    const reason = readCompleteSignal(runDir);
    if (!reason) return;
    if (!task.completion.allowed) {
      this.record(task.id, runId, 'agent', 'warning', {
        summary: 'completion signal ignored: this task does not let the agent complete it',
      });
      return;
    }
    if (end.reason === 'stopped') {
      this.record(task.id, runId, 'agent', 'warning', {
        summary: 'completion signal ignored: the run was stopped',
      });
      return;
    }
    this.completeTask(task.id, reason);
  }

  /**
   * The conversation this run's agent gets (agent.session 'continue', Claude
   * Code and Codex): resume the stored one while it has runs left on it,
   * otherwise start a new one — claude under a fresh looper-chosen id, codex
   * under an id of its own that the run reports back (see AgentEnd.sessionId).
   * sessionMaxRuns of 1 therefore behaves exactly like 'fresh'. Any other
   * configuration clears leftover state.
   */
  private rollingSession(task: Task, rt: TaskRuntime): { id: string; resume: boolean } | undefined {
    if (task.agent.session !== 'continue') {
      rt.session = null;
      return undefined;
    }
    let kind: string;
    try {
      kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
    } catch {
      return undefined;
    }
    if (kind !== 'claude-code' && kind !== 'codex') return undefined;
    if (rt.session && rt.session.runs < task.agent.sessionMaxRuns) {
      return { id: rt.session.id, resume: true };
    }
    return kind === 'claude-code' ? { id: randomUUID(), resume: false } : undefined;
  }

  /**
   * Book the run against the rolling conversation. A lost resume clears the id
   * so the next run starts fresh (recorded in the run log via the error
   * headline). An `error` end — or one the network took down — books nothing:
   * the model never got the prompt (spawn failure, usage limit, offline), and
   * a resumed conversation is still there to try again.
   */
  private rollSession(task: Task, rt: TaskRuntime, s: { id: string; resume: boolean }, end: AgentEnd): void {
    if (end.sessionLost) {
      rt.session = null;
      this.d.log.warn(`[${task.id}] conversation ${s.id} no longer exists; the next run starts a new one`);
      return;
    }
    if (end.reason === 'error' || end.network) return;
    rt.session =
      s.resume && rt.session?.id === s.id
        ? { id: s.id, runs: rt.session.runs + 1 }
        : { id: s.id, runs: 1 };
  }

  /**
   * The run's agent had the task's one-off note in its prompt: use up one
   * charge. An `error` or network end never consumes (spawn failure, usage
   * limit, offline — the model never processed the prompt), a `stopped` end never consumes (the
   * user killed the run before it could finish acting on the note), and
   * neither does a note that was replaced while the run was going.
   */
  private consumeNote(taskId: string, text: string): void {
    const fresh = this.d.tasks.get(taskId);
    if (!fresh?.note || fresh.note.text !== text) return;
    const runsLeft = fresh.note.runsLeft - 1;
    try {
      this.d.tasks.patch(taskId, { note: runsLeft > 0 ? { text, runsLeft } : undefined });
    } catch (e) {
      this.d.log.error(`[${taskId}] cannot consume the run note: ${errMsg(e)}`);
    }
  }

  /**
   * One run ended. Its outcome always lands on the task (last finisher wins)
   * and it settles its own share of the streak, the auto-pause threshold and
   * any usage-limit wait right away; but parking the task — idle, paused,
   * disabled, and `nextRunAt` — belongs to the last run to finish: while
   * others are still in flight the task stays in an active aggregate state,
   * with a pause or a limit wait pending until then.
   */
  private finishCycle(
    taskId: string,
    rt: TaskRuntime,
    runId: string,
    errored: boolean,
    outcome: RunResult,
    detail: string,
    retryAtMs?: number,
    network = false,
    wasCompleted = false,
    slept = false,
    environment = false,
  ): void {
    const now = this.now();
    // A usage-limit wait is an error with a known end, and a network error, an
    // environment error or a system sleep is the computer's fault, not the
    // task's: none of them counts toward the auto-pause threshold nor resets
    // the streak of real errors. An offline, WSL-less or sleeping machine can
    // therefore never auto-pause a task.
    const limitWait = retryAtMs !== undefined && retryAtMs > now;
    const counts = !limitWait && !network && !environment && !slept;
    if (counts) rt.consecutiveErrors = errored ? rt.consecutiveErrors + 1 : 0;
    rt.lastRunId = runId;
    rt.lastResult = outcome;
    rt.lastDetail = detail || null;
    const at = rt.runs.findIndex((r) => r.runId === runId);
    if (at >= 0) rt.runs.splice(at, 1);
    this.recompute(rt);
    const fresh = this.d.tasks.get(taskId);
    if (!fresh) {
      // The task was deleted mid-cycle; drop its runtime once nothing is left.
      if (rt.runs.length === 0) this.forget(taskId);
      this.persist();
      return;
    }
    // The run that crosses the threshold declares the pause, so a sibling
    // ending well later can neither trigger it with the wrong evidence nor
    // wipe the streak first; like a user pause it takes effect when the last
    // run finishes.
    let autoPausedReason: string | undefined;
    if (counts && errored && !rt.pausedReason && rt.consecutiveErrors >= fresh.backoff.maxConsecutiveErrors) {
      rt.pausedReason = `auto-paused after ${rt.consecutiveErrors} consecutive errors`;
      autoPausedReason = rt.pausedReason;
      this.d.log.warn(`[${taskId}] ${rt.pausedReason}`);
    }
    if (limitWait) {
      // Remembered past this run so no slot starts into the same limit while
      // siblings finish, and so the last finisher waits for the reset.
      const waitUntil = Math.max(retryAtMs!, this.limitWaits.get(taskId) ?? 0);
      this.limitWaits.set(taskId, waitUntil);
      this.d.log.warn(`[${taskId}] usage limit reached; next attempt at ${new Date(waitUntil).toISOString()}`);
    }
    if (rt.runs.length === 0) this.park(fresh, rt, detail);
    else if (limitWait && rt.nextRunAt !== null) rt.nextRunAt = Math.max(rt.nextRunAt, retryAtMs!);
    this.notifyCycleEnd(fresh, runId, {
      outcome,
      detail,
      errored,
      limitWait,
      network,
      environment,
      slept,
      autoPausedReason,
      completed: !wasCompleted && !!fresh.completedAt,
    });
    this.emitRuntime(rt);
    this.persist();
  }

  /** The task's last run ended: it rests (idle, paused, disabled) until its next run, and `detail` is that run's. */
  private park(task: Task, rt: TaskRuntime, detail: string): void {
    const taskId = task.id;
    const now = this.now();
    const owedSleep = this.sleepOwed.delete(taskId);
    const waitUntil = this.limitWaits.get(taskId);
    this.limitWaits.delete(taskId);
    // Taken here and put back only when the retry is scheduled below.
    const machineRetry = this.machineRetries.get(taskId);
    this.machineRetries.delete(taskId);
    if (!task.enabled) {
      rt.state = parkedState(task);
      rt.nextRunAt = null;
    } else if (rt.pausedReason) {
      rt.state = 'paused';
      rt.nextRunAt = null;
    } else if (waitUntil !== undefined && waitUntil > now) {
      rt.state = 'idle';
      rt.nextRunAt = waitUntil;
    } else if (owedSleep) {
      rt.state = 'idle';
      // The sleep killed the run's work, so the task goes due again a grace
      // from now. Reached at a suspend, that lands shortly after the wake:
      // the timer only runs again once the machine is back up, and
      // `onResume` re-defers whatever the sleep left overdue.
      rt.nextRunAt = now + RESUME_GRACE_MS;
    } else {
      rt.state = 'idle';
      // A slot that came due while the task was blocked by an environment or
      // harness limit is still owed; anything else is the next cron slot.
      const owed = rt.nextRunAt !== null && rt.nextRunAt <= now && !!scheduleOf(task);
      if (!owed) rt.nextRunAt = this.computeNext(task, now);
      // The machine failed a scheduled run: retry it on a widening wait,
      // as long as that comes before the next regular slot.
      if (machineRetry) {
        const at = now + MACHINE_RETRY_MS[Math.min(machineRetry.attempt, MACHINE_RETRY_MS.length) - 1];
        if (rt.nextRunAt === null || at < rt.nextRunAt) {
          this.machineRetries.set(taskId, machineRetry);
          rt.nextRunAt = at;
          const when = formatDateTime(at, detectSystemLocale());
          rt.lastDetail = `${detail}; retrying at ${when}`;
          this.d.log.info(`[${taskId}] the machine failed the run; retry ${machineRetry.attempt} at ${new Date(at).toISOString()}`);
        }
      }
    }
  }

  /** A deleted task's last run ended: its runtime goes. */
  private forget(taskId: string): void {
    this.runtimes.delete(taskId);
    this.limitWaits.delete(taskId);
    this.sleepOwed.delete(taskId);
  }

  /**
   * At most one toast per cycle, the most specific applicable event first:
   * usage-limit wait, then auto-pause, then the task completing, then the plain
   * end at the task's chosen level. A kind that is switched off falls through to the next — except a
   * network error, which is silent unless the task asked for those: the
   * computer being offline says nothing about the task and would otherwise
   * toast for every task at once. A run the system sleep cut short is treated
   * the same way — it re-fires after the wake, and that run's own end toasts.
   * An environment error (WSL could not start the step) is silent too, unless
   * the task asked for environment errors.
   */
  private notifyCycleEnd(
    task: Task,
    runId: string,
    end: {
      outcome: RunResult;
      detail: string;
      errored: boolean;
      limitWait: boolean;
      network: boolean;
      environment: boolean;
      slept: boolean;
      autoPausedReason?: string;
      /** The task finished for good during this cycle. */
      completed: boolean;
    },
  ): void {
    const n = task.notifications;
    if (end.limitWait && n.usageLimit) {
      this.notify(task, runId, 'usage-limit', capFirst(end.detail) || 'Usage limit reached');
      return;
    }
    if (end.autoPausedReason && n.autoPaused) {
      this.notify(task, runId, 'auto-paused', capFirst(end.autoPausedReason), true);
      return;
    }
    if (end.completed && n.completed) {
      this.notify(task, runId, 'completed', `Completed: ${capFirst(task.completedReason ?? end.detail)}`);
      return;
    }
    if (end.errored && (end.network || end.slept) && !n.networkErrors) return;
    if (end.errored && end.environment && !n.environmentErrors) return;
    if (!end.errored && end.slept) return;
    const matches =
      n.end === 'all' ||
      (n.end === 'end' && end.outcome !== 'noop') ||
      (n.end === 'warning' && (end.errored || end.outcome === 'warning')) ||
      (n.end === 'error' && end.errored);
    if (!matches) return;
    const label = resultLabel(end.outcome);
    const problem = end.errored || end.outcome === 'warning';
    this.notify(task, runId, 'end', end.detail ? `${label}: ${capFirst(end.detail)}` : label, problem);
  }

  private notify(task: Task, runId: string, kind: NotifyKind, body: string, problem?: boolean): void {
    this.emitEvent({ type: 'notify', taskId: task.id, runId, kind, title: task.name, body, ...(problem ? { problem } : {}) });
  }

  /** Feed a session's output into the live event stream (`looper serve` prints it). */
  private outputSink(taskId: string, runId: string): (data: string) => void {
    return (data) => this.emitEvent({ type: 'agent:data', taskId, runId, data });
  }

  /**
   * The classify step as a session, mirroring runAgent: output streams out and
   * the handle is registered so Stop reaches it.
   */
  private async runClassifier(task: Task, ctx: RunContext): Promise<ClassifyResult> {
    try {
      const cls = await this.steps.runClassify(ctx, {
        onData: this.outputSink(task.id, ctx.runId),
        onHandle: (handle) => this.agents.set(ctx.runId, handle),
      });
      return cls;
    } finally {
      this.agents.delete(ctx.runId);
    }
  }

  /**
   * The agent step: one session, or several when the agent restarts at its
   * context limit (looper-restart). Each restart ends the session, files it
   * away (endAgentSession) and starts the next one with the task's prompt and
   * the handoff; the end that comes back is the last session's, with the
   * whole step's duration.
   */
  private async runAgent(
    task: Task,
    rt: TaskRuntime,
    ctx: RunContext,
    /** A delegated agent's own answers to some of the callbacks (its questions go to its parent). */
    own: Partial<AgentCallbacks> = {},
  ): Promise<AgentEnd & { doneStatus?: DoneStatus }> {
    const stopReason = (): string => this.cycleStops.get(ctx.runId)?.reason ?? 'stopped by user';
    let elapsedMs = 0;
    let wasHeld = false;
    // Results come back through the guidance hooks, so only a harness that takes guidance may start agents.
    const delegate: AgentCallbacks['delegate'] =
      task.agent.delegate.allowed && this.takesGuidance(task)
        ? {
            handle: (args, cwd) => this.delegateRequest(task, ctx, args, cwd),
            busy: () => this.childrenOf(task.id, ctx.runId).length > 0,
          }
        : undefined;
    for (;;) {
      const handle = await this.steps.startAgent(ctx, {
        delegate,
        onData: this.outputSink(task.id, ctx.runId),
        onHold: () => {
          this.setHeld(rt, ctx.runId, true);
          this.record(task.id, ctx.runId, 'agent', 'held', {
            summary: `idle for ${task.agent.idleGraceMin} min without looper-done; holding for a human`,
          });
          if (task.notifications.held) this.notify(task, ctx.runId, 'held', 'The agent is waiting for your input');
        },
        onResume: () => this.setHeld(rt, ctx.runId, false),
        onQuestion: (question) => {
          this.setQuestion(rt, ctx.runId, question);
          this.record(task.id, ctx.runId, 'question', 'sent', { summary: headlineOf(question), body: question });
          this.notify(task, ctx.runId, 'question', question);
        },
        onNoAnswer: () => {
          this.setQuestion(rt, ctx.runId, null);
          this.record(task.id, ctx.runId, 'question', 'undelivered', {
            summary: `no answer within ${Number(task.agent.ask.waitMin.toFixed(2))} min`,
          });
        },
        onContext: (tokens, limit) =>
          this.record(task.id, ctx.runId, 'agent', 'sent', {
            summary: `context at ${Math.round(tokens / 1000)}k tokens, past the limit of ${Math.round(limit / 1000)}k: asked the agent to restart`,
          }),
        ...own,
      });
      // The resumed session has its prompt; a later session of the run gets its own.
      ctx.resume = undefined;
      this.agents.set(ctx.runId, handle);
      // A stopTask that landed while the agent was still starting has no handle
      // to end and aborts the cycle signal instead: honor it now.
      if (ctx.signal?.aborted) void handle.stop('stopped', stopReason());
      const end = await handle.finished;
      // A question still waiting has nobody left to read the answer.
      this.setQuestion(rt, ctx.runId, null);
      elapsedMs += end.durationMs;
      wasHeld ||= end.wasHeld;
      // Stop in the message box ended a headless agent's turn: the run waits for the next message, which resumes the conversation.
      if (this.turnStops.delete(ctx.runId) && !ctx.signal?.aborted && !this.stopping) {
        const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
        const sessionId = end.sessionId ?? readRunSessionId(ctx.runDir, kind);
        if (sessionId) {
          this.record(task.id, ctx.runId, 'agent', 'sent', { summary: 'the user stopped the turn; the run waits for the next message' });
          const limitMs = task.agent.maxRuntimeMin * 60_000;
          const idleMs = task.agent.idleGraceMin * 60_000;
          const waitStart = Date.now();
          this.agents.delete(ctx.runId);
          this.waitingRuns.add(ctx.runId);
          let came = false;
          try {
            came = await this.waitForMessage(ctx.runDir, Math.min(idleMs, limitMs - elapsedMs), ctx.signal);
            if (!came && task.agent.onIdleTimeout === 'hold' && !ctx.signal?.aborted && !this.stopping) {
              this.setHeld(rt, ctx.runId, true);
              this.record(task.id, ctx.runId, 'agent', 'held', { summary: `idle for ${task.agent.idleGraceMin} min after the user stopped the turn; holding for a human` });
              if (task.notifications.held) this.notify(task, ctx.runId, 'held', 'The agent is waiting for your input');
              came = await this.waitForMessage(ctx.runDir, limitMs - elapsedMs - (Date.now() - waitStart), ctx.signal);
              this.setHeld(rt, ctx.runId, false);
            }
          } finally {
            this.waitingRuns.delete(ctx.runId);
          }
          elapsedMs += Date.now() - waitStart;
          const whole = { durationMs: elapsedMs, wasHeld, doneStatus: undefined };
          if (ctx.signal?.aborted || this.stopping) return { ...end, ...whole, reason: 'stopped', headline: stopReason() };
          const prompt = came ? this.takeWaiting(ctx.runDir) : null;
          if (prompt) {
            ctx.agentSession = { id: sessionId, resume: true };
            ctx.resume = { prompt, usedMs: elapsedMs };
            continue;
          }
          if (elapsedMs >= limitMs) return { ...end, ...whole, reason: 'max-runtime', headline: `exceeded ${task.agent.maxRuntimeMin} min` };
          return { ...end, ...whole, reason: 'idle-timeout', headline: `idle for ${task.agent.idleGraceMin} min after the user stopped the turn` };
        }
      }
      // A headless agent ends its turn to wait for the agents it started: once
      // one of them leaves it a message (a result, or a question), the next
      // session resumes its conversation with their messages. (An interactive
      // one waits in its own session.)
      if (
        delegate &&
        task.agent.mode === 'headless' &&
        end.reason === 'done' &&
        end.doneStatus === undefined &&
        (this.childrenOf(task.id, ctx.runId).length > 0 || fileExists(path.join(ctx.runDir, DELEGATE_FILE)))
      ) {
        const limitMs = task.agent.maxRuntimeMin * 60_000;
        this.record(task.id, ctx.runId, 'agent', 'sent', { summary: 'the agent ended its turn to wait for the agents it started' });
        const waitStart = Date.now();
        // Its session is over: Stop Task now reaches the cycle's stop signal, which ends the wait.
        this.agents.delete(ctx.runId);
        this.waitingRuns.add(ctx.runId);
        try {
          await this.waitForChildren(task.id, ctx.runId, ctx.runDir, limitMs - elapsedMs, ctx.signal);
        } finally {
          this.waitingRuns.delete(ctx.runId);
        }
        elapsedMs += Date.now() - waitStart;
        const whole = { durationMs: elapsedMs, wasHeld, doneStatus: undefined };
        if (ctx.signal?.aborted) return { ...end, ...whole, reason: 'stopped', headline: stopReason() };
        if (elapsedMs >= limitMs) return { ...end, ...whole, reason: 'max-runtime', headline: `exceeded ${task.agent.maxRuntimeMin} min` };
        const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
        const sessionId = end.sessionId ?? readRunSessionId(ctx.runDir, kind);
        if (sessionId) {
          const prompt = this.takeWaiting(ctx.runDir);
          if (prompt) {
            ctx.agentSession = { id: sessionId, resume: true };
            ctx.resume = { prompt, usedMs: elapsedMs };
            continue;
          }
        } else if (fileExists(path.join(ctx.runDir, DELEGATE_FILE))) {
          this.record(task.id, ctx.runId, 'delegate', 'undelivered', {
            summary: 'not delivered: no conversation was recorded to resume',
            body: takeDelegateMessages(ctx.runDir) ?? undefined,
          });
        }
      }
      const whole = { durationMs: elapsedMs, wasHeld };
      const status = end.doneStatus;
      if (status !== RESTART_STATUS) return { ...end, ...whole, doneStatus: status };
      // The session ended for a restart: what it didn't get to stays undone.
      const nonDone = { ...end, ...whole, doneStatus: undefined };
      if (ctx.signal?.aborted) return { ...nonDone, reason: 'stopped', headline: stopReason() };
      if (elapsedMs >= task.agent.maxRuntimeMin * 60_000) {
        return { ...nonDone, reason: 'max-runtime', headline: `exceeded ${task.agent.maxRuntimeMin} min` };
      }
      const count = (ctx.restart?.count ?? 0) + 1;
      const handoff = end.body?.trim() || end.headline || 'The earlier session left no handoff.';
      this.record(task.id, ctx.runId, 'agent', 'restarted', {
        summary: `restart ${count} of ${task.agent.maxRestarts}: ${end.headline ?? 'context restart'}`,
        body: handoff,
        durationMs: end.durationMs,
      });
      endAgentSession(ctx.runDir, count);
      ctx.restart = { count, handoff, elapsedMs };
      // The next session is a new conversation. A rolling one moves on to it:
      // claude under a new looper-chosen id, codex under the id it reports.
      ctx.agentSession = task.agent.session === 'continue' ? this.newConversation(task) : undefined;
      this.d.log.info(`[${task.id}] agent restarts at its context limit (restart ${count} of ${task.agent.maxRestarts})`);
    }
  }

  /** A new rolling conversation for a claude agent; codex picks its own id (undefined). */
  private newConversation(task: Task): { id: string; resume: boolean } | undefined {
    try {
      const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
      return kind === 'claude-code' ? { id: randomUUID(), resume: false } : undefined;
    } catch {
      return undefined;
    }
  }

  private record(
    taskId: string,
    runId: string,
    phase: RunPhase,
    result: RunResult,
    extra: Partial<RunRecord> = {},
  ): void {
    const rec: RunRecord = { ts: new Date(this.now()).toISOString(), taskId, runId, phase, result };
    try {
      const version = this.d.taskVersion?.(taskId);
      if (version !== undefined) rec.taskVersion = version;
    } catch {
      /* an unreadable history only costs the stamp */
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) (rec as unknown as Record<string, unknown>)[k] = v;
    }
    try {
      this.d.runs.append(rec);
    } catch (e) {
      this.d.log.error(`[${taskId}] cannot write run log: ${errMsg(e)}`);
    }
    this.emitEvent({ type: 'record', record: rec });
  }

  private emitRuntime(rt: TaskRuntime): void {
    this.emitEvent({ type: 'runtime', runtime: this.snapshot(rt) });
  }

  /** A copy listeners and the state file can keep: `runs` is mutated in place. */
  private snapshot(rt: TaskRuntime): TaskRuntime {
    return { ...rt, runs: rt.runs.map((r) => ({ ...r })), children: rt.children.map((r) => ({ ...r })) };
  }

  private emitEvent(e: EngineEvent): void {
    try {
      this.emit('event', e);
    } catch (err) {
      this.d.log.error(`event listener failed: ${errMsg(err)}`);
    }
  }

  private persist(): void {
    const snapshot: Record<string, TaskRuntime> = {};
    for (const [id, rt] of this.runtimes) snapshot[id] = this.snapshot(rt);
    this.d.state.save(snapshot);
  }
}
