import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { spawnOffThread, type OffThreadChild } from '../engine/exec-worker';
import { convertWslPath, loadSystemLocale, type HostKind } from '../engine/host';
import { errMsg, type Logger } from '../engine/log';
import { childEnv, stripShellNoise } from '../engine/steps/common';
import { killHostTree } from '../engine/target/kill';
import { withCrossingVars } from '../engine/env-exec';
import { ADDON_EXT } from '../shared/files';
import {
  ADDON_PROTOCOL,
  ADDON_REQUESTS,
  AddonEventResultSchema,
  AddonPaneContentSchema,
  AddonProjectTabStateSchema,
  AddonRefreshSchema,
  AddonScreenSchema,
  environmentsFor,
  readAddonManifest,
  runCommand,
  sideName,
  withAddonDir,
  type AddonEvent,
  type AddonEventResult,
  type AddonInfo,
  type AddonLocalRun,
  type AddonManifest,
  type AddonNotification,
  type AddonPaneContent,
  type AddonProjectTabState,
  type AddonRefresh,
  type AddonRequestMethod,
  type AddonRun,
  type AddonScreen,
  type AddonStatus,
} from '../shared/addons';
import { addonIconError, addonIcons } from './addon-icons';
import { ADDON_MANIFEST_FILE, readAddonPackage, readPackageManifest, type PackageFile } from './addon-package';
import { tokenize } from '../shared/cmdline';
import { DEFAULT_SHELL } from '../shared/environments';
import { REPORT_INPUT, issueLines } from '../shared/issues';
import type { Environment } from '../shared/types';

const REQUEST_TIMEOUT_MS = 30_000;
/** An event's answer can wait for what it does (a git push runs up to 600 s). */
export const EVENT_TIMEOUT_MS = 600_000;
/** After stdin closes, how long an addon gets to exit before it is killed. */
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL = 4096;
/** Requests at least this slow get an engine log line; faster ones log only when they fail. */
export const SLOW_REQUEST_MS = 250;
/** Requests of the addon's that last as long as the user takes (a window open until it is closed): never logged as slow. */
const OPEN_ENDED_REQUESTS: ReadonlySet<string> = new Set<AddonRequestMethod>(['looper/openWindow']);
/** Stderr lines per minute an addon may write to the engine log. */
export const STDERR_LINES_PER_MIN = 60;

export interface SpawnLine {
  command: string;
  args: string[];
  cwd?: string;
}

export interface AddonLaunch {
  /** The command, working folder and variables: the user's when they changed them, the manifest's otherwise (${addonDir} still in it). */
  run: AddonRun;
  /** The environment that runs it: the user's choice, else the default environment, else the first that fits. Unset when none fits, and for a `looper` addon, which needs none. */
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
  const run: AddonRun = local
    ? { on: own.on, command: local.command, ...(local.cwd ? { cwd: local.cwd } : {}), ...(local.env ? { env: local.env } : {}) }
    : own;
  if (own.on === 'looper') return { run };
  const fits = environmentsFor(own.on, settings.environments, host);
  const defaultEnvironment = fits.find((e) => e.id === settings.defaultEnvironmentId) ?? fits[0];
  const chosen = local && fits.find((e) => e.id === local.environmentId);
  return { run, environment: chosen ?? defaultEnvironment, defaultEnvironment };
}

/**
 * The process to start for an addon in its environment. A `looper` addon is
 * Looper's own executable run as Node, its script and arguments after it, in
 * its folder unless it names another (`addonDir`, Looper's path of it). A
 * WSL command goes through the environment's shell (by default an
 * interactive login bash, as tasks do, so PATH has what ~/.bashrc adds: nvm,
 * bun); `exec "$@"` then replaces the shell with the command, unquoted args
 * and all. A Windows command starts directly.
 */
