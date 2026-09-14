import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type * as PtyNS from 'node-pty';
import type { Harness } from '../../shared/types';
import { autoTrustWorkspace, codexPermissionArgs } from '../../shared/environments';
import { TerminalHost } from '../terminal-host';
import { CLAUDE_NETWORK_RE, CLAUDE_RETRY_RE, looksLikeNetworkError } from '../network';
import { FileSignalWatcher } from '../signals';
import { writeJsonAtomic, writeText } from '../store/fsutil';
import { killHostTree } from '../target/kill';
import type { SpawnSpec } from '../target';
import { stopHookMessages } from '../target/stop-hook';
import { childEnv, runDirTarget, stripShellNoise, targetFile, writeLauncher, type RunContext } from './common';

/**
 * A harness session: one spawned CLI conversation, interactive (pty + terminal
 * emulation, watched for its done signal) or headless (pipes + stream-json).
 * The agent and the classifier both run through here; SessionOpts carries
 * everything that differs between them — file prefix, done command, prompts,
 * timeouts — so the two steps of one run can never collide on a file, an
 * environment variable, or a helper name.
 */

export type SessionEndReason = 'done' | 'idle-timeout' | 'max-runtime' | 'exited' | 'stopped' | 'error';

export interface SessionEnd {
  reason: SessionEndReason;
  exitCode: number | null;
  /** Only for reason 'done': the status given to the done command (or the step's implicit one). */
  doneStatus?: string;
  /** One short phrase stating the outcome: the done command's argument, or an engine message. */
  headline?: string;
  /** The session's final message, i.e. the detailed report of the run. Markdown. */
  body?: string;
  /** A resume attempt failed: the conversation to continue no longer exists. */
  sessionLost?: boolean;
  /** Headless: the result event's structured_output (from --json-schema / --output-schema). */
  structured?: unknown;
  /** Headless: the result event's total_cost_usd. */
  costUsd?: number;
  /** codex: the thread id of the conversation this session ran (for session 'continue'). */
  sessionId?: string;
  /** Set when the run failed because the usage limit was hit: epoch ms of when to try again. */
  retryAtMs?: number;
  /** The run failed because the computer could not reach the API, not because the job failed. */
  network?: boolean;
  durationMs: number;
  wasHeld: boolean;
}

export interface SessionHandle {
  runId: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(reason?: SessionEndReason, headline?: string): Promise<void>;
  finished: Promise<SessionEnd>;
  readonly held: boolean;
}

export interface SessionCallbacks {
  onData: (data: string) => void;
  onHold?: () => void;
  onResume?: () => void;
}

export interface SessionOpts {
  /** The step behind the session, deciding the stop-hook wording and log labels. */
  step: 'agent' | 'classify';
  /** File prefix inside the run dir ('' = agent, 'classify-' = classifier). */
  prefix: string;
  /** Launcher script name (run / classify). */
  launcherName: string;
  harness: Harness;
  headless: boolean;
  model?: string;
  /** claude: --permission-mode; codex: mapped to sandbox/approval flags. Empty/undefined omits them. */
  permissionMode?: string;
  /**
   * Rolling conversation. claude: resume the id, or start the conversation
   * under it. codex: only resumes make it here — the CLI picks its own thread
   * id, reported back via SessionEnd.sessionId.
   */
  session?: { id: string; resume: boolean };
  extraArgs: readonly string[];
  /** System footer (claude: --append-system-prompt; others: prepended). Empty = none. */
  footer: string;
  prompt: string;
  /** Headless: schema for claude's --json-schema / codex's --output-schema; the end then carries `structured`. */
  jsonSchema?: object;
  /** Done command defined on the session's PATH and the statuses it accepts. */
  doneCommand: string;
  doneStatuses: readonly string[];
  /** Completion command on the session's PATH. Unset = the session cannot complete the task. */
  completeCommand?: string;
  /** Status assumed when the done file has no recognized status line (agent: success; classify: none). */
  implicitDoneStatus?: string;
  /** Whether the Stop hook gates turn ends (reminder + background-task block). Interactive needs it. */
  stopGate: boolean;
  maxRuntimeMs: number;
  /** Headline when the max runtime kills the session. */
  maxRuntimeText: string;
  idleGraceMs: number;
  /** Headline when the idle grace ends the session. */
  idleText: string;
  onIdleTimeout: 'finish' | 'hold';
}

