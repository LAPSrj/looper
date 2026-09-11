import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Note, Settings, Task } from '../../shared/types';
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
  /** Aborts when the user stops the task mid-cycle. */
  signal?: AbortSignal;
  /** Agent step, claude-code only: resume this conversation, or start a new one under this id. */
  agentSession?: { id: string; resume: boolean };
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

/**
 * Per-step file prefix inside the run dir: the agent step owns the bare names
 * (done, stop.json, output.txt…), the classifier prefixes everything with
 * `classify-` so the two steps of one run can never collide.
 */
export function baseEnv(ctx: RunContext, prefix = ''): Record<string, string> {
  return {
    LOOPER_TASK: ctx.task.id,
    LOOPER_TASK_NAME: ctx.task.name,
    LOOPER_RUN: ctx.runId,
    LOOPER_RUN_DIR: runDirTarget(ctx),
    LOOPER_DONE_FILE: targetFile(ctx, prefix + 'done'),
    LOOPER_STOP_FILE: targetFile(ctx, prefix + 'stop.json'),
  };
}

export interface Launcher {
  hostPath: string;
  spec: SpawnSpec;
}

/** The done command of the agent step (and of plain check launchers). */
export const AGENT_DONE = { command: 'looper-done', statuses: ['success', 'warning', 'error'] as const };

/** The command an agent that may finish its task for good calls (task completion). */
export const AGENT_COMPLETE = 'looper-complete';

export interface LauncherOpts {
  /** Step file prefix ('' = agent, 'classify-' = classifier). */
  prefix?: string;
  /** Done command defined by the launcher and written to bin/. */
  doneCommand?: string;
  doneStatuses?: readonly string[];
  /** Completion command written to bin/. Unset = the agent cannot complete the task. */
  completeCommand?: string;
}

/**
 * Write the done helper + a launcher script into the run dir and return how to
 * spawn it. The task's env vars override `extraEnv` (e.g. a harness's env
 * vars); neither can override the LOOPER_* variables.
 */
export function writeLauncher(
  ctx: RunContext,
  name: string,
  body: string,
  extraEnv: Record<string, string> = {},
  opts: LauncherOpts = {},
): Launcher {
  const prefix = opts.prefix ?? '';
  const doneCommand = opts.doneCommand ?? AGENT_DONE.command;
  const doneStatuses = opts.doneStatuses ?? AGENT_DONE.statuses;
  const helper = path.join(ctx.runDir, 'bin', ctx.target.doneHelperFile(doneCommand));
  writeText(helper, ctx.target.renderDoneHelper(doneStatuses), 0o755);
  const locked = baseEnv(ctx, prefix);
  if (opts.completeCommand) {
    locked.LOOPER_COMPLETE_FILE = targetFile(ctx, prefix + 'complete');
    writeText(
      path.join(ctx.runDir, 'bin', ctx.target.doneHelperFile(opts.completeCommand)),
      ctx.target.renderTextHelper('LOOPER_COMPLETE_FILE', 'completed'),
      0o755,
    );
  }
  const hostPath = path.join(ctx.runDir, name + ctx.target.launcherExt);
  writeText(
    hostPath,
    ctx.target.renderLauncher({
      taskId: ctx.task.id,
      runId: ctx.runId,
      cwd: ctx.task.cwd,
      env: { ...extraEnv, ...ctx.task.env, ...locked },
      binDir: targetFile(ctx, 'bin'),
      doneCommand,
      doneStatuses,
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

/** The task's one-off guidance, appended after everything else so it wins. */
export function noteSection(note: Note | undefined): string {
  if (!note) return '';
  return (
    '\n\n## One-off guidance for this run\n' +
    'The user attached this note to this specific run. It applies to this run only and overrides any conflicting instruction above.\n\n' +
    note.text
  );
}

/**
 * What an interactive bash (`-i`) prints when it has no controlling terminal.
 * The default shell is interactive so ~/.bashrc is read; check, classify and
 * headless agents run without a pty, so every one of them would carry these.
 */
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
  /** Aborting kills the process tree (the user stopped the task). */
  signal?: AbortSignal;
  /** Called after the host tree was killed on timeout or abort (e.g. kill leftovers on the target). */
  onKill?: () => Promise<void>;
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
    let onAbort: (() => void) | null = null;
    const finish = (r: Omit<CapturedResult, 'stdout' | 'stderr' | 'timedOut' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stdout, stderr: stripShellNoise(stderr), timedOut, durationMs: Date.now() - started });
    };
    /** Kill the tree, run the caller's cleanup, and force an end if 'close' never comes. */
    const killTree = async (endSignal: string, error: string) => {
      if (settled) return;
      if (child?.pid) await killHostTree(child.pid);
      try {
        await opts.onKill?.();
      } catch {
        /* best effort */
      }
      setTimeout(() => finish({ code: null, signal: endSignal, error }), 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree('TIMEOUT', 'timed out');
    }, opts.timeoutMs);
    if (opts.signal?.aborted) {
      finish({ code: null, signal: 'ABORTED', error: 'stopped' });
      return;
    }
    onAbort = () => void killTree('ABORTED', 'stopped');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
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
