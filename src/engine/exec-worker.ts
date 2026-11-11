import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { SpawnOptions, StdioOptions } from 'node:child_process';

/** What execFile's callback got, made cloneable. */
export interface ExecResult {
  error: { code?: number | string; killed?: boolean; message: string } | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
  /** How the output is decoded: wsl.exe's own listings are UTF-16. */
  encoding?: 'utf8' | 'utf16le';
}

type ErrInfo = { message: string; code?: string | number; errno?: number; syscall?: string; path?: string };

type ToWorker =
  | { op: 'exec'; id: number; file: string; args: string[]; options: ExecOptions }
  | { op: 'spawn'; id: number; command: string; args: string[]; options: SpawnOptions }
  | { op: 'write'; id: number; data: Uint8Array }
  | { op: 'end'; id: number }
  | { op: 'kill'; id: number; signal?: NodeJS.Signals | number }
  | { op: 'pty'; id: number; module: string; file: string; args: string[]; options: PtyOptions }
  | { op: 'pty-write'; id: number; data: string }
  | { op: 'pty-resize'; id: number; cols: number; rows: number }
  | { op: 'pty-kill'; id: number };

type FromWorker =
  | { id: number; result: ExecResult }
  | { id: number; ev: 'spawn'; pid: number }
  | { id: number; ev: 'out' | 'err'; data: Uint8Array | string }
  | { id: number; ev: 'error' | 'stdin-error'; error: ErrInfo }
  | { id: number; ev: 'exit' | 'close'; code: number | null; signal: NodeJS.Signals | null };
type ChildEvent = Exclude<FromWorker, { result: ExecResult }>;

/** node-pty's spawn options that Looper uses. */
export interface PtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

// Plain JavaScript run with `eval`, so it needs no bundle entry of its own.
const SOURCE = `
const { parentPort } = require('node:worker_threads');
const { execFile, spawn } = require('node:child_process');
const children = new Map();
const ptys = new Map();
const ptyModules = new Map();
const info = (e) => ({ message: String(e && e.message), code: e && e.code, errno: e && e.errno, syscall: e && e.syscall, path: e && e.path });
parentPort.on('message', (m) => {
  if (m.op === 'exec') {
    const enc = m.options.encoding || 'utf8';
    try {
      execFile(m.file, m.args, { ...m.options, encoding: 'buffer' }, (err, stdout, stderr) => {
        const error = err ? { code: err.code, killed: err.killed, message: err.message } : null;
        const text = (b) => (Buffer.isBuffer(b) ? b.toString(enc) : String(b ?? ''));
        parentPort.postMessage({ id: m.id, result: { error, stdout: text(stdout), stderr: text(stderr) } });
      });
    } catch (err) {
      parentPort.postMessage({ id: m.id, result: { error: { code: err.code, message: String(err.message) }, stdout: '', stderr: '' } });
    }
    return;
  }
  if (m.op === 'spawn') {
    let c;
    try {
      c = spawn(m.command, m.args, m.options);
    } catch (err) {
      parentPort.postMessage({ id: m.id, ev: 'error', error: info(err) });
      parentPort.postMessage({ id: m.id, ev: 'close', code: null, signal: null });
      return;
    }
    children.set(m.id, c);
    c.on('spawn', () => parentPort.postMessage({ id: m.id, ev: 'spawn', pid: c.pid }));
    c.on('error', (err) => parentPort.postMessage({ id: m.id, ev: 'error', error: info(err) }));
    c.on('exit', (code, signal) => parentPort.postMessage({ id: m.id, ev: 'exit', code, signal }));
    c.on('close', (code, signal) => {
      children.delete(m.id);
      parentPort.postMessage({ id: m.id, ev: 'close', code, signal });
    });
    c.stdout?.on('data', (data) => parentPort.postMessage({ id: m.id, ev: 'out', data }));
    c.stderr?.on('data', (data) => parentPort.postMessage({ id: m.id, ev: 'err', data }));
    c.stdin?.on('error', (err) => parentPort.postMessage({ id: m.id, ev: 'stdin-error', error: info(err) }));
    return;
  }
  if (m.op === 'pty') {
    let p;
    try {
      if (!ptyModules.has(m.module)) ptyModules.set(m.module, require(m.module));
      p = ptyModules.get(m.module).spawn(m.file, m.args, m.options);
    } catch (err) {
      parentPort.postMessage({ id: m.id, ev: 'error', error: info(err) });
      parentPort.postMessage({ id: m.id, ev: 'close', code: null, signal: null });
      return;
    }
    ptys.set(m.id, p);
    // On Windows the pid is known only once the console has connected, before its first output.
    let announced = false;
    const announce = () => {
      if (announced || !(p.pid > 0)) return;
      announced = true;
      parentPort.postMessage({ id: m.id, ev: 'spawn', pid: p.pid });
    };
    announce();
    p.onData((data) => {
      announce();
      parentPort.postMessage({ id: m.id, ev: 'out', data });
    });
    p.onExit(({ exitCode }) => {
      announce();
      ptys.delete(m.id);
      parentPort.postMessage({ id: m.id, ev: 'exit', code: exitCode, signal: null });
      parentPort.postMessage({ id: m.id, ev: 'close', code: exitCode, signal: null });
    });
    return;
  }
  if (m.op.startsWith('pty-')) {
    const p = ptys.get(m.id);
    try {
      if (!p) return;
      if (m.op === 'pty-write') p.write(m.data);
      else if (m.op === 'pty-resize') p.resize(m.cols, m.rows);
      else p.kill();
    } catch {
      // A pty that has just exited can't be resized or killed.
    }
    return;
  }
  const c = children.get(m.id);
  if (!c) return;
  if (m.op === 'write') c.stdin?.write(m.data);
  else if (m.op === 'end') c.stdin?.end();
  else if (m.op === 'kill') c.kill(m.signal);
});
`;

