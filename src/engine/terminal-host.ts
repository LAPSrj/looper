import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TerminalIn, TerminalOut } from './terminal-worker';

/** How long close() waits for the worker to flush before terminating it. */
const CLOSE_TIMEOUT_MS = 10_000;

export interface TerminalHostOpts {
  /** Host path of the clean log (output.txt). */
  file: string;
  cols: number;
  rows: number;
  /** Also keep a screen model, so screenContains() can answer. */
  screen: boolean;
  /** Override the worker bundle (tests). */
  workerFile?: string;
  /** Called once if the worker dies. The run continues without terminal emulation. */
  onError?: (err: Error) => void;
}

/**
 * In a packaged app `__dirname` lives inside app.asar, which a Worker cannot
 * load from; electron-builder's asarUnpack puts a real copy next to it.
 */
function defaultWorkerFile(): string {
  const file = path.join(__dirname, 'terminal-worker.js');
  if (file.includes('app.asar.unpacked')) return file;
  return file.includes('app.asar') ? file.replace('app.asar', 'app.asar.unpacked') : file;
}

/**
 * Host-side proxy for the terminal worker: the xterm parsing behind CleanLog
 * and ScreenModel runs off the main thread, so a busy agent never freezes the
 * UI. Every failure mode is soft — a dead worker costs the clean log and
 * prompt detection, never the run.
 */
export class TerminalHost {
  private worker: Worker | null = null;
  private readonly onError?: (err: Error) => void;
  private dead = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private closedResolve: (() => void) | null = null;
  private screenText: string | null = null;

  constructor(opts: TerminalHostOpts) {
    this.onError = opts.onError;
    let worker: Worker;
    try {
      worker = new Worker(opts.workerFile ?? defaultWorkerFile());
    } catch (e) {
      this.fail(e);
      return;
    }
    this.worker = worker;
    worker.on('message', (msg: TerminalOut) => {
      if (msg.type === 'screen') this.screenText = msg.text;
      else if (msg.type === 'closed') this.resolveClosed();
    });
    worker.on('error', (e) => this.fail(e));
    worker.on('exit', (code) => {
      if (this.closing) {
        this.resolveClosed();
      } else {
        this.fail(new Error(`terminal worker exited with code ${code}`));
      }
    });
    this.post({ type: 'init', file: opts.file, cols: opts.cols, rows: opts.rows, screen: opts.screen });
  }

  private fail(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.worker = null;
    this.resolveClosed();
    if (this.dead) return;
    this.dead = true;
    try {
      this.onError?.(err);
    } catch {
      /* a reporting failure must not escalate */
    }
  }

  private resolveClosed(): void {
    const r = this.closedResolve;
    this.closedResolve = null;
    r?.();
  }

  private post(msg: TerminalIn): void {
    if (!this.worker || this.dead || this.closing) return;
    try {
      this.worker.postMessage(msg);
    } catch (e) {
      this.fail(e);
    }
  }

  write(data: string): void {
    this.post({ type: 'write', data });
  }

  resize(cols: number, rows: number): void {
    this.post({ type: 'resize', cols: Math.max(2, cols), rows: Math.max(2, rows) });
  }

  /** Tests the last screen snapshot; false until the first one arrives. */
  screenContains(re: RegExp): boolean {
    return this.screenText !== null && re.test(this.screenText);
  }

  /** First match of `re` in the last screen snapshot; null until one arrives. */
  screenMatch(re: RegExp): RegExpExecArray | null {
    return this.screenText === null ? null : re.exec(this.screenText);
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    const worker = this.worker;
    const closed = new Promise<void>((r) => (this.closedResolve = r));
    const alive = !this.dead;
    this.closing = true;
    if (worker && alive) {
      try {
        worker.postMessage({ type: 'close' } satisfies TerminalIn);
      } catch {
        this.resolveClosed();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((r) => (timer = setTimeout(r, CLOSE_TIMEOUT_MS)));
      await Promise.race([closed, timeout]);
      clearTimeout(timer);
    } else {
      this.resolveClosed();
    }
    this.worker = null;
    try {
      await worker?.terminate();
    } catch {
      /* already gone */
    }
  }
}
