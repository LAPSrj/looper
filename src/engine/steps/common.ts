import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Settings, Task } from '../../shared/types';
import { hasPlaceholder, renderTemplate } from '../../shared/template';
import type { HostKind } from '../host';
import type { Logger } from '../log';
import type { SpawnSpec, Target } from '../target';
import { joinTarget } from '../target/paths';
import { killHostTree } from '../target/kill';
import { writeText } from '../store/fsutil';

export interface RunContext {
  task: Task;
  runId: string;
  /** Host path of the run directory. */
  runDir: string;
  target: Target;
  settings: Settings;
  host: HostKind;
  log: Logger;
  /** Template variables accumulated across steps (task, summary, context…). */
  vars: Record<string, unknown>;
}

/** Markers a parent claude session leaves behind; a looper agent is never a "child session". */
const NESTED_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'];

/** Environment for spawned steps: the host env minus nested-claude markers. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !NESTED_SESSION_VARS.includes(k)) env[k] = v;
  }
  return env;
}

export function runDirTarget(ctx: RunContext): string {
  return ctx.target.toTargetPath(ctx.runDir);
}

/** Target-native path of a file inside the run dir. */
export function targetFile(ctx: RunContext, ...parts: string[]): string {
  return joinTarget(ctx.target.kind, runDirTarget(ctx), ...parts);
}

export function baseEnv(ctx: RunContext): Record<string, string> {
  return {
    LOOPER_TASK: ctx.task.id,
    LOOPER_TASK_NAME: ctx.task.name,
    LOOPER_RUN: ctx.runId,
    LOOPER_RUN_DIR: runDirTarget(ctx),
    LOOPER_DONE_FILE: targetFile(ctx, 'done'),
    LOOPER_IDLE_FILE: targetFile(ctx, 'idle'),
  };
}

export interface Launcher {
  hostPath: string;
  spec: SpawnSpec;
}

/** Write the done helper + a launcher script into the run dir and return how to spawn it. */
export function writeLauncher(ctx: RunContext, name: string, body: string): Launcher {
  const helper = path.join(ctx.runDir, 'bin', ctx.target.doneHelperFile);
  writeText(helper, ctx.target.renderDoneHelper(), 0o755);
  const hostPath = path.join(ctx.runDir, name + ctx.target.launcherExt);
  writeText(
    hostPath,
    ctx.target.renderLauncher({
      taskId: ctx.task.id,
      runId: ctx.runId,
      cwd: ctx.task.cwd,
      env: baseEnv(ctx),
      binDir: targetFile(ctx, 'bin'),
      body,
    }),
    0o755,
  );
  return { hostPath, spec: ctx.target.spawnSpec(hostPath) };
}

/**
 * Render a prompt template. If it does not reference the check output itself,
 * the summary/context are appended so the model always sees them.
 */
export function buildPrompt(tpl: string, vars: Record<string, unknown>): string {
  let text = renderTemplate(tpl, vars);
  if (!hasPlaceholder(tpl, 'summary', 'context') && (vars.summary || vars.context !== undefined)) {
    text += '\n\n## Check output\n';
    if (vars.summary) text += `Summary: ${String(vars.summary)}\n`;
    if (vars.context !== undefined) {
      const c = vars.context;
      text += '\n' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '\n';
    }
  }
  return text;
}

/** Noise an interactive bash prints when it has no controlling terminal (check/classify run without a pty). */
const BASH_NOISE = /^bash: (cannot set terminal process group|no job control in this shell).*$\n?/gm;

export function stripShellNoise(stderr: string): string {
  return stderr.replace(BASH_NOISE, '');
}

export interface CapturedResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface CaptureOpts {
  timeoutMs: number;
  maxBytes?: number;
  /** Called after the host tree was killed on timeout (e.g. kill leftovers on the target). */
  onTimeout?: () => Promise<void>;
}

/** Spawn without a pty, capture stdout/stderr, enforce a timeout. Never throws. */
export function runCaptured(spec: SpawnSpec, opts: CaptureOpts): Promise<CapturedResult> {
  const max = opts.maxBytes ?? 1_048_576;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: Omit<CapturedResult, 'stdout' | 'stderr' | 'timedOut' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr: stripShellNoise(stderr), timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      if (child?.pid) await killHostTree(child.pid);
      try {
        await opts.onTimeout?.();
      } catch {
        /* best effort */
      }
      setTimeout(() => finish({ code: null, signal: 'TIMEOUT', error: 'timed out' }), 2000);
    }, opts.timeoutMs);
    try {
      child = spawn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnv(),
      });
    } catch (e) {
      finish({ code: null, signal: null, error: (e as Error).message });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString('utf8');
    });
    child.on('error', (e) => finish({ code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) =>
      finish({ code, signal, error: timedOut ? 'timed out' : undefined }),
    );
  });
}