/** A worker with nothing to run for this long ends, giving its memory back. */
const IDLE_MS = 30_000;

let worker: Worker | null = null;
let idle: NodeJS.Timeout | null = null;
let nextId = 0;
const waiting = new Map<number, (r: ExecResult) => void>();
const children = new Map<number, { receive(m: ChildEvent): void; readonly holds: boolean }>();

function toErr(e: ErrInfo): NodeJS.ErrnoException {
  return Object.assign(new Error(e.message), {
    ...(e.code !== undefined ? { code: String(e.code) } : {}),
    ...(e.errno !== undefined ? { errno: e.errno } : {}),
    ...(e.syscall ? { syscall: e.syscall } : {}),
    ...(e.path ? { path: e.path } : {}),
  });
}

function failAll(message: string): void {
  for (const resolve of waiting.values()) resolve({ error: { message }, stdout: '', stderr: '' });
  waiting.clear();
  for (const c of [...children.values()]) {
    c.receive({ id: -1, ev: 'error', error: { message } });
    c.receive({ id: -1, ev: 'close', code: null, signal: null });
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(SOURCE, { eval: true });
  w.on('message', (m: FromWorker) => {
    if ('result' in m) {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    } else children.get(m.id)?.receive(m);
    settle();
  });
  w.on('error', (err) => {
    if (worker === w) worker = null;
    failAll(err.message);
  });
  w.on('exit', () => {
    if (worker === w) worker = null;
    failAll('The process worker stopped.');
  });
  worker = w;
  return w;
}

/** Keep the Node process alive only for what someone waits on (a CLI command doesn't stay for the rest), and end the worker once nothing runs. */
function settle(): void {
  if (!worker) return;
  if (waiting.size > 0 || [...children.values()].some((c) => c.holds)) worker.ref();
  else worker.unref();
  if (waiting.size > 0 || children.size > 0) {
    if (idle) clearTimeout(idle);
    idle = null;
    return;
  }
  if (idle) return;
  idle = setTimeout(() => {
    idle = null;
    if (waiting.size > 0 || children.size > 0 || !worker) return;
    const w = worker;
    worker = null;
    void w.terminate();
  }, IDLE_MS);
  idle.unref();
}

function post(m: ToWorker): void {
  getWorker().postMessage(m);
}

/**
 * execFile on a worker thread. Starting a process holds the thread that starts it (35-60 ms for a
 * wsl.exe on Windows, over 500 ms on a busy machine), and the main process's thread takes every
 * window's input.
 */
export function execOffThread(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    post({ op: 'exec', id, file, args, options });
    settle();
  });
}

type ChildEvents = {
  spawn: [];
  error: [NodeJS.ErrnoException];
  exit: [number | null, NodeJS.Signals | null];
  close: [number | null, NodeJS.Signals | null];
};

function piped(stdio: StdioOptions | undefined): [boolean, boolean, boolean] {
  if (stdio === undefined || stdio === 'pipe' || stdio === 'overlapped') return [true, true, true];
  if (typeof stdio === 'string') return [false, false, false];
  return [0, 1, 2].map((i) => stdio[i] === undefined || stdio[i] === null || stdio[i] === 'pipe' || stdio[i] === 'overlapped') as [boolean, boolean, boolean];
}

/**
 * A process started on the worker thread, with the parts of a ChildProcess Looper uses: its streams, `kill`, and
 * its spawn, error, exit and close events. Its `pid` comes once it has started; code that kills it by pid awaits
 * `spawned`.
 */
