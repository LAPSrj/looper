import fs from 'node:fs/promises';

export interface SignalCallbacks {
  /** The `done` file appeared: its trimmed text (the headline) and its mtime. */
  onDone: (message: string, mtimeMs: number) => void;
  /** The claude Stop hook wrote its payload, i.e. a turn ended. Fires once per write. */
  onStop: (mtimeMs: number, payload: Record<string, unknown>) => void;
  onTick?: (now: number) => void;
}

/**
 * Polls the run's `done` and `stop.json` signal files. Polling (not fs.watch)
 * because the files are written by another OS through a drvfs/9p mount.
 */
export class FileSignalWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private doneFired = false;
  /** mtime:size of the done file at the last poll; it is read once two polls agree. */
  private doneSeen: string | null = null;
  private lastStopMtime = 0;

  constructor(
    private readonly doneFile: string,
    private readonly stopFile: string,
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
        // The done command writes with a plain redirect (cmd in two steps), so
        // the file is read once it looks the same on two polls in a row:
        // read mid-write, its status and headline would be lost.
        const seen = done ? `${done.mtimeMs}:${done.size}` : null;
        if (done && seen === this.doneSeen) {
          this.doneFired = true;
          const text = await fs.readFile(this.doneFile, 'utf8').catch(() => '');
          cb.onDone(text.trim() || 'done', done.mtimeMs);
        }
        this.doneSeen = seen;
      }
      const stop = await fs.stat(this.stopFile).catch(() => null);
      if (stop && stop.mtimeMs !== this.lastStopMtime) {
        // The hook may still be writing: an empty or truncated file is retried on the next poll.
        const text = await fs.readFile(this.stopFile, 'utf8').catch(() => '');
        // A write that landed between the stat and the read would be reported
        // again under its own mtime: only content read at an unchanged mtime counts.
        const after = await fs.stat(this.stopFile).catch(() => null);
        const payload = after?.mtimeMs === stop.mtimeMs ? parseJsonObject(text) : null;
        if (payload) {
          this.lastStopMtime = stop.mtimeMs;
          cb.onStop(stop.mtimeMs, payload);
        }
      }
      cb.onTick?.(Date.now());
    } catch {
      /* never let a poll error kill the loop */
    } finally {
      this.busy = false;
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
