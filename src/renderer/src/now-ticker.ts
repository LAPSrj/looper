/** The logic behind `useNow`, free of React and the DOM so it can be tested with fake timers. */

export const SECOND = 1000;
export const MINUTE = 60_000;

/** The wait until the next multiple of `intervalMs` on the clock, so minute text changes with the minute. */
export function nextDelay(now: number, intervalMs: number): number {
  return intervalMs - (now % intervalMs);
}

/**
 * How often a time `ms` away from now (ahead or behind) must refresh: `formatDuration`
 * shows seconds below an hour and only minutes above it.
 */
export function tickFor(ms: number): number {
  return Math.abs(ms) < 3_600_000 ? SECOND : MINUTE;
}

export interface TickerEnv {
  now: () => number;
  /** False while the page is hidden: nothing is drawn, so a tick would only cost. */
  visible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

type Listener = (now: number) => void;

interface Channel {
  listeners: Set<Listener>;
  timer: unknown;
}

/**
 * One timer per interval, shared by every listener of that interval and running
 * only while it has any. A tick is skipped while the page is hidden; `resume`
 * (on becoming visible again) gives the listeners the time at once.
 */
export function createTickers(env: TickerEnv) {
  const channels = new Map<number, Channel>();

  const arm = (intervalMs: number, ch: Channel) => {
    ch.timer = env.setTimer(() => {
      if (env.visible()) {
        const now = env.now();
        for (const listener of [...ch.listeners]) listener(now);
      }
      arm(intervalMs, ch);
    }, nextDelay(env.now(), intervalMs));
  };

  return {
    subscribe(intervalMs: number, listener: Listener): () => void {
      let ch = channels.get(intervalMs);
      if (!ch) {
        ch = { listeners: new Set(), timer: undefined };
        channels.set(intervalMs, ch);
        arm(intervalMs, ch);
      }
      const mine = ch;
      mine.listeners.add(listener);
      return () => {
        mine.listeners.delete(listener);
        if (mine.listeners.size === 0 && channels.get(intervalMs) === mine) {
          env.clearTimer(mine.timer);
          channels.delete(intervalMs);
        }
      };
    },
    resume(): void {
      if (!env.visible()) return;
      const now = env.now();
      for (const ch of channels.values()) for (const listener of [...ch.listeners]) listener(now);
    },
    /** How many intervals have a timer running. */
    active: () => channels.size,
  };
}
