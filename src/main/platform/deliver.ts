import fs from 'node:fs';

export interface SaveDeliveryOptions {
  file: string;
  /** The file must be unchanged this long before it counts as written. */
  quietMs?: number;
  pollMs?: number;
  /** Give up on a file that never shows up after this long. */
  maxAgeMs?: number;
  now?: () => number;
  onReady: () => void;
  onExpire: () => void;
}

export const DELIVERY_QUIET_MS = 500;
export const DELIVERY_MAX_AGE_MS = 60 * 60_000;

/**
 * Waits for a file the main process writes for a device ("Save to This
 * Device"): once it exists and has stayed the same size and mtime for
 * `quietMs`, it's ready. The caller never says when it finished writing, so
 * quiet is the only sign.
 */
export class SaveDelivery {
  private timer: NodeJS.Timeout | null = null;
  private sig = '';
  private changedAt: number;
  private readonly started: number;
  private readonly now: () => number;

  constructor(private readonly o: SaveDeliveryOptions) {
    this.now = o.now ?? Date.now;
    this.started = this.now();
    this.changedAt = this.started;
    this.timer = setInterval(() => this.poll(), o.pollMs ?? 100);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    const now = this.now();
    let sig = '';
    try {
      const st = fs.statSync(this.o.file);
      if (st.isFile()) sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      /* not there yet */
    }
    if (sig !== this.sig) {
      this.sig = sig;
      this.changedAt = now;
    } else if (sig && now - this.changedAt >= (this.o.quietMs ?? DELIVERY_QUIET_MS)) {
      this.stop();
      this.o.onReady();
      return;
    }
    if (now - this.started >= (this.o.maxAgeMs ?? DELIVERY_MAX_AGE_MS)) {
      this.stop();
      this.o.onExpire();
    }
  }
}
