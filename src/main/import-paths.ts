import fs from 'node:fs';
import path from 'node:path';
import { convertWslPath, type HostKind } from '../engine/host';
import { tokenize } from '../shared/cmdline';
import { pathFlavor } from '../shared/environments';
import type { Environment, Settings } from '../shared/types';

/** Injection points for tests; production uses the real fs and wslpath. */
export interface ImportPathDeps {
  /** Existence check for a path in the host's own form. */
  exists: (hostPath: string) => boolean;
  /** Path conversion between the host's and a WSL distro's form. */
  convert: typeof convertWslPath;
}

const REAL_DEPS: ImportPathDeps = { exists: (p) => fs.existsSync(p), convert: convertWslPath };

function isAbsolute(flavor: 'posix' | 'windows', p: string): boolean {
  if (flavor === 'windows') return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  return p.startsWith('/');
}

/**
 * The .loopertask's folder in the environment's own path form, or undefined
 * when the environment cannot see the host's filesystem that way.
 */
async function dirInEnvironment(
  hostDir: string,
  env: Environment,
  host: HostKind,
  deps: ImportPathDeps,
): Promise<string | undefined> {
  if (env.kind === 'local') return hostDir;
  if (host === 'windows' && env.kind === 'wsl') return deps.convert(hostDir, 'posix', env.distro);
  if (host === 'wsl' && env.kind === 'windows') return deps.convert(hostDir, 'windows');
  return undefined;
}

/**
 * Whether a path in the environment's form exists, checked through the host's
 * filesystem. Undefined = could not be verified (translation failed), which
 * every caller treats as "leave it alone".
 */
async function existsInEnvironment(
  p: string,
  env: Environment,
  host: HostKind,
  deps: ImportPathDeps,
): Promise<boolean | undefined> {
  if (env.kind === 'local') return deps.exists(p);
  const hostPath =
    host === 'windows' && env.kind === 'wsl'
      ? await deps.convert(p, 'windows', env.distro)
      : host === 'wsl' && env.kind === 'windows'
        ? await deps.convert(p, 'posix')
        : undefined;
  return hostPath === undefined ? undefined : deps.exists(hostPath);
}

/**
 * Re-point the absolute paths of a command at the .loopertask's folder: a path
 * that does not exist in the environment, but whose file name does exist next
 * to the .loopertask, is replaced in place (quoting context preserved); every
 * other token is left untouched. Undefined = nothing changed.
 */
async function adjustCommand(
  command: string,
  flavor: 'posix' | 'windows',
  hostDir: string,
  targetDir: string,
  env: Environment,
  host: HostKind,
  deps: ImportPathDeps,
): Promise<string | undefined> {
  const parsed = tokenize(command);
  if (!parsed.ok) return undefined;
  const hostPath = host === 'windows' ? path.win32 : path.posix;
  const sep = flavor === 'windows' ? '\\' : '/';
  let out = command;
  let changed = false;
  for (const token of parsed.tokens) {
    if (!isAbsolute(flavor, token)) continue;
    const at = out.indexOf(token);
    if (at < 0) continue; // escaped beyond literal recognition
    if ((await existsInEnvironment(token, env, host, deps)) !== false) continue;
    const base = token.split(/[\\/]/).filter(Boolean).pop();
    if (!base || !deps.exists(hostPath.join(hostDir, base))) continue;
    const replacement = targetDir.replace(/[\\/]+$/, '') + sep + base;
    // An unquoted occurrence gets quotes when the new path needs them.
    const quoted = at > 0 && (out[at - 1] === '"' || out[at - 1] === "'");
    const text = !quoted && /\s/.test(replacement) ? `"${replacement}"` : replacement;
    out = out.slice(0, at) + text + out.slice(at + token.length);
    changed = true;
  }
  return changed ? out : undefined;
}

/**
 * Rewrite the paths of an imported task definition so it runs from wherever
 * the .loopertask file was opened:
 * - a working directory that does not exist (or is blank) becomes the file's
 *   own folder, in the environment's path form;
 * - an absolute path in the check command that does not exist is re-pointed
 *   at the same file name next to the .loopertask, when one is there.
 * Anything that cannot be verified — unreachable environment, failed path
 * translation — is left exactly as imported. Returns a new payload.
 */
export async function adjustImportedTaskPaths(
  payload: Record<string, unknown>,
  file: string,
  settings: Settings,
  host: HostKind,
  deps: ImportPathDeps = REAL_DEPS,
): Promise<Record<string, unknown>> {
  // The same environment the import sanitizer will settle on.
  const env =
    settings.environments.find((e) => e.id === payload.environmentId) ??
    settings.environments.find((e) => e.id === settings.defaultEnvironmentId);
  if (!env) return payload;
  const flavor = pathFlavor(env, host);
  if (!flavor) return payload;
  // Host paths follow the host's syntax, whatever platform this runs on.
  const hostPath = host === 'windows' ? path.win32 : path.posix;
  const hostDir = hostPath.dirname(hostPath.resolve(file));
  const targetDir = await dirInEnvironment(hostDir, env, host, deps);
  if (targetDir === undefined) return payload;

  const out = { ...payload };
  const cwd = typeof out.cwd === 'string' ? out.cwd : '';
  if (!cwd || !isAbsolute(flavor, cwd)) {
    out.cwd = targetDir;
  } else if ((await existsInEnvironment(cwd, env, host, deps)) === false) {
    out.cwd = targetDir;
  }

  const check = out.check;
  if (check && typeof check === 'object' && !Array.isArray(check)) {
    const command = (check as Record<string, unknown>).command;
    if (typeof command === 'string' && command) {
      const adjusted = await adjustCommand(command, flavor, hostDir, targetDir, env, host, deps);
      if (adjusted !== undefined) out.check = { ...check, command: adjusted };
    }
  }
  return out;
}
