import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Settings, Task } from '../shared/types';
import { watcherOf } from '../shared/types';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { createTarget, type Target } from './target';
import { killHostTree } from './target/kill';
import { ensureDir } from './store/fsutil';
import { childEnv, writeLauncher, type RunContext } from './steps/common';

/**
 * The watcher processes of every task whose trigger is `watcher`: one
 * long-running child each, spawned in the task's environment through the same
 * launcher machinery as a run's steps. Each non-empty stdout line is one
 * event; a debounced batch of them is handed to the scheduler, which turns it
 * into a single run. The pool owns nothing else — it never starts runs, never
 * pauses a task: it reports (`onEvents`, `onState`, `onCrashLoop`) and the
 * scheduler decides.
 */

export type WatcherState = 'watching' | 'restarting';

export interface WatcherPoolDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  /** A debounced batch of stdout lines from the task's watcher. */
  onEvents: (taskId: string, lines: string[]) => void;
  /** Live state for the runtime UI; null = watcher no longer wanted/running. */
  onState: (taskId: string, state: WatcherState | null) => void;
  /** The watcher crashed this many times in a row without a healthy stretch. */
  onCrashLoop: (taskId: string, detail: string) => void;
  now?: () => number;
}

/** Event lines held for a task before the scheduler takes them; past it the oldest are dropped. */
const MAX_PENDING = 1000;
/** A debounce of 0 still coalesces the lines of one burst, which arrive across several chunks. */
const MIN_DEBOUNCE_MS = 10;
/** A watcher that ran this long before exiting was healthy: its streak of crashes starts over. */
const HEALTHY_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
/** Rolling stderr kept per watcher, for the exit message only. */
const STDERR_TAIL_BYTES = 4096;

interface Entry {
  taskId: string;
  /** The task as of the last sync; respawns use it. */
  task: Task;
  /** Spawn-relevant configuration; a change means stop and start, not a live update. */
  key: string;
  /** Live-updatable: a debounce change never respawns the watcher. */
  debounceMs: number;
  target: Target | null;
  child: ChildProcess | null;
  /** Each spawn gets a number so a stale exit event cannot restart the current child. */
  gen: number;
  startedAt: number;
  /** Trailing partial line of the stdout stream. */
  stdoutBuf: string;
  stderrTail: string;
  pending: string[];
  /** Lines were dropped at the cap; logged once per overflow episode. */
  overflowed: boolean;
  debounce: NodeJS.Timeout | null;
  restart: NodeJS.Timeout | null;
  crashes: number;
  /** Torn down on purpose (stop): the child's exit is expected and never restarts it. */
  stopping: boolean;
  state: WatcherState | null;
}

