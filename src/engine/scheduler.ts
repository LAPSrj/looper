import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
import { cronTz } from '../shared/cron';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { capFirst, resultLabel } from '../shared/format';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { createTarget } from './target';
import { runCheck as defaultRunCheck } from './steps/check';
import { classifyPrompt, runClassify as defaultRunClassify, type ClassifyResult } from './steps/classify';
import { agentPrompt, readCompleteSignal, startAgent as defaultStartAgent, type AgentEnd } from './steps/agent';
import type { SessionHandle } from './steps/session';
import type { RunContext } from './steps/common';
import { newRunId, type RunStore } from './store/runs';
import type { StateStore } from './store/state';
import type { TaskStore } from './store/tasks';

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
  private readonly steps: SchedulerSteps;
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
    await Promise.all(stops);
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
   * Finish a task for good: it stops being scheduled, moves to its completion
   * folder if it has one, and is deleted once the completed-task retention runs
   * out. Everything else follows from the store write (see `onTaskChange`).
   */
  completeTask(taskId: string, reason: string): void {
    const task = this.d.tasks.get(taskId);
    if (!task || task.completedAt) return;
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
        rt.nextRunAt = task.schedule.enabled ? this.now() + 1000 : null;
      } else {
        rt.state = parkedState(task);
      }
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
    if (!task.schedule.enabled) return false;
    if (lastRunAt === null) return true;
    try {
      const next = new Cron(task.schedule.cron, cronTz(task.schedule.timezone)).nextRun(new Date(lastRunAt));
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
      nextRunAt: task.enabled ? this.now() + delayMs : null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastResult: prev?.lastResult ?? null,
      lastDetail: prev?.lastDetail ?? null,
      consecutiveErrors: 0,
      currentRunId: null,
      pausedReason: null,
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
    if (ACTIVE.has(rt.state)) return; // applied when the cycle finishes
    if (!task.enabled) {
      rt.state = parkedState(task);
      rt.nextRunAt = null;
    } else if (rt.state === 'disabled' || rt.state === 'completed') {
      rt.state = 'idle';
      rt.nextRunAt = this.computeNext(task, this.now());
    } else if (
      rt.state === 'idle' &&
      JSON.stringify(previous?.schedule) !== JSON.stringify(task.schedule)
    ) {
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

  /** The schedule has run past its end date and the task has not completed on its own. */
  private scheduleEnded(task: Task, now: number): boolean {
    const at = task.schedule.stopOn;
    if (!at || !task.schedule.enabled || task.completedAt) return false;
    const ms = Date.parse(at);
    return !Number.isNaN(ms) && ms <= now;
  }

  private computeNext(task: Task, from: number): number | null {
    if (!task.schedule.enabled) return null;
    try {
      const next = new Cron(task.schedule.cron, cronTz(task.schedule.timezone)).nextRun(new Date(from));
      return next ? next.getTime() : null;
    } catch (e) {
      this.d.log.error(`[${task.id}] bad schedule: ${errMsg(e)}`);
      return null;
    }
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
        this.completeTask(task.id, `stopped running on ${new Date(task.schedule.stopOn!).toLocaleString()}`);
        continue;
      }
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

  private async runCycle(task: Task, trigger: 'timer' | 'manual'): Promise<void> {
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

    // Without a gate step the run goes straight to the agent: one toast, not two.
    const gated = !!task.check?.enabled || !!task.classifier?.enabled;
    if (task.notifications.runStart && (gated || !task.notifications.agentStart)) {
      this.notify(task, runId, 'run-start', 'Run started');
    }

    let errored = false;
    /** The error above was the computer being offline, not the task failing. */
    let network = false;
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
        vars: { task: task.name, taskId: task.id, runId, trigger },
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
            stdoutTail: check.stdoutTail,
          });
          if (check.status === 'error') {
            errored = true;
            network = !!check.network;
            go = false;
            outcome = 'error';
            detail = `${network ? 'no network: ' : ''}check error: ${check.error}`;
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
            detail: cls.costUsd !== undefined ? { costUsd: cls.costUsd } : undefined,
          });
          if (cls.status === 'error') {
            errored = true;
            network = !!cls.network;
            go = false;
            outcome = 'error';
            detail = `${network ? 'no network: ' : ''}classifier error: ${cls.error}`;
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
        if (ctx.agentSession) this.rollSession(task, rt, ctx.agentSession, end);
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
      this.finishCycle(task.id, rt, runId, errored, outcome, detail, retryAtMs, network, wasCompleted);
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
    if (!task.completion.allowAgent) {
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
   * Code only): resume the stored one while it has runs left on it, otherwise
   * start a new one under a fresh id. sessionMaxRuns of 1 therefore behaves
   * exactly like 'fresh'. Any other configuration clears leftover state.
   */
  private rollingSession(task: Task, rt: TaskRuntime): { id: string; resume: boolean } | undefined {
    if (task.agent.session !== 'continue') {
      rt.session = null;
      return undefined;
    }
    try {
      if (resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind !== 'claude-code') return undefined;
    } catch {
      return undefined;
    }
    if (rt.session && rt.session.runs < task.agent.sessionMaxRuns) {
      return { id: rt.session.id, resume: true };
    }
    return { id: randomUUID(), resume: false };
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
  ): void {
    const now = this.now();
    // A usage-limit wait is an error with a known end, and a network error is
    // the computer's fault, not the task's: neither counts toward the
    // auto-pause threshold nor resets the streak of real errors. An offline
    // machine can therefore never auto-pause a task.
    const limitWait = retryAtMs !== undefined && retryAtMs > now;
    const counts = !limitWait && !network;
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
      } else {
        rt.state = 'idle';
        // A slot that came due while the task was blocked by an environment or
        // harness limit is still owed; anything else is the next cron slot.
        const owed = rt.nextRunAt !== null && rt.nextRunAt <= now && fresh.schedule.enabled;
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
   * toast for every task at once.
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
    if (end.errored && end.network && !n.networkErrors) return;
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
