import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type * as PtyNS from 'node-pty';
import type { Note } from '../../shared/types';
import { autoTrustWorkspace, resolveEnvironment, resolveHarness } from '../../shared/environments';
import { TerminalHost } from '../terminal-host';
import { FileSignalWatcher } from '../signals';
import { writeJsonAtomic, writeText } from '../store/fsutil';
import { killHostTree } from '../target/kill';
import type { SpawnSpec } from '../target';
import { buildPrompt, childEnv, stripShellNoise, targetFile, writeLauncher, type RunContext } from './common';

export type AgentEndReason = 'done' | 'idle-timeout' | 'max-runtime' | 'exited' | 'stopped' | 'error';

/** Outcome the agent reports via `looper-done <status>`. */
export type DoneStatus = 'success' | 'warning' | 'error';

const DONE_STATUSES: ReadonlySet<string> = new Set(['success', 'warning', 'error']);

/**
 * The done file as the helper writes it: the status on the first line, the
 * headline on the rest. A file without a status line (e.g. written by hand)
 * reads as success.
 */
export function parseDoneSignal(text: string): { status: DoneStatus; message: string } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const first = (nl === -1 ? t : t.slice(0, nl)).trim();
  if (DONE_STATUSES.has(first)) {
    return { status: first as DoneStatus, message: nl === -1 ? '' : t.slice(nl + 1).trim() };
  }
  return { status: 'success', message: t };
}

export interface AgentEnd {
  reason: AgentEndReason;
  exitCode: number | null;
  /** Only for reason 'done': the status the agent gave looper-done (success when it gave none). */
  doneStatus?: DoneStatus;
  /** One short phrase stating the outcome: the `looper-done` argument, or an engine message. */
  headline?: string;
  /** The agent's final message, i.e. the detailed report of the run. Markdown. */
  body?: string;
  /** Set when the run failed because the usage limit was hit: epoch ms of when to try again. */
  retryAtMs?: number;
  durationMs: number;
  wasHeld: boolean;
}

export interface AgentHandle {
  runId: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(reason?: AgentEndReason, headline?: string): Promise<void>;
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
    'When you are finished, or if there is nothing to do, run the shell command:',
    '    looper-done <status> "<headline>"',
    'The status is success, warning or error. success: everything was fully done. warning: the job was fully done, but the user should read your report. error: you could not complete the job (blocked, failed, gave up) — say why in your report.',
    'The headline is one short phrase stating the outcome, e.g. "Fixed 3 flaky tests" or "Nothing to do". State the outcome, not that you are done (no "Done:", "Completed:", etc.).',
    "Then write your final message: a detailed report of what you did, what you found and what is left open, in Markdown. Looper records it as the run's summary.",
  ];
  if (!headless) {
    lines.push('Looper closes this session when that message ends. Do not run anything after looper-done and do not wait for further input.');
  }
  return lines.join('\n');
}

/** The full prompt the agent gets: the rendered template plus the run's one-off note. */
export function agentPrompt(ctx: RunContext): string {
  return buildPrompt(ctx.task.agent.prompt, ctx.vars) + noteSection(ctx.task.note);
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

/** Longest headline shown in lists; anything past it is cut. */
export const HEADLINE_MAX = 120;

/** First non-empty line of `text`, without Markdown heading markers, capped at HEADLINE_MAX. */
export function headlineOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > HEADLINE_MAX ? line.slice(0, HEADLINE_MAX - 1).trimEnd() + '…' : line;
}

/** After `looper-done`, how long to wait for the final message (the turn's Stop hook) before ending headline-only. */
const DONE_GRACE_MS = 120_000;

/** Retry margin past the advertised usage-limit reset, so the retry lands safely after it. */
const USAGE_LIMIT_RETRY_MARGIN_MS = 60_000;

/** The workspace-trust dialog claude shows on first interactive use of a directory. */
export const TRUST_PROMPT_RE = /trust\s+this\s+folder/i;
/**
 * Footer of every interactive claude prompt (permission requests, questions,
 * dialogs). A prompt on screen means the agent is waiting for a human — the
 * turn has not ended so the Stop hook will not fire; treat it as idle.
 */
export const WAITING_PROMPT_RE = /Esc\s+to\s+cancel/i;
/**
 * The usage-limit banner an interactive claude shows when a request is
 * rejected, e.g. "You've hit your session limit · resets 5:50am (America/...)".
 * The "resets <time>" tail is required so ordinary conversation text about
 * limits cannot end a run.
 */
