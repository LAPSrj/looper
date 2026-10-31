import type { PreventSleepState, PreventSleepTimer, Settings } from '../shared/types';
import type { Logger } from './log';

export interface PreventSleepDeps {
  settings: Settings;
  /** A chat, terminal or task agent is working. */
  working: () => boolean;
  /** Hold (true) or release (false) the app's sleep blocker; idempotent. */
  keepAwake: (on: boolean) => void;
  emit: (state: PreventSleepState) => void;
  log: Logger;
  now?: () => number;
}

/**
 * Prevent Sleep: keep the computer awake for a while or until turned off, and
 * (While a Session Is Working, a setting) while a chat, terminal or task agent
 * works. The timer is runtime state: it lasts for this run of Looper.
 */
export class PreventSleep {
  private timer: PreventSleepTimer = 'off';
  private until: number | null = null;
  private expiry: NodeJS.Timeout | null = null;
  private active = false;
  private lastSent = '';
  private readonly now: () => number;

  constructor(private readonly d: PreventSleepDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  state(): PreventSleepState {
    return { timer: this.timer, until: this.until, active: this.active };
  }

  /** Start the timer for its minutes or until turned off, or turn it off. */
  set(timer: PreventSleepTimer): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.timer = timer;
    this.until = typeof timer === 'number' ? this.now() + timer * 60_000 : null;
    if (typeof timer === 'number') this.expiry = setTimeout(() => this.set('off'), timer * 60_000);
    this.d.log.info(
      timer === 'off' ? 'prevent sleep: timer off' : `prevent sleep: on ${timer === 'until-off' ? 'until turned off' : `for ${timer} min`}`,
    );
    this.poke();
  }

  /** Re-evaluate: a run, a session or the setting changed. */
  poke(): void {
    const active = this.timer !== 'off' || (this.d.settings.preventSleepWhileWorking && this.d.working());
    if (active !== this.active) {
      this.active = active;
      this.d.keepAwake(active);
    }
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.d.emit(state);
  }

  dispose(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    if (this.active) this.d.keepAwake(false);
    this.active = false;
  }
}