/**
 * The done file as the helper writes it: the status on the first line (empty
 * when the caller gave none), the message on the rest.
 */
export function parseDoneText(text: string, statuses: readonly string[]): { status?: string; message: string } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const first = (nl === -1 ? t : t.slice(0, nl)).trim();
  if (statuses.includes(first)) {
    return { status: first, message: nl === -1 ? '' : t.slice(nl + 1).trim() };
  }
  return { message: t };
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

/** After the done signal, how long to wait for the final message (the turn's Stop hook) before ending headline-only. */
const DONE_GRACE_MS = 120_000;

/** Retry margin past the advertised usage-limit reset, so the retry lands safely after it. */
const USAGE_LIMIT_RETRY_MARGIN_MS = 60_000;

/** The workspace-trust dialog claude shows on first interactive use of a directory. */
export const TRUST_PROMPT_RE = /trust\s+this\s+folder/i;
/** The same dialog in codex ("Do you trust the contents of this directory?"); "Yes, continue" is preselected. */
export const CODEX_TRUST_PROMPT_RE = /trust\s+the\s+contents\s+of\s+this\s+directory/i;
/**
 * Footer of every interactive claude prompt (permission requests, questions,
 * dialogs). A prompt on screen means the session is waiting for a human — the
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

/** What claude (--resume) / codex (exec resume) print when the id has no conversation behind it. */
export const RESUME_LOST_RE = /No conversation found with session ID|no rollout found for thread id/i;
/** Headline of a run that ended because its rolling conversation was gone. */
export const RESUME_LOST_TEXT = 'the conversation to continue no longer exists; the next run starts a new one';

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

/** Codex error wording that means the usage limit was hit, not that the job failed. */
const CODEX_LIMIT_RE = /usage limit|rate limit/i;

/**
 * Everything a headless run's stream output says about how it ended, fed one
 * line at a time. Understands both vocabularies — claude's stream-json
 * (rate_limit_event, system/api_retry, result) and codex's --json JSONL
 * (thread.started, item.completed, error, turn.failed/completed) — since the
 * event types never collide. Split out of the session so the verdict can be
 * replayed from captured lines.
 */
export class HeadlessStream {
  /** claude: the result event's `result`; codex: the last agent_message. The session's final report. */
  result?: string;
  /** claude: the result event's is_error; codex: an error / turn.failed with no completed turn after it. */
  isError = false;
  /** The result event's structured_output (from --json-schema). */
  structured?: unknown;
  costUsd?: number;
  /** codex: the thread id (thread.started), what a later run resumes. */
  sessionId?: string;
  /** codex: the message of the error / turn.failed event that ended the run. */
  errorMessage?: string;
  /** The usage limit was hit; claude's events carry the reset, codex's wording may not. */
  usageLimit = false;
  /** Epoch ms when a rejected usage limit resets, when the events carry one. */
  usageLimitResetMs: number | null = null;
  /** api_retry events with no HTTP status: the request never reached a server. */
  networkRetries = 0;
  /** The result event's terminal_reason and api_error_status. */
  terminalReason?: string;
  apiErrorStatus?: number | null;