export function addonSpawnLine(run: AddonRun, host: HostKind, environment: Environment | undefined, addonDir?: string): SpawnLine {
  if (run.on === 'looper') {
    const cwd = run.cwd ?? addonDir;
    return { command: process.execPath, args: run.command, ...(cwd ? { cwd } : {}) };
  }
  if (!environment) throw new Error(`It's a ${sideName(run.on)} program, and no environment in Settings → Environments runs ${sideName(run.on)} programs. Add one, then start the addon again.`);
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
 * so the manifest's are added to it. A `looper` addon gets
 * ELECTRON_RUN_AS_NODE, which makes Looper's executable Node; only its
 * process does.
 */
export function addonEnv(run: AddonRun, host: HostKind, base: Record<string, string>): Record<string, string> {
  if (run.on === 'looper') return { ...base, ELECTRON_RUN_AS_NODE: '1', ...run.env };
  const crosses = (run.on === 'wsl' && host === 'windows') || (run.on === 'windows' && host === 'wsl');
  return withCrossingVars(base, run.env, crosses);
}

/** A path on Looper's side, in the form the addon's side uses (in its environment's distro); a `looper` addon is on Looper's side. */
export async function forAddonSide(launch: AddonLaunch, hostKind: HostKind, p: string): Promise<string> {
  if (launch.run.on === 'wsl' && hostKind === 'windows') return (await convertWslPath(p, 'posix', launch.environment?.distro || undefined)) ?? p;
  if (launch.run.on === 'windows' && hostKind === 'wsl') return (await convertWslPath(p, 'windows')) ?? p;
  return p;
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
  /** It stopped on its own after starting, not for a reason `error` gives. */
  crashed = false;
  /** ${addonDir} as its process got it, once it has started. */
  addonDir?: string;
  private child: OffThreadChild | null = null;
  /** Each start and stop: a start still finding its paths gives up when this moves on. */
  private gen = 0;
  private buf = '';
  private stderrTail = '';
  private stderrBuf = '';
  private stderrMinute = { start: 0, lines: 0 };
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** What sent each `event` request still unanswered, by the id it went out under (originOf). */
  private readonly origins = new Map<number, unknown>();
  private stopping = false;

  constructor(
    readonly manifest: AddonManifest,
    private readonly d: {
      host: HostKind;
      appVersion: string;
      dataDir: string;
      /** Its installed folder, on Looper's side. */
      folder: string;
      log: Logger;
      /** How to run it right now (addonLaunch). */
      launch: () => AddonLaunch;
      onStatus: () => void;
      onRefresh: (only?: AddonRefresh) => void;
      /** Answers one of its requests to Looper (ADDON_REQUESTS), its params checked. */
      request: (method: AddonRequestMethod, params: unknown) => Promise<unknown>;
      /** The process stopped or exited: whatever it had open for the user has no one to answer it. */
      onStopped: () => void;
    },
  ) {}

  start(): void {
    this.status = 'starting';
    this.error = undefined;
    this.crashed = false;
    this.stopping = false;
    this.buf = '';
    this.stderrTail = '';
    this.stderrBuf = '';
    this.stderrMinute = { start: 0, lines: 0 };
    void this.spawn(++this.gen);
  }

  private async spawn(gen: number): Promise<void> {
    const m = this.manifest;
    const launch = this.d.launch();
    let line: SpawnLine;
    let run: AddonRun;
    try {
      if (launch.run.on !== 'looper' && !launch.environment) {
        throw new Error(`It's a ${sideName(launch.run.on)} program, and no environment in Settings → Environments runs ${sideName(launch.run.on)} programs. Add one, then start the addon again.`);
      }
      const dir = await forAddonSide(launch, this.d.host, this.d.folder);
      if (gen !== this.gen) return;
      this.addonDir = dir;
      run = withAddonDir(launch.run, dir);
      line = addonSpawnLine(run, this.d.host, launch.environment, this.d.folder);
    } catch (e) {
      if (gen === this.gen) this.stopped(errMsg(e));
      return;
    }
    this.d.log.info(`addon ${m.id}: starting ${line.command} ${line.args.join(' ')}`);
    let child: OffThreadChild;
    try {
      child = spawnOffThread(line.command, line.args, {
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
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => this.onStdout(d));
    child.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL);
      this.onStderr(d);
    });
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => this.exited(child, null, e.message));
    child.on('exit', (code) => this.exited(child, code));
    void forAddonSide(launch, this.d.host, this.d.dataDir)
      .then(async (dataDir) => {
        if (this.child !== child) return;
        // The locale the windows format dates and numbers with (Windows' regional format), else the runtime's.
        const locale = (await loadSystemLocale()) ?? Intl.DateTimeFormat().resolvedOptions().locale;
        if (this.child !== child) return;
        await this.request('initialize', { protocol: ADDON_PROTOCOL, looper: this.d.appVersion, host: this.d.host, dataDir, locale });
        if (this.child !== child) return;
        this.status = 'running';
        this.d.log.info(`addon ${m.id}: running after ${Math.round(performance.now() - started)} ms`);
        this.d.onStatus();
      })
      .catch((e) => {
        if (this.child !== child) return;
        this.d.log.error(`addon ${m.id}: initialize failed: ${errMsg(e)}`);
        void this.stop();
        this.stopped(`It didn't start: ${errMsg(e)}`);
      });
  }

  /** Close stdin, which tells the addon to exit; kill it if it doesn't. Settles once it has exited. */
  stop(): Promise<void> {
    this.gen++;
    const child = this.child;
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.error = undefined;
      this.crashed = false;
      this.d.onStatus();
    }
    if (!child) return Promise.resolve();
    this.stopping = true;
    this.child = null;
    this.failPending(new Error(`${this.manifest.name} stopped.`));
    const gone = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      // An exit that never comes (a kill that failed) doesn't hold up the caller for good.
      setTimeout(resolve, STOP_GRACE_MS * 3).unref();
    });
    child.stdin!.end();
    this.d.onStopped();
    const timer = setTimeout(() => {
      if (child.exitCode === null) void child.spawned.then((pid) => (pid ? killHostTree(pid) : undefined));
    }, STOP_GRACE_MS);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    return gone;
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params).done;
  }

  /** A notification (no answer) to the running addon; dropped while it isn't running. */
  notify(n: AddonNotification): void {
    if (this.status !== 'running' || !this.child) return;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...n })}\n`);
  }

  /**
   * A request whose reply `parse` checks, logged as one engine log line when
   * it is slow or fails. The line names it by `what` (method and pane, view or
   * event id) and never includes params, field values or the reply, which can
   * hold passwords.
   */
  async call<T>(method: string, params: unknown, what: string, parse: (reply: unknown) => T, timeoutMs = REQUEST_TIMEOUT_MS, origin?: unknown): Promise<T> {
    const inFlight = this.pending.size;
    const started = performance.now();
    const { id, done } = this.send(method, params, timeoutMs);
    if (origin !== undefined) this.origins.set(id, origin);
    const head = () =>
      `addon ${this.manifest.id}: #${id} ${what} ${Math.round(performance.now() - started)} ms${inFlight ? ` (${inFlight} in flight)` : ''}`;
    let reply: unknown;
    try {
      reply = await done;
    } catch (e) {
      this.d.log.warn(`${head()}, failed: ${errMsg(e)}`);
      throw e;
    } finally {
      this.origins.delete(id);
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

  /** What sent the `event` request that went out under `id`, while it is unanswered. */
  originOf(id: number): unknown {
    return this.origins.get(id);
  }

  private send(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): { id: number; done: Promise<unknown> } {
    const child = this.child;
    const id = this.nextId++;
    if (!child) return { id, done: Promise.reject(new Error(`${this.manifest.name} isn't running.`)) };
    const done = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.manifest.name} didn't answer within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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
    if (typeof msg.method !== 'string') return;
    // A request (it has an id) is owed an answer; a notification isn't.
    const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : undefined;
    if (id === undefined) {
      if (msg.method === 'refresh') this.onRefresh(msg.params);
      else this.d.log.warn(`addon ${this.manifest.id}: unknown method ${msg.method}`);
      return;
    }
    if (Object.hasOwn(ADDON_REQUESTS, msg.method)) {
      void this.answer(id, msg.method as AddonRequestMethod, msg.params);
      return;
    }
    this.d.log.warn(`addon ${this.manifest.id}: unknown method ${msg.method}`);
    this.reply(this.child, { id, error: { code: -32601, message: `Looper has no method "${msg.method}"` } });
  }

  /** The addon's refresh: what its params name, or everything when it sent none or ones Looper can't read. */
  private onRefresh(params: unknown): void {
    if (params === undefined) return this.d.onRefresh();
    const r = AddonRefreshSchema.safeParse(params, REPORT_INPUT);
    if (!r.success) {
      this.d.log.warn(`addon ${this.manifest.id}: refresh with params Looper can't read, so everything is drawn again:\n${issueLines(r.error, 4)}`);
      return this.d.onRefresh();
    }
    this.d.onRefresh(r.data);
  }

  /**
   * One of the addon's requests to Looper: its params checked, then its
   * handler's result, or why it failed. Logged like Looper's own requests
   * (slow or failed), without params or results.
   */
  private async answer(id: number | string, method: AddonRequestMethod, params: unknown): Promise<void> {
    const child = this.child;
    const parsed = ADDON_REQUESTS[method].safeParse(params ?? {}, REPORT_INPUT);
    if (!parsed.success) {
      this.d.log.warn(`addon ${this.manifest.id}: ${method} with params Looper can't read`);
      this.reply(child, { id, error: { code: -32602, message: `Invalid params for ${method}:\n${issueLines(parsed.error, 4)}` } });
      return;
    }
    const started = performance.now();
    const head = () => `addon ${this.manifest.id}: ${method} ${Math.round(performance.now() - started)} ms`;
    try {
      const result = await this.d.request(method, parsed.data);
      if (performance.now() - started >= SLOW_REQUEST_MS && !OPEN_ENDED_REQUESTS.has(method)) this.d.log.info(head());
      this.reply(child, { id, result: result ?? null });
    } catch (e) {
      this.d.log.warn(`${head()}, failed: ${errMsg(e)}`);
      this.reply(child, { id, error: { code: 1, message: errMsg(e) } });
    }
  }

  /** An answer, to the process that asked: one that has exited since gets none. */
  private reply(to: OffThreadChild | null, msg: { id: number | string } & ({ result: unknown } | { error: { code: number; message: string } })): void {
    if (!to || this.child !== to) return;
    to.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  private exited(child: OffThreadChild, code: number | null, spawnError?: string): void {
    if (this.child !== child && !this.stopping) return;
    if (this.child === child) this.child = null;
    if (this.stderrBuf) {
      this.logStderr([this.stderrBuf]);
      this.stderrBuf = '';
    }
    this.failPending(new Error(`${this.manifest.name} stopped.`));
    if (this.stopping) return;
    this.d.onStopped();
    const tail = stripShellNoise(this.stderrTail).trim().split('\n').slice(-6).join('\n');
    const why = spawnError ?? (code === null ? 'It stopped unexpectedly.' : `It stopped unexpectedly.\nError code: ${exitCodeText(code)}`);
    this.d.log.warn(`addon ${this.manifest.id}: ${why}${tail ? `\n${tail}` : ''}`);
    // The exit code and what it wrote are for whoever writes the addon: the Engine Log has them.
    if (spawnError) this.stopped(spawnError);
    else this.stopped('It stopped unexpectedly. What it wrote last is in the Engine Log.', true);
  }

  private stopped(error: string, crashed = false): void {
    this.status = 'stopped';
    this.error = error;
    this.crashed = crashed;
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

/** An exit code as Windows writes error codes: a small one as it is, one past 255 (a Windows status) in hexadecimal. */
export const exitCodeText = (code: number): string => (code >= 0 && code <= 255 ? String(code) : `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);

/** Throws the addon developer a readable reason when a reply doesn't fit the protocol. */
function check<T>(what: string, schema: z.ZodType<T, unknown>, value: unknown): T {
  const r = schema.safeParse(value, REPORT_INPUT);
  if (!r.success) throw new Error(`The addon sent ${what} Looper can't show:\n${issueLines(r.error, 4)}`);
  return r.data;
}

export interface AddonHostDeps {
  /** Where installed addons are kept, a folder each: <dataDir>/addons. */
  dir: string;
  host: HostKind;
  appVersion: string;
  log: Logger;
  /** The list or a status changed. */
  onChange: (addons: AddonInfo[]) => void;
  /** The addon asked to draw things again: what `only` names, or everything. */
  onRefresh: (addonId: string, only?: AddonRefresh) => void;
  /** The ids of the addons stopped in the Addons window, and where a change to them is saved. */
  disabled: () => string[];
  setDisabled: (ids: string[]) => void;
  /** The user's changes to how addons run, by id, and where a change to them is saved. */
  runs: () => Record<string, AddonLocalRun>;
  setRuns: (runs: Record<string, AddonLocalRun>) => void;
  /** Settings → Environments, which run the addons. */
  environments: () => { environments: Environment[]; defaultEnvironmentId: string };
  /** Answers an addon's request to Looper (ADDON_REQUESTS), its params already checked. */
  request: (addonId: string, method: AddonRequestMethod, params: unknown) => Promise<unknown>;
  /** An addon's process stopped or exited (a restart, a disable, a crash): what it had open for the user goes. */
  onStopped?: (addonId: string) => void;
  /** The packages Looper comes with (out/addons): installed without asking. */
  bundledDir?: string;
  /** The bundled addons the user removed, which stay removed, and where a change to them is saved. */
  removedBundled: () => string[];
  setRemovedBundled: (ids: string[]) => void;
}

/** Dot-separated numbers compared one by one ("1.10.0" is after "1.9.2"); what isn't a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** A folder or file of the addons folder that isn't an installed addon: one being installed or set aside (they start with "."). */
const isWorkName = (name: string): boolean => name.startsWith('.');

/**
 * Format 1 kept each installed addon as <dir>/<id>.looperaddon, its manifest
 * as JSON with ${addonDir} already replaced. Each such file (a file, of
 * format 1 by its own $version) becomes <dir>/<id>/addon.json, the same
 * manifest with $version 2, and goes. Resolves with how many it moved.
 */
export async function migrateAddonFiles(dir: string, log: Logger): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // no addons yet
  }
  let moved = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(`.${ADDON_EXT}`)) continue;
    const file = path.join(dir, e.name);
    try {
      const old = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
      if (old?.$type !== 'looper/addon' || old.$version !== 1) continue;
      const id = typeof old.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(old.id) ? old.id : undefined;
      if (!id) throw new Error('it has no id a folder can be named by');
      const folder = path.join(dir, id);
      await fs.promises.mkdir(folder, { recursive: true });
      const target = path.join(folder, ADDON_MANIFEST_FILE);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, `${JSON.stringify({ ...old, $version: 2 }, null, 2)}\n`, 'utf8');
      await fs.promises.rename(tmp, target);
      await fs.promises.rm(file, { force: true });
      moved++;
    } catch (err) {
      log.error(`addon ${e.name}: cannot move it to its own folder: ${errMsg(err)}`);
    }
  }
  return moved;
}

