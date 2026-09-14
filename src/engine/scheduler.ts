import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Cron } from 'croner';
import type {
  ActiveRun,
  EngineEvent,
  NotifyKind,
  RunPhase,
  RunRecord,
  RunResult,
  Settings,
  Task,
  TaskRuntime,
} from '../shared/types';
import { scheduleOf, watcherOf } from '../shared/types';
import { cronTz, runWindowOpen } from '../shared/cron';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { capFirst, formatDateTime, resultLabel } from '../shared/format';
import { detectSystemLocale, type HostKind } from './host';
import { errMsg, type Logger } from './log';
import { createTarget } from './target';
import { runCheck as defaultRunCheck } from './steps/check';
import { classifyPrompt, runClassify as defaultRunClassify, type ClassifyResult } from './steps/classify';
import { agentPrompt, readCompleteSignal, startAgent as defaultStartAgent, type AgentEnd } from './steps/agent';
import type { SessionHandle } from './steps/session';
import type { RunContext } from './steps/common';
import { newRunId, type RunStore } from './store/runs';
import { writeText } from './store/fsutil';
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
}

const ACTIVE: ReadonlySet<TaskRuntime['state']> = new Set(['checking', 'classifying', 'running']);

/** Stop reason of runs cut short because the system is suspending. */
const SLEEP_STOP_REASON = 'computer went to sleep';
/** Work due at (or cut short by) a sleep waits this long past the wake, so the network can come back first. */
const RESUME_GRACE_MS = 20_000;
/** Watcher event lines a task may carry into its next run; past it the oldest are dropped. */
const MAX_PENDING_EVENTS = 1000;

/** How far along a run is; the task's aggregate state is its most advanced run. */
const ADVANCE: Record<ActiveRun['state'], number> = { checking: 0, classifying: 1, running: 2 };