export const USAGE_LIMIT_RE =
  /(?:hit|reached) (?:your|the) [\w-]*\s?limit\b[^\n]{0,80}?resets(?:\s+at)?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i;
/** Fallback wait when the banner shows no parseable reset time. */
const USAGE_LIMIT_FALLBACK_MS = 3_600_000;

/** Epoch ms of the "resets 5:50am" wall-clock time in `text` (next occurrence, local), or null. */
export function parseUsageLimitReset(text: string, now: number): number | null {
  const m = /resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59 || (ampm && hour > 12)) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}
const PTY_COLS = 120;
const PTY_ROWS = 32;

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

/** What the agent step needs from a running process, whether it sits behind a pty or plain pipes. */
interface AgentProc {
  /** 0 when the spawn itself failed. */
  readonly pid: number;
  onStdout(cb: (data: string) => void): void;
  onStderr(cb: (data: string) => void): void;
  /** Fires once, after all output has been delivered. */
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Interactive: a real terminal, so the TUI renders and can be typed into. */
function spawnPty(spec: SpawnSpec, cwd: string): AgentProc {
  const pty = loadPty();
  const proc = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: childEnv(),
  });
  return {
    pid: proc.pid,
    onStdout: (cb) => proc.onData(cb),
    onStderr: () => {},
    onExit: (cb) => proc.onExit(({ exitCode }) => cb(exitCode)),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  };
}

/**
 * Headless: plain pipes. A pty (ConPTY on Windows) re-renders output as a
 * screen, hard-wrapping every long stream-json line at the terminal width,
 * which makes the result object unparseable. Pipes deliver the bytes as written.
 */
function spawnPiped(spec: SpawnSpec, cwd: string, onError: (e: Error) => void): AgentProc {
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let exitCb: ((code: number | null) => void) | null = null;
  let exitFired = false;
  const fireExit = (code: number | null): void => {
    if (exitFired) return;
    exitFired = true;
    exitCb?.(code);
  };
  child.on('error', (e) => {
    onError(e);
    fireExit(null);
  });
  // 'close' rather than 'exit': the stdio streams have been drained by then.
  child.on('close', (code) => fireExit(code));
  return {
    pid: child.pid ?? 0,
    onStdout: (cb) => child.stdout.on('data', cb),
    onStderr: (cb) => child.stderr.on('data', cb),
    onExit: (cb) => {
      exitCb = cb;
    },
    write: () => {},
    resize: () => {},
    kill: () => child.kill(),
  };
}

