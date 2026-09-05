import type { RestState, Settings, TaskRuntime } from '../shared/types';
import { errMsg, type Logger } from './log';

/**
 * Electron power hooks, injected by the app host so the engine (which also
 * runs headless) never imports Electron. The blocker is
 * `powerSaveBlocker.start('prevent-app-suspension')`: while armed, Looper owns
 * the sleep policy — Windows' own idle sleep can't kill the schedule, and the
 * blocker is released only to suspend deliberately. Start/stop are idempotent.
 */
export interface PowerAdapter {
  startBlocker(): void;
  stopBlocker(): void;
  onSuspend(cb: () => void): void;
  onResume(cb: () => void): void;
  isOnBattery(): boolean;
}

/** OS power commands (see power-win.ts); injected so tests run without an OS. */
export interface PowerOps {
  suspend(): Promise<void>;
  /** Register/retarget the wake task; resolves only once WakeToRun is verified. */
  registerWake(atMs: number): Promise<void>;
  clearWake(): Promise<void>;
}

export interface RestDeps {
  settings: Settings;
  runtimes: () => TaskRuntime[];
  adapter: PowerAdapter;
  ops: PowerOps;
  log: Logger;
  emit: (state: RestState, disarmReason?: 'user-wake') => void;
  now?: () => number;
}

const EVAL_MS = 5000;
/** A resume this close to the planned wake time counts as the wake timer firing. */
const WAKE_WINDOW_BEFORE_MS = 120_000;
const WAKE_WINDOW_AFTER_MS = 180_000;

/** A held agent is a parked session waiting for a human: it does not keep the computer awake. */
function isBusy(rt: TaskRuntime): boolean {
  if (rt.state === 'checking' || rt.state === 'classifying') return true;
  return rt.state === 'running' && !rt.held;
}

/**
 * Rest Mode: while armed, put the computer to sleep whenever every task is
 * quiet for the grace period, with a Task Scheduler wake timer set for the
 * next scheduled run — no earlier than the minimum sleep, counted from sleep
 * onset. Cron slots that pass while asleep are simply skipped; the overdue
 * task fires once on the first tick after the resume, which is the existing
 * scheduler behavior. Arming is runtime state, never persisted: a computer
 * that restarts overnight must not go back to sleep on the user at login.
 */
export class RestController {
  private phase: RestState['phase'] = 'off';
  private sleepAt: number | null = null;
  private wakeAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Set between the sleep decision and the resume, so pokes can't double-fire. */
  private suspending = false;
  private readonly now: () => number;

  constructor(private readonly d: RestDeps) {
    this.now = d.now ?? (() => Date.now());
    d.adapter.onSuspend(() => this.onSuspend());
    d.adapter.onResume(() => this.onResume());
  }

  /** Startup hygiene: a wake task left behind by a previous run is stale. */
  init(): void {
    void this.d.ops.clearWake().catch(() => undefined);
  }

  dispose(): void {
    if (this.phase !== 'off') this.doDisarm('looper shutting down');
  }

  state(): RestState {
    return { armed: this.phase !== 'off', phase: this.phase, sleepAt: this.sleepAt, wakeAt: this.wakeAt };
  }

  arm(): void {
    if (this.phase !== 'off') return;
    this.d.adapter.startBlocker();
    this.phase = 'waiting';
    this.timer = setInterval(() => this.poke(), EVAL_MS);
    this.d.log.info('rest mode armed');
    this.emit();
    this.poke();
  }

  disarm(reason = 'turned off by user'): void {
    this.doDisarm(reason);
  }

  /** Re-evaluate; called on every runtime event and on a coarse timer. */
  poke(): void {
    if (this.phase === 'off' || this.phase === 'sleeping' || this.suspending) return;
    if (this.d.runtimes().some(isBusy)) {
      if (this.phase !== 'waiting') {
        this.phase = 'waiting';
        this.sleepAt = null;
        this.emit();
      }
      return;
    }
    if (this.phase === 'waiting') {
      this.sleepAt = this.now() + this.d.settings.rest.graceSec * 1000;
      this.phase = 'countdown';
      this.emit();
    } else if (this.phase === 'countdown' && this.sleepAt !== null && this.now() >= this.sleepAt) {
      void this.sleep();
    }
  }

