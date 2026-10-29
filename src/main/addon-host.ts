import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { HostKind } from '../engine/host';
import { errMsg, type Logger } from '../engine/log';
import { childEnv, stripShellNoise } from '../engine/steps/common';
import { killHostTree } from '../engine/target/kill';
import {
  ADDON_EXT,
  AddonEventResultSchema,
  AddonPaneContentSchema,
  AddonScreenSchema,
  environmentsFor,
  readAddonManifest,
  runCommand,
  sideName,
  zodSummary,
  type AddonEvent,
  type AddonEventResult,
  type AddonInfo,
  type AddonLocalRun,
  type AddonManifest,
  type AddonPaneContent,
  type AddonRun,
  type AddonScreen,
  type AddonStatus,
} from '../shared/addons';
import { tokenize } from '../shared/cmdline';
import { DEFAULT_SHELL } from '../shared/environments';
import type { Environment } from '../shared/types';

const REQUEST_TIMEOUT_MS = 30_000;
/** After stdin closes, how long an addon gets to exit before it is killed. */
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL = 4096;
/** Requests at least this slow get an engine log line; faster ones log only when they fail. */
export const SLOW_REQUEST_MS = 250;
/** Stderr lines per minute an addon may write to the engine log. */
export const STDERR_LINES_PER_MIN = 60;

export interface SpawnLine {
  command: string;
  args: string[];
  cwd?: string;
}

export interface AddonLaunch {
  /** The command, working folder and variables: the user's when they changed them, the manifest's otherwise. */
  run: AddonRun;
  /** The environment that runs it: the user's choice, else the default environment, else the first that fits. Unset when none fits. */
  environment?: Environment;
  defaultEnvironment?: Environment;
}

/** How the addon runs for this user, from its manifest, the user's changes and their environments. */
export function addonLaunch(
  own: AddonRun,
  local: AddonLocalRun | undefined,
  settings: { environments: Environment[]; defaultEnvironmentId: string },
  host: HostKind,
): AddonLaunch {
  const fits = environmentsFor(own.on, settings.environments, host);
  const defaultEnvironment = fits.find((e) => e.id === settings.defaultEnvironmentId) ?? fits[0];
  const chosen = local && fits.find((e) => e.id === local.environmentId);
  const run: AddonRun = local
    ? { on: own.on, command: local.command, ...(local.cwd ? { cwd: local.cwd } : {}), ...(local.env ? { env: local.env } : {}) }
    : own;
  return { run, environment: chosen ?? defaultEnvironment, defaultEnvironment };
}

/**
 * The process to start for an addon in its environment. A WSL command goes
 * through the environment's shell (by default an interactive login bash, as
 * tasks do, so PATH has what ~/.bashrc adds: nvm, bun); `exec "$@"` then
 * replaces the shell with the command, unquoted args and all. A Windows
 * command starts directly.
 */
export function addonSpawnLine(run: AddonRun, host: HostKind, environment: Environment): SpawnLine {
  if (!environmentsFor(run.on, [environment], host).length) {
    throw new Error(`the "${environment.name}" environment can't run ${sideName(run.on)} programs`);
  }
  if (run.on === 'windows') {
    // From WSL, interop starts the .exe; a Windows cwd means nothing on this side.
    return { command: run.command[0], args: run.command.slice(1), ...(host === 'windows' && run.cwd ? { cwd: run.cwd } : {}) };
  }
  const shell = tokenize(environment.shell ?? DEFAULT_SHELL);
  const inner = [...(shell.ok && shell.tokens.length ? shell.tokens : ['bash', '-lic']), 'exec "$@"', 'looper-addon', ...run.command];
  if (host === 'windows') {
    return {
      command: 'wsl.exe',
      args: [...(environment.distro ? ['-d', environment.distro] : []), ...(run.cwd ? ['--cd', run.cwd] : []), '-e', ...inner],
    };
  }
  return { command: inner[0], args: inner.slice(1), ...(run.cwd ? { cwd: run.cwd } : {}) };
}

/**
 * The addon's environment: Looper's, plus the manifest's `env`. A command
 * that crosses between Windows and WSL only gets the variables WSLENV names,
 * so the manifest's are added to it.
 */
