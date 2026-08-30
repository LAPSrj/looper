import fs from 'node:fs';
import path from 'node:path';
import type * as PtyNS from 'node-pty';
import { stripAnsi } from '../../shared/ansi';
import { FileSignalWatcher } from '../signals';
import { writeJsonAtomic, writeText } from '../store/fsutil';
import { killHostTree } from '../target/kill';
import { buildPrompt, childEnv, targetFile, writeLauncher, type RunContext } from './common';

export type AgentEndReason = 'done' | 'idle-timeout' | 'max-runtime' | 'exited' | 'stopped' | 'error';

export interface AgentEnd {
  reason: AgentEndReason;
  exitCode: number | null;
  message?: string;
  durationMs: number;
  wasHeld: boolean;
}

export interface AgentHandle {
  runId: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(reason?: AgentEndReason, message?: string): Promise<void>;
  finished: Promise<AgentEnd>;
  readonly held: boolean;
}

export interface AgentCallbacks {
  onData: (data: string) => void;
  onHold?: () => void;
  onResume?: () => void;
}

export function systemFooter(taskName: string, runId: string, headless: boolean): string {
  const lines = [
    `You were started by Looper for the task "${taskName}" (run ${runId}). This is a one-shot, unattended session: nobody is typing at the other end unless they choose to intervene.`,
    'Do the work described in the prompt without asking for confirmation. Make reasonable decisions yourself.',
  ];
  if (headless) {
    lines.push('When you are finished, end your response with a one-line summary of what you did.');
  } else {
    lines.push(
      'When you are finished — or if there is nothing to do — your VERY LAST action must be to run the shell command:',
      '    looper-done "<one line summary of what you did>"',
      'This signals Looper to close this session. Do not wait for further input after running it.',
    );
  }
  return lines.join('\n');
}

/** The workspace-trust dialog claude shows on first interactive use of a directory. */
export const TRUST_PROMPT_RE = /trust\s+this\s+folder/i;
/**
 * Footer of every interactive claude prompt (permission requests, questions,
 * dialogs). A prompt on screen means the agent is waiting for a human — the
 * turn has not ended so the Stop hook will not fire; treat it as idle.
 */
export const WAITING_PROMPT_RE = /Esc\s+to\s+cancel/i;
const TRUST_WINDOW = 6000;
/** Printable output after a prompt that means "the agent moved on" (auto mode approved it, or a human answered). */
const PROMPT_RESOLVED_CHARS = 300;

