import type { HostKind } from '../host';
import type { Settings, Task } from '../../shared/types';
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
  /** Command for the claude Stop hook: touch the idle marker. */
  renderIdleHook(idleTargetPath: string): string;
  spawnSpec(launcherHostPath: string): SpawnSpec;
  /** Kill any process on the target still carrying LOOPER_RUN=<runId>. Best effort. */
  killLeftovers(runId: string): Promise<void>;
}

export interface TargetContext {
  host: HostKind;
  settings: Settings;
}

export function createTarget(task: Task, ctx: TargetContext): Target {
  if (task.target.kind === 'windows') return new WindowsTarget(ctx);
  return new BashTarget(ctx, task.target.distro ?? ctx.settings.defaultDistro, task.target.shell);
}

export { BashTarget, WindowsTarget };