  private async sleep(): Promise<void> {
    this.suspending = true;
    const now = this.now();
    let earliest: number | null = null;
    for (const rt of this.d.runtimes()) {
      if (rt.nextRunAt !== null && (earliest === null || rt.nextRunAt < earliest)) earliest = rt.nextRunAt;
    }
    // Nothing scheduled at all: sleep with no wake registered.
    const wakeAt = earliest === null ? null : Math.max(earliest, now + this.d.settings.rest.minSleepMin * 60_000);
    try {
      if (wakeAt !== null) await this.d.ops.registerWake(wakeAt);
      else await this.d.ops.clearWake().catch(() => undefined);
    } catch (e) {
      // An unverified wake would strand the machine asleep: stay awake, retry
      // after another grace period.
      this.d.log.error(`rest: wake registration failed, staying awake: ${errMsg(e)}`);
      this.sleepAt = this.now() + this.d.settings.rest.graceSec * 1000;
      this.suspending = false;
      this.emit();
      return;
    }
    // A run may have started while the registration was in flight.
    if (this.d.runtimes().some(isBusy)) {
      void this.d.ops.clearWake().catch(() => undefined);
      this.phase = 'waiting';
      this.sleepAt = null;
      this.suspending = false;
      this.emit();
      return;
    }
    this.wakeAt = wakeAt;
    this.sleepAt = null;
    this.phase = 'sleeping';
    this.d.log.info(
      wakeAt !== null
        ? `rest: sleeping, wake at ${new Date(wakeAt).toISOString()}`
        : 'rest: sleeping with no wake (nothing scheduled)',
    );
    this.emit();
    this.d.adapter.stopBlocker();
    try {
      await this.d.ops.suspend();
    } catch (e) {
      this.d.log.error(`rest: suspend failed: ${errMsg(e)}`);
      this.d.adapter.startBlocker();
      void this.d.ops.clearWake().catch(() => undefined);
      this.wakeAt = null;
      this.phase = 'waiting';
      this.suspending = false;
      this.emit();
    }
  }

  /** The system is suspending outside our own sleep path (user, power button, lid). */
  private onSuspend(): void {
    if (this.phase === 'off' || this.phase === 'sleeping') return;
    this.phase = 'sleeping';
    this.sleepAt = null;
    this.wakeAt = null;
    this.emit();
  }

  private onResume(): void {
    if (this.phase === 'off') return;
    // Re-acquire the blocker immediately: after a timer wake Windows re-sleeps
    // on the short "unattended idle timeout" unless an app blocks it.
    this.d.adapter.startBlocker();
    this.suspending = false;
    if (this.phase !== 'sleeping') return;
    const now = this.now();
    const ourWake =
      this.wakeAt !== null && now >= this.wakeAt - WAKE_WINDOW_BEFORE_MS && now <= this.wakeAt + WAKE_WINDOW_AFTER_MS;
    this.wakeAt = null;
    void this.d.ops.clearWake().catch(() => undefined);
    if (!ourWake && this.d.settings.rest.disarmOnUserWake) {
      this.doDisarm('computer woken manually', 'user-wake');
      return;
    }
    this.d.log.info(ourWake ? 'rest: woken by the wake timer' : 'rest: woken externally; staying armed');
    this.phase = 'waiting';
    this.sleepAt = null;
    this.emit();
    this.poke();
  }

  private doDisarm(reason: string, disarmReason?: 'user-wake'): void {
    if (this.phase === 'off') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.phase = 'off';
    this.sleepAt = null;
    this.wakeAt = null;
    this.suspending = false;
    void this.d.ops.clearWake().catch(() => undefined);
    this.d.adapter.stopBlocker();
    this.d.log.info(`rest mode disarmed: ${reason}`);
    this.emit(disarmReason);
  }

  private emit(disarmReason?: 'user-wake'): void {
    this.d.emit(this.state(), disarmReason);
  }
}