  feed(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // not JSON: a shell warning or a torn line
    }
    if (obj.type === 'rate_limit_event') {
      const info = obj.rate_limit_info as { status?: string; resetsAt?: number } | undefined;
      if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
        this.usageLimit = true;
        this.usageLimitResetMs = info.resetsAt * 1000;
      }
    } else if (obj.type === 'system' && obj.subtype === 'api_retry') {
      // A retry with a status is the API answering (429, 500…); without one the
      // request never got out of the machine.
      if (obj.error_status === null) this.networkRetries += 1;
    } else if (obj.type === 'result') {
      if (typeof obj.result === 'string') this.result = obj.result;
      this.isError = obj.is_error === true;
      if (obj.structured_output !== undefined) this.structured = obj.structured_output;
      if (typeof obj.total_cost_usd === 'number') this.costUsd = obj.total_cost_usd;
      if (typeof obj.terminal_reason === 'string') this.terminalReason = obj.terminal_reason;
      if (obj.api_error_status !== undefined) this.apiErrorStatus = obj.api_error_status as number | null;
    } else if (obj.type === 'thread.started') {
      if (typeof obj.thread_id === 'string') this.sessionId = obj.thread_id;
    } else if (obj.type === 'item.completed') {
      const item = obj.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') this.result = item.text;
    } else if (obj.type === 'error' || obj.type === 'turn.failed') {
      this.isError = true;
      const msg = obj.type === 'error' ? obj.message : (obj.error as { message?: unknown } | undefined)?.message;
      if (typeof msg === 'string') {
        this.errorMessage = msg;
        if (CODEX_LIMIT_RE.test(msg)) {
          this.usageLimit = true;
          this.usageLimitResetMs ??= parseUsageLimitReset(msg, Date.now());
        }
      }
    } else if (obj.type === 'turn.completed') {
      // The turn recovered from whatever errored earlier in it.
      this.isError = false;
      this.errorMessage = undefined;
    }
  }

  /**
   * The run failed because the API was unreachable, not because it answered
   * with an error. Only the final result decides: a status-less retry earlier
   * in the run may well have recovered (see `networkRetries` for a run that
   * never got a result at all).
   */
  get network(): boolean {
    if (!this.isError) return false;
    if (this.terminalReason === 'api_error' && this.apiErrorStatus == null) return true;
    return looksLikeNetworkError(this.result) || looksLikeNetworkError(this.errorMessage);
  }
}

const PTY_COLS = 120;
const PTY_ROWS = 32;

/** Bytes of recent output kept to explain an exit or a timer that fired. */
const RECENT_OUT_BYTES = 4096;

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