/** Windows refuses a rename for a moment while something (an antivirus, the addon's last handle) has a file in it open. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

/** An installed addon's package: its manifest and its files (addon.json among them, else written from the manifest). */
export interface AddonPackage {
  manifest: AddonManifest;
  files?: PackageFile[];
}

/** The installed addons: their folders on disk and their processes. */
export class AddonHost {
  private readonly procs = new Map<string, AddonProcess>();
  /** projectTab calls the addons are still answering, by addon, tab and project. */
  private readonly pendingTabs = new Map<string, Promise<AddonProjectTabState>>();
  /** The bundled packages' ids, by their file, read once. */
  private bundled: Promise<Map<string, string>> | null = null;

  constructor(private readonly d: AddonHostDeps) {}

  /** Move format 1's files to their folders, then read the installed addons and start every enabled one. */
  async start(): Promise<void> {
    const n = await migrateAddonFiles(this.d.dir, this.d.log);
    if (n) this.d.log.info(`addons: moved ${n} installed addon${n === 1 ? '' : 's'} to ${n === 1 ? 'its own folder' : 'folders of their own'}`);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(this.d.dir, { withFileTypes: true });
    } catch {
      /* no addons yet */
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory()) continue;
      // An install or a replace that a quit cut short.
      if (isWorkName(e.name)) {
        void fs.promises.rm(path.join(this.d.dir, e.name), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      try {
        const r = readAddonManifest(JSON.parse(await fs.promises.readFile(path.join(this.d.dir, e.name, ADDON_MANIFEST_FILE), 'utf8')));
        if (!r.ok) throw new Error(r.error ?? r.reason);
        if (r.manifest.id !== e.name) throw new Error(`its folder is named "${e.name}" and its manifest's id is "${r.manifest.id}"`);
        const iconError = addonIconError(r.manifest);
        if (iconError) throw new Error(iconError);
        this.launch(r.manifest);
      } catch (err) {
        this.d.log.error(`addon ${e.name}: not loaded: ${errMsg(err)}`);
      }
    }
    this.changed();
  }

