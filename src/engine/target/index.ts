import type { HostKind } from '../host';
import type { Settings, Task } from '../../shared/types';
import type { GuideHookFormat, StopHookSpec } from './stop-hook';
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
  /** Target-native path to the run's bin/ dir (holds the done helper). */
  binDir: string;
  /** Name of the done command defined for this step (looper-done / looper-classify). */
  doneCommand: string;
  /** Statuses the done command accepts as its first argument. */
  doneStatuses: readonly string[];
  /** Command line(s), already in the target's shell syntax. */
  body: string;
}

export interface Target {
  readonly kind: 'wsl' | 'windows';
  readonly launcherExt: string;
  /** File name of a step's done helper in the run's bin/ dir. */
  doneHelperFile(command: string): string;
  /** Host path -> path as the target sees it. */
  toTargetPath(hostPath: string): string;
  /** Target-native path -> path the host process can read. Throws when there is none. */
  toHostPath(targetPath: string): string;
  /** Quote a literal for the target shell. */
  quote(s: string): string;
  /** Shell expression that expands to the contents of a file as ONE argument. */
  catFile(targetPath: string): string;
  /** Shell expression referencing an environment variable. */
  envRef(name: string): string;
  renderLauncher(spec: LauncherSpec): string;
  renderDoneHelper(statuses: readonly string[]): string;
  /** Helper that writes its arguments (or `fallback`) into the file named by the `envVar` variable. */
  renderTextHelper(envVar: string, fallback: string): string;
  /** Command for a claude hook: dump the hook's stdin JSON into the given file. */
  renderPipeHook(targetPath: string): string;
  /** File name of the Stop-hook gate script in the run's bin/ dir. */
  readonly stopHookFile: string;
  /**
   * Script for the claude Stop hook: block while background tasks are running,
   * remind once when looper-done was never called, otherwise record the payload.
   */
  renderStopHook(spec: StopHookSpec): string;
  /** Command for a claude hook (Stop gate, guidance): run the script written at `targetPath`. */
  stopHookCommand(targetPath: string): string;
  /** File name of the guidance hook script. */
  readonly guideHookFile: string;
  /**
   * Script for the PostToolUse guidance hook: take the waiting guidance file
   * and print it as additional context. `guidanceFile` unset = find it in
   * $LOOPER_RUN_DIR, so one script serves every run (codex trusts a hook
   * only while its command stays the same).
   */
  renderGuideHook(format: GuideHookFormat, guidanceFile?: string): string;
  /** File name of the subagent guard script in the run's bin/ dir. */
  readonly guardHookFile: string;
  /**
   * Script for the claude PreToolUse guard on Bash: deny a subagent's call
   * whose input names one of `commands` (the step's signal helpers), with
   * `message` as the reason.
   */
  renderSubagentGuard(commands: readonly string[], message: string): string;
  /**
   * Shell command a codex hook definition runs: the script at `targetPath`,
   * unquoted so it fits a TOML literal string. Null when the path would need
   * quoting.
   */
  codexHookCommand(targetPath: string): string | null;
  /** File name of the codex notify hook script in the run's bin/ dir. */
  readonly notifyHookFile: string;
  /**
   * Script for the codex notify hook: codex invokes it with the event JSON as
   * its last argument; the script drops that payload into `stopJson`.
   */
  renderNotifyHook(stopJson: string): string;
  /** Argv for codex's `notify` config entry: how to run the hook script at `targetPath`. */
  notifyCommand(targetPath: string): string[];
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
export type { GuideHookFormat, StopHookSpec };
