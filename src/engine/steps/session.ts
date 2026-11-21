import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from '../../shared/types';
import type { ChatPermissionRequest } from '../../shared/chat';
import { autoTrustWorkspace, codexPermissionArgs, projectMcpApproval } from '../../shared/environments';
import { TerminalHost } from '../terminal-host';
import { delegateMessage, eventsMessage, guidanceMessage } from '../../shared/messages';
import { LOGIN_FAILED_RE } from '../../shared/logins';
import { resolveEnvironment } from '../../shared/environments';
import { readContextTokens } from '../context';
import { spawnOffThread, spawnPtyOffThread } from '../exec-worker';
import {
  DELEGATE_FILE,
  EVENTS_FILE,
  GUIDANCE_FILE,
  NOTICE_FILE,
  queueNotice,
  takeDelegateMessages,
  takeEvents,
  takeNotice,
  takePendingGuidance,
} from '../guidance';
import { findStepTranscript, LiveSweep, transcriptHostPath } from '../messages';
import { claudeModelWindows, modelWindows } from '../model-windows';
import { CLAUDE_NETWORK_RE, CLAUDE_RETRY_RE, looksLikeEnvironmentError, looksLikeNetworkError } from '../network';
import { FileSignalWatcher } from '../signals';
import { writeJsonAtomic, writeText } from '../store/fsutil';
import { killHostTree } from '../target/kill';
import type { SpawnSpec } from '../target';
import { CRON_REFUSAL, stopHookMessages, subagentGuardMessage } from '../target/stop-hook';
import { mergeClaudeSettings, mergeSystemPrompt, readUserSettings } from '../claude-settings';
import { MOD_DIR, MOD_FILES, MOD_MISSING_TEXT, toolKey, writeClaudeMod } from '../claude-mod';
import {
  ASK_DIR,
  childEnv,
  DELEGATE_BUSY_FILE,
  DELEGATE_DIR,
  runDirTarget,
  SOCKET_FILE,
  stripShellNoise,
  targetFile,
  writeLauncher,
  type RunContext,
} from './common';

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
  /** The machine's environment never started the harness (WSL unreachable, wsl.exe missing). */
  environment?: boolean;
  /** With environment: Claude Code had no usable login. */
  login?: boolean;
  durationMs: number;
  wasHeld: boolean;
}

export interface SessionHandle {
  runId: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * Guidance was just queued in the run dir. An interactive session whose turn
   * has ended gets it typed in; otherwise the hooks hand it over mid-turn.
   */
  deliverGuidance(): void;
  /**
   * Interactive: end the agent's turn, as Esc pressed in it does, and type in
   * the guidance waiting (Send Now). The session goes on, idle. Headless has
   * no turn to end apart from its process: the scheduler ends it.
   */
  stopTurn(): void;
  /** Interactive: the agent's turn is over (at its prompt, or held). */
  readonly turnOver: boolean;
  /** The question the agent is waiting on an answer to, or null. */
  readonly question: string | null;
  /** Hand the user's answer to the waiting question; false when none waits. */
  answer(text: string): boolean;
  /** Interactive Claude Code: the tool call waiting for the user's permission, as its terminal asks too; null when none waits. */
  readonly permission: ChatPermissionRequest | null;
  /** Allow or deny the waiting tool call `id`; false when it no longer waits (answered in the terminal, or timed out). */
  answerPermission(id: string, allow: boolean): boolean;
  stop(reason?: SessionEndReason, headline?: string): Promise<void>;
  finished: Promise<SessionEnd>;
  readonly held: boolean;
}

export interface SessionCallbacks {
  onData: (data: string) => void;
  onHold?: () => void;
  onResume?: () => void;
  /** The context passed the session's limit (or a further step past it) and the notice was left for the agent. */
  onContext?: (tokens: number, limit: number) => void;
  /** The agent asked the user a question. */
  onQuestion?: (question: string) => void;
  /** Nobody answered the question in time, and the agent got the session's no-answer text. */
  onNoAnswer?: (question: string) => void;
  /** A tool call started waiting for the user's permission, or (null) stopped waiting. */
  onPermission?: (request: ChatPermissionRequest | null) => void;
}

/** The done-file status of a session that ended for a context restart (written by the restart helper). */
export const RESTART_STATUS = 'restart';

/** How often the context of a session with a limit is read off its transcript, in signal polls (5 s by default). */
const CONTEXT_POLLS = 5;

/** The run-dir folder (after the step's prefix) where permission requests wait for Looper's answer. */
const PERMISSIONS_DIR = 'permissions';