/** The newest run in flight (runs are appended in start order). */
function newestRun(rt: TaskRuntime | undefined): ActiveRun | undefined {
  return rt && rt.runs.length ? rt.runs[rt.runs.length - 1] : undefined;
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
  /** Terminal output per run id; a finished run's buffer stays until the task starts a new one. */
  private readonly buffers = new Map<string, { taskId: string; runId: string; data: string }>();
  /** Tasks whose deferral (concurrency limit) has been logged, to log once per wait. */
  private readonly deferLogged = new Set<string>();
  /** Per task: the usage-limit reset a run reported, pending until its last sibling finishes. */
  private readonly limitWaits = new Map<string, number>();
  /** Runs stopped mid-flight because the system suspended (by run id). */
  private readonly sleptRuns = new Set<string>();
  /** Tasks owed a fresh run: a system sleep cut their run short, so the slot's work never happened. */
  private readonly sleepOwed = new Set<string>();
  /** Watcher event lines waiting for a run slot, per task; a batch never queues a second run. */
  private readonly pendingEvents = new Map<string, string[]>();
  /**
   * Tasks owed a runOnStart catch-up: watching started cold (app launch,
   * enable, pause lifted, system wake, run window opening) and the check
   * should re-derive what was missed. Settled by the next watcher run,
   * whatever triggers it.
   */
  private readonly catchUpOwed = new Set<string>();
  /** Watcher tasks whose run window was closed at the last tick; reopening starts watching cold. */
  private readonly windowClosed = new Set<string>();
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
        this.record(task.id, run.runId, 'system', 'interrupted', {
          summary: `looper restarted while ${run.state}`,
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

  /**
   * The terminal buffer of a run: the named one, else the newest run in
   * flight, else the task's most recent buffer — a finished run's output stays
   * visible in the terminal tab while the task is idle.
   */
  getBuffer(taskId: string, runId?: string): { runId: string; data: string } | null {
    let buf = this.buffers.get(runId ?? newestRun(this.runtimes.get(taskId))?.runId ?? '');
    if (!buf && !runId) {
      for (const b of this.buffers.values()) if (b.taskId === taskId) buf = b;
    }
    return buf ? { runId: buf.runId, data: buf.data } : null;
  }

  // ---------- commands ----------

  runNow(taskId: string): boolean {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    // A manual run lifts a pause — parked, or still pending behind runs in flight.
    if (rt.state === 'paused' || rt.state === 'disabled' || rt.state === 'completed' || rt.pausedReason) {
      rt.pausedReason = null;
      rt.consecutiveErrors = 0;
      if (!ACTIVE.has(rt.state)) rt.state = 'idle';
      // The lifted pause revives the trigger too: a watcher task starts watching again.
      this.syncWatcher(task);
    }
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
    void this.runCycle(task, 'manual');
    return true;
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
    const target = runId ?? newestRun(this.runtimes.get(taskId))?.runId;
    if (!target) return false;
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
        if (run.held) continue;
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

  writeAgent(taskId: string, data: string, runId?: string): void {
    this.agents.get(runId ?? newestRun(this.runtimes.get(taskId))?.runId ?? '')?.write(data);
  }

  resizeAgent(taskId: string, cols: number, rows: number, runId?: string): void {
    this.agents.get(runId ?? newestRun(this.runtimes.get(taskId))?.runId ?? '')?.resize(cols, rows);
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
  }

  /** Move one run to its next step and republish the aggregate. */
  private setRunState(rt: TaskRuntime, runId: string, state: ActiveRun['state']): void {
    const run = rt.runs.find((r) => r.runId === runId);
    if (!run) return;
    run.state = state;
    this.recompute(rt);
    this.emitRuntime(rt);
  }

  /** A run started/stopped holding for a human; the task is held while any run is. */
  private setHeld(rt: TaskRuntime, runId: string, held: boolean): void {
    const run = rt.runs.find((r) => r.runId === runId);
    if (!run) return;
    run.held = held;
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
    if (lastRunAt === null) return true;
    try {
      const next = new Cron(schedule.cron, cronTz(schedule.timezone)).nextRun(new Date(lastRunAt));
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
      runs: [],
      // Only a cron schedule has a next slot; manual and watcher tasks never do.
      nextRunAt: task.enabled && scheduleOf(task) ? this.now() + delayMs : null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastResult: prev?.lastResult ?? null,
      lastDetail: prev?.lastDetail ?? null,
      consecutiveErrors: 0,
      currentRunId: null,
      pausedReason: null,
      watcher: null,
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
      for (const run of [...(gone?.runs ?? [])]) void this.stopTask(task.id, 'task removed', run.runId);
      void this.watchers.stop(task.id);
      this.pendingEvents.delete(task.id);
      this.catchUpOwed.delete(task.id);
      this.windowClosed.delete(task.id);
      this.deferLogged.delete(task.id);
      if (gone && !ACTIVE.has(gone.state)) {
        this.runtimes.delete(task.id);
        this.dropBuffers(task.id);
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
      // The schedule's end date, checked before the due-slot guard so it also
      // reaches a task that is paused or disabled but still scheduled.
      if (this.scheduleEnded(task, now)) {
        this.completeTask(
          task.id,
          `stopped running on ${formatDateTime(task.trigger.stopOn!.at, detectSystemLocale())}`,
          { force: true },
        );
        continue;
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
   * running — including the other runs of the task that wants to start.
   */
  private concurrencyBlock(task: Task): string | null {
    const env = this.d.settings.environments.find((e) => e.id === task.environmentId);
    if (!env) return null;
    const harnessId = task.agent.harnessId ?? env.harnesses[0]?.id;
    const harness = env.harnesses.find((h) => h.id === harnessId);
    const envLimit = env.maxConcurrentTasks;
    const harnessLimit = harness?.maxConcurrentTasks;
    if (envLimit === undefined && harnessLimit === undefined) return null;
    let envActive = 0;
    let harnessActive = 0;
    for (const t of this.d.tasks.list()) {
      if (t.environmentId !== env.id) continue;
      const active = this.runtimes.get(t.id)?.runs.length ?? 0;
      if (!active) continue;
      envActive += active;
      if ((t.agent.harnessId ?? env.harnesses[0]?.id) === harnessId) harnessActive += active;
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
    const pending = this.pendingEvents.get(taskId) ?? [];
    pending.push(...lines);
    if (pending.length > MAX_PENDING_EVENTS) pending.splice(0, pending.length - MAX_PENDING_EVENTS);
    this.pendingEvents.set(taskId, pending);
    this.flushEvents(task);
  }

  /**
   * Turn what the watcher collected into one run. At the concurrency cap the
   * batch stays pending and keeps growing until a slot frees up (retried every
   * tick): watcher events coalesce into the next run, they never queue runs.
   */
  private flushEvents(task: Task): void {
    const rt = this.runtimes.get(task.id);
    const pending = this.pendingEvents.get(task.id);
    if (!rt || !pending?.length) return;
    if (rt.pausedReason || !task.enabled || task.completedAt) {
      this.pendingEvents.delete(task.id);
      return;
    }
    const block = this.watcherBlock(task, rt);
    if (block) {
      if (!this.deferLogged.has(task.id)) {
        this.deferLogged.add(task.id);
        this.d.log.info(`[${task.id}] watcher run deferred: ${block}`);
      }
      return;
    }
    this.deferLogged.delete(task.id);
    this.pendingEvents.delete(task.id);
    // Whatever happened while nothing was watching rides along in this run.
    this.catchUpOwed.delete(task.id);
    void this.runCycle(task, 'watcher', pending);
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
    if (this.pendingEvents.get(task.id)?.length) return; // the events run will settle it
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
  ): Promise<void> {
    const rt = this.runtimes.get(task.id);
    if (!rt || rt.runs.length >= task.maxConcurrentRuns) return;
    const runId = newRunId(new Date(this.now()));
    let runDir: string;
    try {
      runDir = this.d.runs.createRunDir(task.id, runId);
    } catch (e) {
      this.d.log.error(`[${task.id}] cannot create run dir: ${errMsg(e)}`);
      rt.consecutiveErrors += 1;
      rt.nextRunAt = this.computeNext(task, this.now());
      return;
    }

    // The task as it stood when the cycle started; what completes during it is the news.
    const wasCompleted = !!task.completedAt;
    rt.runs.push({ runId, state: 'checking', held: false, startedAt: this.now(), trigger });
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
      this.record(task.id, runId, 'watcher', 'act', {
        summary: `${events.length} event(s)`,
        body: '```\n' + events.join('\n') + '\n```',
      });
    } else if (catchUpNote) {
      this.record(task.id, runId, 'watcher', 'act', { summary: catchUpNote });
    }

    // Without a gate step the run goes straight to the agent: one toast, not two.
    const gated = !!task.check?.enabled || !!task.classifier?.enabled;
    if (task.notifications.runStart && (gated || !task.notifications.agentStart)) {
      this.notify(task, runId, 'run-start', 'Run started');
    }

    let errored = false;
    /** The error above was the computer being offline, not the task failing. */
    let network = false;
    /** The run spanned a system sleep: the machine's fault too, and the slot's work never happened. */
    let slept = false;
    let outcome: RunResult = 'noop';
    let detail = 'nothing to do';
    let retryAtMs: number | undefined;
    const stopper = { controller: new AbortController(), reason: 'stopped by user' };
    this.cycleStops.set(runId, stopper);
    const stopped = (): boolean => stopper.controller.signal.aborted;
    try {
      const ctx: RunContext = {
        task,
        runId,
        runDir,
        target: createTarget(task, { host: this.d.host, settings: this.d.settings }),
        settings: this.d.settings,
        host: this.d.host,
        log: this.d.log,
        signal: stopper.controller.signal,
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
      let checkSummary: string | undefined;
      if (task.check?.enabled) {
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
            slept: check.slept,
            stdoutTail: check.stdoutTail,
          });
          if (check.status === 'error') {
            errored = true;
            network = !!check.network;
            slept = !!check.slept;
            go = false;
            outcome = 'error';
            detail = `${slept ? 'slept through the run: ' : network ? 'no network: ' : ''}check error: ${check.error}`;
          } else if (check.status === 'noop') {
            go = false;
            detail = check.summary ?? 'nothing to do';
          } else {
            ctx.vars.summary = check.summary ?? '';
            ctx.vars.context = check.context;
            checkSummary = check.summary;
          }
        }
      }
      if (go && task.classifier?.enabled) {
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
            slept: cls.slept,
            detail: cls.costUsd !== undefined ? { costUsd: cls.costUsd } : undefined,
          });
          if (cls.status === 'error') {
            errored = true;
            network = !!cls.network;
            slept = !!cls.slept;
            go = false;
            outcome = 'error';
            detail = `${slept ? 'slept through the run: ' : network ? 'no network: ' : ''}classifier error: ${cls.error}`;
            retryAtMs = cls.retryAtMs;
          } else if (cls.status === 'noop') {
            go = false;
            detail = `classifier: ${cls.reason ?? 'no'}`;
          }
        }
      }
      // A stop between steps (or during a step that still returned cleanly).
      if (go && stopped()) {
        go = false;
        outcome = 'stopped';
        detail = stopper.reason;
      }
      if (go) {
        this.setRunState(rt, runId, 'running');
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
        this.record(task.id, runId, 'agent', 'started', { summary: checkSummary, body: agentPrompt(ctx) });
        if (task.notifications.agentStart) {
          this.notify(task, runId, 'agent-start', checkSummary ? `Agent started: ${checkSummary}` : 'Agent started');
        }
        const end = await this.runAgent(task, rt, ctx);
        // A done run's outcome is the status the agent reported via looper-done;
        // every other end keeps its mechanism (idle-timeout, exited, ...).
        outcome = end.doneStatus ?? end.reason;
        this.record(task.id, runId, 'agent', outcome, {
          durationMs: end.durationMs,
          exitCode: end.exitCode,
          network: end.network,
          detail: { wasHeld: end.wasHeld },
        });
        if (end.headline || end.body) {
          this.record(task.id, runId, 'result', outcome, { summary: end.headline, body: end.body });
        }
        // A session the network took down (banner, exit, or a timer that fired
        // mid-retry) failed whatever mechanism ended it.
        if (end.reason === 'error' || end.doneStatus === 'error' || end.network) {
          errored = true;
          network = !!end.network;
        }
        detail = `${network ? 'no network: ' : ''}${end.headline ?? ''}`;
        retryAtMs = end.retryAtMs;
        // codex assigns its own thread id on a fresh run; book it once reported.
        const booked =
          ctx.agentSession ??
          (task.agent.session === 'continue' && end.sessionId ? { id: end.sessionId, resume: false } : undefined);
        if (booked) this.rollSession(task, rt, booked, end);
        this.applyCompleteSignal(task, runId, ctx.runDir, end);
        if (task.note && end.reason !== 'error' && end.reason !== 'stopped' && !end.network) {
          this.consumeNote(task.id, task.note.text);
        }
      }
    } catch (e) {
      errored = true;
      outcome = 'error';
      detail = errMsg(e);
      this.d.log.error(`[${task.id}] run ${runId} failed: ${errMsg(e)}`);
      this.record(task.id, runId, 'system', 'error', { error: errMsg(e) });
    } finally {
      this.agents.delete(runId);
      this.cycleStops.delete(runId);
      // Cut short by the system suspending, or a step that provably spanned a
      // sleep: either way the machine went down mid-run and the task is owed
      // a fresh run once it is back up.
      if (this.sleptRuns.delete(runId)) slept = true;
      if (slept) this.sleepOwed.add(task.id);
      this.finishCycle(task.id, rt, runId, errored, outcome, detail, retryAtMs, network, wasCompleted, slept);
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
  ): void {
    const now = this.now();
    // A usage-limit wait is an error with a known end, and a network error or
    // a system sleep is the computer's fault, not the task's: none of them
    // counts toward the auto-pause threshold nor resets the streak of real
    // errors. An offline or sleeping machine can therefore never auto-pause a
    // task.
    const limitWait = retryAtMs !== undefined && retryAtMs > now;
    const counts = !limitWait && !network && !slept;
    if (counts) rt.consecutiveErrors = errored ? rt.consecutiveErrors + 1 : 0;
    rt.lastResult = outcome;
    rt.lastDetail = detail || null;
    const at = rt.runs.findIndex((r) => r.runId === runId);
    if (at >= 0) rt.runs.splice(at, 1);
    this.recompute(rt);
    const fresh = this.d.tasks.get(taskId);
    if (!fresh) {
      // The task was deleted mid-cycle; drop its runtime once nothing is left.
      if (rt.runs.length === 0) {
        this.runtimes.delete(taskId);
        this.dropBuffers(taskId);
        this.limitWaits.delete(taskId);
        this.sleepOwed.delete(taskId);
      }
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
    if (rt.runs.length === 0) {
      const owedSleep = this.sleepOwed.delete(taskId);
      const waitUntil = this.limitWaits.get(taskId);
      this.limitWaits.delete(taskId);
      if (!fresh.enabled) {
        rt.state = parkedState(fresh);
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
        const owed = rt.nextRunAt !== null && rt.nextRunAt <= now && !!scheduleOf(fresh);
        if (!owed) rt.nextRunAt = this.computeNext(fresh, now);
      }
    } else if (limitWait && rt.nextRunAt !== null) {
      rt.nextRunAt = Math.max(rt.nextRunAt, retryAtMs!);
    }
    this.notifyCycleEnd(fresh, runId, {
      outcome,
      detail,
      errored,
      limitWait,
      network,
      slept,
      autoPausedReason,
      completed: !wasCompleted && !!fresh.completedAt,
    });
    this.emitRuntime(rt);
    this.persist();
  }

  /**
   * At most one toast per cycle, the most specific applicable event first:
   * usage-limit wait, then auto-pause, then the task completing, then the plain
   * end at the task's chosen level. A kind that is switched off falls through to the next — except a
   * network error, which is silent unless the task asked for those: the
   * computer being offline says nothing about the task and would otherwise
   * toast for every task at once. A run the system sleep cut short is treated
   * the same way — it re-fires after the wake, and that run's own end toasts.
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
      this.notify(task, runId, 'auto-paused', capFirst(end.autoPausedReason));
      return;
    }
    if (end.completed && n.completed) {
      this.notify(task, runId, 'completed', `Completed: ${capFirst(task.completedReason ?? end.detail)}`);
      return;
    }
    if (end.errored && (end.network || end.slept) && !n.networkErrors) return;
    if (!end.errored && end.slept) return;
    const matches =
      n.end === 'all' ||
      (n.end === 'end' && end.outcome !== 'noop') ||
      (n.end === 'warning' && (end.errored || end.outcome === 'warning')) ||
      (n.end === 'error' && end.errored);
    if (!matches) return;
    const label = resultLabel(end.outcome);
    this.notify(task, runId, 'end', end.detail ? `${label}: ${capFirst(end.detail)}` : label);
  }

  private notify(task: Task, runId: string, kind: NotifyKind, body: string): void {
    this.emitEvent({ type: 'notify', taskId: task.id, runId, kind, title: task.name, body });
  }

  /** Feed a session's output into the run's terminal buffer and the live event stream. */
  private bufferSink(taskId: string, runId: string): (data: string) => void {
    const max = this.d.settings.outputBufferBytes;
    // Keep the buffer across the steps of one run, so the terminal tab shows
    // the classifier's output followed by the agent's. A new run of the task
    // is what clears out the buffers of its finished runs — never the finish
    // itself, so an idle task still shows what its last run printed.
    if (!this.buffers.has(runId)) {
      const live = new Set(this.runtimes.get(taskId)?.runs.map((r) => r.runId) ?? []);
      for (const [id, buf] of this.buffers) if (buf.taskId === taskId && !live.has(id)) this.buffers.delete(id);
      this.buffers.set(runId, { taskId, runId, data: '' });
    }
    return (data) => {
      const buf = this.buffers.get(runId);
      if (buf) {
        buf.data += data;
        if (buf.data.length > max) buf.data = buf.data.slice(buf.data.length - max);
      }
      this.emitEvent({ type: 'agent:data', taskId, runId, data });
    };
  }

  private dropBuffers(taskId: string): void {
    for (const [id, buf] of this.buffers) if (buf.taskId === taskId) this.buffers.delete(id);
  }

  /**
   * The classify step as a session, mirroring runAgent: output streams to the
   * terminal tab and the handle is registered so Stop / typing reach it.
   */
  private async runClassifier(task: Task, ctx: RunContext): Promise<ClassifyResult> {
    try {
      const cls = await this.steps.runClassify(ctx, {
        onData: this.bufferSink(task.id, ctx.runId),
        onHandle: (handle) => this.agents.set(ctx.runId, handle),
      });
      this.emitEvent({ type: 'agent:end', taskId: task.id, runId: ctx.runId });
      return cls;
    } finally {
      this.agents.delete(ctx.runId);
    }
  }

  private async runAgent(task: Task, rt: TaskRuntime, ctx: RunContext): Promise<AgentEnd> {
    const handle = await this.steps.startAgent(ctx, {
      onData: this.bufferSink(task.id, ctx.runId),
      onHold: () => {
        this.setHeld(rt, ctx.runId, true);
        this.record(task.id, ctx.runId, 'agent', 'held', {
          summary: `idle for ${task.agent.idleGraceMin} min without looper-done; holding for a human`,
        });
        if (task.notifications.held) this.notify(task, ctx.runId, 'held', 'The agent is waiting for your input');
      },
      onResume: () => this.setHeld(rt, ctx.runId, false),
    });
    this.agents.set(ctx.runId, handle);
    // A stopTask that landed while the agent was still starting has no handle
    // to end and aborts the cycle signal instead: honor it now.
    if (ctx.signal?.aborted) {
      void handle.stop('stopped', this.cycleStops.get(ctx.runId)?.reason ?? 'stopped by user');
    }
    const end = await handle.finished;
    this.emitEvent({ type: 'agent:end', taskId: task.id, runId: ctx.runId });
    return end;
  }

  private record(
    taskId: string,
    runId: string,
    phase: RunPhase,
    result: RunResult,
    extra: Partial<RunRecord> = {},
  ): void {
    const rec: RunRecord = { ts: new Date(this.now()).toISOString(), taskId, runId, phase, result };
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
    return { ...rt, runs: rt.runs.map((r) => ({ ...r })) };
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