export class OffThreadChild extends EventEmitter<ChildEvents> {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** The pid once it has started, or undefined when it couldn't start. */
  readonly spawned: Promise<number | undefined>;
  /** Whether it keeps the Node process alive, as a ChildProcess does until `unref`. */
  holds = true;
  private done = false;
  private settleSpawned!: (pid: number | undefined) => void;

  constructor(
    private readonly id: number,
    stdio: StdioOptions | undefined,
  ) {
    super();
    this.spawned = new Promise((r) => (this.settleSpawned = r));
    const [i, o, e] = piped(stdio);
    this.stdin = i
      ? new Writable({
          write: (chunk: Buffer, _enc, cb) => {
            if (!this.done) post({ op: 'write', id: this.id, data: chunk });
            cb();
          },
          final: (cb) => {
            if (!this.done) post({ op: 'end', id: this.id });
            cb();
          },
        })
      : null;
    this.stdout = o ? new Readable({ read() {} }) : null;
    this.stderr = e ? new Readable({ read() {} }) : null;
  }

  /** @internal What the worker reported about this process. */
  receive(m: ChildEvent): void {
    switch (m.ev) {
      case 'spawn':
        this.pid = m.pid;
        this.settleSpawned(m.pid);
        this.emit('spawn');
        break;
      case 'out':
        if (typeof m.data !== 'string') this.stdout?.push(Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength));
        break;
      case 'err':
        if (typeof m.data !== 'string') this.stderr?.push(Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength));
        break;
      case 'stdin-error':
        this.stdin?.destroy(toErr(m.error));
        break;
      case 'error':
        this.settleSpawned(this.pid);
        this.emit('error', toErr(m.error));
        break;
      case 'exit':
        this.exitCode = m.code;
        this.signalCode = m.signal;
        this.emit('exit', m.code, m.signal);
        break;
      case 'close':
        this.done = true;
        children.delete(this.id);
        this.settleSpawned(this.pid);
        this.stdout?.push(null);
        this.stderr?.push(null);
        // After the streams' own end, as a ChildProcess's close follows its streams' close.
        setImmediate(() => this.emit('close', m.code, m.signal));
        break;
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.done) return false;
    this.killed = true;
    post({ op: 'kill', id: this.id, signal });
    return true;
  }

  ref(): void {
    this.holds = true;
    settle();
  }

  unref(): void {
    this.holds = false;
    settle();
  }
}

/** child_process.spawn on the worker thread, for the same reason as execOffThread. */
export function spawnOffThread(command: string, args: string[], options: SpawnOptions = {}): OffThreadChild {
  const id = nextId++;
  const child = new OffThreadChild(id, options.stdio);
  children.set(id, child);
  post({ op: 'spawn', id, command, args, options });
  settle();
  return child;
}

/**
 * A pseudo-terminal (node-pty) started on the worker thread, for the same reason as spawnOffThread: creating a
 * console and its process held the main thread 700 ms when many processes were starting. `modulePath` is
 * node-pty's, outside app.asar; a start that fails reaches `onError`, then the exit.
 */
export class OffThreadPty {
  /** 0 until it has started. */
  pid = 0;
  /** The pid once it has started, 0 when it couldn't start. */
  readonly spawned: Promise<number>;
  readonly holds = true;
  private done = false;
  private settleSpawned!: (pid: number) => void;
  private readonly dataCbs: ((data: string) => void)[] = [];
  private readonly exitCbs: ((code: number | null) => void)[] = [];

  constructor(
    private readonly id: number,
    private readonly onError: (err: Error) => void,
  ) {
    this.spawned = new Promise((r) => (this.settleSpawned = r));
  }

  /** @internal */
  receive(m: ChildEvent): void {
    switch (m.ev) {
      case 'spawn':
        this.pid = m.pid;
        this.settleSpawned(m.pid);
        break;
      case 'out':
        if (typeof m.data === 'string') for (const cb of this.dataCbs) cb(m.data);
        break;
      case 'error':
        this.settleSpawned(0);
        this.onError(toErr(m.error));
        break;
      case 'close':
        this.done = true;
        children.delete(this.id);
        this.settleSpawned(this.pid);
        for (const cb of this.exitCbs) cb(m.code);
        break;
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  write(data: string): void {
    if (!this.done) post({ op: 'pty-write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    if (!this.done) post({ op: 'pty-resize', id: this.id, cols, rows });
  }

  kill(): void {
    if (!this.done) post({ op: 'pty-kill', id: this.id });
  }
}

export function spawnPtyOffThread(modulePath: string, file: string, args: string[], options: PtyOptions, onError: (err: Error) => void): OffThreadPty {
  const id = nextId++;
  const pty = new OffThreadPty(id, onError);
  children.set(id, pty);
  post({ op: 'pty', id, module: modulePath, file, args, options });
  settle();
  return pty;
}