let ptyModule: typeof PtyNS | null = null;
function loadPty(): typeof PtyNS {
  if (!ptyModule) {
    // Lazy so the CLI's non-serve commands never load the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as typeof PtyNS;
  }
  return ptyModule;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

export async function startAgent(ctx: RunContext, cb: AgentCallbacks): Promise<AgentHandle> {
  const { task, target, settings } = ctx;
  const a = task.agent;
  const headless = a.mode === 'headless';

  writeText(path.join(ctx.runDir, 'prompt.txt'), buildPrompt(a.prompt, ctx.vars));
  writeText(path.join(ctx.runDir, 'system.txt'), systemFooter(task.name, ctx.runId, headless));
  writeJsonAtomic(path.join(ctx.runDir, 'settings.json'), {
    // The done signal must never be blocked by a permission prompt.
    permissions: { allow: ['Bash(looper-done:*)', 'Bash(looper-done)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: target.renderIdleHook(targetFile(ctx, 'idle')) }] }],
    },
  });

  const q = (s: string) => target.quote(s);
  const parts: string[] = [settings.claudeCommand];
  if (a.model) parts.push('--model', q(a.model));
  if (a.permissionMode) parts.push('--permission-mode', q(a.permissionMode));
  parts.push('--append-system-prompt', target.catFile(targetFile(ctx, 'system.txt')));
  parts.push('--settings', q(targetFile(ctx, 'settings.json')));
  if (headless) parts.push('-p', '--output-format', 'stream-json', '--verbose');
  for (const extra of a.extraArgs) parts.push(q(extra));
  parts.push(target.catFile(targetFile(ctx, 'prompt.txt')));
  const body = (target.kind === 'windows' ? '' : 'exec ') + parts.join(' ');
  const launcher = writeLauncher(ctx, 'run', body);

  const out = fs.createWriteStream(path.join(ctx.runDir, 'output.log'), { flags: 'a' });
  out.on('error', () => {
    /* never fatal */
  });

  const pty = loadPty();
  const proc = pty.spawn(launcher.spec.command, launcher.spec.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: ctx.runDir,
    env: childEnv(),
  });
  ctx.log.info(`[${task.id}] agent pid ${proc.pid}: ${launcher.spec.command} ${launcher.spec.args.join(' ')}`);

  const started = Date.now();
  let ended = false;
  let held = false;
  let exitCode: number | null = null;
  let exited = false;
  let lastInputAt = 0;
  let idleSince: number | null = null;
  let resolveFinished!: (e: AgentEnd) => void;
  const finished = new Promise<AgentEnd>((r) => (resolveFinished = r));
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => (exitResolve = r));

  const watcher = new FileSignalWatcher(
    path.join(ctx.runDir, 'done'),
    path.join(ctx.runDir, 'idle'),
    settings.signalPollMs,
  );
  const idleGraceMs = a.idleGraceMin * 60_000;

  const killTree = async (): Promise<void> => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    await killHostTree(proc.pid);
    await withTimeout(target.killLeftovers(ctx.runId), 20_000);
    await withTimeout(exitPromise, 3000);
  };

  const finish = async (reason: AgentEndReason, message?: string): Promise<void> => {
    if (ended) return;
    ended = true;
    watcher.stop();
    clearTimeout(maxTimer);
    if (!exited) await killTree();
    out.end();
    resolveFinished({
      reason,
      exitCode,
      message,
      durationMs: Date.now() - started,
      wasHeld: held,
    });
  };

  const maxTimer = setTimeout(() => void finish('max-runtime', `exceeded ${a.maxRuntimeMin} min`), a.maxRuntimeMin * 60_000);

  let trustHandled = headless || !settings.autoTrustWorkspace;
  let recent = '';
  let promptSince: number | null = null;
  let printableSincePrompt = 0;
  proc.onData((d) => {
    out.write(d);
    if (!headless) {
      const plain = stripAnsi(d);
      recent = (recent + plain).slice(-TRUST_WINDOW);
      if (!trustHandled && TRUST_PROMPT_RE.test(recent)) {
        trustHandled = true;
        ctx.log.info(`[${task.id}] answering the workspace trust dialog for ${task.cwd}`);
        // Options are "No, exit" (preselected) / "Yes, I trust this folder": Down, then Enter.
        setTimeout(() => !ended && proc.write('\x1b[B'), 400);
        setTimeout(() => {
          if (ended) return;
          proc.write('\r');
          promptSince = null;
          recent = '';
        }, 800);
      } else if (WAITING_PROMPT_RE.test(plain)) {
        // A prompt is on screen (re-renders keep hitting this branch while it waits).
        if (promptSince === null) {
          promptSince = Date.now();
          ctx.log.info(`[${task.id}] agent is waiting on a prompt`);
        }
        printableSincePrompt = 0;
      } else if (promptSince !== null) {
        printableSincePrompt += plain.replace(/\s+/g, '').length;
        if (printableSincePrompt > PROMPT_RESOLVED_CHARS) {
          promptSince = null;
          ctx.log.info(`[${task.id}] prompt resolved; agent continues`);
        }
      }
    }
    try {
      cb.onData(d);
    } catch {
      /* UI listener errors never affect the run */
    }
  });
  proc.onExit(({ exitCode: code }) => {
    exited = true;
    exitCode = code;
    exitResolve?.();
    if (ended) return;
    if (headless) void finish(code === 0 ? 'done' : 'exited', code === 0 ? undefined : `claude exited ${code}`);
    else void finish('exited', `claude exited ${code}`);
  });

  if (!headless) {
    watcher.start({
      onDone: (msg) => void finish('done', msg),
      onIdle: (mtime) => {
        if (mtime <= lastInputAt) return;
        if (idleSince === null || mtime > idleSince) idleSince = mtime;
      },
      onTick: (now) => {
        if (held) return;
        const since = idleSince ?? promptSince;
        if (since === null) return;
        if (now - since < idleGraceMs) return;
        if (a.onIdleTimeout === 'finish') {
          void finish('idle-timeout', `idle for ${a.idleGraceMin} min without looper-done`);
        } else {
          held = true;
          cb.onHold?.();
        }
      },
    });
  }

  return {
    runId: ctx.runId,
    pid: proc.pid,
    get held() {
      return held;
    },
    write(data: string) {
      if (ended) return;
      lastInputAt = Date.now();
      idleSince = null;
      promptSince = null;
      if (held) {
        held = false;
        cb.onResume?.();
      }
      proc.write(data);
    },
    resize(cols: number, rows: number) {
      if (ended) return;
      try {
        proc.resize(Math.max(2, cols), Math.max(2, rows));
      } catch {
        /* ignore */
      }
    },
    stop(reason: AgentEndReason = 'stopped', message?: string) {
      return finish(reason, message);
    },
    finished,
  };
}