export function addonEnv(run: AddonRun, host: HostKind, base: Record<string, string>): Record<string, string> {
  const env = { ...base, ...run.env };
  const crosses = (run.on === 'wsl' && host === 'windows') || (run.on === 'windows' && host === 'wsl');
  const names = Object.keys(run.env ?? {});
  if (crosses && names.length) env.WSLENV = [base.WSLENV, ...names].filter(Boolean).join(':');
  return env;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One running addon: its process and the JSON-RPC exchange over its stdio. */
class AddonProcess {
  status: AddonStatus = 'starting';
  error?: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private stderrTail = '';
  private stderrBuf = '';
  private stderrMinute = { start: 0, lines: 0 };
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stopping = false;

  constructor(
    readonly manifest: AddonManifest,
    private readonly d: {
      host: HostKind;
      appVersion: string;
      log: Logger;
      /** How to run it right now (addonLaunch). */
      launch: () => AddonLaunch;
      onStatus: () => void;
      onRefresh: () => void;
    },
  ) {}

  start(): void {
    this.status = 'starting';
    this.error = undefined;
    this.stopping = false;
    this.buf = '';
    this.stderrTail = '';
    this.stderrBuf = '';
    this.stderrMinute = { start: 0, lines: 0 };
    const m = this.manifest;
    const { run, environment } = this.d.launch();
    if (!environment) {
      this.stopped(
        `It's a ${sideName(run.on)} program, and no environment in Settings → Environments runs ${sideName(run.on)} programs. Add one, then start the addon again.`,
      );
      return;
    }
    let line: SpawnLine;
    try {
      line = addonSpawnLine(run, this.d.host, environment);
    } catch (e) {
      this.stopped(errMsg(e));
      return;
    }
    this.d.log.info(`addon ${m.id}: starting ${line.command} ${line.args.join(' ')}`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(line.command, line.args, {
        cwd: line.cwd,
        env: addonEnv(run, this.d.host, childEnv()),
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (e) {
      this.stopped(errMsg(e));
      return;
    }
    this.child = child;
    const started = performance.now();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onStdout(d));
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL);
      this.onStderr(d);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => this.exited(child, null, e.message));
    child.on('exit', (code) => this.exited(child, code));
    void this.request('initialize', { protocol: 1, looper: this.d.appVersion, host: this.d.host })
      .then(() => {
        if (this.child !== child) return;
        this.status = 'running';
        this.d.log.info(`addon ${m.id}: running after ${Math.round(performance.now() - started)} ms`);
        this.d.onStatus();
      })
      .catch((e) => {
        if (this.child !== child) return;
        this.d.log.error(`addon ${m.id}: initialize failed: ${errMsg(e)}`);
        this.stop();
        this.stopped(`It didn't start: ${errMsg(e)}`);
      });
  }

  /** Close stdin, which tells the addon to exit; kill it if it doesn't. */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    this.failPending(new Error(`${this.manifest.name} stopped.`));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.pid) void killHostTree(child.pid);
    }, STOP_GRACE_MS);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.error = undefined;
      this.d.onStatus();
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params).done;
  }

  /**
   * A request whose reply `parse` checks, logged as one engine log line when
   * it is slow or fails. The line names it by `what` (method and pane, view or
   * event id) and never includes params, field values or the reply, which can
   * hold passwords.
   */
  async call<T>(method: string, params: unknown, what: string, parse: (reply: unknown) => T): Promise<T> {
    const inFlight = this.pending.size;
    const started = performance.now();
    const { id, done } = this.send(method, params);
    const head = () =>
      `addon ${this.manifest.id}: #${id} ${what} ${Math.round(performance.now() - started)} ms${inFlight ? ` (${inFlight} in flight)` : ''}`;
    let reply: unknown;
    try {
      reply = await done;
    } catch (e) {
      this.d.log.warn(`${head()}, failed: ${errMsg(e)}`);
      throw e;
    }
    let result: T;
    try {
      result = parse(reply);
    } catch (e) {
      this.d.log.warn(`${head()}, ${errMsg(e)}`);
      throw e;
    }
    if (performance.now() - started >= SLOW_REQUEST_MS) this.d.log.info(head());
    return result;
  }

  private send(method: string, params: unknown): { id: number; done: Promise<unknown> } {
    const child = this.child;
    const id = this.nextId++;
    if (!child) return { id, done: Promise.reject(new Error(`${this.manifest.name} isn't running.`)) };
    const done = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.manifest.name} didn't answer within ${REQUEST_TIMEOUT_MS / 1000} s.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return { id, done };
  }

  /** Each stderr line goes to the engine log, up to STDERR_LINES_PER_MIN a minute. */
  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    const lines = this.stderrBuf.split('\n');
    this.stderrBuf = lines.pop() ?? '';
    this.logStderr(lines);
  }

  private logStderr(lines: string[]): void {
    const now = Date.now();
    for (const raw of stripShellNoise(lines.join('\n')).split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (now - this.stderrMinute.start >= 60_000) this.stderrMinute = { start: now, lines: 0 };
      const n = ++this.stderrMinute.lines;
      if (n <= STDERR_LINES_PER_MIN) this.d.log.info(`addon ${this.manifest.id} stderr: ${line}`);
      else if (n === STDERR_LINES_PER_MIN + 1) {
        this.d.log.warn(`addon ${this.manifest.id}: wrote over ${STDERR_LINES_PER_MIN} stderr lines this minute; the rest of the minute's lines are skipped`);
      }
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A shell profile or a stray print: not a message.
        this.d.log.warn(`addon ${this.manifest.id}: ignored output: ${text.slice(0, 200)}`);
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const err = msg.error as { message?: unknown } | undefined;
      if (err) p.reject(new Error(typeof err.message === 'string' && err.message ? err.message : 'The addon reported an error.'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'refresh') {
      this.d.onRefresh();
      return;
    }
    if (typeof msg.method === 'string') {
      this.d.log.warn(`addon ${this.manifest.id}: unknown method ${msg.method}`);
      // A request (it has an id) is owed an answer.
      if (msg.id !== undefined && this.child) {
        this.child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Looper has no method "${msg.method}"` } })}\n`,
        );
      }
    }
  }

  private exited(child: ChildProcessWithoutNullStreams, code: number | null, spawnError?: string): void {
    if (this.child !== child && !this.stopping) return;
    if (this.child === child) this.child = null;
    if (this.stderrBuf) {
      this.logStderr([this.stderrBuf]);
      this.stderrBuf = '';
    }
    this.failPending(new Error(`${this.manifest.name} stopped.`));
    if (this.stopping) return;
    const tail = stripShellNoise(this.stderrTail).trim().split('\n').slice(-6).join('\n');
    const why = spawnError ?? (code === null ? 'It stopped.' : `It exited with code ${code}.`);
    this.d.log.warn(`addon ${this.manifest.id}: ${why}${tail ? `\n${tail}` : ''}`);
    this.stopped(tail ? `${why}\n${tail}` : why);
  }

  private stopped(error: string): void {
    this.status = 'stopped';
    this.error = error;
    this.d.onStatus();
  }

  private failPending(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

/** Throws the addon developer a readable reason when a reply doesn't fit the protocol. */
function check<T>(what: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`The addon sent ${what} Looper can't show:\n${zodSummary(r.error)}`);
  return r.data;
}

export interface AddonHostDeps {
  /** Where installed manifests are kept: <dataDir>/addons. */
  dir: string;
  host: HostKind;
  appVersion: string;
  log: Logger;
  /** The list or a status changed. */
  onChange: (addons: AddonInfo[]) => void;
  onRefresh: (addonId: string) => void;
  /** The ids of the addons stopped in the Addons window, and where a change to them is saved. */
  disabled: () => string[];
  setDisabled: (ids: string[]) => void;
  /** The user's changes to how addons run, by id, and where a change to them is saved. */
  runs: () => Record<string, AddonLocalRun>;
  setRuns: (runs: Record<string, AddonLocalRun>) => void;
  /** Settings → Environments, which run the addons. */
  environments: () => { environments: Environment[]; defaultEnvironmentId: string };
}

/** The installed addons: their manifests on disk and their processes. */
export class AddonHost {
  private readonly procs = new Map<string, AddonProcess>();

  constructor(private readonly d: AddonHostDeps) {}

  /** Read the installed manifests and start every enabled addon. */
  start(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.d.dir).filter((n) => n.endsWith(`.${ADDON_EXT}`));
    } catch {
      /* no addons yet */
    }
    for (const name of names.sort()) {
      const file = path.join(this.d.dir, name);
      try {
        const r = readAddonManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!r.ok) throw new Error(r.error ?? r.reason);
        this.launch(r.manifest);
      } catch (e) {
        this.d.log.error(`addon ${path.basename(name, `.${ADDON_EXT}`)}: not loaded: ${errMsg(e)}`);
      }
    }
    this.changed();
  }

  dispose(): void {
    for (const p of this.procs.values()) p.stop();
  }

  list(): AddonInfo[] {
    return [...this.procs.values()].map((p) => {
      const l = this.launchOf(p.manifest);
      return {
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        run: `${runCommand(l.run)}\n${l.environment ? `in ${l.environment.name}` : `(no ${sideName(l.run.on)} environment)`}`,
        ownRun: p.manifest.run,
        localRun: this.runOf(p.manifest.id),
        environmentId: l.environment?.id,
        defaultEnvironmentId: l.defaultEnvironment?.id,
        panes: p.manifest.panes,
        tools: p.manifest.tools,
        toolbar: p.manifest.toolbar,
        toolbarName: p.manifest.toolbarName,
        enabled: this.enabled(p.manifest.id),
        status: p.status,
        error: p.error,
      };
    });
  }

  /** How the addon runs for this user (addonLaunch). */
  launchOf(manifest: Pick<AddonManifest, 'id' | 'run'>): AddonLaunch {
    return addonLaunch(manifest.run, this.runOf(manifest.id), this.d.environments(), this.d.host);
  }

  get(id: string): AddonManifest | undefined {
    return this.procs.get(id)?.manifest;
  }

  /** The user's changes to how the addon runs, if any. */
  runOf(id: string): AddonLocalRun | undefined {
    return this.d.runs()[id];
  }

  /** Save the user's changes to how the addon runs (undefined goes back to the manifest's and the default environment), and restart it. */
  setRun(id: string, run: AddonLocalRun | undefined): void {
    const p = this.procs.get(id);
    if (!p) return;
    const { [id]: _, ...rest } = this.d.runs();
    this.d.setRuns(run ? { ...rest, [id]: run } : rest);
    if (this.enabled(id)) {
      p.stop();
      p.start();
    }
    this.changed();
  }

  /** Save the manifest and start it, replacing an installed addon with the same id. Installing enables it. */
  install(manifest: AddonManifest): void {
    this.setDisabledId(manifest.id, false);
    fs.mkdirSync(this.d.dir, { recursive: true });
    fs.writeFileSync(this.file(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    this.procs.get(manifest.id)?.stop();
    this.launch(manifest);
    this.changed();
  }

  remove(id: string): void {
    this.procs.get(id)?.stop();
    this.procs.delete(id);
    fs.rmSync(this.file(id), { force: true });
    this.setDisabledId(id, false);
    if (this.runOf(id)) {
      const { [id]: _, ...rest } = this.d.runs();
      this.d.setRuns(rest);
    }
    this.changed();
  }

  restart(id: string): void {
    const p = this.procs.get(id);
    if (!p || !this.enabled(id)) return;
    p.stop();
    p.start();
    this.changed();
  }

  /** Start (enabled) or stop (disabled) an addon, and remember it for the next time Looper starts. */
  setEnabled(id: string, enabled: boolean): void {
    const p = this.procs.get(id);
    if (!p) return;
    this.setDisabledId(id, !enabled);
    if (enabled) {
      p.stop();
      p.start();
    } else {
      p.stop();
      p.status = 'stopped';
      p.error = undefined;
    }
    this.changed();
  }

  async pane(id: string, pane: string): Promise<AddonPaneContent> {
    return this.proc(id).call('pane', { pane }, `pane ${pane}`, (r) => check('a pane', AddonPaneContentSchema, r));
  }

  async render(id: string, view: string, params: Record<string, unknown>): Promise<AddonScreen> {
    return this.proc(id).call('render', { view, params }, `render ${view}`, (r) => check('a screen', AddonScreenSchema, r));
  }

  async event(id: string, event: AddonEvent): Promise<AddonEventResult> {
    return this.proc(id).call('event', event, `event ${event.kind} ${event.id}`, (r) =>
      check('an answer', AddonEventResultSchema, r ?? {}),
    );
  }

  /** A screen that took long to draw after it was asked for, as the window measured it. */
  logSlowDraw(id: string, view: string, ms: number): void {
    if (!this.procs.has(id) || typeof view !== 'string' || !Number.isFinite(ms)) return;
    this.d.log.info(`addon ${id}: render ${view.slice(0, 100).replace(/\s+/g, ' ')} drawn after ${Math.round(ms)} ms`);
  }

  private proc(id: string): AddonProcess {
    const p = this.procs.get(id);
    if (!p) throw new Error(`The addon "${id}" isn't installed.`);
    return p;
  }

  private launch(manifest: AddonManifest): void {
    const p = new AddonProcess(manifest, {
      host: this.d.host,
      appVersion: this.d.appVersion,
      log: this.d.log,
      launch: () => this.launchOf(manifest),
      onStatus: () => this.changed(),
      onRefresh: () => this.d.onRefresh(manifest.id),
    });
    this.procs.set(manifest.id, p);
    if (this.enabled(manifest.id)) p.start();
    else p.status = 'stopped';
  }

  private enabled(id: string): boolean {
    return !this.d.disabled().includes(id);
  }

  private setDisabledId(id: string, disabled: boolean): void {
    const ids = this.d.disabled();
    if (ids.includes(id) === disabled) return;
    this.d.setDisabled(disabled ? [...ids, id] : ids.filter((x) => x !== id));
  }

  private file(id: string): string {
    return path.join(this.d.dir, `${id}.${ADDON_EXT}`);
  }

  private changed(): void {
    this.d.onChange(this.list());
  }
}
