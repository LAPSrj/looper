import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readAppLaunch } from '../engine/cli-tool';
import { detectHost } from '../engine/host';
import { describeHolder, liveHolder, type LockHolder } from '../engine/lock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** describeHolder at the start of a sentence. */
const Holder = (h: LockHolder): string => {
  const d = describeHolder(h);
  return d[0].toUpperCase() + d.slice(1);
};

/** Exit 3: Looper isn't running and couldn't be started, or didn't answer. */
function unreachable(message: string): never {
  console.error(message);
  process.exit(3);
}

/** From WSL, a data dir on a Windows drive belongs to the Windows app. */
function windowsDataDir(dataDir: string): boolean {
  if (detectHost() !== 'wsl') return false;
  try {
    return /^[A-Za-z]:\\/.test(execFileSync('wslpath', ['-w', dataDir], { encoding: 'utf8' }).trim());
  } catch {
    return false;
  }
}

function detached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => unreachable(`cannot start ${command}: ${e.message}`));
  child.unref();
}

/**
 * Start Looper on the data dir: the desktop app the way it last recorded
 * (cli-tool.ts), or `looper serve` where there's no desktop to show it on.
 * What it started, as the messages name it.
 */
function launch(dataDir: string): string {
  const host = detectHost();
  const app = readAppLaunch(dataDir);
  const missing = (): never =>
    unreachable(`Looper isn't running on ${dataDir}, and it hasn't recorded how to start it: open Looper once, and looper can start it after that.`);
  // The app opens this data dir, not the one it would open by itself.
  const on = (dir: string) => `--data-dir=${dir}`;
  if (windowsDataDir(dataDir)) {
    if (!app?.command) missing();
    const windowsDir = execFileSync('wslpath', ['-w', dataDir], { encoding: 'utf8' }).trim();
    detached(execFileSync('wslpath', ['-u', app!.command!], { encoding: 'utf8' }).trim(), [...(app!.args ?? []), on(windowsDir)]);
    return 'Looper';
  }
  if (host === 'windows') {
    if (!app?.command) missing();
    detached(app!.command!, [...(app!.args ?? []), on(dataDir)]);
    return 'Looper';
  }
  // macOS starts an app with open, which fails where no one is logged in to the desktop.
  if (host === 'mac' && app?.bundle && spawnSync('open', ['-g', '-a', app.bundle, '--args', on(dataDir)], { stdio: 'ignore' }).status === 0) return 'Looper';
  if (app?.command && (host === 'mac' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    detached(app.command, [...(app.args ?? []), on(dataDir)]);
    return 'Looper';
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'serve.log'), 'a');
  spawn(process.execPath, [process.argv[1], '--data-dir', dataDir, 'serve', '--quiet'], { detached: true, stdio: ['ignore', log, log] }).unref();
  return 'looper serve';
}

/** The running Looper once its command server listens; exits with 3 when it doesn't in time. */
async function serverUp(dataDir: string, deadline: number, late: () => string): Promise<LockHolder> {
  for (;;) {
    const holder = liveHolder(dataDir);
    if (holder?.port && holder.token) return holder;
    if (Date.now() >= deadline) unreachable(late());
    await sleep(250);
  }
}

function wslNetworkingMode(): string {
  try {
    return execFileSync('wslinfo', ['--networking-mode'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'nat';
  }
}

/** Where this computer reaches the Looper holding the lock. */
function address(holder: LockHolder): { host: string; port: number } {
  const fromWsl = detectHost() === 'wsl' && holder.where === 'windows';
  if (!fromWsl && holder.hostname !== os.hostname()) unreachable(`Looper runs on another computer: ${describeHolder(holder)}. Run looper there.`);
  // In WSL's NAT mode, Windows is WSL's default gateway, not 127.0.0.1.
  if (fromWsl && wslNetworkingMode() !== 'mirrored') {
    const gateway = /default via (\S+)/.exec(execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' }))?.[1];
    if (!gateway) unreachable("WSL has no default route, so looper can't reach Windows.");
    if (!holder.wslPort) unreachable(`${Holder(holder)} isn't listening on WSL's network yet; try again in a few seconds.`);
    return { host: gateway, port: holder.wslPort };
  }
  return { host: '127.0.0.1', port: holder.port! };
}

function post(to: { host: string; port: number }, token: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: to.host, port: to.port, method: 'POST', path: '/request', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

export interface CallOptions {
  /** Before the app's reason when it refuses the command. */
  refused?: string;
}

/**
 * Send the Looper running on the data dir a command and return its answer,
 * starting Looper first when it isn't running. Exits with 1 when Looper
 * refuses the command (its reason on stderr), and with 3 when it can't be
 * started or doesn't answer within `timeoutSec` (0: no limit).
 */
export async function callApp<T = unknown>(dataDir: string, method: string, params: Record<string, unknown>, timeoutSec: number, opts: CallOptions = {}): Promise<T> {
  const timeoutMs = timeoutSec * 1000;
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  let holder = liveHolder(dataDir);
  if (!holder) {
    const what = launch(dataDir);
    console.error(`Looper isn't running on ${dataDir}; starting ${what}…`);
    const log = path.join(dataDir, what === 'looper serve' ? 'serve.log' : 'engine.log');
    holder = await serverUp(dataDir, deadline, () => `${what} didn't start within ${timeoutSec}s; check ${log}`);
  } else if (!holder.port || !holder.token) {
    const running = holder;
    holder = await serverUp(dataDir, deadline, () => `${Holder(running)} isn't taking commands; it may be older than this command-line tool.`);
  }
  const to = address(holder);
  let res: { status: number; text: string };
  try {
    res = await post(to, holder.token!, JSON.stringify({ method, params }), timeoutMs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'TIMEOUT') unreachable(`${Holder(holder)} didn't answer ${method} within ${timeoutSec}s.`);
    unreachable(`${Holder(holder)} didn't answer at ${to.host}:${to.port} (${code ?? (e as Error).message}).`);
  }
  let answer: { result?: T; error?: string };
  try {
    answer = JSON.parse(res.text) as typeof answer;
  } catch {
    unreachable(`Something other than Looper answered at ${to.host}:${to.port}.`);
  }
  if (res.status !== 200) {
    console.error(`${opts.refused ?? ''}${answer.error ?? `Looper answered ${res.status}.`}`);
    process.exit(1);
  }
  return answer.result as T;
}