/** Run id of a watcher process: what its launcher stamps on the target, for killLeftovers. */
function watchRunId(taskId: string): string {
  return 'watch-' + taskId;
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export class WatcherPool {
  private readonly entries = new Map<string, Entry>();
  /** Respawns waiting for their stop to finish; a `stop` in between cancels them. */
  private readonly pendingRestart = new Map<string, number>();
  private opSeq = 0;
  private readonly now: () => number;
  /** The system is asleep: children are down and nothing respawns until `resume`. */
  private suspended = false;

  constructor(private readonly d: WatcherPoolDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  /**
   * Bring the task's watcher in line with the task: start one when it is
   * wanted, stop it when it is not, and respawn it when what it was spawned
   * with changed. Called for every task change, so it must be cheap and
   * idempotent for the common case of an unrelated edit.
   */
  sync(task: Task): void {
    const watcher = watcherOf(task);
    const entry = this.entries.get(task.id);
    if (!watcher || !task.enabled || task.completedAt) {
      // Unconditional: it also cancels a respawn that is waiting for its kill.
      void this.stop(task.id);
      return;
    }
    const key = spawnKey(task);
    const debounceMs = Math.max(MIN_DEBOUNCE_MS, Math.round(watcher.debounceSec * 1000));
    if (!entry) {
      this.start(task, key, debounceMs);
      return;
    }
    entry.task = task;
    entry.debounceMs = debounceMs;
    if (entry.key === key) return;
    this.d.log.info(`[${task.id}] watcher configuration changed; restarting it`);
    // The kill is awaited, so the restart is booked against a token: a stop
    // that lands while it is in flight (disabled, paused, removed) cancels it.
    const stopped = this.stop(task.id);
    const token = ++this.opSeq;
    this.pendingRestart.set(task.id, token);
    void stopped.then(() => {
      if (this.pendingRestart.get(task.id) !== token) return;
      this.pendingRestart.delete(task.id);
      this.start(task, key, debounceMs);
    });
  }

  /** The watcher is no longer wanted: kill it, drop what it had collected, forget the entry. */
  async stop(taskId: string): Promise<void> {
    this.pendingRestart.delete(taskId);
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    await this.teardown(entry);
    this.setState(entry, null);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /**
   * The system is suspending. A watcher cannot survive it (its child processes
   * and WSL sessions die with the machine), so every one is killed now and the
   * entry kept: `resume` brings them all back.
   */
  suspend(): void {
    this.suspended = true;
    for (const entry of this.entries.values()) {
      if (entry.restart) clearTimeout(entry.restart);
      entry.restart = null;
      const child = entry.child;
      entry.child = null;
      entry.gen += 1;
      if (child?.pid) void killHostTree(child.pid);
      this.setState(entry, 'restarting');
    }
  }

  /** The system woke up: every watcher starts over, with a clean crash streak. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    for (const entry of this.entries.values()) {
      entry.crashes = 0;
      if (entry.child || entry.stopping) continue;
      this.spawn(entry);
    }
  }

  state(taskId: string): WatcherState | null {
    return this.entries.get(taskId)?.state ?? null;
  }

  // ---------- internals ----------

  private start(task: Task, key: string, debounceMs: number): void {
    if (this.entries.has(task.id)) return;
    const entry: Entry = {
      taskId: task.id,
      task,
      key,
      debounceMs,
      target: null,
      child: null,
      gen: 0,
      startedAt: 0,
      stdoutBuf: '',
      stderrTail: '',
      pending: [],
      overflowed: false,
      debounce: null,
      restart: null,
      crashes: 0,
      stopping: false,
      state: null,
    };
    this.entries.set(task.id, entry);
    // Suspended: the entry exists and waits for the wake, like one between restarts.
    if (this.suspended) this.setState(entry, 'restarting');
    else this.spawn(entry);
  }

  private spawn(entry: Entry): void {
    if (entry.stopping || this.suspended || entry.child) return;
    const task = entry.task;
    const watcher = watcherOf(task);
    if (!watcher) return;
    const gen = ++entry.gen;
    let child: ChildProcess;
    try {
      const watchDir = path.join(this.d.dataDir, 'tasks', task.id, 'watcher');
      ensureDir(watchDir);
      const target = createTarget(task, { host: this.d.host, settings: this.d.settings });
      entry.target = target;
      // Enough of a run context for the launcher: the watcher has no run, so
      // its "run dir" is the task's watcher dir and its run id marks the
      // processes it leaves on the target.
      const ctx: RunContext = {
        task,
        runId: watchRunId(task.id),
        runDir: watchDir,
        target,
        settings: this.d.settings,
        host: this.d.host,
        log: this.d.log,
        vars: {},
      };
      const { spec } = writeLauncher(ctx, 'watcher', watcher.command);
      child = spawn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnv(),
      });
    } catch (e) {
      this.exited(entry, gen, null, `cannot start the watcher: ${errMsg(e)}`);
      return;
    }
    entry.child = child;
    entry.startedAt = this.now();
    entry.stdoutBuf = '';
    entry.stderrTail = '';
    this.d.log.info(`[${entry.taskId}] watcher started (pid ${child.pid ?? '?'})`);
    this.setState(entry, 'watching');
    child.stdout?.on('data', (d: Buffer) => this.onStdout(entry, d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => {
      entry.stderrTail = (entry.stderrTail + d.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // A failed spawn emits 'error' and may or may not emit 'close'; the
    // generation guard makes whichever arrives first the one that counts.
    child.on('error', (e) => this.exited(entry, gen, null, errMsg(e)));
    child.on('close', (code) => this.exited(entry, gen, code));
  }

  /**
   * Split the chunk into lines, keeping the trailing partial for the next one.
   * Every line (re)arms the debounce, so a burst becomes one batch and a
   * steady trickle keeps waiting for the quiet the debounce asks for.
   */
  private onStdout(entry: Entry, chunk: string): void {
    entry.stdoutBuf += chunk;
    const parts = entry.stdoutBuf.split('\n');
    entry.stdoutBuf = parts.pop() ?? '';
    let got = false;
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      entry.pending.push(line);
      got = true;
      if (entry.pending.length > MAX_PENDING) {
        entry.pending.splice(0, entry.pending.length - MAX_PENDING);
        if (!entry.overflowed) {
          entry.overflowed = true;
          this.d.log.warn(
            `[${entry.taskId}] watcher events dropped: more than ${MAX_PENDING} lines are waiting to be delivered`,
          );
        }
      }
    }
    if (!got) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => this.flush(entry), entry.debounceMs);
  }

  private flush(entry: Entry): void {
    entry.debounce = null;
    if (entry.stopping || !entry.pending.length) return;
    const lines = entry.pending;
    entry.pending = [];
    entry.overflowed = false;
    this.safe(entry.taskId, () => this.d.onEvents(entry.taskId, lines));
  }

  /**
   * The watcher process is gone. Deliberate ends (stop, suspend, a respawn
   * that already happened) are not failures; anything else is one, and a
   * streak of them without a healthy stretch in between means the command is
   * broken rather than flaky — the pool stops restarting it and lets the
   * scheduler pause the task.
   */
  private exited(entry: Entry, gen: number, code: number | null, error?: string): void {
    if (gen !== entry.gen || entry.stopping || this.suspended) return;
    entry.child = null;
    const last = error ?? lastLine(entry.stderrTail);
    const detail = last || (code === null ? 'no exit code' : `exit code ${code}`);
    this.d.log.warn(
      `[${entry.taskId}] watcher exited (${code === null ? 'no exit code' : `code ${code}`})${last ? `: ${last}` : ''}`,
    );
    this.setState(entry, 'restarting');
    if (entry.startedAt && this.now() - entry.startedAt >= HEALTHY_MS) entry.crashes = 0;
    entry.crashes += 1;
    if (entry.crashes >= entry.task.backoff.maxConsecutiveErrors) {
      // Last thing done with this entry: the callback pauses the task, which
      // stops (and drops) it right back through `stop`.
      this.safe(entry.taskId, () =>
        this.d.onCrashLoop(entry.taskId, `watcher failed ${entry.crashes} times in a row: ${detail}`),
      );
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (entry.crashes - 1));
    entry.restart = setTimeout(() => {
      entry.restart = null;
      this.spawn(entry);
    }, delay);
  }

  private async teardown(entry: Entry): Promise<void> {
    entry.stopping = true;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.restart) clearTimeout(entry.restart);
    entry.debounce = null;
    entry.restart = null;
    entry.pending = [];
    entry.stdoutBuf = '';
    entry.overflowed = false;
    entry.gen += 1;
    const child = entry.child;
    entry.child = null;
    try {
      if (child?.pid) await killHostTree(child.pid);
      await entry.target?.killLeftovers(watchRunId(entry.taskId));
    } catch (e) {
      this.d.log.warn(`[${entry.taskId}] cannot kill the watcher: ${errMsg(e)}`);
    }
  }

  private setState(entry: Entry, state: WatcherState | null): void {
    if (entry.state === state) return;
    entry.state = state;
    this.safe(entry.taskId, () => this.d.onState(entry.taskId, state));
  }

  /** A listener that throws must not take the pool's bookkeeping down with it. */
  private safe(taskId: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.d.log.error(`[${taskId}] watcher callback failed: ${errMsg(e)}`);
    }
  }
}

/** What the watcher was spawned with; a change respawns it, anything else does not. */
function spawnKey(task: Task): string {
  return JSON.stringify([watcherOf(task)?.command ?? '', task.environmentId, task.cwd, task.env]);
}
