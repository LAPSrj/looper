import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { TerminalIn, TerminalOut } from './terminal-worker';

/** How long close() waits for the worker to flush before giving up on it. */
const CLOSE_TIMEOUT_MS = 10_000;

export interface TerminalHostOpts {
  /** Host path of the clean log (output.txt). */
  file: string;
  cols: number;
  rows: number;
  /** Also keep a screen model, so screenContains() can answer. */
  screen: boolean;
  /** Write after what the clean log already holds instead of starting it over. */
  append?: boolean;
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
 * One worker for every terminal: each Worker is a V8 of its own, about 8.5 MB and 100 ms to start, and a
 * terminal's emulation is light enough to share one. It starts with the first terminal and ends with the last.
 */
interface SharedWorker {
  worker: Worker;
  hosts: Map<number, TerminalHost>;
}
const workers = new Map<string, SharedWorker>();
let nextId = 0;

function sharedWorker(file: string): SharedWorker {
  const open = workers.get(file);
  if (open) return open;
  const s: SharedWorker = { worker: new Worker(file), hosts: new Map() };
  workers.set(file, s);
  const gone = (err: Error) => {
    if (workers.get(file) === s) workers.delete(file);
    for (const h of [...s.hosts.values()]) h.workerGone(err);
    s.hosts.clear();
  };
  s.worker.on('message', (msg: TerminalOut) => s.hosts.get(msg.id)?.receive(msg));
  s.worker.on('error', (e) => gone(e));
  s.worker.on('exit', (code) => gone(new Error(`terminal worker exited with code ${code}`)));
  return s;
}

/**
 * Host-side proxy for the terminal worker: the xterm parsing behind CleanLog
 * and ScreenModel runs off the main thread, so a busy agent never freezes the
 * UI. Every failure mode is soft — a dead worker costs the clean log and
 * prompt detection, never the run.
 */
export class TerminalHost {
  private readonly id = ++nextId;
  private shared: SharedWorker | null = null;
  private readonly file: string;
  private readonly onError?: (err: Error) => void;
  private dead = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private closedResolve: (() => void) | null = null;
  private screenText: string | null = null;

  constructor(opts: TerminalHostOpts) {
    this.onError = opts.onError;
    this.file = opts.workerFile ?? defaultWorkerFile();
    try {
      this.shared = sharedWorker(this.file);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.shared.hosts.set(this.id, this);
    this.post({ type: 'init', id: this.id, file: opts.file, cols: opts.cols, rows: opts.rows, screen: opts.screen, append: opts.append });
  }

  /** A message from the worker for this terminal. */
  receive(msg: TerminalOut): void {
    if (msg.type === 'screen') this.screenText = msg.text;
    else if (msg.type === 'closed') this.resolveClosed();
    else if (msg.type === 'failed') this.fail(new Error(msg.message));
  }

  /** The worker died or exited: a terminal being closed is done, any other has failed. */
  workerGone(err: Error): void {
    this.shared = null;
    if (this.closing) this.resolveClosed();
    else this.fail(err);
  }

  private fail(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.detach();
    this.resolveClosed();
    if (this.dead) return;
    this.dead = true;
    try {
      this.onError?.(err);
    } catch {
      /* a reporting failure must not escalate */
    }
  }

  /** Off the shared worker; the last terminal to leave ends it. */
  private detach(): void {
    const s = this.shared;
    this.shared = null;
    if (!s || !s.hosts.delete(this.id) || s.hosts.size > 0) return;
    if (workers.get(this.file) === s) workers.delete(this.file);
    s.worker.removeAllListeners('exit');
    void s.worker.terminate().catch(() => undefined);
  }

  private resolveClosed(): void {
    const r = this.closedResolve;
    this.closedResolve = null;
    r?.();
  }

  private post(msg: TerminalIn): void {
    if (!this.shared || this.dead || this.closing) return;
    try {
      this.shared.worker.postMessage(msg);
    } catch (e) {
      this.fail(e);
    }
  }

  write(data: string): void {
    this.post({ type: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.post({ type: 'resize', id: this.id, cols: Math.max(2, cols), rows: Math.max(2, rows) });
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
    const s = this.shared;
    const closed = new Promise<void>((r) => (this.closedResolve = r));
    this.closing = true;
    if (s && !this.dead) {
      try {
        s.worker.postMessage({ type: 'close', id: this.id } satisfies TerminalIn);
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
    this.detach();
  }
}