/** What the session needs from a running process, whether it sits behind a pty or plain pipes. */
interface SessionProc {
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
function spawnPty(spec: SpawnSpec, cwd: string): SessionProc {
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
function spawnPiped(spec: SpawnSpec, cwd: string, onError: (e: Error) => void): SessionProc {
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

export async function startSession(ctx: RunContext, opts: SessionOpts, cb: SessionCallbacks): Promise<SessionHandle> {
  const { task, target } = ctx;
  const { harness, headless, doneCommand, doneStatuses } = opts;
  const claude = harness.kind === 'claude-code';
  const codex = harness.kind === 'codex';
  const f = (name: string): string => opts.prefix + name;

  // Claude Code gets its instructions as a system prompt; other harnesses have
  // no equivalent flag, so the footer is prepended to the prompt itself.
  writeText(
    path.join(ctx.runDir, f('prompt.txt')),
    claude || !opts.footer ? opts.prompt : opts.footer + '\n\n' + opts.prompt,
  );
  if (claude) {
    if (opts.footer) writeText(path.join(ctx.runDir, f('system.txt')), opts.footer);
    const hooks: Record<string, unknown> = {
      // The SessionStart payload names the session's transcript file: the Messages view reads it live.
      SessionStart: [{ hooks: [{ type: 'command', command: target.renderPipeHook(targetFile(ctx, f('session.json'))) }] }],
    };
    if (opts.stopGate) {
      // The Stop-hook gate: blocks the turn from ending while background tasks
      // run (ending the session would kill them), reminds once when the done
      // command was never called, and records allowed stops in stop.json — whose
      // payload carries last_assistant_message (the session's report) and whose
      // mtime doubles as the idle signal.
      const stopHookFile = f(target.stopHookFile);
      writeText(
        path.join(ctx.runDir, 'bin', stopHookFile),
        target.renderStopHook({
          stopJson: targetFile(ctx, f('stop.json')),
          doneFile: targetFile(ctx, f('done')),
          reminderFile: targetFile(ctx, f('stop-reminded')),
          ...stopHookMessages(opts.step),
        }),
        0o755,
      );
      hooks.Stop = [{ hooks: [{ type: 'command', command: target.stopHookCommand(targetFile(ctx, 'bin', stopHookFile)) }] }];
    }
    const signalCommands = opts.completeCommand ? [doneCommand, opts.completeCommand] : [doneCommand];
    writeJsonAtomic(path.join(ctx.runDir, f('settings.json')), {
      // A signal command must never be blocked by a permission prompt, and the
      // Bash sandbox must never confine it: the run dir sits outside the
      // sandbox's writable set (EROFS), e.g. on /mnt/c for a WSL agent.
      permissions: { allow: signalCommands.flatMap((c) => [`Bash(${c}:*)`, `Bash(${c})`]) },
      sandbox: { excludedCommands: signalCommands },
      hooks,
    });
  }
  if (headless && opts.jsonSchema) {
    writeJsonAtomic(path.join(ctx.runDir, f('schema.json')), opts.jsonSchema);
  }
  if (codex && !headless) {
    // The notify hook is codex's Stop-hook equivalent: it fires per finished
    // turn with the last assistant message and the thread id, and its dump
    // into stop.json doubles as the idle signal.
    writeText(
      path.join(ctx.runDir, 'bin', f(target.notifyHookFile)),
      target.renderNotifyHook(targetFile(ctx, f('stop.json'))),
      0o755,
    );
  }

  const q = (s: string) => target.quote(s);
  const parts: string[] = [harness.command];
  if (claude) {
    if (opts.model) parts.push('--model', q(opts.model));
    if (opts.permissionMode) parts.push('--permission-mode', q(opts.permissionMode));
    if (opts.session) parts.push(opts.session.resume ? '--resume' : '--session-id', q(opts.session.id));
    if (opts.footer) parts.push('--append-system-prompt', target.catFile(targetFile(ctx, f('system.txt'))));
    parts.push('--settings', q(targetFile(ctx, f('settings.json'))));
    if (headless) {
      parts.push('-p', '--output-format', 'stream-json', '--verbose');
      if (opts.jsonSchema) parts.push('--json-schema', target.catFile(targetFile(ctx, f('schema.json'))));
    }
  } else if (codex) {
    if (headless) parts.push('exec');
    // Shared flags sit on the parent command: `exec resume` defines no
    // sandbox flags of its own but accepts them placed before the subcommand.
    const permArgs = codexPermissionArgs(opts.permissionMode, !headless);
    for (const arg of permArgs) parts.push(arg);
    // A sandboxed session must still reach the run dir: the done/classify
    // helpers write their signal files there, outside the workspace. Never
    // with a UNC run dir (WSL host driving a Windows target): codex's Windows
    // sandbox cannot mount a network share — --add-dir then breaks its shell
    // outright ("setup refresh had errors"), and the share stays unreachable
    // either way, so such a run signals via its report instead of looper-done.
    const runDirT = runDirTarget(ctx);
    if (permArgs.some((a) => a === '--approve-for-me' || a === '--sandbox') && !runDirT.startsWith('\\\\')) {
      parts.push('--add-dir', q(runDirT));
    }
    if (opts.model) parts.push('--model', q(opts.model));
    if (opts.session?.resume) parts.push('resume', q(opts.session.id));
    if (headless) {
      parts.push('--json', '--skip-git-repo-check');
      if (opts.jsonSchema) parts.push('--output-schema', q(targetFile(ctx, f('schema.json'))));
    } else {
      // Inline scrollback mode: the alt-screen TUI would endlessly redraw over
      // itself in the captured output log.
      parts.push('--no-alt-screen');
      // TOML literal (single-quoted) strings: a double quote inside an argument
      // would be mangled by Windows PowerShell's native-argument passing.
      const notifyCmd = target.notifyCommand(targetFile(ctx, 'bin', f(target.notifyHookFile)));
      parts.push('-c', q(`notify=[${notifyCmd.map((c) => `'${c}'`).join(',')}]`));
    }
  }
  for (const arg of harness.args) parts.push(q(arg));
  for (const extra of opts.extraArgs) parts.push(q(extra));
  // claude's variadic options (--allowedTools, --disallowedTools, ...) swallow
  // the following positional, eating the prompt when such a flag comes last:
  // terminate option parsing so the prompt always lands as the prompt.
  if (claude) parts.push('--');
  parts.push(target.catFile(targetFile(ctx, f('prompt.txt'))));
  let body = (target.kind === 'windows' ? '' : 'exec ') + parts.join(' ');
  if (codex) {
    // Record the target-native codex home before the CLI starts: the rollout
    // transcript behind the Messages view lives under it, only the target
    // knows its own home, and codex never prints the path.
    const homeFile = q(targetFile(ctx, f('codex-home')));
    body =
      (target.kind === 'windows'
        ? `Set-Content -NoNewline -LiteralPath ${homeFile} -Value $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })`
        : `printf '%s' "\${CODEX_HOME:-$HOME/.codex}" > ${homeFile}`) +
      '\n' +
      body;
  }
  const launcher = writeLauncher(ctx, opts.launcherName, body, harness.env, {
    prefix: opts.prefix,
    doneCommand,
    doneStatuses,
    completeCommand: opts.completeCommand,
  });

  const out = fs.createWriteStream(path.join(ctx.runDir, f('output.log')), { flags: 'a' });
  out.on('error', () => {
    /* never fatal */
  });
  // Headless output is stream-json: one huge JSON object per line. Running it
  // through a terminal would wrap it into thousands of rows, so output.txt is
  // written straight from the stream. Interactive output is a TUI and needs
  // the terminal emulation, which lives in a worker thread.
  const cleanOut = headless
    ? fs.createWriteStream(path.join(ctx.runDir, f('output.txt')), { flags: 'w' })
    : null;
  cleanOut?.on('error', () => {
    /* never fatal */
  });
  // The rendered screen is watched for claude's and codex's trust dialogs, and
  // for claude's usage-limit / network / waiting-prompt banners. Custom
  // harnesses end only via the done command, process exit or the max runtime.
  const screenEnabled = !headless && (claude || codex);
  const host = headless
    ? null
    : new TerminalHost({
        file: path.join(ctx.runDir, f('output.txt')),
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
  ctx.log.info(`[${task.id}] ${opts.step} pid ${proc.pid}: ${launcher.spec.command} ${launcher.spec.args.join(' ')}`);

  const started = Date.now();
  let ended = false;
  let held = false;
  let exitCode: number | null = null;
  let exited = false;
  let lastInputAt = 0;
  let idleSince: number | null = null;
  const stream = new HeadlessStream();
  let streamBuf = '';
  let prevEndedNewline = false;
  /** Rolling tail of raw output: what an exit or an expired timer can be blamed on. */
  let recentOut = '';
  /** Latest last_assistant_message seen from the Stop/notify hook (interactive). */
  let lastMessage: string | undefined;
  /** codex interactive: the thread id the notify hook reported. */
  let notifySessionId: string | undefined;
  /** codex: the Messages view locates the rollout transcript from this ref
   * (codex never reports the rollout path itself, only the thread id — the
   * launcher-recorded codex-home file supplies the sessions dir to search). */
  let codexRefWritten = false;
  const writeCodexRef = (threadId: string): void => {
    if (codexRefWritten) return;
    codexRefWritten = true;
    writeJsonAtomic(path.join(ctx.runDir, f('codex-session.json')), { thread_id: threadId });
  };
  // A --resume of a pruned/foreign conversation errors in the first output;
  // watching only the head keeps conversation text from ever matching.
  let earlyOutput = '';
  const watchResume = opts.session?.resume === true;
  /** Every byte printed, kept twice: the head (resume check) and the tail (what to blame an end on). */
  const noteOutput = (d: string): void => {
    if (watchResume && earlyOutput.length < 16384) earlyOutput += d;
    recentOut = (recentOut + d).slice(-RECENT_OUT_BYTES);
  };
  const sessionLost = (): boolean => watchResume && RESUME_LOST_RE.test(earlyOutput);
  /**
   * The output on hand shows the *harness* losing the network. For claude only
   * its own banner counts — the agent's tool output may name ECONNREFUSED and
   * friends while doing its job; for other harnesses, whose process died
   * (exit) with no verdict, the generic patterns are the best evidence there is.
   */
  const outputBlamesNetwork = (): boolean =>
    claude
      ? CLAUDE_NETWORK_RE.test(recentOut) || host?.screenContains(CLAUDE_NETWORK_RE) === true
      : looksLikeNetworkError(recentOut);
  /**
   * A timer fired while claude was failing on (or retrying) the network: the
   * run failed for network reasons even though the clock got there first —
   * claude retries for ~185 s, longer than a 180 s classifier timeout. On
   * screen that is the retry or the final banner; in a headless stream it is
   * status-less retries with no result ever arriving.
   */
  const stalledOnNetwork = (): boolean =>
    host
      ? host.screenContains(CLAUDE_RETRY_RE) || host.screenContains(CLAUDE_NETWORK_RE)
      : headless && stream.networkRetries > 0 && stream.result === undefined;
  /** Set once the done command has been seen: mtime of the done file, its status and headline. */
  let doneMtime: number | null = null;
  let doneStatus: string | undefined;
  let doneHeadline: string | undefined;
  let doneTimer: NodeJS.Timeout | null = null;
  let resolveFinished!: (e: SessionEnd) => void;
  const finished = new Promise<SessionEnd>((r) => (resolveFinished = r));
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => (exitResolve = r));

  const watcher = new FileSignalWatcher(
    path.join(ctx.runDir, f('done')),
    path.join(ctx.runDir, f('stop.json')),
    ctx.settings.signalPollMs,
  );

  let trustHandled = headless || !autoTrustWorkspace(harness);
  let promptSince: number | null = null;

  // A Windows TUI reached through WSL interop blocks at startup on a
  // cursor-position query (ESC[6n) nothing answers — a native console's ConPTY
  // would, so only that combination gets a stand-in reply from looper.
  const answerCursorQuery = !headless && target.kind === 'windows' && ctx.host !== 'windows';
  let cursorQueryCarry = '';

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
    reason: SessionEndReason,
    headline?: string,
    body?: string,
    retryAtMs?: number,
    network?: boolean,
  ): Promise<void> => {
    if (ended) return;
    ended = true;
    watcher.stop();
    clearTimeout(maxTimer);
    if (doneTimer) clearTimeout(doneTimer);
    if (!exited) await killTree();
    out.end();
    // output.txt is read the moment `finished` resolves (run log, tests): let it land.
    if (cleanOut) await withTimeout(new Promise<boolean>((r) => cleanOut.end(() => r(true))), 2000);
    await host?.close();
    resolveFinished({
      reason,
      exitCode,
      doneStatus: reason === 'done' ? doneStatus : undefined,
      headline,
      body,
      sessionLost: sessionLost() || undefined,
      structured: stream.structured,
      costUsd: stream.costUsd,
      sessionId: notifySessionId ?? stream.sessionId,
      retryAtMs,
      network: network || undefined,
      durationMs: Date.now() - started,
      wasHeld: held,
    });
  };

  /**
   * Headless: the final response is the report. The done command (if the
   * session ran it) names the headline; otherwise the response's first line does.
   */
  const finishHeadless = async (code: number | null): Promise<void> => {
    if (spawnError) {
      await finish('error', spawnError);
      return;
    }
    if (sessionLost()) {
      await finish('error', RESUME_LOST_TEXT);
      return;
    }
    const doneText = await fs.promises.readFile(path.join(ctx.runDir, f('done')), 'utf8').catch(() => '');
    const done = doneText.trim() ? parseDoneText(doneText, doneStatuses) : null;
    if (done) doneStatus = done.status ?? opts.implicitDoneStatus;
    // codex --output-schema constrains the final message itself to the schema.
    if (codex && opts.jsonSchema && stream.structured === undefined && stream.result) {
      try {
        stream.structured = JSON.parse(stream.result);
      } catch {
        /* the model ignored the schema; toClassifyResult reports the missing verdict */
      }
    }
    const body = stream.result?.trim() || stream.errorMessage?.trim() || undefined;
    if (stream.isError && stream.usageLimit) {
      const resetMs = stream.usageLimitResetMs ?? Date.now() + USAGE_LIMIT_FALLBACK_MS;
      const headline = headlineOf(body) ?? 'usage limit reached';
      ctx.log.error(`[${task.id}] ${headline}; retrying after ${new Date(resetMs).toISOString()}`);
      await finish('error', headline, body, resetMs + USAGE_LIMIT_RETRY_MARGIN_MS);
      return;
    }
    // The API was never reached: an engine error, not a run the agent failed.
    if (stream.network) {
      const headline = headlineOf(body) ?? "can't reach the API server";
      ctx.log.error(`[${task.id}] ${headline}`);
      await finish('error', headline, body, undefined, true);
      return;
    }
    if (code === 0) {
      await finish('done', (done && headlineOf(done.message)) ?? headlineOf(body), body);
    } else {
      const headline = headlineOf(stream.errorMessage) ?? `${harness.name} exited ${code}`;
      await finish('exited', headline, body, undefined, outputBlamesNetwork());
    }
  };

  const maxTimer = setTimeout(
    () => void finish('max-runtime', opts.maxRuntimeText, undefined, undefined, stalledOnNetwork()),
    opts.maxRuntimeMs,
  );

  /** Headless stream to the terminal tab: pipes carry bare LF, xterm needs CRLF; blank runs collapse. */
  const showHeadless = (d: string): void => {
    let display = d.replace(/(\r?\n)+/g, '\r\n');
    if (prevEndedNewline) display = display.replace(/^\r\n/, '');
    prevEndedNewline = /\r?\n$/.test(d);
    if (display) cb.onData(display);
  };

  proc.onStdout((d) => {
    out.write(d);
    noteOutput(d);
    if (answerCursorQuery && !ended) {
      const s = cursorQueryCarry + d;
      for (let i = 0; (i = s.indexOf('\x1b[6n', i)) !== -1; i += 4) proc.write(`\x1b[${PTY_ROWS};1R`);
      cursorQueryCarry = s.slice(-3);
    }
    if (!ended) host?.write(d);
    if (headless) {
      streamBuf += d;
      let nl: number;
      while ((nl = streamBuf.indexOf('\n')) !== -1) {
        const line = streamBuf.slice(0, nl).trimEnd();
        streamBuf = streamBuf.slice(nl + 1);
        if (cleanOut && !cleanOut.writableEnded) cleanOut.write(line + '\n');
        if (line) stream.feed(line);
      }
      if (codex && stream.sessionId) writeCodexRef(stream.sessionId);
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
    noteOutput(cleaned);
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
        if (!stream.result) stream.feed(remaining);
      }
    }
    if (ended) return;
    if (headless) {
      void finishHeadless(code);
    } else if (doneMtime !== null) {
      // Signalled done, then exited before the turn ended: headline only.
      void finish('done', doneHeadline);
    } else if (sessionLost()) {
      void finish('error', RESUME_LOST_TEXT);
    } else {
      void finish('exited', `${harness.name} exited ${code}`, undefined, undefined, outputBlamesNetwork());
    }
  });

  if (!headless) {
    watcher.start({
      onDone: (msg, mtime) => {
        if (ended || doneMtime !== null) return;
        doneMtime = mtime;
        const parsed = parseDoneText(msg, doneStatuses);
        doneStatus = parsed.status ?? opts.implicitDoneStatus;
        doneHeadline = headlineOf(parsed.message) ?? 'done';
        ctx.log.info(`[${task.id}] ${doneCommand} ${doneStatus ?? '(no status)'} "${doneHeadline}"; waiting for the final message`);
        doneTimer = setTimeout(() => void finish('done', doneHeadline), DONE_GRACE_MS);
      },
      onStop: (mtime, payload) => {
        if (codex) {
          // The TUI spins up a side thread to name the session; its turn is not
          // the agent's and must neither feed the idle clock nor the report.
          const inputs = payload['input-messages'];
          if (
            Array.isArray(inputs) &&
            typeof inputs[0] === 'string' &&
            inputs[0].startsWith('Generate a concise, single-line task title')
          ) {
            return;
          }
          const tid = payload['thread-id'];
          if (typeof tid === 'string') {
            notifySessionId = tid;
            writeCodexRef(tid);
          }
        }
        const raw = payload.last_assistant_message ?? payload['last-assistant-message'];
        const msg = typeof raw === 'string' ? raw.trim() : '';
        if (msg) lastMessage = msg;
        // The turn that ran the done command ends after it: that Stop carries the report.
        if (doneMtime !== null && mtime >= doneMtime) {
          void finish('done', doneHeadline, msg || undefined);
          return;
        }
        if (mtime <= lastInputAt) return;
        if (idleSince === null || mtime > idleSince) idleSince = mtime;
      },
      onTick: (now) => {
        if (ended || doneMtime !== null) return;
        if (screenEnabled && host && !trustHandled) {
          const trustRe = claude ? TRUST_PROMPT_RE : CODEX_TRUST_PROMPT_RE;
          if (host.screenContains(trustRe)) {
            trustHandled = true;
            ctx.log.info(`[${task.id}] answering the workspace trust dialog for ${task.cwd}`);
            // claude preselects "No, exit", so: Down to "Yes, I trust this
            // folder", then Enter. codex preselects "Yes, continue": Enter.
            if (claude) setTimeout(() => !ended && proc.write('\x1b[B'), 300);
            setTimeout(() => !ended && proc.write('\r'), 700);
            return;
          }
        }
        if (screenEnabled && host && claude) {
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
          // The API is out of reach (claude gives up after its retries): the
          // prompt never landed, so this is an engine error, not a failed job.
          const netErr = host.screenMatch(CLAUDE_NETWORK_RE);
          if (netErr) {
            const headline = netErr[0].replace(/\s+/g, ' ').trim();
            ctx.log.error(`[${task.id}] ${headline}`);
            void finish('error', headline, undefined, undefined, true);
            return;
          }
          // A prompt visible on screen = the session is waiting for a human; treat as idle.
          if (host.screenContains(WAITING_PROMPT_RE)) {
            if (promptSince === null) {
              promptSince = now;
              ctx.log.info(`[${task.id}] ${opts.step} is waiting on a prompt`);
            }
          } else if (promptSince !== null) {
            promptSince = null;
            ctx.log.info(`[${task.id}] prompt resolved; ${opts.step} continues`);
          }
        }
        if (held) return;
        const since = idleSince ?? promptSince;
        if (since === null) return;
        if (now - since < opts.idleGraceMs) return;
        if (opts.onIdleTimeout === 'finish') {
          void finish('idle-timeout', opts.idleText, lastMessage, undefined, stalledOnNetwork());
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
    stop(reason: SessionEndReason = 'stopped', headline?: string) {
      return finish(reason, headline);
    },
    finished,
  };
}
