import fs from 'node:fs/promises';

export interface SignalCallbacks {
  onDone: (message: string) => void;
  onIdle: (mtimeMs: number) => void;
  onTick?: (now: number) => void;
}

/**
 * Polls the run's `done` and `idle` marker files. Polling (not fs.watch)
 * because the files are written by another OS through a drvfs/9p mount.
 */
export class FileSignalWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private doneFired = false;
  private lastIdleMtime = 0;

  constructor(
    private readonly doneFile: string,
    private readonly idleFile: string,
    private readonly intervalMs: number,
  ) {}

  start(cb: SignalCallbacks): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(cb), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(cb: SignalCallbacks): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.doneFired) {
        const done = await fs.stat(this.doneFile).catch(() => null);
        if (done) {
          this.doneFired = true;
          const text = await fs.readFile(this.doneFile, 'utf8').catch(() => '');
          cb.onDone(text.trim() || 'done');
          return;
        }
      }
      const idle = await fs.stat(this.idleFile).catch(() => null);
      if (idle && idle.mtimeMs !== this.lastIdleMtime) {
        this.lastIdleMtime = idle.mtimeMs;
        cb.onIdle(idle.mtimeMs);
      }
      cb.onTick?.(Date.now());
    } catch {
      /* never let a poll error kill the loop */
    } finally {
      this.busy = false;
    }
  }
}