  dispose(): void {
    for (const p of this.procs.values()) void p.stop();
  }

  list(): AddonInfo[] {
    return [...this.procs.values()].map((p) => {
      const l = this.launchOf(p.manifest);
      const run = p.addonDir ? withAddonDir(l.run, p.addonDir) : l.run;
      const where = l.run.on === 'looper' ? 'with Looper’s Node' : l.environment ? `in ${l.environment.name}` : `(no ${sideName(l.run.on)} environment)`;
      return {
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        run: `${runCommand(run)}\n${where}`,
        ownRun: p.manifest.run,
        localRun: this.runOf(p.manifest.id),
        environmentId: l.environment?.id,
        defaultEnvironmentId: l.defaultEnvironment?.id,
        panes: p.manifest.panes,
        panesIcon: p.manifest.panesIcon,
        tabs: p.manifest.tabs,
        projectTabs: p.manifest.projectTabs,
        commands: p.manifest.commands,
        icons: addonIcons(p.manifest),
        toolbarName: p.manifest.toolbarName,
        toolCalls: p.manifest.toolCalls,
        enabled: this.enabled(p.manifest.id),
        status: p.status,
        error: p.error,
        crashed: p.crashed || undefined,
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

  /** The addon's installed folder, on Looper's side. */
  folder(id: string): string {
    return path.join(this.d.dir, id);
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
      void p.stop();
      p.start();
    }
    this.changed();
  }

  /**
   * Unpack the package into a folder of its own, swap it in for the installed
   * version's (which is set aside, then deleted), and start it. Installing by
   * hand enables it and brings back a bundled addon the user removed; a
   * bundled package's update (`bundled`) leaves both as the user had them.
   */
  async install(pkg: AddonPackage, opts: { bundled?: boolean } = {}): Promise<void> {
    const m = pkg.manifest;
    if (!opts.bundled) {
      this.setDisabledId(m.id, false);
      this.setRemovedBundledId(m.id, false);
    }
    await fs.promises.mkdir(this.d.dir, { recursive: true });
    const fresh = await fs.promises.mkdtemp(path.join(this.d.dir, `.${m.id}.new-`));
    try {
      const files = pkg.files ?? [];
      if (!files.some((f) => f.name === ADDON_MANIFEST_FILE)) {
        await fs.promises.writeFile(path.join(fresh, ADDON_MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
      }
      for (const f of files) {
        const to = path.resolve(fresh, ...f.name.split('/'));
        if (!to.startsWith(fresh + path.sep)) throw new Error(`"${f.name}" leaves the addon's folder.`);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.writeFile(to, f.data, { mode: f.executable ? 0o755 : 0o644 });
      }
    } catch (e) {
      await fs.promises.rm(fresh, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    const old = this.procs.get(m.id);
    // Its process may hold its folder (its working folder on Windows) until it has exited.
    await old?.stop();
    const folder = this.folder(m.id);
    const aside = path.join(this.d.dir, `.${m.id}.old-${Date.now().toString(36)}`);
    const had = await fs.promises.stat(folder).then(() => true, () => false);
    try {
      if (had) await renameRetrying(folder, aside);
      try {
        await renameRetrying(fresh, folder);
      } catch (e) {
        if (had) await renameRetrying(aside, folder).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      await fs.promises.rm(fresh, { recursive: true, force: true }).catch(() => undefined);
      if (old && this.procs.get(m.id) === old && this.enabled(m.id)) old.start();
      this.changed();
      throw e;
    }
    if (had) void fs.promises.rm(aside, { recursive: true, force: true }).catch((e) => this.d.log.warn(`addon ${m.id}: the old version's folder stays: ${errMsg(e)}`));
    this.launch(m);
    this.changed();
  }

  /** Stop the addon and delete its folder. `byUser` (the Addons window's Remove): a bundled addon stays removed. */
  async remove(id: string, byUser = false): Promise<void> {
    const p = this.procs.get(id);
    this.procs.delete(id);
    this.setDisabledId(id, false);
    if (this.runOf(id)) {
      const { [id]: _, ...rest } = this.d.runs();
      this.d.setRuns(rest);
    }
    this.changed();
    if (byUser && [...(await this.bundledIds()).values()].includes(id)) this.setRemovedBundledId(id, true);
    await p?.stop();
    await fs.promises.rm(this.folder(id), { recursive: true, force: true });
  }

  /**
   * Install each package Looper comes with, without asking: one that isn't
   * installed (unless the user removed it), or a newer version of an
   * installed one. Startup runs it after the first window.
   */
  async installBundled(): Promise<void> {
    const dir = this.d.bundledDir;
    if (!dir) return;
    for (const [file, id] of await this.bundledIds()) {
      try {
        const installed = this.get(id);
        if (!installed && this.d.removedBundled().includes(id)) continue;
        const r = await readAddonPackage(await fs.promises.readFile(path.join(dir, file)));
        if (!r.ok) throw new Error(r.error ?? r.reason);
        if (installed && compareVersions(r.manifest.version, installed.version) <= 0) continue;
        const iconError = addonIconError(r.manifest);
        if (iconError) throw new Error(iconError);
        await this.install(r, { bundled: true });
        this.d.log.info(`addon ${id}: ${installed ? `updated from ${installed.version} to` : 'installed'} ${r.manifest.version}, which Looper comes with`);
      } catch (e) {
        this.d.log.error(`addon ${file}: the package Looper comes with didn't install: ${errMsg(e)}`);
      }
    }
  }

  /** The bundled packages' file names and addon ids. */
  private bundledIds(): Promise<Map<string, string>> {
    const dir = this.d.bundledDir;
    this.bundled ??= (async () => {
      const ids = new Map<string, string>();
      if (!dir) return ids;
      let names: string[] = [];
      try {
        names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith(`.${ADDON_EXT}`)).sort();
      } catch {
        return ids; // none bundled
      }
      for (const name of names) {
        const r = await readPackageManifest(await fs.promises.readFile(path.join(dir, name))).catch((e: unknown) => ({ ok: false as const, error: errMsg(e) }));
        if (r.ok) ids.set(name, r.manifest.id);
        else this.d.log.error(`addon ${name}: the package Looper comes with can't be read: ${r.error ?? ('reason' in r ? r.reason : '')}`);
      }
      return ids;
    })();
    return this.bundled;
  }

  restart(id: string): void {
    const p = this.procs.get(id);
    if (!p || !this.enabled(id)) return;
    void p.stop();
    p.start();
    this.changed();
  }

  /** Start (enabled) or stop (disabled) an addon, and remember it for the next time Looper starts. */
  setEnabled(id: string, enabled: boolean): void {
    const p = this.procs.get(id);
    if (!p) return;
    this.setDisabledId(id, !enabled);
    if (enabled) {
      void p.stop();
      p.start();
    } else {
      void p.stop();
      p.status = 'stopped';
      p.error = undefined;
      p.crashed = false;
    }
    this.changed();
  }

  /** Tell every running addon (projectsChanged, activity). */
  notify(n: AddonNotification): void {
    for (const p of this.procs.values()) p.notify(n);
  }

  async pane(id: string, pane: string): Promise<AddonPaneContent> {
    return this.proc(id).call('pane', { pane }, `pane ${pane}`, (r) => check('a pane', AddonPaneContentSchema, r));
  }

  async render(id: string, view: string, params: Record<string, unknown>): Promise<AddonScreen> {
    return this.proc(id).call('render', { view, params }, `render ${view}`, (r) => check('a screen', AddonScreenSchema, r));
  }

  /**
   * Whether the addon's project tab shows for the project, and its title now. The same question asked again
   * while the addon is answering it (every window showing the project asks at once) waits for that answer.
   */
  projectTab(id: string, tab: string, projectId: string): Promise<AddonProjectTabState> {
    const key = `${id}\n${tab}\n${projectId}`;
    const pending = this.pendingTabs.get(key);
    if (pending) return pending;
    const asked = (async () =>
      this.proc(id).call('projectTab', { tab, projectId }, `projectTab ${tab}`, (r) => check('a project tab', AddonProjectTabStateSchema, r ?? {})))().finally(() => {
      if (this.pendingTabs.get(key) === asked) this.pendingTabs.delete(key);
    });
    this.pendingTabs.set(key, asked);
    return asked;
  }

  /** The addon said something changed: a project tab asked about after this gets a new answer. */
  private forgetPendingTabs(id: string): void {
    for (const key of this.pendingTabs.keys()) if (key.startsWith(`${id}\n`)) this.pendingTabs.delete(key);
  }

  /** `origin` is whatever sent the event (a window): originOf gives it back while the addon is still answering. */
  async event(id: string, event: AddonEvent, origin?: unknown): Promise<AddonEventResult> {
    return this.proc(id).call('event', event, `event ${event.kind} ${event.id}`, (r) => check('an answer', AddonEventResultSchema, r ?? {}), EVENT_TIMEOUT_MS, origin);
  }

  /** What sent the `event` request that went to the addon under `requestId`, until the addon has answered it (or it failed or the addon stopped). */
  originOf(id: string, requestId: number): unknown {
    return this.procs.get(id)?.originOf(requestId);
  }

  /** A screen that took long to draw after it was asked for, as the window measured it. */
  logSlowDraw(id: string, view: string, ms: number): void {
    if (!this.procs.has(id) || typeof view !== 'string' || !Number.isFinite(ms)) return;
    this.d.log.info(`addon ${id}: render ${view.slice(0, 100).replace(/\s+/g, ' ')} drawn after ${Math.round(ms)} ms`);
  }

  /** A window screen whose page scrolls: the window its manifest opens is too small for it. */
  logOverflow(id: string, view: string, tab: string, height: number): void {
    if (!this.procs.has(id) || typeof view !== 'string' || typeof tab !== 'string' || !Number.isFinite(height)) return;
    const where = `${view.slice(0, 100)}${tab ? ` tab ${tab.slice(0, 100)}` : ''}`.replace(/\s+/g, ' ');
    this.d.log.warn(`addon ${id}: window ${where} scrolls; it needs a height of ${Math.ceil(height)}`);
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
      dataDir: path.dirname(this.d.dir),
      folder: this.folder(manifest.id),
      log: this.d.log,
      launch: () => this.launchOf(manifest),
      onStatus: () => this.changed(),
      onRefresh: (only) => {
        this.forgetPendingTabs(manifest.id);
        this.d.onRefresh(manifest.id, only);
      },
      request: (method, params) => this.d.request(manifest.id, method, params),
      onStopped: () => this.d.onStopped?.(manifest.id),
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

  private setRemovedBundledId(id: string, removed: boolean): void {
    const ids = this.d.removedBundled();
    if (ids.includes(id) === removed) return;
    this.d.setRemovedBundled(removed ? [...ids, id] : ids.filter((x) => x !== id));
  }

  private changed(): void {
    this.d.onChange(this.list());
  }
}
