import type { HostKind } from '../host';
import type { Settings, Task } from '../../shared/types';
import type { StopHookSpec } from './stop-hook';
import { resolveEnvironment } from '../../shared/environments';
import { BashTarget } from './bash';
import { WindowsTarget } from './windows';

export interface SpawnSpec {
  command: string;
  args: string[];
}

export interface LauncherSpec {
  taskId: string;
  runId: string;
  /** Target-native working directory. */
  cwd: string;
  env: Record<string, string>;
  /** Target-native path to the run's bin/ dir (holds the looper-done helper). */
  binDir: string;
  /** Command line(s), already in the target's shell syntax. */
  body: string;
}

export interface Target {
  readonly kind: 'wsl' | 'windows';
  readonly launcherExt: string;
  readonly doneHelperFile: string;
  /** Host path -> path as the target sees it. */
  toTargetPath(hostPath: string): string;
  /** Quote a literal for the target shell. */
  quote(s: string): string;
  /** Shell expression that expands to the contents of a file as ONE argument. */
  catFile(targetPath: string): string;
  /** Shell expression referencing an environment variable. */
  envRef(name: string): string;
  renderLauncher(spec: LauncherSpec): string;
  renderDoneHelper(): string;
  /** Command for a claude hook: dump the hook's stdin JSON into the given file. */
  renderPipeHook(targetPath: string): string;
  /** File name of the Stop-hook gate script in the run's bin/ dir. */
  readonly stopHookFile: string;
  /**
   * Script for the claude Stop hook: block while background tasks are running,
   * remind once when looper-done was never called, otherwise record the payload.
   */
  renderStopHook(spec: StopHookSpec): string;
  /** Command for the claude Stop hook: run the gate script written at `targetPath`. */
  stopHookCommand(targetPath: string): string;
  spawnSpec(launcherHostPath: string): SpawnSpec;
  /** Kill any process on the target still carrying LOOPER_RUN=<runId>. Best effort. */
  killLeftovers(runId: string): Promise<void>;
}

export interface TargetContext {
  host: HostKind;
}

/** Automount roots detected via wslpath ('' key = the default / host distro). */
const detectedMountPrefixes = new Map<string, string>();

export function setDetectedMountPrefix(distro: string | undefined, prefix: string): void {
  detectedMountPrefixes.set(distro ?? '', prefix);
}

function mountPrefixFor(env: { distro?: string; mountPrefix?: string }, key?: string): string | undefined {
  return env.mountPrefix ?? detectedMountPrefixes.get(key ?? '');
}

export function createTarget(task: Task, opts: { host: HostKind; settings: Settings }): Target {
  const env = resolveEnvironment(task, opts.settings);
  const ctx: TargetContext = { host: opts.host };
  switch (env.kind) {
    case 'windows':
      return new WindowsTarget(ctx, mountPrefixFor(env));
    case 'wsl':
      if (opts.host !== 'windows') {
        throw new Error(`environment "${env.name}" is a WSL bridge and only works from a Windows host`);
      }
      return new BashTarget(ctx, env.distro, env.shell, mountPrefixFor(env, env.distro));
    case 'local':
      return opts.host === 'windows' ? new WindowsTarget(ctx) : new BashTarget(ctx, undefined, env.shell);
  }
}

export { BashTarget, WindowsTarget };
export type { StopHookSpec };