export async function startAgent(ctx: RunContext, cb: AgentCallbacks): Promise<AgentHandle> {
  const { task, target, settings } = ctx;
  const a = task.agent;
  const headless = a.mode === 'headless';
  const env = resolveEnvironment(task, settings);
  const harness = resolveHarness(task, env);
  const claude = harness.kind === 'claude-code';

  // Claude Code gets its instructions as a system prompt; other harnesses have
  // no equivalent flag, so the footer is prepended to the prompt itself.
  const footer = systemFooter(task.name, ctx.runId, headless);
  const promptText = agentPrompt(ctx);
  writeText(path.join(ctx.runDir, 'prompt.txt'), claude ? promptText : footer + '\n\n' + promptText);
  if (claude) {
    writeText(path.join(ctx.runDir, 'system.txt'), footer);
    // The Stop-hook gate: blocks the turn from ending while background tasks
    // run (ending the session would kill them), reminds once when looper-done
    // was never called, and records allowed stops in stop.json — whose payload
    // carries last_assistant_message (the run's report) and whose mtime
    // doubles as the idle signal.
    writeText(
      path.join(ctx.runDir, 'bin', target.stopHookFile),
      target.renderStopHook({
        stopJson: targetFile(ctx, 'stop.json'),
        doneFile: targetFile(ctx, 'done'),
        reminderFile: targetFile(ctx, 'stop-reminded'),
      }),
      0o755,
    );
    writeJsonAtomic(path.join(ctx.runDir, 'settings.json'), {
      // The done signal must never be blocked by a permission prompt, and the
      // Bash sandbox must never confine it: the run dir sits outside the
      // sandbox's writable set (EROFS), e.g. on /mnt/c for a WSL agent.
      permissions: { allow: ['Bash(looper-done:*)', 'Bash(looper-done)'] },
      sandbox: { excludedCommands: ['looper-done'] },
      hooks: {
        // The SessionStart payload names the session's transcript file: the Messages view reads it live.
        SessionStart: [{ hooks: [{ type: 'command', command: target.renderPipeHook(targetFile(ctx, 'session.json')) }] }],
        Stop: [{ hooks: [{ type: 'command', command: target.stopHookCommand(targetFile(ctx, 'bin', target.stopHookFile)) }] }],
      },
    });
  }

  const q = (s: string) => target.quote(s);
  const parts: string[] = [harness.command];
  if (claude) {
    if (a.model) parts.push('--model', q(a.model));
    if (a.permissionMode) parts.push('--permission-mode', q(a.permissionMode));
    parts.push('--append-system-prompt', target.catFile(targetFile(ctx, 'system.txt')));
    parts.push('--settings', q(targetFile(ctx, 'settings.json')));
    if (headless) parts.push('-p', '--output-format', 'stream-json', '--verbose');
  } else if (harness.kind === 'codex') {
    if (headless) parts.push('exec');
    if (a.model) parts.push('--model', q(a.model));
  }
  for (const arg of harness.args) parts.push(q(arg));
  for (const extra of a.extraArgs) parts.push(q(extra));
  parts.push(target.catFile(targetFile(ctx, 'prompt.txt')));
  const body = (target.kind === 'windows' ? '' : 'exec ') + parts.join(' ');
  const launcher = writeLauncher(ctx, 'run', body, harness.env);

  const out = fs.createWriteStream(path.join(ctx.runDir, 'output.log'), { flags: 'a' });
  out.on('error', () => {
    /* never fatal */
  });
  // Headless output is stream-json: one huge JSON object per line. Running it
  // through a terminal would wrap it into thousands of rows, so output.txt is
  // written straight from the stream. Interactive output is a TUI and needs
  // the terminal emulation, which lives in a worker thread.
  const cleanOut = headless
    ? fs.createWriteStream(path.join(ctx.runDir, 'output.txt'), { flags: 'w' })
    : null;
  cleanOut?.on('error', () => {
    /* never fatal */
  });
  // The trust dialog and the waiting-prompt footer are Claude Code UI; other
  // harnesses end only via looper-done, process exit or the max runtime.
  const screenEnabled = !headless && claude;
  const host = headless
    ? null
    : new TerminalHost({
        file: path.join(ctx.runDir, 'output.txt'),
        cols: PTY_COLS,
        rows: PTY_ROWS,
        screen: screenEnabled,
        onError: (e) => ctx.log.warn(`[${task.id}] terminal worker failed: ${e.message}`),
      });

  let spawnError: string | undefined;
  const proc = headless
    ? spawnPiped(launcher.spec, ctx.runDir, (e) => {
        ctx.log.error(`[${task.id}] cannot start ${harness.name}: ${e.message}`);
        spawnError = e.message;
      })
    : spawnPty(launcher.spec, ctx.runDir);
  ctx.log.info(`[${task.id}] agent pid ${proc.pid}: ${launcher.spec.command} ${launcher.spec.args.join(' ')}`);

  const started = Date.now();
  let ended = false;
  let held = false;
  let exitCode: number | null = null;
  let exited = false;
  let lastInputAt = 0;
  let idleSince: number | null = null;
  let headlessResult: string | undefined;
  let headlessResultIsError = false;
  /** Epoch ms when a rejected usage limit resets, from the stream's rate_limit_event lines. */
  let usageLimitResetMs: number | null = null;
  let streamBuf = '';
  let prevEndedNewline = false;
  /** Latest last_assistant_message seen from the Stop hook (interactive). */
  let lastMessage: string | undefined;
  /** Set once looper-done has been seen: mtime of the done file, its status and headline. */
  let doneMtime: number | null = null;
  let doneStatus: DoneStatus | undefined;
  let doneHeadline: string | undefined;
  let doneTimer: NodeJS.Timeout | null = null;
  let resolveFinished!: (e: AgentEnd) => void;
  const finished = new Promise<AgentEnd>((r) => (resolveFinished = r));
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => (exitResolve = r));

  const watcher = new FileSignalWatcher(
    path.join(ctx.runDir, 'done'),
    path.join(ctx.runDir, 'stop.json'),
    settings.signalPollMs,
  );
  const idleGraceMs = a.idleGraceMin * 60_000;

  let trustHandled = headless || !autoTrustWorkspace(harness);
  let promptSince: number | null = null;

  const killTree = async (): Promise<void> => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    if (proc.pid > 0) await killHostTree(proc.pid);
    await withTimeout(target.killLeftovers(ctx.runId), 20_000);
    await withTimeout(exitPromise, 3000);
  };

  const finish = async (
    reason: AgentEndReason,
    headline?: string,
    body?: string,
    retryAtMs?: number,
  ): Promise<void> => {
    if (ended) return;
    ended = true;
    watcher.stop();
    clearTimeout(maxTimer);
    if (doneTimer) clearTimeout(doneTimer);
    if (!exited) await killTree();
    out.end();
    cleanOut?.end();
    await host?.close();
    resolveFinished({
      reason,
      exitCode,
      doneStatus: reason === 'done' ? doneStatus : undefined,
      headline,
      body,
      retryAtMs,
      durationMs: Date.now() - started,
      wasHeld: held,
    });
  };

  /**
   * Headless: the final response is the report. `looper-done` (if the agent ran
   * it) names the headline; otherwise the response's first line does.
   */
  const finishHeadless = async (code: number | null): Promise<void> => {
    if (spawnError) {
      await finish('error', spawnError);
      return;
    }
    const doneText = await fs.promises.readFile(path.join(ctx.runDir, 'done'), 'utf8').catch(() => '');
    const done = doneText.trim() ? parseDoneSignal(doneText) : null;
    if (done) doneStatus = done.status;
    const body = headlessResult?.trim() || undefined;
    if (headlessResultIsError && usageLimitResetMs !== null) {
      const headline = headlineOf(body) ?? 'usage limit reached';
      ctx.log.error(`[${task.id}] ${headline}; retrying after ${new Date(usageLimitResetMs).toISOString()}`);
      await finish('error', headline, body, usageLimitResetMs + USAGE_LIMIT_RETRY_MARGIN_MS);
      return;
    }
    if (code === 0) {
      await finish('done', (done && headlineOf(done.message)) ?? headlineOf(body), body);
    } else {
      await finish('exited', `${harness.name} exited ${code}`, body);
    }
  };

  const maxTimer = setTimeout(() => void finish('max-runtime', `exceeded ${a.maxRuntimeMin} min`), a.maxRuntimeMin * 60_000);

  const takeResult = (line: string): void => {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'rate_limit_event') {
        const info = obj.rate_limit_info;
        if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
          usageLimitResetMs = info.resetsAt * 1000;
        }
      } else if (obj.type === 'result' && typeof obj.result === 'string') {
        headlessResult = obj.result;
        headlessResultIsError = obj.is_error === true;
      }
    } catch {
      /* not JSON: a shell warning or a torn line */
    }
  };

  /** Headless stream to the terminal tab: pipes carry bare LF, xterm needs CRLF; blank runs collapse. */
  const showHeadless = (d: string): void => {
    let display = d.replace(/(\r?\n)+/g, '\r\n');
    if (prevEndedNewline) display = display.replace(/^\r\n/, '');
    prevEndedNewline = /\r?\n$/.test(d);
    if (display) cb.onData(display);
  };

  proc.onStdout((d) => {
    out.write(d);
    if (!ended) host?.write(d);
    if (headless) {
      streamBuf += d;
      let nl: number;
      while ((nl = streamBuf.indexOf('\n')) !== -1) {
        const line = streamBuf.slice(0, nl).trimEnd();
        streamBuf = streamBuf.slice(nl + 1);
        if (cleanOut && !cleanOut.writableEnded) cleanOut.write(line + '\n');
        if (line) takeResult(line);
      }
    }
    try {
      if (headless) showHeadless(d);
      else cb.onData(d);
    } catch {
      /* UI listener errors never affect the run */
    }
  });
  // Only the piped (headless) process has a separate stderr: shell and harness
  // diagnostics. They go to the raw log and the terminal tab, never to output.txt.
  // Whole lines only, so bash's job-control warnings can be dropped even when a
  // chunk boundary falls inside one.
  let stderrBuf = '';
  const passStderr = (text: string): void => {
    const cleaned = stripShellNoise(text);
    if (!cleaned) return;
    out.write(cleaned);
    try {
      showHeadless(cleaned);
    } catch {
      /* UI listener errors never affect the run */
    }
  };
  proc.onStderr((d) => {
    stderrBuf += d;
    const nl = stderrBuf.lastIndexOf('\n');
    if (nl === -1) return;
    passStderr(stderrBuf.slice(0, nl + 1));
    stderrBuf = stderrBuf.slice(nl + 1);
  });
  proc.onExit((code) => {
    exited = true;
    exitCode = code;
    exitResolve?.();
    if (stderrBuf) {
      passStderr(stderrBuf);
      stderrBuf = '';
    }
    if (headless) {
      // The final result line may still be in streamBuf without a trailing \n.
      const remaining = streamBuf.trimEnd();
      streamBuf = '';
      if (remaining) {
        if (cleanOut && !cleanOut.writableEnded) cleanOut.write(remaining + '\n');
        if (!headlessResult) takeResult(remaining);
      }
    }
    if (ended) return;
    if (headless) {
      void finishHeadless(code);
    } else if (doneMtime !== null) {
      // Signalled done, then exited before the turn ended: headline only.
      void finish('done', doneHeadline);
    } else {
      void finish('exited', `${harness.name} exited ${code}`);
    }
  });

  if (!headless) {
    watcher.start({
      onDone: (msg, mtime) => {
        if (ended || doneMtime !== null) return;
        doneMtime = mtime;
        const parsed = parseDoneSignal(msg);
        doneStatus = parsed.status;
        doneHeadline = headlineOf(parsed.message) ?? 'done';
        ctx.log.info(`[${task.id}] looper-done ${doneStatus} "${doneHeadline}"; waiting for the final message`);
        doneTimer = setTimeout(() => void finish('done', doneHeadline), DONE_GRACE_MS);
      },
      onStop: (mtime, payload) => {
        const msg = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
        if (msg) lastMessage = msg;
        // The turn that ran looper-done ends after it: that Stop carries the report.
        if (doneMtime !== null && mtime >= doneMtime) {
          void finish('done', doneHeadline, msg || undefined);
          return;
        }
        if (mtime <= lastInputAt) return;
        if (idleSince === null || mtime > idleSince) idleSince = mtime;
      },
      onTick: (now) => {
        if (ended || doneMtime !== null || !screenEnabled || !host) return;
        if (!trustHandled && host.screenContains(TRUST_PROMPT_RE)) {
          trustHandled = true;
          ctx.log.info(`[${task.id}] answering the workspace trust dialog for ${task.cwd}`);
          // Options are "No, exit" (preselected) / "Yes, I trust this folder": Down, then Enter.
          setTimeout(() => !ended && proc.write('\x1b[B'), 300);
          setTimeout(() => !ended && proc.write('\r'), 700);
          return;
        }
        // The usage-limit banner: the request was rejected, the model never got
        // the prompt. End as an error (so a one-off note is not consumed) and
        // retry after the advertised reset — or in an hour when none is shown.
        const limit = host.screenMatch(USAGE_LIMIT_RE);
        if (limit) {
          const headline = limit[0].replace(/\s+/g, ' ').trim();
          const resetMs = parseUsageLimitReset(headline, now) ?? now + USAGE_LIMIT_FALLBACK_MS;
          ctx.log.error(`[${task.id}] ${headline}; retrying after ${new Date(resetMs).toISOString()}`);
          void finish('error', headline, undefined, resetMs + USAGE_LIMIT_RETRY_MARGIN_MS);
          return;
        }
        // A prompt visible on screen = the agent is waiting for a human; treat as idle.
        if (host.screenContains(WAITING_PROMPT_RE)) {
          if (promptSince === null) {
            promptSince = now;
            ctx.log.info(`[${task.id}] agent is waiting on a prompt`);
          }
        } else if (promptSince !== null) {
          promptSince = null;
          ctx.log.info(`[${task.id}] prompt resolved; agent continues`);
        }
        if (held) return;
        const since = idleSince ?? promptSince;
        if (since === null) return;
        if (now - since < idleGraceMs) return;
        if (a.onIdleTimeout === 'finish') {
          void finish('idle-timeout', `idle for ${a.idleGraceMin} min without looper-done`, lastMessage);
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
        host?.resize(cols, rows);
      } catch {
        /* ignore */
      }
    },
    stop(reason: AgentEndReason = 'stopped', headline?: string) {
      return finish(reason, headline);
    },
    finished,
  };
}