/** The PermissionRequest hook's answer: allow the call, or deny it with what the agent is told. */
export function permissionDecision(allow: boolean, message: string): string {
  const decision = allow ? { behavior: 'allow' } : { behavior: 'deny', message };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

/** Where a Claude Code session's StopFailure hook records the turn that ended on an API error. */
export const STOP_FAILURE_FILE = 'stop-failure.json';

/** How much longer than the answer wait the ask helper waits for Looper's response, in seconds. */
const ASK_HELPER_MARGIN_S = 120;

/** Claude Code's own ceiling on a Bash call's timeout. */
const BASH_MAX_DEFAULT_MS = 600_000;

/**
 * How long a Claude Code session that has started (its SessionStart hook ran)
 * may go without its mod reporting in before the run ends as an environment
 * error (claude-mod.ts).
 */
const MOD_READY_MS = 20_000;

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
  /** claude: --effort; codex: -c model_reasoning_effort=. Unset omits the flag. */
  effort?: string;
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
  /** Empty: the session starts at its prompt, and its messages come through `inbox` (an interactive chat's). */
  prompt: string;
  /** Claude Code: the run-dir files the mod takes the user's messages from, in this order, in place of the guidance ones (`guidance`). */
  inbox?: readonly string[];
  /** Claude Code: more settings for the session, after Looper's and before the user's --settings. */
  settings?: Record<string, unknown>;
  /** Headless: schema for claude's --json-schema / codex's --output-schema; the end then carries `structured`. */
  jsonSchema?: object;
  /** Done command defined on the session's PATH and the statuses it accepts. Unset = the session has none, and only its process ends it. */
  doneCommand?: string;
  doneStatuses?: readonly string[];
  /** Completion command on the session's PATH. Unset = the session cannot complete the task. */
  completeCommand?: string;
  /**
   * Restart command on the session's PATH: it writes the done file with
   * RESTART_STATUS, so the session ends like a done one and its final message
   * is the handoff. Unset = the session cannot restart.
   */
  restartCommand?: string;
  /**
   * claude-code and codex: read the conversation's context off its transcript
   * and leave `notice` for the agent once it passes `limit` tokens, and again
   * at every further tenth of the limit.
   */
  context?: { limit: number; notice: (tokens: number, again: boolean) => string };
  /**
   * The ask command on the session's PATH. Its requests come in through the
   * run dir's ask folder, one question at a time; the user's answer goes back,
   * or `noAnswer` once `waitMs` passes. The idle clock stops while a question
   * waits. Unset = the session cannot ask.
   */
  ask?: { command: string; waitMs: number; noAnswer: string };
  /**
   * Interactive Claude Code: each permission request also goes to Looper
   * (`onPermission`), which answers it from the run window or a phone while
   * the terminal asks too, whichever answers first. Unanswered after `waitMs`,
   * the call is denied and the agent told `noAnswer`.
   */
  permissions?: { waitMs: number; noAnswer: string };
  /**
   * The delegate command on the session's PATH (looper-delegate). Its
   * requests come in through the run dir's delegate folder, and `handle`
   * answers each with the text the command prints and its exit code. The
   * idle clock stops while `busy()`: an agent the session started is still
   * going, and its result will start the next turn. Unset = the session
   * cannot start agents.
   */
  delegate?: {
    command: string;
    handle: (args: string[], cwd: string) => Promise<{ text: string; code: number }>;
    busy: () => boolean;
  };
  /** The watch command on the session's PATH (a chat's looper-watch), whose requests the chat answers. */
  watchCommand?: string;
  /** The session continues a run an earlier session started (a context restart): the logs keep the earlier output. */
  continued?: boolean;
  /** Status assumed when the done file has no recognized status line (agent: success; classify: none). */
  implicitDoneStatus?: string;
  /** Whether the Stop hook gates turn ends (reminder + background-task block). Interactive needs it. */
  stopGate: boolean;
  /** The session takes the user's guidance mid-run (engine/guidance.ts): the agent step does. */
  guidance?: boolean;
  /** Infinity: no limit. */
  maxRuntimeMs: number;
  /** Headline when the max runtime kills the session. */
  maxRuntimeText: string;
  idleGraceMs: number;
  /** Headline when the idle grace ends the session. */
  idleText: string;
  onIdleTimeout: 'finish' | 'hold';
  /**
   * Interactive Claude Code that someone works in (a chat): a turn that ends on
   * an API error leaves Claude Code at its prompt, where they can go on.
   * Unset: the error ends the session, as an unattended run has nobody to go on.
   */
  keepOnApiError?: boolean;
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

/**
 * A claude Stop payload whose session still waits on something that starts its
 * next turn: a running background task (a Monitor is one), or a scheduled
 * prompt (a ScheduleWakeup is one).
 */
export function stopWaitsOn(payload: Record<string, unknown>): boolean {
  const tasks = payload.background_tasks;
  const crons = payload.session_crons;
  return (
    (Array.isArray(tasks) && tasks.some((t) => (t as { status?: unknown } | null)?.status === 'running')) ||
    (Array.isArray(crons) && crons.length > 0)
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

/** After the done signal, how long to wait for the final message (the turn's Stop hook) before ending headline-only. */
const DONE_GRACE_MS = 120_000;

/** Retry margin past the advertised usage-limit reset, so the retry lands safely after it. */
export const USAGE_LIMIT_RETRY_MARGIN_MS = 60_000;

/** The workspace-trust dialog claude shows on first interactive use of a directory. */
export const TRUST_PROMPT_RE = /trust\s+this\s+folder/i;
/** The same dialog in codex ("Do you trust the contents of this directory?"); "Yes, continue" is preselected. */
export const CODEX_TRUST_PROMPT_RE = /trust\s+the\s+contents\s+of\s+this\s+directory/i;
/**
 * Footer of every interactive claude prompt (permission requests, questions,
 * dialogs): "Esc to cancel", "Esc to reject all", and so on. A working turn's
 * "esc to interrupt" is the only one that isn't waiting. A prompt on screen
 * means the session is waiting for a human — the turn has not ended so the
 * Stop hook will not fire; treat it as idle.
 */
export const WAITING_PROMPT_RE = /Esc\s+to\s+(?!interrupt\b)[a-z]/i;
/**
 * An interactive claude whose SessionStart hook hasn't fired this long after
 * spawning is held up by a startup dialog (trust, project MCP servers, or one
 * Looper doesn't know yet): it waits for a human like any other prompt.
 */
const STARTUP_PROMPT_MS = 120_000;
/**
 * The usage-limit banner an interactive claude shows when a request is
 * rejected, e.g. "You've hit your session limit · resets 5:50am (America/...)".
 * The "resets <time>" tail is required so ordinary conversation text about
 * limits cannot end a run.
 */
export const USAGE_LIMIT_RE =
  /(?:hit|reached) (?:your|the) [\w-]*\s?limit\b[^\n]{0,80}?resets(?:\s+at)?\s+(?:[a-z]{3}[a-z]*\.?\s+\d{1,2},?\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i;
/** Fallback wait when the banner shows no parseable reset time. */
const USAGE_LIMIT_FALLBACK_MS = 3_600_000;

/** What claude (--resume) / codex (exec resume) print when the id has no conversation behind it. */
export const RESUME_LOST_RE = /No conversation found with session ID|no rollout found for thread id/i;
/** Headline of a run that ended because its rolling conversation was gone. */
export const RESUME_LOST_TEXT = 'the conversation to continue no longer exists; the next run starts a new one';

/**
 * A launcher line that writes the target-native codex home into `quotedFile`:
 * the rollout transcript lives under it, only the target knows its own home,
 * and codex never prints the path.
 */
export function recordCodexHome(kind: 'wsl' | 'windows', quotedFile: string): string {
  return kind === 'windows'
    ? `Set-Content -NoNewline -LiteralPath ${quotedFile} -Value $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })`
    : `printf '%s' "\${CODEX_HOME:-$HOME/.codex}" > ${quotedFile}`;
}

/**
 * Epoch ms of the wall-clock time in `text`, local: "resets 5:50am" (the next
 * one), or a weekly limit's "resets Nov 24, 4am" (the next Nov 24). Null without one.
 */
export function parseUsageLimitReset(text: string, now: number): number | null {
  const m = /resets(?:\s+at)?\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (hour > 23 || minute > 59 || (ampm && hour > 12)) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const at = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month === -1) return null;
    at.setMonth(month, Number(m[2]));
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Epoch ms of the time in Codex's usage-limit error, local: "try again at
 * 2:21 AM" (the next one), or with a date, "try again at Sep 22nd, 2026 2:21
 * AM" (seen in a rollout's task_complete error). Null without one.
 */
export function parseCodexLimitReset(text: string, now: number): number | null {
  const m = /try again at\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const ampm = m[6]?.toLowerCase();
  if (hour > 23 || minute > 59 || (ampm && (hour > 12 || hour === 0))) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const at = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month === -1) return null;
    at.setFullYear(Number(m[3]), month, Number(m[2]));
  }
  at.setHours(hour, minute, 0, 0);
  if (!m[1] && at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** When a usage-limit error says the limit resets: Claude's "resets 5:50am" or Codex's "try again at …"; null when it doesn't say. */
export function usageLimitReset(text: string, now: number): number | null {
  return parseUsageLimitReset(text, now) ?? parseCodexLimitReset(text, now);
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
  /** Claude Code had no usable login: an API error that says to run /login. */
  loginFailed = false;

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
    } else if (obj.type === 'assistant' && obj.is_api_error_message === true) {
      if (LOGIN_FAILED_RE.test(line)) this.loginFailed = true;
    } else if (obj.type === 'result') {
      if (typeof obj.result === 'string') this.result = obj.result;
      this.isError = obj.is_error === true;
      if (this.isError && typeof obj.result === 'string' && LOGIN_FAILED_RE.test(obj.result)) this.loginFailed = true;
      if (obj.structured_output !== undefined) this.structured = obj.structured_output;
      if (typeof obj.total_cost_usd === 'number') this.costUsd = obj.total_cost_usd;
      if (typeof obj.terminal_reason === 'string') this.terminalReason = obj.terminal_reason;
      if (obj.api_error_status !== undefined) this.apiErrorStatus = obj.api_error_status as number | null;
      modelWindows.learn(claudeModelWindows(obj));
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
          this.usageLimitResetMs ??= usageLimitReset(msg, Date.now());
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

/**
 * What xterm sends when the terminal gains (CSI I) or loses (CSI O) focus,
 * once the session turned focus reporting on (DECSET 1004, which ConPTY sends
 * at the start of a session).
 */
export const FOCUS_REPORT_RE = /^(?:\x1b\[[IO])+$/;

/** Bytes of recent output kept to explain an exit or a timer that fired. */
const RECENT_OUT_BYTES = 4096;

/** node-pty's entry, outside app.asar, where the process worker can load it from (electron-builder unpacks the whole package). */
function ptyModulePath(): string {
  const file = require.resolve('node-pty');
  return file.includes('app.asar.unpacked') ? file : file.replace('app.asar', 'app.asar.unpacked');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** What the session needs from a running process, whether it sits behind a pty or plain pipes. */
export interface SessionProc {
  /** 0 until it has started, and when the spawn itself failed. */
  readonly pid: number;
  /** The pid once it has started, 0 when it couldn't start. */
  readonly spawned: Promise<number>;
  onStdout(cb: (data: string) => void): void;
  onStderr(cb: (data: string) => void): void;
  /** Fires once, after all output has been delivered. */
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * A bare Windows command resolved against the env's Path. node-pty's own
 * lookup fails ("File not found: " with an empty path) whenever the command
 * also exists in the app's working directory, and a login start runs Looper
 * from C:\Windows\System32, where wsl.exe is. Anything else passes through.
 */
export function resolveWinCommand(command: string, env: Record<string, string>): string {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return command;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  for (const dir of (key ? env[key] : '').split(';')) {
    if (!dir) continue;
    const candidate = path.win32.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this dir
    }
  }
  return command;
}

/** Interactive: a real terminal, so the TUI renders and can be typed into. A start that fails reaches `onError`, then the exit. */
export function spawnPty(spec: SpawnSpec, cwd: string, onError: (e: Error) => void): SessionProc {
  const env = childEnv();
  const proc = spawnPtyOffThread(ptyModulePath(), resolveWinCommand(spec.command, env), spec.args, { name: 'xterm-256color', cols: PTY_COLS, rows: PTY_ROWS, cwd, env }, (e) =>
    // ConPTY says "File not found: <path>" (an empty path when PATH has no match); worded like Node's spawn
    // error so a missing wsl.exe reads the same whichever way the step was started.
    onError(/^File not found:/.test(e.message) ? new Error(`spawn ${spec.command} ENOENT (${e.message})`) : e),
  );
  return {
    get pid() {
      return proc.pid;
    },
    spawned: proc.spawned,
    onStdout: (cb) => proc.onData(cb),
    onStderr: () => {},
    onExit: (cb) => proc.onExit(cb),
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
  const child = spawnOffThread(spec.command, spec.args, {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
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
    get pid() {
      return child.pid ?? 0;
    },
    spawned: child.spawned.then((pid) => pid ?? 0),
    onStdout: (cb) => child.stdout!.on('data', cb),
    onStderr: (cb) => child.stderr!.on('data', cb),
    onExit: (cb) => {
      exitCb = cb;
    },
    write: () => {},
    resize: () => {},
    kill: () => child.kill(),
  };
}

/**
 * The command of the codex guidance hook (headless only), or null when there
 * is none. Codex runs a hook only once the user has trusted its definition in
 * codex's /hooks screen, and the trust holds while the definition stays the
 * same. So every run gets the same command: one script in the data dir, which
 * finds the run through LOOPER_RUN_DIR. Untrusted, codex skips the hook
 * without a word and the guidance reaches the agent in a continuation run
 * instead. Interactive codex never gets the hook: its TUI would open on the
 * "hooks need review" screen and the unattended session would wait there.
 */
function codexGuideHookCommand(ctx: RunContext): string | null {
  if (!ctx.dataDir) return null;
  const file = path.join(ctx.dataDir, 'hooks', 'codex-' + ctx.target.guideHookFile);
  try {
    // Atomic: a hook of another run may be reading the script right now.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeText(tmp, ctx.target.renderGuideHook('codex'), 0o755);
    fs.renameSync(tmp, file);
  } catch (e) {
    ctx.log.warn(`[${ctx.task.id}] cannot write the codex guidance hook: ${(e as Error).message}`);
    return null;
  }
  return ctx.target.codexHookCommand(ctx.target.toTargetPath(file));
}

export async function startSession(ctx: RunContext, opts: SessionOpts, cb: SessionCallbacks): Promise<SessionHandle> {
  const { task, target } = ctx;
  const { harness, headless, doneCommand, doneStatuses } = opts;
  const claude = harness.kind === 'claude-code';
  const codex = harness.kind === 'codex';
  const f = (name: string): string => opts.prefix + name;
  // Interactive Claude Code writes its transcript seconds late, and some rows later still: its mod hands each row over as it is made.
  const liveDir = claude && !headless ? path.join(ctx.runDir, f(MOD_FILES.live)) : null;
  const signalCommands = [doneCommand, opts.completeCommand, opts.restartCommand].filter((c): c is string => !!c);
  // The ask and delegate commands must pass permissions and the sandbox too, but they don't end the session: a subagent may run them.
  const helperCommands = [...signalCommands, ...(opts.ask ? [opts.ask.command] : []), ...(opts.delegate ? [opts.delegate.command] : [])];
  // The restart helper ends the session through the done file, under its own status.
  const parseStatuses = [...(doneStatuses ?? []), ...(opts.restartCommand ? [RESTART_STATUS] : [])];
  // A done file an earlier session in this run folder left would end this one as soon as it starts.
  fs.rmSync(path.join(ctx.runDir, f('done')), { force: true });
  if (opts.restartCommand) {
    writeText(
      path.join(ctx.runDir, 'bin', target.doneHelperFile(opts.restartCommand)),
      target.renderStatusHelper(RESTART_STATUS, 'context restart'),
      0o755,
    );
  }

  // Claude Code gets its instructions as a system prompt; other harnesses have
  // no equivalent flag, so the footer is prepended to the prompt itself.
  if (opts.prompt) {
    writeText(
      path.join(ctx.runDir, f('prompt.txt')),
      claude || !opts.footer ? opts.prompt : opts.footer + '\n\n' + opts.prompt,
    );
  }
  // The user's arguments, and with Claude Code those left once their --settings and --append-system-prompt join Looper's.
  let userArgs: string[] = [...harness.args, ...opts.extraArgs];
  let userSettings: Record<string, unknown>[] = [];
  let systemPrompt: string | undefined = opts.footer || undefined;
  if (claude) {
    const read = await readUserSettings(userArgs, { target, cwd: task.cwd });
    userSettings = read.settings;
    const merged = mergeSystemPrompt(opts.footer, read.rest);
    systemPrompt = merged.text;
    userArgs = merged.rest;
  }
  // The ask helper waits the answer wait plus ASK_HELPER_MARGIN_S; its Bash call outlasts it.
  const askWaitS = opts.ask ? Math.ceil(opts.ask.waitMs / 1000) + ASK_HELPER_MARGIN_S : 0;
  const askBashMs = opts.ask ? (askWaitS + 30) * 1000 : 0;
  /** Interactive Claude Code: its permission requests go to Looper too. */
  const relayPermissions = claude && !headless && !!opts.permissions;
  if (claude) {
    if (systemPrompt) writeText(path.join(ctx.runDir, f('system.txt')), systemPrompt);
    for (const name of [MOD_FILES.ready, MOD_FILES.control, MOD_FILES.turnEnd, MOD_FILES.usage, MOD_FILES.toolEnd, STOP_FAILURE_FILE]) {
      fs.rmSync(path.join(ctx.runDir, f(name)), { force: true });
    }
    const hooks: Record<string, unknown> = {
      // The SessionStart payload names the session's transcript file (the Messages view reads it live), and the
      // session's own socket tells the helpers' caller from a session started inside the run.
      SessionStart: [
        { hooks: [{ type: 'command', command: target.renderSessionStartHook(targetFile(ctx, f('session.json')), targetFile(ctx, f(SOCKET_FILE))) }] },
      ],
      // A turn that ended on an API error (a usage limit, no login, no network): no Stop hook runs for it.
      ...(opts.keepOnApiError ? {} : { StopFailure: [{ hooks: [{ type: 'command', command: target.renderPipeHook(targetFile(ctx, f(STOP_FAILURE_FILE))) }] }] }),
    };
    if (relayPermissions && opts.permissions) {
      // Each permission request waits for Looper's answer too (the poll below), while the terminal asks.
      fs.rmSync(path.join(ctx.runDir, f(PERMISSIONS_DIR)), { recursive: true, force: true });
      writeText(path.join(ctx.runDir, 'bin', f(target.permissionHookFile)), target.renderPermissionHook(targetFile(ctx, f(PERMISSIONS_DIR))), 0o755);
      hooks.PermissionRequest = [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: target.stopHookCommand(targetFile(ctx, 'bin', f(target.permissionHookFile))),
              timeout: Math.ceil(opts.permissions.waitMs / 1000) + 60,
            },
          ],
        },
      ];
    }
    if (opts.stopGate) {
      // The Stop-hook gate: reminds once when the done command was never called,
      // and records allowed stops in stop.json — whose payload carries
      // last_assistant_message (the session's report) and what the session still
      // waits on, and whose mtime doubles as the idle signal.
      const stopHookFile = f(target.stopHookFile);
      const { blockNoDone } = stopHookMessages(opts.step);
      writeText(
        path.join(ctx.runDir, 'bin', stopHookFile),
        target.renderStopHook({
          stopJson: targetFile(ctx, f('stop.json')),
          doneFile: targetFile(ctx, f('done')),
          reminderFile: targetFile(ctx, f('stop-reminded')),
          guidanceFile: opts.guidance ? targetFile(ctx, GUIDANCE_FILE) : undefined,
          eventsFile: opts.guidance ? targetFile(ctx, EVENTS_FILE) : undefined,
          delegateFile: opts.guidance ? targetFile(ctx, DELEGATE_FILE) : undefined,
          delegateBusyFile: opts.delegate ? targetFile(ctx, DELEGATE_DIR, DELEGATE_BUSY_FILE) : undefined,
          noticeFile: opts.guidance ? targetFile(ctx, NOTICE_FILE) : undefined,
          blockNoDone,
        }),
        0o755,
      );
      hooks.Stop = [{ hooks: [{ type: 'command', command: target.stopHookCommand(targetFile(ctx, 'bin', stopHookFile)) }] }];
    }
    // What an earlier session handed over is in its transcript.
    if (liveDir) await fs.promises.rm(liveDir, { recursive: true, force: true }).catch(() => undefined);
    // The mod hands guidance over, records each turn and keeps subagents from the signal helpers (engine/claude-mod.ts).
    writeClaudeMod(path.join(ctx.runDir, f(MOD_DIR)), {
      files: {
        ready: targetFile(ctx, f(MOD_FILES.ready)),
        control: targetFile(ctx, f(MOD_FILES.control)),
        turnEnd: targetFile(ctx, f(MOD_FILES.turnEnd)),
        usage: targetFile(ctx, f(MOD_FILES.usage)),
        turn: targetFile(ctx, f('turn.json')),
        ...(relayPermissions ? { toolEnd: targetFile(ctx, f(MOD_FILES.toolEnd)) } : {}),
      },
      inbox: (opts.inbox ?? (opts.guidance ? [GUIDANCE_FILE, EVENTS_FILE, DELEGATE_FILE, NOTICE_FILE] : [])).map((name) => targetFile(ctx, name)),
      userInbox: (opts.inbox ?? (opts.guidance ? [GUIDANCE_FILE] : [])).map((name) => targetFile(ctx, name)),
      signalCommands,
      guardMessage: subagentGuardMessage(signalCommands),
      ...(askBashMs ? { ask: { command: opts.ask!.command, timeoutMs: askBashMs } } : {}),
      ...(headless ? { cronRefusal: CRON_REFUSAL } : {}),
      headless,
      prompted: !!opts.prompt,
      windows: target.kind === 'windows',
      ...(liveDir ? { live: targetFile(ctx, f(MOD_FILES.live)) } : {}),
    });
    writeJsonAtomic(
      path.join(ctx.runDir, f('settings.json')),
      mergeClaudeSettings(
        {
          // A helper command must never be blocked by a permission prompt, and the
          // Bash sandbox must never confine it: the run dir sits outside the
          // sandbox's writable set (EROFS), e.g. on /mnt/c for a WSL agent.
          permissions: { allow: helperCommands.flatMap((c) => [`Bash(${c}:*)`, `Bash(${c})`]) },
          sandbox: { excludedCommands: helperCommands },
          // The ask helper's Bash call waits in the foreground for the whole answer wait: the mod gives it that timeout.
          ...(askBashMs ? { env: { BASH_MAX_TIMEOUT_MS: String(Math.max(BASH_MAX_DEFAULT_MS, askBashMs)) } } : {}),
          ...projectMcpApproval(harness),
          hooks,
        },
        [...(opts.settings ? [opts.settings] : []), ...userSettings],
      ),
    );
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
    if (opts.effort) parts.push('--effort', q(opts.effort));
    if (opts.permissionMode) parts.push('--permission-mode', q(opts.permissionMode));
    if (opts.session) parts.push(opts.session.resume ? '--resume' : '--session-id', q(opts.session.id));
    if (systemPrompt) parts.push('--append-system-prompt', target.catFile(targetFile(ctx, f('system.txt'))));
    parts.push('--settings', q(targetFile(ctx, f('settings.json'))));
    parts.push('--plugin-dir', q(targetFile(ctx, f(MOD_DIR))));
    if (headless) {
      parts.push('-p', '--output-format', 'stream-json', '--verbose');
      // Under -p Claude Code sends thinking blocks without their text unless the display is set explicitly.
      parts.push('--thinking-display', 'summarized');
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
    if (opts.effort) parts.push('-c', q('model_reasoning_effort=' + opts.effort));
    if (headless && opts.guidance) {
      const hookCmd = codexGuideHookCommand(ctx);
      if (hookCmd) parts.push('-c', q(`hooks.PostToolUse=[{hooks=[{type='command',command='${hookCmd}'}]}]`));
    }
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
  for (const arg of userArgs) parts.push(q(arg));
  if (opts.prompt) {
    // claude's variadic options (--allowedTools, --disallowedTools, ...) swallow
    // the following positional, eating the prompt when such a flag comes last:
    // terminate option parsing so the prompt always lands as the prompt.
    if (claude) parts.push('--');
    parts.push(target.catFile(targetFile(ctx, f('prompt.txt'))));
  }
  let body = (target.kind === 'windows' ? '' : 'exec ') + parts.join(' ');
  if (codex) {
    // Record the target-native codex home before the CLI starts: the rollout
    // transcript behind the Messages view lives under it, only the target
    // knows its own home, and codex never prints the path.
    body = recordCodexHome(target.kind, q(targetFile(ctx, f('codex-home')))) + '\n' + body;
  }
  const launcher = writeLauncher(ctx, opts.launcherName, body, harness.env, {
    prefix: opts.prefix,
    doneCommand,
    doneStatuses,
    completeCommand: opts.completeCommand,
    // The helper outwaits Looper's own deadline, so the no-answer text is what it prints.
    ask: opts.ask ? { command: opts.ask.command, waitS: askWaitS } : undefined,
    delegateCommand: opts.delegate?.command,
    watchCommand: opts.watchCommand,
  });
  const askDir = path.join(ctx.runDir, f(ASK_DIR));
  // A question an earlier session of the run left behind has nobody waiting on it.
  fs.rmSync(askDir, { recursive: true, force: true });
  // Nor has a delegate request; the busy file stays, since the agents an earlier session started may still be going.
  const delegateDir = path.join(ctx.runDir, DELEGATE_DIR);
  for (const sub of ['requests', 'responses']) fs.rmSync(path.join(delegateDir, sub), { recursive: true, force: true });

  if (opts.continued) {
    // A restarted session writes after the earlier one; a line in the logs marks where.
    const mark = '\n── context restart: a new session continues the run ──\n\n';
    for (const name of headless ? ['output.log'] : ['output.log', 'output.txt']) {
      try {
        fs.appendFileSync(path.join(ctx.runDir, f(name)), mark);
      } catch {
        /* never fatal */
      }
    }
  }
  const out = fs.createWriteStream(path.join(ctx.runDir, f('output.log')), { flags: 'a' });
  out.on('error', () => {
    /* never fatal */
  });
  // Headless output is stream-json: one huge JSON object per line. Running it
  // through a terminal would wrap it into thousands of rows, so output.txt is
  // written straight from the stream. Interactive output is a TUI and needs
  // the terminal emulation, which lives in a worker thread.
  const cleanOut = headless
    ? fs.createWriteStream(path.join(ctx.runDir, f('output.txt')), { flags: opts.continued ? 'a' : 'w' })
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
        append: opts.continued,
        onError: (e) => ctx.log.warn(`[${task.id}] terminal worker failed: ${e.message}`),
      });

  let spawnError: string | undefined;
  const onSpawnError = (e: Error) => {
    ctx.log.error(`[${task.id}] cannot start ${harness.name}: ${e.message}`);
    spawnError = e.message;
  };
  const proc = headless ? spawnPiped(launcher.spec, ctx.runDir, onSpawnError) : spawnPty(launcher.spec, ctx.runDir, onSpawnError);
  void proc.spawned.then((pid) => ctx.log.info(`[${task.id}] ${opts.step} pid ${pid}: ${launcher.spec.command} ${launcher.spec.args.join(' ')}`));

  const started = Date.now();
  let ended = false;
  /** Claude Code had no usable login (SessionEnd.login). */
  let noLogin = false;
  let held = false;
  let exitCode: number | null = null;
  let exited = false;
  let lastInputAt = 0;
  let idleSince: number | null = null;
  /** The turn that set idleSince left something that will start the next one: the idle limit doesn't count. */
  let waiting = false;
  const stream = new HeadlessStream();
  let streamBuf = '';
  let prevEndedNewline = false;
  /** Rolling tail of raw output: what an exit or an expired timer can be blamed on. */
  let recentOut = '';
  /** Latest last_assistant_message seen from the Stop/notify hook (interactive). */
  let lastMessage: string | undefined;
  /** The last turn end the Stop/notify hook recorded: when, and its final message. */
  let lastStop: { mtime: number; message: string | undefined } | null = null;
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
  /** Every byte printed, kept twice: the head (resume and environment checks) and the tail (what to blame an end on). */
  const noteOutput = (d: string): void => {
    if (earlyOutput.length < 16384) earlyOutput += d;
    recentOut = (recentOut + d).slice(-RECENT_OUT_BYTES);
  };
  const sessionLost = (): boolean => watchResume && RESUME_LOST_RE.test(earlyOutput);
  /**
   * wsl.exe failed before the harness ever ran: its error is the first thing
   * printed. Only the head counts, so a wsl.exe error the agent's own tools
   * print mid-run can never pass for the environment failing.
   */
  const environmentFailed = (): boolean => looksLikeEnvironmentError(earlyOutput.slice(0, 2048));
  /** wsl.exe's error code (Wsl/Service/WSAETIMEDOUT…): the one part of its message worth a headline. */
  const environmentHeadline = (): string => /\bWsl\/[\w/]+/.exec(earlyOutput.replace(/\0/g, ''))?.[0] ?? 'WSL unavailable';
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
    doneCommand || opts.restartCommand ? path.join(ctx.runDir, f('done')) : undefined,
    path.join(ctx.runDir, f('stop.json')),
    ctx.settings.signalPollMs,
    claude && !headless ? path.join(ctx.runDir, f('turn.json')) : undefined,
  );

  /** Claude Code: the mod reported in this session (mod.json), so it hands messages over and Stop goes through it. */
  let modReady = false;
  /** Each Stop sent through the mod raises this (MOD_FILES.control). */
  let abortSeq = 0;
  let modTimer: NodeJS.Timeout | null = null;
  const runFile = (name: string): string => path.join(ctx.runDir, f(name));
  const mtimeOf = (name: string): Promise<number | null> =>
    fs.promises.stat(runFile(name)).then(
      (s) => s.mtimeMs,
      () => null,
    );
  const readJsonFile = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      const v: unknown = JSON.parse(await fs.promises.readFile(runFile(name), 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  /** `$.session.usage()` as the mod last saved it. */
  const modUsage = () => readJsonFile(MOD_FILES.usage);
  /** The final answer of a turn that ended at or after `since`, as the mod recorded it. */
  const answerSince = async (since: number): Promise<string | undefined> => {
    const at = await mtimeOf(MOD_FILES.turnEnd);
    if (at === null || at < since) return undefined;
    const answer = (await readJsonFile(MOD_FILES.turnEnd))?.answer;
    return typeof answer === 'string' && answer.trim() ? answer.trim() : undefined;
  };
  /** When the usage the mod saw says a limit is used up: the latest reset among the full windows. */
  const usageResetMs = async (): Promise<number | null> => {
    const limits = (await modUsage())?.rateLimits;
    if (!Array.isArray(limits)) return null;
    const resets = limits
      .filter((l: { percentUsed?: unknown }) => typeof l?.percentUsed === 'number' && l.percentUsed >= 100)
      .map((l: { resetsAt?: unknown }) => (typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN))
      .filter((ms) => Number.isFinite(ms));
    return resets.length ? Math.max(...resets) : null;
  };
  let stopFailureAt = 0;
  /**
   * Interactive Claude Code: a turn ended on an API error (StopFailure). A usage
   * limit retries after its reset, a lost login or network is the machine's
   * error, and any other API error ends the run with Claude Code's message.
   */
  const checkStopFailure = async (): Promise<void> => {
    const at = await mtimeOf(STOP_FAILURE_FILE);
    if (at === null || at <= stopFailureAt) return;
    stopFailureAt = at;
    const payload = await readJsonFile(STOP_FAILURE_FILE);
    if (!payload || ended || doneMtime !== null) return;
    const error = typeof payload.error === 'string' ? payload.error : '';
    const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
    const headline = headlineOf(text) ?? (error ? `API error: ${error}` : 'API error');
    if (error === 'max_output_tokens') return;
    if (/rate_limit/.test(error) || USAGE_LIMIT_RE.test(text)) {
      const now = Date.now();
      const resetMs = parseUsageLimitReset(text, now) ?? (await usageResetMs()) ?? now + USAGE_LIMIT_FALLBACK_MS;
      ctx.log.error(`[${task.id}] ${headline}; retrying after ${new Date(resetMs).toISOString()}`);
      await finish('error', headline, undefined, resetMs + USAGE_LIMIT_RETRY_MARGIN_MS);
    } else if (/authentication/.test(error) || LOGIN_FAILED_RE.test(text)) {
      ctx.log.error(`[${task.id}] Claude Code needs you to log in again`);
      noLogin = true;
      await finish('error', 'Claude Code needs you to log in again', text || undefined, undefined, undefined, true);
    } else if (CLAUDE_NETWORK_RE.test(text) || looksLikeNetworkError(text)) {
      ctx.log.error(`[${task.id}] ${headline}`);
      await finish('error', headline, text || undefined, undefined, true);
    } else {
      ctx.log.error(`[${task.id}] the turn ended on an API error (${error || 'unknown'}): ${headline}`);
      await finish('error', headline, text || undefined);
    }
  };
  if (claude) {
    let checking = false;
    modTimer = setInterval(() => {
      if (checking || ended) return;
      checking = true;
      void (async () => {
        if (!modReady) {
          if ((await mtimeOf(MOD_FILES.ready)) !== null) {
            modReady = true;
            ctx.log.info(`[${task.id}] ${opts.step}: Looper's mod is running in the session`);
          } else {
            const startedAt = await mtimeOf('session.json');
            if (startedAt !== null && startedAt >= started - 1000 && Date.now() - startedAt > MOD_READY_MS && !ended) {
              ctx.log.error(`[${task.id}] ${MOD_MISSING_TEXT}`);
              await finish('error', MOD_MISSING_TEXT, undefined, undefined, undefined, true);
              return;
            }
          }
        }
        if (!headless && !opts.keepOnApiError) await checkStopFailure();
      })()
        .catch((e: Error) => ctx.log.warn(`[${task.id}] cannot read the session's state: ${e.message}`))
        .finally(() => (checking = false));
    }, 1000);
  }

  let trustHandled = headless || !autoTrustWorkspace(harness);
  let promptSince: number | null = null;
  /** SessionStart fired for this session (its hook wrote session.json after the spawn). */
  let sessionStarted = false;
  const startupBlocked = (now: number): boolean => {
    if (sessionStarted || now - started < STARTUP_PROMPT_MS) return false;
    try {
      // An earlier session of a continued run may have left its own session.json.
      sessionStarted = fs.statSync(path.join(ctx.runDir, f('session.json'))).mtimeMs >= started - 1000;
    } catch {
      /* not written yet */
    }
    return !sessionStarted;
  };

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
    // A console that hasn't connected or printed yet has no pid to kill by; its kill above ends it.
    const pid = (await withTimeout(proc.spawned, 3000)) ?? 0;
    if (pid > 0) await killHostTree(pid);
    await withTimeout(target.killLeftovers(ctx.runId), 20_000);
    await withTimeout(exitPromise, 3000);
  };

  const finish = async (
    reason: SessionEndReason,
    headline?: string,
    body?: string,
    retryAtMs?: number,
    network?: boolean,
    environment?: boolean,
  ): Promise<void> => {
    if (ended) return;
    ended = true;
    watcher.stop();
    clearTimeout(maxTimer);
    if (contextTimer) clearInterval(contextTimer);
    if (liveTimer) clearInterval(liveTimer);
    if (askTimer) clearInterval(askTimer);
    if (delegateTimer) clearInterval(delegateTimer);
    if (doneTimer) clearTimeout(doneTimer);
    if (modTimer) clearInterval(modTimer);
    if (permissionTimer) clearInterval(permissionTimer);
    settlePermission();
    // Interactive Claude Code's cost and a report the Stop hook never brought: the mod's record, read before the session goes.
    const usage = claude && stream.costUsd === undefined ? await modUsage() : null;
    const modCost = (usage?.cost as { usd?: unknown } | undefined)?.usd;
    if (reason === 'done' && !body && claude && doneMtime !== null) body = await answerSince(doneMtime);
    if (!exited) await killTree();
    out.end();
    // output.txt is read the moment `finished` resolves (run log, tests): let it land.
    if (cleanOut) await withTimeout(new Promise<boolean>((r) => cleanOut.end(() => r(true))), 2000);
    await host?.close();
    // The transcript has every row now.
    if (liveDir) await fs.promises.rm(liveDir, { recursive: true, force: true }).catch(() => undefined);
    resolveFinished({
      reason,
      exitCode,
      doneStatus: reason === 'done' ? doneStatus : undefined,
      headline,
      body,
      sessionLost: sessionLost() || undefined,
      structured: stream.structured,
      costUsd: stream.costUsd ?? (typeof modCost === 'number' ? modCost : undefined),
      sessionId: notifySessionId ?? stream.sessionId,
      retryAtMs,
      network: network || undefined,
      environment: environment || undefined,
      login: noLogin || undefined,
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
      await finish('error', spawnError, undefined, undefined, undefined, looksLikeEnvironmentError(spawnError));
      return;
    }
    // The environment never started the harness: no stream, no verdict, wsl.exe's message is all there is.
    if (code !== 0 && environmentFailed()) {
      await finish('error', `${harness.name} never started: ${environmentHeadline()}`, undefined, undefined, undefined, true);
      return;
    }
    if (sessionLost()) {
      await finish('error', RESUME_LOST_TEXT);
      return;
    }
    const doneText = await fs.promises.readFile(path.join(ctx.runDir, f('done')), 'utf8').catch(() => '');
    const done = doneText.trim() ? parseDoneText(doneText, parseStatuses) : null;
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
    // Claude Code has no login: an environment error, which doesn't count toward auto-pause and is retried.
    if (stream.isError && stream.loginFailed) {
      const headline = headlineOf(body) ?? 'Claude Code needs you to log in again';
      ctx.log.error(`[${task.id}] ${headline}`);
      noLogin = true;
      await finish('error', headline, body, undefined, undefined, true);
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

  /** The context watch's poll (see below); unset without a context limit. */
  let contextTimer: NodeJS.Timeout | null = null;
  /** The live folder's sweep (see below); unset without one. */
  let liveTimer: NodeJS.Timeout | null = null;
  /** The ask poll (see below); unset when the session cannot ask. */
  let askTimer: NodeJS.Timeout | null = null;
  /** The question waiting on an answer: its request id, its text, and when Looper took it. */
  let pendingAsk: { rid: string; question: string; at: number } | null = null;
  /** The delegate poll (see below); unset when the session cannot start agents. */
  let delegateTimer: NodeJS.Timeout | null = null;
  /** The permission poll (see below); unset when Looper doesn't relay the session's permission requests. */
  let permissionTimer: NodeJS.Timeout | null = null;
  const maxTimer = Number.isFinite(opts.maxRuntimeMs)
    ? setTimeout(() => void finish('max-runtime', opts.maxRuntimeText, undefined, undefined, stalledOnNetwork()), opts.maxRuntimeMs)
    : undefined;

  /** Headless stream to the live output: pipes carry bare LF, a terminal needs CRLF; blank runs collapse. */
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
  // diagnostics. They go to the raw log and the live output, never to output.txt.
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
    } else if (spawnError) {
      void finish('error', spawnError, undefined, undefined, undefined, looksLikeEnvironmentError(spawnError));
    } else if (doneMtime !== null) {
      // Signalled done, then exited before the turn ended: headline only.
      void finish('done', doneHeadline);
    } else if (sessionLost()) {
      void finish('error', RESUME_LOST_TEXT);
    } else if (environmentFailed()) {
      void finish('error', `${harness.name} never started: ${environmentHeadline()}`, undefined, undefined, undefined, true);
    } else {
      void finish('exited', `${harness.name} exited ${code}`, undefined, undefined, outputBlamesNetwork());
    }
  });

  if (!headless) {
    watcher.start({
      onDone: (msg, mtime) => {
        if (ended || doneMtime !== null) return;
        doneMtime = mtime;
        const parsed = parseDoneText(msg, parseStatuses);
        doneStatus = parsed.status ?? opts.implicitDoneStatus;
        doneHeadline = headlineOf(parsed.message) ?? 'done';
        // The done file is read once two polls agree, so the turn's Stop may have come in between: it carries the report.
        if (lastStop && lastStop.mtime >= mtime) {
          void finish('done', doneHeadline, lastStop.message);
          return;
        }
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
        lastStop = { mtime, message: msg || undefined };
        // The turn that ran the done command ends after it: that Stop carries the report.
        if (doneMtime !== null && mtime >= doneMtime) {
          void finish('done', doneHeadline, msg || undefined);
          return;
        }
        if (mtime <= lastInputAt) return;
        if (idleSince === null || mtime > idleSince) {
          idleSince = mtime;
          waiting = stopWaitsOn(payload);
        }
        // Guidance that missed the turn (no hook ran after it arrived) starts the next one.
        deliverIdleGuidance();
      },
      onTurn: (mtime) => {
        if (ended || idleSince === null || mtime <= idleSince) return;
        idleSince = null;
        if (held) {
          held = false;
          cb.onResume?.();
        }
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
          // A usage limit, a lost login or network end the turn through StopFailure (checkStopFailure).
          // A prompt visible on screen, or a session that never started = the session is waiting for a human; treat as idle.
          const blocked = startupBlocked(now);
          if (blocked || host.screenContains(WAITING_PROMPT_RE)) {
            if (promptSince === null) {
              promptSince = now;
              ctx.log.info(`[${task.id}] ${opts.step} is waiting on a ${blocked ? 'startup ' : ''}prompt`);
            }
          } else if (promptSince !== null) {
            promptSince = null;
            ctx.log.info(`[${task.id}] prompt resolved; ${opts.step} continues`);
          }
        }
        // A question or a permission request has a wait of its own, which ends it.
        if (held || pendingAsk || pendingPermission || opts.delegate?.busy()) return;
        const since = (waiting ? null : idleSince) ?? promptSince;
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

  /**
   * Keyboard input from looper itself (guidance typed in): the session is
   * busy again. A focus report is a terminal gaining or losing focus, not
   * anyone acting on the session.
   */
  function input(data: string): void {
    if (ended) return;
    if (!FOCUS_REPORT_RE.test(data)) {
      lastInputAt = Date.now();
      idleSince = null;
      promptSince = null;
      if (held) {
        held = false;
        cb.onResume?.();
      }
    }
    proc.write(data);
  }

  /**
   * Interactive, the turn over (idle or held) and no done signal yet: nothing
   * will run a hook, so the waiting guidance is typed in as the next prompt.
   * A bracketed paste keeps its line breaks from submitting early; Enter
   * follows once the TUI has taken the paste in.
   */
  function deliverIdleGuidance(): void {
    if (!opts.guidance || headless || ended || doneMtime !== null) return;
    // Claude Code's mod starts the next turn with it, unless someone is typing in the terminal.
    if (claude && modReady) return;
    if (idleSince === null && !held) return;
    const text = takePendingGuidance(ctx.runDir);
    // Related events wait behind the user's guidance, the delegated agents' messages behind them, and Looper's own notice last.
    const events = text === null ? takeEvents(ctx.runDir) : null;
    const delegated = text === null && events === null ? takeDelegateMessages(ctx.runDir) : null;
    const message =
      text !== null
        ? guidanceMessage(text)
        : events !== null
          ? eventsMessage(events)
          : delegated !== null
            ? delegateMessage([delegated])
            : takeNotice(ctx.runDir);
    if (message === null) return;
    const what = text !== null ? "the user's guidance" : events !== null ? 'related events' : delegated !== null ? "the delegated agents' messages" : "Looper's notice";
    ctx.log.info(`[${task.id}] typing ${what} into the idle session`);
    input('\x1b[200~' + message.replace(/\r?\n/g, '\r') + '\x1b[201~');
    setTimeout(() => input('\r'), 300);
  }

  /**
   * The context watch: once the conversation passes the limit, the notice is
   * left for the agent (a hook hands it over with the next tool result or at
   * the turn's end; an idle session gets it typed in), and again each time
   * the context grows another tenth of the limit.
   */
  let distro: string | undefined;
  try {
    const env = resolveEnvironment(task, ctx.settings);
    distro = env.kind === 'wsl' ? env.distro : undefined;
  } catch {
    /* no environment: the paths need no distro */
  }

  // The live folder keeps only the rows the transcript doesn't have yet, whether or not anyone reads the conversation.
  if (liveDir) {
    let sweep: LiveSweep | null = null;
    let sweeping = false;
    liveTimer = setInterval(() => {
      if (sweeping || ended) return;
      sweeping = true;
      void (async () => {
        if (!sweep) {
          // An earlier session of a continued run may have left its own session.json.
          const at = await mtimeOf('session.json');
          if (at === null || at < started - 1000) return;
          const transcript = await findStepTranscript(ctx.runDir, opts.prefix, (p) => transcriptHostPath(p, ctx.host, distro));
          if (!transcript) return;
          sweep = new LiveSweep(liveDir, transcript.file);
        }
        await sweep.sweep();
      })()
        .catch((e: Error) => ctx.log.warn(`[${task.id}] cannot clear the live folder: ${e.message}`))
        .finally(() => (sweeping = false));
    }, ctx.settings.signalPollMs * 2);
  }

  if (opts.context && (claude || codex)) {
    const { limit, notice } = opts.context;
    const stepSize = Math.max(1, Math.round(limit / 10));
    let transcript: { file: string; kind: 'claude' | 'codex' } | null = null;
    let asked = 0;
    let busy = false;
    contextTimer = setInterval(() => {
      if (busy || ended || doneMtime !== null) return;
      busy = true;
      void (async () => {
        // Claude Code's mod saves the live context every few seconds; the transcript is read only without it.
        const live = modReady ? ((await modUsage())?.context as { tokens?: unknown } | undefined)?.tokens : undefined;
        let tokens: number | null = typeof live === 'number' ? live : null;
        if (tokens === null) {
          transcript ??= await findStepTranscript(ctx.runDir, opts.prefix, (p) => transcriptHostPath(p, ctx.host, distro));
          if (!transcript) return; // not written yet
          tokens = await readContextTokens(transcript.file, transcript.kind);
        }
        if (tokens === null || tokens < limit || ended || doneMtime !== null) return;
        const step = 1 + Math.floor((tokens - limit) / stepSize);
        if (step <= asked) return;
        queueNotice(ctx.runDir, notice(tokens, asked > 0));
        asked = step;
        ctx.log.info(`[${task.id}] context at ${tokens} tokens, past the limit of ${limit}; notice left for the agent`);
        cb.onContext?.(tokens, limit);
        deliverIdleGuidance();
      })()
        .catch((e: Error) => ctx.log.warn(`[${task.id}] cannot read the context: ${e.message}`))
        .finally(() => (busy = false));
    }, ctx.settings.signalPollMs * CONTEXT_POLLS);
  }

  /** The waiting helper prints `text` and exits with `code`; the code file appears last, by rename, so the response is whole. */
  const respond = (rid: string, text: string, code: number): void => {
    const res = path.join(askDir, 'responses');
    try {
      fs.mkdirSync(res, { recursive: true });
      fs.writeFileSync(path.join(res, `${rid}.out`), text.endsWith('\n') ? text : text + '\n');
      fs.writeFileSync(path.join(res, `${rid}.code.tmp`), String(code));
      fs.renameSync(path.join(res, `${rid}.code.tmp`), path.join(res, `${rid}.code`));
    } catch (e) {
      ctx.log.warn(`[${task.id}] cannot answer ${opts.ask?.command}: ${(e as Error).message}`);
    }
  };

  /**
   * The ask poll: takes the oldest question the agent asked, and once its
   * wait runs out unanswered, sends the no-answer text back. One question at
   * a time; a second one waits in requests/ until the first is settled.
   */
  if (opts.ask) {
    const { command, waitMs, noAnswer } = opts.ask;
    const reqDir = path.join(askDir, 'requests');
    askTimer = setInterval(() => {
      if (ended) return;
      if (pendingAsk) {
        if (Date.now() - pendingAsk.at < waitMs) return;
        const { rid, question } = pendingAsk;
        pendingAsk = null;
        respond(rid, noAnswer, 0);
        ctx.log.info(`[${task.id}] nobody answered the agent's question in time`);
        cb.onNoAnswer?.(question);
        return;
      }
      let name: string | undefined;
      try {
        name = fs.readdirSync(reqDir).filter((n) => n.endsWith('.req')).sort()[0];
      } catch {
        return; // no question yet
      }
      if (!name) return;
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(reqDir, name), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
        fs.rmSync(path.join(reqDir, name), { force: true });
      } catch {
        return;
      }
      const rid = name.slice(0, -'.req'.length);
      // The op, the caller's folder, then one line per argument.
      const question = lines.slice(2).join(' ').trim();
      if (!question || question === '--help' || question === '-h') {
        respond(rid, `usage: ${command} "<question>"`, question ? 0 : 2);
        return;
      }
      pendingAsk = { rid, question, at: Date.now() };
      ctx.log.info(`[${task.id}] the agent asks ${ctx.delegatedBy ? 'the agent that started it' : 'the user'}: ${question}`);
      cb.onQuestion?.(question);
    }, ctx.settings.signalPollMs);
  }

  /**
   * The permission poll: the oldest request waiting goes to Looper. It stops
   * waiting when its file goes (the hook removes it once answered, the terminal
   * answered it and the hook ended), or Looper denies it once `waitMs` passes.
   */
  let pendingPermission: (ChatPermissionRequest & { at: number }) | null = null;
  const permissionDir = path.join(ctx.runDir, f(PERMISSIONS_DIR));
  const answerRequest = (id: string, json: string): void => {
    const file = path.join(permissionDir, `${id}.ans`);
    try {
      // Whole or not at all: the hook prints the answer as soon as the file exists.
      fs.writeFileSync(`${file}.tmp`, json);
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      ctx.log.warn(`[${task.id}] cannot answer permission request ${id}: ${(e as Error).message}`);
    }
  };
  /** Requests already answered, denied or let go: their files stay until their hook ends. */
  const settledPermissions = new Set<string>();
  const settlePermission = (): void => {
    if (!pendingPermission) return;
    settledPermissions.add(pendingPermission.id);
    pendingPermission = null;
    cb.onPermission?.(null);
  };
  if (relayPermissions && opts.permissions) {
    const { waitMs, noAnswer } = opts.permissions;
    let polling = false;
    permissionTimer = setInterval(() => {
      if (ended || polling) return;
      polling = true;
      void (async () => {
        const names = (await fs.promises.readdir(permissionDir).catch(() => [] as string[])).filter((n) => n.endsWith('.req')).sort();
        if (pendingPermission) {
          const { id, at, tool, input } = pendingPermission;
          // Answered in the terminal: the call ran (or was refused) and the mod saw it end, but Claude Code leaves the hook waiting.
          const last = await readJsonFile(MOD_FILES.toolEnd);
          const answeredThere = typeof last?.at === 'number' && last.at >= at && last.tool === tool && last.key === toolKey(input);
          if (!names.includes(`${id}.req`)) {
            settlePermission();
          } else if (answeredThere) {
            ctx.log.info(`[${task.id}] the agent's ${tool} call was answered in its terminal`);
            try {
              fs.writeFileSync(path.join(permissionDir, `${id}.cancel`), '');
            } catch {
              /* the hook ends at its timeout instead */
            }
            settlePermission();
          } else if (Date.now() - at >= waitMs) {
            ctx.log.info(`[${task.id}] nobody allowed the agent's ${pendingPermission.tool} call in time: denied`);
            answerRequest(id, permissionDecision(false, noAnswer));
            settlePermission();
          }
          return;
        }
        const name = names.find((n) => !settledPermissions.has(n.slice(0, -'.req'.length)));
        if (!name) return;
        const id = name.slice(0, -'.req'.length);
        try {
          const req = JSON.parse((await fs.promises.readFile(path.join(permissionDir, name), 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
          if (ended) return;
          pendingPermission = { id, tool: String(req.tool_name ?? 'tool'), input: req.tool_input ?? {}, at: Date.now() };
          ctx.log.info(`[${task.id}] the agent asks permission for ${pendingPermission.tool}`);
          cb.onPermission?.({ id, tool: pendingPermission.tool, input: pendingPermission.input });
        } catch (e) {
          // Unreadable: refuse it rather than leave the agent waiting for nobody.
          ctx.log.warn(`[${task.id}] unreadable permission request ${name}: ${(e as Error).message}`);
          answerRequest(id, permissionDecision(false, noAnswer));
          settledPermissions.add(id);
        }
      })()
        .catch((e: Error) => ctx.log.warn(`[${task.id}] cannot read permission requests: ${e.message}`))
        .finally(() => (polling = false));
    }, ctx.settings.signalPollMs);
  }

  /** The delegate poll: answers each request in order, one at a time. */
  if (opts.delegate) {
    const { command, handle } = opts.delegate;
    const reqDir = path.join(delegateDir, 'requests');
    const resDir = path.join(delegateDir, 'responses');
    const reply = (rid: string, text: string, code: number): void => {
      try {
        fs.mkdirSync(resDir, { recursive: true });
        fs.writeFileSync(path.join(resDir, `${rid}.out`), text.endsWith('\n') ? text : text + '\n');
        fs.writeFileSync(path.join(resDir, `${rid}.code.tmp`), String(code));
        fs.renameSync(path.join(resDir, `${rid}.code.tmp`), path.join(resDir, `${rid}.code`));
      } catch (e) {
        ctx.log.warn(`[${task.id}] cannot answer ${command}: ${(e as Error).message}`);
      }
    };
    let handling = false;
    delegateTimer = setInterval(() => {
      if (ended || handling) return;
      let name: string | undefined;
      try {
        name = fs.readdirSync(reqDir).filter((n) => n.endsWith('.req')).sort()[0];
      } catch {
        return; // no request yet
      }
      if (!name) return;
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(reqDir, name), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
        fs.rmSync(path.join(reqDir, name), { force: true });
      } catch {
        return;
      }
      const rid = name.slice(0, -'.req'.length);
      // The op, the caller's folder, then one line per argument (the last line ends the file).
      const args = lines.slice(2);
      if (args.length && args[args.length - 1] === '') args.pop();
      handling = true;
      void handle(args, lines[1] ?? '')
        .then(
          (r) => reply(rid, r.text, r.code),
          (e: Error) => reply(rid, `looper: ${e.message}`, 1),
        )
        .finally(() => (handling = false));
    }, ctx.settings.signalPollMs);
  }

  return {
    runId: ctx.runId,
    get pid() {
      return proc.pid;
    },
    get held() {
      return held;
    },
    get question() {
      return pendingAsk?.question ?? null;
    },
    answer(text: string) {
      if (!pendingAsk || ended) return false;
      respond(pendingAsk.rid, `The user answered:\n\n${text}`, 0);
      pendingAsk = null;
      return true;
    },
    get permission() {
      if (!pendingPermission) return null;
      const { id, tool, input } = pendingPermission;
      return { id, tool, input };
    },
    answerPermission(id: string, allow: boolean) {
      if (ended || pendingPermission?.id !== id) return false;
      answerRequest(id, permissionDecision(allow, 'The user denied this in Looper.'));
      ctx.log.info(`[${task.id}] the user ${allow ? 'allowed' : 'denied'} the agent's ${pendingPermission.tool} call`);
      settlePermission();
      return true;
    },
    write: input,
    deliverGuidance: deliverIdleGuidance,
    get turnOver() {
      return !headless && !ended && (idleSince !== null || held);
    },
    stopTurn() {
      if (headless || ended || doneMtime !== null) return;
      if (claude && modReady) {
        // The mod ends the turn (no Stop hook runs for it), then starts the next one with the guidance waiting.
        if (idleSince === null && !held) {
          writeJsonAtomic(runFile(MOD_FILES.control), { abort: ++abortSeq });
          idleSince = Date.now();
          waiting = false;
        }
        return;
      }
      if (idleSince === null && !held) {
        // The turn is over from here, whether or not the harness runs its Stop hook for an interrupted turn.
        proc.write('\x1b');
        idleSince = Date.now();
        waiting = false;
      }
      // The TUI takes the Esc in before a paste.
      setTimeout(deliverIdleGuidance, 500);
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
