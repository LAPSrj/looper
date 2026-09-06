import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type {
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
import { agentPrompt, startAgent as defaultStartAgent, type AgentEnd } from './steps/agent';
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

export class Scheduler extends EventEmitter {
  private readonly runtimes = new Map<string, TaskRuntime>();
  /** The live harness session of each active task: the agent, or the interactive classifier. */
  private readonly agents = new Map<string, SessionHandle>();
  /** Per active cycle: aborting kills whatever step is running (check, classifier). */
  private readonly cycleStops = new Map<string, { controller: AbortController; reason: string }>();
  private readonly buffers = new Map<string, { runId: string; data: string }>();
  /** Tasks whose deferral (concurrency limit) has been logged, to log once per wait. */
  private readonly deferLogged = new Set<string>();
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
      if (prev && ACTIVE.has(prev.state) && prev.currentRunId) {
        this.record(task.id, prev.currentRunId, 'system', 'interrupted', {
          summary: `looper restarted while ${prev.state}`,
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

  getBuffer(taskId: string): { runId: string; data: string } | null {
    return this.buffers.get(taskId) ?? null;
  }

  // ---------- commands ----------

  runNow(taskId: string): boolean {
    const task = this.d.tasks.get(taskId);
    const rt = this.runtimes.get(taskId);
    if (!task || !rt) throw new Error(`unknown task ${taskId}`);
    if (rt.state === 'paused' || rt.state === 'disabled') {
      rt.pausedReason = null;
      rt.consecutiveErrors = 0;
      rt.state = 'idle';
    }
    if (rt.state !== 'idle') {
      this.record(taskId, rt.currentRunId ?? '-', 'skip', 'skipped', {
        summary: `manual run ignored: task is ${rt.state}`,
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
        rt.state = 'disabled';
      }
    }
    this.emitRuntime(rt);
  }

  /** Stop the task's current cycle wherever it is: a running check or classifier is killed, an agent is ended. */
  async stopTask(taskId: string, reason = 'stopped by user'): Promise<boolean> {
    const h = this.agents.get(taskId);
    if (h) {
      await h.stop('stopped', reason);
      return true;
    }
    const cycle = this.cycleStops.get(taskId);
    if (cycle && !cycle.controller.signal.aborted) {
      cycle.reason = reason;
      cycle.controller.abort();
      return true;
    }
    return false;
  }

  writeAgent(taskId: string, data: string): void {
    this.agents.get(taskId)?.write(data);
  }

  resizeAgent(taskId: string, cols: number, rows: number): void {
    this.agents.get(taskId)?.resize(cols, rows);
  }

  // ---------- internals ----------

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
      state: task.enabled ? 'idle' : 'disabled',
      held: false,
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
      void this.stopTask(task.id, 'task removed');
      this.deferLogged.delete(task.id);
      const rt = this.runtimes.get(task.id);
      if (rt && !ACTIVE.has(rt.state)) {
        this.runtimes.delete(task.id);
        this.buffers.delete(task.id);
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
    if (ACTIVE.has(rt.state)) return; // applied when the cycle finishes
    if (!task.enabled) {
      rt.state = 'disabled';
      rt.nextRunAt = null;
    } else if (rt.state === 'disabled') {
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
      if (!rt || rt.nextRunAt === null || rt.nextRunAt > now) continue;
      try {
        if (rt.state === 'idle') {
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
          // A cron slot passed while a cycle is in progress: skip it, never overlap.
          this.record(task.id, rt.currentRunId ?? '-', 'skip', 'skipped', {
            summary: `scheduled run skipped: task is ${rt.state}`,
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
   * null when free to start. A task counts against its environment's limit
   * (and its agent harness's) for its whole cycle: checking, classifying, running.
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
      if (t.id === task.id || t.environmentId !== env.id) continue;
      const rt = this.runtimes.get(t.id);
      if (!rt || !ACTIVE.has(rt.state)) continue;
      envActive += 1;
      if ((t.agent.harnessId ?? env.harnesses[0]?.id) === harnessId) harnessActive += 1;
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
    if (!rt || rt.state !== 'idle') return;
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

    rt.state = 'checking';
    rt.currentRunId = runId;
    rt.lastRunAt = this.now();
    rt.held = false;
    rt.nextRunAt = task.enabled ? this.computeNext(task, this.now()) : null;
    this.emitRuntime(rt);
    this.persist();

    // Without a gate step the run goes straight to the agent: one toast, not two.
    const gated = !!task.check?.enabled || !!task.classifier?.enabled;
    if (task.notifications.runStart && (gated || !task.notifications.agentStart)) {
      this.notify(task, runId, 'run-start', 'Run started');
    }

    let errored = false;
    let outcome: RunResult = 'noop';
    let detail = 'nothing to do';
    let retryAtMs: number | undefined;
    const stopper = { controller: new AbortController(), reason: 'stopped by user' };
    this.cycleStops.set(task.id, stopper);
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
            stdoutTail: check.stdoutTail,
          });
          if (check.status === 'error') {
            errored = true;
            go = false;
            outcome = 'error';
            detail = `check error: ${check.error}`;
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
        rt.state = 'classifying';
        this.emitRuntime(rt);
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
            detail: cls.costUsd !== undefined ? { costUsd: cls.costUsd } : undefined,
          });
          if (cls.status === 'error') {
            errored = true;
            go = false;
            outcome = 'error';
            detail = `classifier error: ${cls.error}`;
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
        rt.state = 'running';
        this.emitRuntime(rt);
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
          detail: { wasHeld: end.wasHeld },
        });
        if (end.headline || end.body) {
          this.record(task.id, runId, 'result', outcome, { summary: end.headline, body: end.body });
        }
        detail = end.headline ?? '';
        if (end.reason === 'error' || end.doneStatus === 'error') errored = true;
        retryAtMs = end.retryAtMs;
        if (ctx.agentSession) this.rollSession(task, rt, ctx.agentSession, end);
        if (task.note && end.reason !== 'error' && end.reason !== 'stopped') {
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
      this.agents.delete(task.id);
      this.cycleStops.delete(task.id);
      this.finishCycle(task.id, rt, errored, outcome, detail, retryAtMs);
    }
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
   * headline). An `error` end books nothing: the model never got the prompt
   * (spawn failure, usage limit), and a resumed conversation is still there to
   * try again.
   */
  private rollSession(task: Task, rt: TaskRuntime, s: { id: string; resume: boolean }, end: AgentEnd): void {
    if (end.sessionLost) {
      rt.session = null;
      this.d.log.warn(`[${task.id}] conversation ${s.id} no longer exists; the next run starts a new one`);
      return;
    }
    if (end.reason === 'error') return;
    rt.session =
      s.resume && rt.session?.id === s.id
        ? { id: s.id, runs: rt.session.runs + 1 }
        : { id: s.id, runs: 1 };
  }

  /**
   * The run's agent had the task's one-off note in its prompt: use up one
   * charge. An `error` end never consumes (spawn failure, usage limit — the
   * model never processed the prompt), a `stopped` end never consumes (the
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

  private finishCycle(
    taskId: string,
    rt: TaskRuntime,
    errored: boolean,
    outcome: RunResult,
    detail: string,
    retryAtMs?: number,
  ): void {
    // A usage-limit wait is an error with a known end: it neither counts toward
    // the auto-pause threshold nor resets the streak of real errors.
    const limitWait = retryAtMs !== undefined && retryAtMs > this.now();
    if (!limitWait) rt.consecutiveErrors = errored ? rt.consecutiveErrors + 1 : 0;
    rt.lastResult = outcome;
    rt.lastDetail = detail || null;
    const runId = rt.currentRunId ?? '-';
    rt.currentRunId = null;
    rt.held = false;
    const fresh = this.d.tasks.get(taskId);
    if (!fresh) {
      this.runtimes.delete(taskId);
      this.buffers.delete(taskId);
      this.persist();
      return;
    }
    let autoPausedReason: string | undefined;
    if (!fresh.enabled) {
      rt.state = 'disabled';
      rt.nextRunAt = null;
    } else if (rt.pausedReason) {
      rt.state = 'paused';
      rt.nextRunAt = null;
    } else if (limitWait) {
      rt.state = 'idle';
      rt.nextRunAt = retryAtMs!;
      this.d.log.warn(`[${taskId}] usage limit reached; next attempt at ${new Date(retryAtMs!).toISOString()}`);
    } else if (errored && rt.consecutiveErrors >= fresh.backoff.maxConsecutiveErrors) {
      rt.state = 'paused';
      rt.pausedReason = `auto-paused after ${rt.consecutiveErrors} consecutive errors`;
      autoPausedReason = rt.pausedReason;
      rt.nextRunAt = null;
      this.d.log.warn(`[${taskId}] ${rt.pausedReason}`);
    } else {
      rt.state = 'idle';
      rt.nextRunAt = this.computeNext(fresh, this.now());
    }
    this.notifyCycleEnd(fresh, runId, { outcome, detail, errored, limitWait, autoPausedReason });
    this.emitRuntime(rt);
    this.persist();
  }

  /**
   * At most one toast per cycle, the most specific applicable event first:
   * usage-limit wait, then auto-pause, then the plain end at the task's chosen
   * level. A kind that is switched off falls through to the next.
   */
  private notifyCycleEnd(
    task: Task,
    runId: string,
    end: { outcome: RunResult; detail: string; errored: boolean; limitWait: boolean; autoPausedReason?: string },
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

  /** Feed a session's output into the task's terminal buffer and the live event stream. */
  private bufferSink(taskId: string, runId: string): (data: string) => void {
    const max = this.d.settings.outputBufferBytes;
    // Keep the buffer across the steps of one run, so the terminal tab shows
    // the classifier's output followed by the agent's.
    const existing = this.buffers.get(taskId);
    if (!existing || existing.runId !== runId) this.buffers.set(taskId, { runId, data: '' });
    return (data) => {
      const buf = this.buffers.get(taskId);
      if (buf && buf.runId === runId) {
        buf.data += data;
        if (buf.data.length > max) buf.data = buf.data.slice(buf.data.length - max);
      }
      this.emitEvent({ type: 'agent:data', taskId, runId, data });
    };
  }

  /**
   * The classify step as a session, mirroring runAgent: output streams to the
   * terminal tab and the handle is registered so Stop / typing reach it.
   */
  private async runClassifier(task: Task, ctx: RunContext): Promise<ClassifyResult> {
    try {
      const cls = await this.steps.runClassify(ctx, {
        onData: this.bufferSink(task.id, ctx.runId),
        onHandle: (handle) => this.agents.set(task.id, handle),
      });
      this.emitEvent({ type: 'agent:end', taskId: task.id, runId: ctx.runId });
      return cls;
    } finally {
      this.agents.delete(task.id);
    }
  }

  private async runAgent(task: Task, rt: TaskRuntime, ctx: RunContext): Promise<AgentEnd> {
    const handle = await this.steps.startAgent(ctx, {
      onData: this.bufferSink(task.id, ctx.runId),
      onHold: () => {
        rt.held = true;
        this.record(task.id, ctx.runId, 'agent', 'held', {
          summary: `idle for ${task.agent.idleGraceMin} min without looper-done; holding for a human`,
        });
        if (task.notifications.held) this.notify(task, ctx.runId, 'held', 'The agent is waiting for your input');
        this.emitRuntime(rt);
      },
      onResume: () => {
        rt.held = false;
        this.emitRuntime(rt);
      },
    });
    this.agents.set(task.id, handle);
    // A stopTask that landed while the agent was still starting has no handle
    // to end and aborts the cycle signal instead: honor it now.
    if (ctx.signal?.aborted) {
      void handle.stop('stopped', this.cycleStops.get(task.id)?.reason ?? 'stopped by user');
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
    this.emitEvent({ type: 'runtime', runtime: { ...rt } });
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
    for (const [id, rt] of this.runtimes) snapshot[id] = { ...rt };
    this.d.state.save(snapshot);
  }
}
