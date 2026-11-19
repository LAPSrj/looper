import { convertWslPath, type HostKind } from './host';
import { execOffThread, spawnOffThread } from './exec-worker';
import type { Environment } from '../shared/types';

/**
 * Running a program in an environment (Settings → Environments) without a
 * shell, as Looper runs its own git and an addon's `looper/exec`: a WSL
 * environment from Windows through wsl.exe in its distro, a Windows one from
 * WSL through interop (the program's .exe), anything else directly.
 */

/** Whether a program in the environment is on the other side of WSL from Looper, where only the variables WSLENV names get through. */
export function crossesWsl(env: Pick<Environment, 'kind'>, host: HostKind): boolean {
  return (env.kind === 'wsl' && host === 'windows') || (env.kind === 'windows' && host !== 'windows');
}

/** `base` with `extra` on top; across WSL, `extra`'s names are added to WSLENV so they get through. */
export function withCrossingVars(base: Record<string, string>, extra: Record<string, string> | undefined, crosses: boolean): Record<string, string> {
  const env = { ...base, ...extra };
  const names = Object.keys(extra ?? {});
  if (crosses && names.length) env.WSLENV = [base.WSLENV, ...names].filter(Boolean).join(':');
  return env;
}

/**
 * The command line that runs `argv` in the environment. `wslCwd`: for a WSL
 * environment from Windows, the folder (in the distro's form) wsl.exe starts
 * it in; the other ways take the folder as the process's own.
 */
export function envArgv(env: Pick<Environment, 'kind' | 'distro'>, host: HostKind, argv: string[], wslCwd?: string): string[] {
  if (env.kind === 'wsl' && host === 'windows') {
    return ['wsl.exe', ...(env.distro ? ['-d', env.distro] : []), ...(wslCwd ? ['--cd', wslCwd] : []), '--exec', ...argv];
  }
  // From WSL a Windows program is found by its .exe name.
  if (env.kind === 'windows' && host !== 'windows') return [/\.[a-z0-9]+$/i.test(argv[0]) ? argv[0] : `${argv[0]}.exe`, ...argv.slice(1)];
  return argv;
}

export interface EnvExecOptions {
  /** The working folder in the environment's own form. */
  cwd?: string;
  /** Variables on top of `baseEnv`; across WSL their names go in WSLENV. */
  env?: Record<string, string>;
  baseEnv: Record<string, string>;
  /** Written to its stdin, which then closes. */
  stdin?: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface EnvExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `argv` in the environment and collect its output. Rejects only when it
 * can't start, runs past the timeout or writes more than `maxBuffer`.
 */
export async function execInEnvironment(env: Pick<Environment, 'kind' | 'distro'>, host: HostKind, argv: string[], o: EnvExecOptions): Promise<EnvExecResult> {
  const viaWsl = env.kind === 'wsl' && host === 'windows';
  const line = envArgv(env, host, argv, viaWsl ? o.cwd : undefined);
  let cwd: string | undefined;
  if (o.cwd && !viaWsl) {
    // From WSL a Windows folder is started in through its /mnt path.
    cwd = env.kind === 'windows' && host !== 'windows' ? await convertWslPath(o.cwd, 'posix') : o.cwd;
    if (!cwd) throw new Error(`${o.cwd} can't be reached from WSL.`);
  }
  const vars = withCrossingVars(o.baseEnv, o.env, crossesWsl(env, host));
  const [command, ...args] = line;
  if (o.stdin === undefined) {
    const r = await execOffThread(command, args, { cwd, env: vars, timeout: o.timeoutMs, maxBuffer: o.maxBuffer, windowsHide: true });
    const e = r.error;
    if (e?.code === 'ENOENT') throw new Error(notFound(command, cwd));
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`${argv[0]} wrote more than ${Math.round(o.maxBuffer / 1024 / 1024)} MB.`);
    if (e?.killed) throw new Error(`${argv[0]} didn't finish within ${Math.round(o.timeoutMs / 1000)} s.`);
    // Any other code that isn't an exit code is one it couldn't start with (EACCES); a signal leaves none.
    if (typeof e?.code === 'string') throw new Error(e.message);
    return { code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: r.stdout, stderr: r.stderr };
  }
  return spawnWithInput(command, args, { cwd, env: vars, stdin: o.stdin, timeoutMs: o.timeoutMs, maxBuffer: o.maxBuffer, name: argv[0] });
}

/** Node says ENOENT for a program it can't find and for a working folder that doesn't exist. */
const notFound = (command: string, cwd: string | undefined): string =>
  `${command} isn't installed${command === 'wsl.exe' ? '' : ' on this machine'}${cwd ? `, or the folder ${cwd} doesn't exist` : ''}.`;

function spawnWithInput(
  command: string,
  args: string[],
  o: { cwd?: string; env: Record<string, string>; stdin: string; timeoutMs: number; maxBuffer: number; name: string },
): Promise<EnvExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawnOffThread(command, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: 'pipe' });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let failed: Error | null = null;
    const fail = (e: Error) => {
      if (failed) return;
      failed = e;
      clearTimeout(timer);
      child.kill();
    };
    const timer = setTimeout(() => fail(new Error(`${o.name} didn't finish within ${Math.round(o.timeoutMs / 1000)} s.`)), o.timeoutMs);
    const collect = (into: Buffer[]) => (d: Buffer) => {
      bytes += d.length;
      if (bytes > o.maxBuffer) fail(new Error(`${o.name} wrote more than ${Math.round(o.maxBuffer / 1024 / 1024)} MB.`));
      else into.push(d);
    };
    child.stdout!.on('data', collect(out));
    child.stderr!.on('data', collect(err));
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail(new Error(notFound(command, o.cwd)));
      else fail(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin!.end(o.stdin);
  });
}
