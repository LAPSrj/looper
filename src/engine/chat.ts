import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { stripAnsi } from '../shared/ansi';
import { agentArgs } from '../shared/projects';
import { fileAttachments, withCommands, withFileList, type CommandOutput } from '../shared/bash-mode';
import { UserCommands } from './command-output';
import type { SudoAskpass } from './sudo-askpass';
import { spawnOffThread, type OffThreadChild } from './exec-worker';
import {
  CONTINUE_TEXT,
  attachmentName,
  chatTitle,
  continueDelay,
  continueSkipped,
  forkPoint,
  slashCommandsOf,
  usageLimitsOf,
  type Attachment,
  type ChatContext,
  type ChatDraft,
  type ChatInfo,
  type ChatPermissionRequest,
  type ChatSettings,
  type ChatState,
  type QueuedMessage,
  type TaskWatch,
  type TitleBy,
  type UsageLimitHit,
  type WatchableTask,
  autoCompactPercent,
  contextPast,
} from '../shared/chat';
import { limitsKey, type SlashCommand, type UsageLimits } from '../shared/sessions';
import {
  codexPermissionArgs,
  harnessKindLabel,
  harnessModels,
  projectMcpApproval,
  resolveEffort,
  resolveEnvironment,
  resolveHarness,
} from '../shared/environments';
import { compactRows, compactedText, fromRun, contextFullResend, contextFullRetry, layered } from '../shared/compact';
import type { MessageRow } from '../shared/messages';
import type { EngineEvent, Harness, RunRecord, Settings, Task } from '../shared/types';
import { CHAT_MESSAGE_FILE, chatMessageWaiting, queueGuidance, readPendingGuidance, takeChatMessage, takePendingGuidance, writeChatMessage } from './guidance';
import { MOD_FILES } from './claude-mod';
import { ClaudeStreamAccumulator, CodexExecAccumulator } from './builder/stream';
import { contextOfLine, readCodexContextWindow, readContextTokens } from './context';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { COMPACTED_FILE, compactedFile, findCodexRollout, LiveRows, readCompactedReplNames, TranscriptReader, transcriptHostPath, withLooperInstructions } from './messages';
import { REPL_FILES, replDataFiles, replDefinitions, replNames, replPrelude, replStateNote } from './repl-state';
import { claudeModelWindows, modelWindows as sharedWindows } from './model-windows';
import { AGENT_WATCH, childEnv, SOCKET_FILE, WATCH_DIR, writeLauncher, type RunContext } from './steps/common';
import { parseWatchArgs, tasksText, WATCH_FOOTER, WATCH_USAGE, watchedLines, watchText, withWatch, type WatchTarget } from './task-watch';
import { mergeClaudeSettings, mergeSystemPrompt, readUserSettings, readUserSettingsSync } from './claude-settings';
import { takeFlagValues } from '../shared/claude-args';
import { endingError, usageLimitOf } from './sessions';
import { LOGIN_FAILED_RE } from '../shared/logins';
import { recordCodexHome, startSession, usageLimitReset, type SessionEnd, type SessionHandle } from './steps/session';
import { REMOTE_LINK_RE } from './remote';
import { readJson, writeJsonAtomic, writeText } from './store/fsutil';
import { newRunId } from './store/runs';
import type { OpenConversation } from './store/state';
import { createTarget, type Target } from './target';
import { killHostTree } from './target/kill';
import { joinTarget } from './target/paths';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The media type of an image the agents can see, by the file's extension; undefined for any other file. */
export function imageMediaType(file: string): string | undefined {
  return IMAGE_TYPES[path.extname(file).toLowerCase()];
}

/** Largest image sent to Claude inside the message: base64 grows it by a third, and the API refuses images over 5 MB. */
export const MAX_INLINE_IMAGE = 3_750_000;

/** How long a permission hook may wait for the user: the chat window stays open meanwhile. */
const PERMISSION_TIMEOUT_SEC = 86_400;

/** Bytes of an interactive chat's terminal output kept for a window that shows it after it started. */
const SCREEN_BYTES = 262_144;

/** Bytes of an interactive chat's latest terminal output searched for its Remote Control link. */
const REMOTE_SCAN_BYTES = 8192;

/** Claude Code's refusal to resume a Code Mode session headless (2.1.327: "This session was started in Code Mode (experimental), …"). */
const CODE_MODE_RESUME_RE = /session was started in Code Mode/i;

/** Why a Code Mode chat stays interactive. */
const CODE_MODE_TEXT = "This conversation is in Claude Code's Code Mode, which Claude Code goes on with only in a terminal, so the chat stays interactive. Compact into New Chat to go on headless.";

/** What an interactive chat's agent is told about a permission request nobody answered. */
const NO_PERMISSION_ANSWER = 'Nobody answered this permission request in Looper within a day, so it was denied.';

/** The chat folder's folder of subagent inboxes, one per agent id. */
const SUBAGENT_INBOX = 'subagent-inbox';

/** A Claude Code agent id ("a030e1626c74e4140"), which names a folder. */
const SUBAGENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Looper's copy of a file attached to a message, from the path an agent read
 * it at (tasks/<task>/attachments/<file>, in the agent's path form); null for
 * any other path.
 */
export function attachmentAt(tasksDir: string): (agentPath: string) => Attachment | null {
  return (agentPath) => {
    const parts = agentPath.split(/[\\/]/);
    if (parts.length < 3) return null;
    const [task, folder, name] = parts.slice(-3);
    if (folder !== 'attachments' || [task, name].some((s) => !s || s === '.' || s === '..')) return null;
    return { name: attachmentName(name), path: path.join(tasksDir, task, folder, name), image: !!imageMediaType(name) };
  };
}


/**
 * One message for Claude's stream-json input. An image goes inside the
 * message, where Claude sees it at once; any other file, or an image too
 * large to send that way, goes as its path in the target's form.
 */
export function claudeUserMessage(
  text: string,
  attachments: Attachment[],
  toTargetPath: (hostPath: string) => string,
  read: (hostPath: string) => Buffer = (p) => fs.readFileSync(p),
  /** A compacted chat's first message: the earlier conversation, as a text block of its own ahead of the message. */
  compacted?: string,
): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [];
  const files: string[] = [];
  for (const a of fileAttachments(attachments)) {
    const mediaType = a.image ? imageMediaType(a.path) : undefined;
    const data = mediaType ? read(a.path) : null;
    if (mediaType && data && data.length <= MAX_INLINE_IMAGE) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } });
    } else {
      files.push(toTargetPath(a.path));
    }
  }
  // The commands the user ran go first, as Claude Code's own bash mode puts them in the conversation.
  const body = withFileList(withCommands(text, attachments), files);
  const content = [...(compacted ? [{ type: 'text', text: compacted }] : []), ...(body ? [{ type: 'text', text: body }] : []), ...blocks];
  return { type: 'user', message: { role: 'user', content } };
}

/**
 * The decision a PermissionRequest hook prints for claude. No updatedInput:
 * with one, Claude Code checks the call again and refuses what still asks
 * (settings files, .mcp.json), even when the input is unchanged.
 */
export function permissionAnswer(allow: boolean): string {
  const decision = allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user denied this in Looper.' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

/**
 * Claude's stream-json control request that switches the permission mode of
 * the running session. '' (no mode) is the CLI's default mode.
 */
export function permissionModeRequest(requestId: string, mode: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode: mode || 'default' } });
}

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/** The turn of Codex's thread (as `thread/turns/list` lists it) holding the `occurrence`-th agent message with this text. */
export function forkTurnId(turns: unknown[], text: string, occurrence: number): string | null {
  let seen = 0;
  for (const turn of turns) {
    const t = obj(turn);
    const items = Array.isArray(t?.items) ? t.items : [];
    for (const item of items) {
      const i = obj(item);
      if (i?.type !== 'agentMessage' || typeof i.text !== 'string' || i.text.trim() !== text) continue;
      seen += 1;
      if (seen === occurrence) return typeof t?.id === 'string' ? t.id : null;
    }
  }
  return null;
}

/** How long Codex's app server gets to copy a thread. */
const FORK_TIMEOUT_MS = 60_000;

type AppServerCall = (method: string, params: Rec) => Promise<Rec>;

/**
 * A conversation with Codex's app server over its JSON-RPC on stdio (`codex
 * app-server`): `body` makes its calls after the handshake, and its answer
 * is the result. Rejects with the reason, or when the server ends or takes
 * longer than `timeoutMs`.
 */
function codexAppServer<T>(
  child: Pick<OffThreadChild, 'stdin' | 'stdout' | 'on'>,
  timeoutMs: number,
  endedEarly: string,
  body: (call: AppServerCall) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const waiting = new Map<number, (msg: Rec) => void>();
    let seq = 0;
    let done = false;
    const finish = (err: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error("Codex's app server didn't answer in time.")), timeoutMs);
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let msg: Rec | null;
      try {
        msg = obj(JSON.parse(line));
      } catch {
        return;
      }
      // Answers carry the request's id; the server's own requests and notifications don't concern a fork.
      if (!msg || typeof msg.id !== 'number' || !('result' in msg || 'error' in msg)) return;
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    child.on('error', (err: Error) => finish(err));
    child.on('close', () => finish(new Error(endedEarly)));
    child.stdin?.on('error', () => {
      /* the close reports it */
    });
    const send = (msg: Rec) => child.stdin?.write(JSON.stringify(msg) + '\n');
    const call: AppServerCall = (method, params) =>
      new Promise((ok, fail) => {
        const id = ++seq;
        waiting.set(id, (msg) => {
          const error = obj(msg.error);
          if (error) fail(new Error(String(error.message ?? `${method} failed`)));
          else ok(obj(msg.result) ?? {});
        });
        send({ id, method, params });
      });
    void (async () => {
      await call('initialize', { clientInfo: { name: 'looper', version: '1' } });
      send({ method: 'initialized' });
      finish(null, await body(call));
    })().catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * Fork a Codex thread through the turn holding an agent message, over the
 * app server: list the thread's turns, then `thread/fork` with that turn as
 * the last one. Returns the new thread's id; rejects with the reason.
 */
export function codexForkThread(
  child: Pick<OffThreadChild, 'stdin' | 'stdout' | 'on'>,
  threadId: string,
  text: string,
  occurrence: number,
  timeoutMs = FORK_TIMEOUT_MS,
): Promise<string> {
  return codexAppServer(child, timeoutMs, "Codex's app server ended before the fork was made.", async (call) => {
    const turns: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('thread/turns/list', {
        threadId,
        sortDirection: 'asc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      });
      if (Array.isArray(page.data)) turns.push(...page.data);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    const lastTurnId = forkTurnId(turns, text, occurrence);
    if (!lastTurnId) throw new Error("Codex's thread doesn't have this message.");
    const res = await call('thread/fork', { threadId, lastTurnId, excludeTurns: true });
    const id = obj(res.thread)?.id;
    if (typeof id !== 'string' || !id) throw new Error("Codex's app server didn't name the new thread.");
    return id;
  });
}

/** How long Codex's app server gets to list the skills. */
const SKILLS_TIMEOUT_MS = 20_000;

/** The skills Codex offers in a folder, from its app server's `skills/list`; disabled ones are left out. */
export function codexListSkills(
  child: Pick<OffThreadChild, 'stdin' | 'stdout' | 'on'>,
  cwd: string,
  timeoutMs = SKILLS_TIMEOUT_MS,
): Promise<SlashCommand[]> {
  return codexAppServer(child, timeoutMs, "Codex's app server ended before it listed the skills.", async (call) => {
    const res = await call('skills/list', { cwds: [cwd] });
    const out: SlashCommand[] = [];
    for (const entry of Array.isArray(res.data) ? res.data : []) {
      const skills = obj(entry)?.skills;
      for (const s of Array.isArray(skills) ? skills : []) {
        const skill = obj(s);
        if (!skill || typeof skill.name !== 'string' || skill.enabled === false) continue;
        if (out.some((x) => x.name === skill.name)) continue;
        out.push({ name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' });
      }
    }
    return out;
  });
}

/** A claude record's tool calls (tool_use) by id, or the ids of the calls its results answer (tool_result). */
export function toolUseIds(rec: Rec, kind: 'tool_use' | 'tool_result'): string[] {
  const content = obj(rec.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((c) => {
    const block = obj(c);
    const id = kind === 'tool_use' ? block?.id : block?.tool_use_id;
    return block?.type === kind && typeof id === 'string' ? [id] : [];
  });
}

/** The model's context window from claude's `result` record (modelUsage per model): the named model's, else the only one. */
export function claudeContextWindow(result: Rec, model: string | undefined): number | undefined {
  const usage = obj(result.modelUsage);
  if (!usage) return undefined;
  const entries = Object.entries(usage);
  const entry = obj(model ? usage[model] : undefined) ?? (entries.length === 1 ? obj(entries[0][1]) : null);
  const w = entry?.contextWindow;
  return typeof w === 'number' && w > 0 ? w : undefined;
}

/**
 * The account's usage limits in the mod's usage record ($.session.usage(),
 * Claude Code 2.1.327): `rateLimits` lists each window by its kind, with the
 * share used as a percentage and its reset as an ISO time. Null when it has
 * neither the 5-hour nor the 7-day window.
 */
export function modUsageLimits(usage: Rec): UsageLimits | null {
  const out: UsageLimits = {};
  for (const l of Array.isArray(usage.rateLimits) ? usage.rateLimits : []) {
    const w = obj(l);
    const resetsAt = typeof w?.resetsAt === 'string' ? Date.parse(w.resetsAt) : NaN;
    if (typeof w?.percentUsed !== 'number' || !Number.isFinite(resetsAt)) continue;
    const window = { used: w.percentUsed / 100, resetsAt };
    if (w.kind === 'five_hour') out.fiveHour = window;
    else if (w.kind === 'seven_day') out.sevenDay = window;
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

/** What a Claude chat's running process was started with. */
export interface Launched {
  model?: string;
  effort?: string;
  permissionMode: string;
  interactive: boolean;
}

/**
 * Claude runs one process for the whole chat. Headless, only the permission
 * mode changes while it runs (Bypass excepted: the CLI refuses it unless
 * started with it); in a terminal, Looper can't change it. A new model,
 * effort, session type, Bypass, or an interactive chat's new permission mode
 * needs a new process that resumes the conversation.
 */
export function needsNewProcess(launched: Launched, next: ChatSettings, nextEffort: string | undefined): boolean {
  const interactive = next.mode === 'interactive';
  if (launched.model !== next.model || launched.effort !== nextEffort || launched.interactive !== interactive) return true;
  if (interactive) return launched.permissionMode !== next.permissionMode;
  return next.permissionMode === 'bypassPermissions' && launched.permissionMode !== 'bypassPermissions';
}

export interface ChatDeps {
  dataDir: string;
  host: HostKind;
  /** Asks the user for sudo's password in the "!" commands of the chats (UserCommands). */
  askpass?: SudoAskpass;
  settings: Settings;
  log: Logger;
  emit: (e: EngineEvent) => void;
  /** The folder of a run: a chat's id is its run id. */
  runDir: (taskId: string, runId: string) => string;
  /** The conversation a run recorded, as rows: a run's (Continue in Chat) or a chat's own (opened again). */
  readHistory: (taskId: string, runId: string) => Promise<MessageRow[]>;
  /** The same conversation whole, as a compacted one keeps it (compactRows): what Compact starts from. */
  readCompactable: (taskId: string, runId: string) => Promise<MessageRow[]>;
  /** The newest rows of a run's conversation, when its transcript is long: they show while the whole of it is read (none for a short one). */
  readNewest?: (taskId: string, runId: string) => Promise<MessageRow[]>;
  /** A conversation from outside Looper, read from its transcript (a host path): its rows, and the whole of it as compaction keeps it. */
  readTranscript?: (hostPath: string, format: 'claude' | 'codex') => Promise<{ rows: MessageRow[]; compact: MessageRow[]; name?: string }>;
  /** The name a run's conversation has (the user's for a terminal session, else the harness's): Continue in Chat starts with it. */
  readName?: (taskId: string, runId: string) => Promise<string | undefined>;
  /** The chat is a run and the harness named its conversation: Looper's ledger of sessions keeps it. */
  onSession?: (chat: { taskId: string; runId: string; sessionId: string }) => void;
  writeInfo: (taskId: string, runId: string, info: ChatInfo) => void;
  /** Add a record to the task's run log and tell the windows. */
  appendRecord: (record: RunRecord) => void;
  taskVersion: (taskId: string) => number | undefined;
  /** Claude reported the usage limits of the account the harness (by limitsKey) runs on. */
  onLimits: (key: string, limits: UsageLimits) => void;
  /** A Claude turn ended: on Claude Code's error for a missing login (`worked` false), or without an error. */
  onLogin?: (environmentId: string, harnessId: string, worked: boolean) => void;
  /** Until when the chat's prompt cache lasts, when its harness says. */
  cacheUntil?: (chatId: string) => number | undefined;
  /**
   * Remote Control for a Claude chat starting on the harness: the name the
   * Claude app lists it under, or undefined to start without it.
   */
  remoteName?: (task: Task, harness: Harness) => string | undefined;
  /** Claude Code turned Remote Control on for the chat: its claude.ai address. */
  onRemote?: (chat: { id: string; taskId: string; name: string; cwd: string; dir: string; link: string }) => void;
  /** The chat closed (Close Conversation, or a move to another harness); quitting Looper keeps it for the next start. */
  onClose?: (chatId: string) => void;
  /**
   * A started conversation (`sessionId`) moves to another harness of the
   * task's environment: its transcript is copied to that harness's folder
   * when it keeps its conversations elsewhere (copyConversation).
   */
  moveConversation?: (task: Task, fromHarnessId: string, toHarnessId: string, sessionId: string) => Promise<void>;
  /** A chat that goes on with a run (Continue in Chat) opened, at Looper's start too. */
  onOpen?: (chat: { id: string; taskId: string; fromRunId: string }) => void;
  /** A chat compacted into `to` (by hand or by itself): the task's run it held goes on there, and what's kept by its id moves. */
  onCompacted?: (chat: { taskId: string; from: string; to: string }) => void;
  /** A message for the chat's agent: the user's, or Looper's (related events). */
  onTalk?: (chat: { id: string; taskId: string }) => void;
  /** The tasks a chat on the task (`chatTaskId`) can watch: every task, in the Tasks list's order. */
  watchTargets?: (chatTaskId: string) => WatchTarget[];
  /** A chat closed for good has ended its processes: `sessionId` is the conversation it went on with. */
  onClosed?: (chat: { id: string; taskId: string; sessionId?: string }) => void;
}

/** Claude's stream-json control request that turns Remote Control on (with the name the Claude app lists the session under) or off. */
export function remoteControlRequest(requestId: string, name: string | undefined): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: name ? { subtype: 'remote_control', enabled: true, name } : { subtype: 'remote_control', enabled: false },
  });
}

/**
 * Claude's stream-json control request that renames the session, as a host
 * does (source "host": Claude Code counts it as the user's rename, and writes
 * a custom-title record to the transcript). Claude Code refuses an empty title.
 */
export function renameSessionRequest(requestId: string, title: string, sessionId?: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'rename_session', title, source: 'host', ...(sessionId ? { session_id: sessionId } : {}) },
  });
}

/** Claude's stream-json control request that stops one background task (its task id), as its own task list's stop does. */
export function stopTaskRequest(requestId: string, taskId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: taskId } });
}

/** Most of the first message Claude Code gets to name a chat from. */
const MAX_TITLE_DESCRIPTION = 2000;

/**
 * Claude's stream-json control request that names the session from
 * `description` (Claude Code 2.1.318's generate_session_title handler: its
 * answer is `{ title }`). `persist` keeps the name in the transcript, and a
 * session that already has one answers with that.
 */
export function sessionTitleRequest(requestId: string, description: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'generate_session_title', description, persist: true } });
}

/** The text of a user record's message: its content string, or its text blocks joined. */
export function userRecordText(rec: Record<string, unknown>): string {
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && (c as Rec).type === 'text' && typeof (c as Rec).text === 'string' ? ((c as Rec).text as string) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

interface Pending {
  text: string;
  attachments: Attachment[];
}

/**
 * The earlier conversation's rows (a run's transcript, or a forked chat's
 * copy) with ids of their own: `h` and the position. The chat's live rows are
 * numbered from 0 by their accumulator, and the transcript's rows are too, so
 * without this the two lists share ids, and one list of both (the Sessions
 * window's) repeats React keys.
 */
export function historyRows(rows: MessageRow[]): MessageRow[] {
  return rows.map((r, i) => ({ ...r, id: `h${i}` }));
}

/**
 * How often an interactive chat reads the rows its mod hands over
 * (MOD_FILES.live). They're on the run folder's own disk, so this is cheap,
 * where the transcript may be on another system's.
 */
const LIVE_POLL_MS = 100;

/** Fork and Compact while the chat's earlier conversation is still being read. */
const HISTORY_READING = 'The conversation is still being read. Try again in a moment.';

/** How long Stop waits for Claude to end its turn by itself before ending the process. */
const INTERRUPT_GRACE_MS = 5000;
/** How long a message the mod handed over still shows as queued after a turn it could have started ended without it. */
const DELIVERED_GRACE_MS = 3000;

/** The user message Claude records when a turn is interrupted. */
const INTERRUPTED = '[Request interrupted by user]';

/**
 * Fork from Here: the conversation the new chat starts from, until the agent
 * has made its copy. Claude copies it up to a message (by its transcript id);
 * Codex up to the end of the turn holding an agent message (found by its text,
 * the `occurrence`-th time that text appears, counting from 1).
 */
type ForkSource = { sessionId: string; claudeAt: string } | { sessionId: string; codexText: string; occurrence: number };

/**
 * A chat's settings once it moves to harness `to`: the task's own on the
 * task's harness, the chat's on another harness of the same kind, else the
 * defaults, since model ids, efforts and modes don't carry across kinds.
 */
export function chatSettingsOn(
  to: Harness,
  from: { kind: Harness['kind']; settings: ChatSettings },
  own: { id: string; settings: ChatSettings },
): ChatSettings {
  if (to.id === own.id) return own.settings;
  if (to.kind === from.kind) return from.settings;
  return { permissionMode: 'auto' };
}

/** A new chat moved to another harness before its first message: its id, the harness, and the settings it had. */
export interface HarnessChoice {
  id: string;
  harnessId: string;
  from: { kind: Harness['kind']; settings: ChatSettings };
}

/** How a chat window starts. */
export type ChatOpening =
  /** Open Project in Chat: a new conversation. */
  | { kind: 'new' }
  /** Continue in Chat on a run that isn't a chat: a new chat that goes on with the run's conversation (and its name, read with readName). */
  | { kind: 'continue'; runId: string; sessionId: string; harnessId?: string }
  /** Continue in Chat on a chat's run, or a chat Looper opens again at its start: the chat again, in its own run. */
  | { kind: 'reopen'; runId: string; info: ChatInfo; sessionId?: string }
  /** Fork from Here. */
  | {
      kind: 'fork';
      from: string;
      fork?: ForkSource;
      harnessId: string;
      settings: ChatSettings;
      history: MessageRow[];
      draft?: ChatState['draft'];
    }
  /**
   * Compact into New Chat, or Continue Compacted on a run: a new conversation
   * that starts from the earlier one's messages (compactRows), which the agent
   * gets with the first message. `from` is the run they came from.
   */
  | {
      kind: 'compact';
      from: string;
      /** The divider above the compacted conversation; unset: "Compacted from run <from>". */
      label?: string;
      history: MessageRow[];
      harnessId?: string;
      settings?: ChatSettings;
      /** Claude: the context window the earlier conversation's model had, which the chat shows until its first result names it. */
      window?: number;
      draft?: ChatState['draft'];
      /** The chat compacted by itself: past its auto-compact share of the context (`threshold`), or on a context too full for the model (`full`). */
      auto?: 'threshold' | 'full';
      /** A chat compacted: what it watched (Watch Task Events) and its Continue When Limit Resets, which move to the new chat. */
      watches?: TaskWatch[];
      autoContinue?: boolean;
      /** Mute Notifications, which moves to the new chat too. */
      muted?: boolean;
      /** A chat that compacted while it held a task's run (Continue in Chat): the new chat holds it. */
      fromRunId?: string;
      /** A chat compacted: its name and whose it is, which the new chat keeps. */
      title?: string;
      titleBy?: TitleBy;
      /** A chat compacted: when it started and its last turn ended, so the new chat keeps its place in the list and its finished turn. */
      startedAt?: number;
      turnEndedAt?: number;
      /** Code Mode: what the earlier session's REPL held (ChatSession.replCarry), for this conversation's first session. */
      repl?: CompactRepl;
    }
  /**
   * Continue in Chat on a conversation from outside Looper (the History
   * window): a chat in the project, or a folder's stand-in, that resumes the
   * harness's own session, its history read from the transcript at
   * `transcript` (a host path). `harnessId`: the environment's harness to go
   * on with; unset: the project's.
   */
  | { kind: 'resume'; sessionId: string; harnessKind: 'claude-code' | 'codex'; transcript: string; harnessId?: string };

/** Where a chat's earlier conversation is: a run's, or a transcript's (a host path). */
export type ChatHistorySource = { runId: string } | { transcript: string; format: 'claude' | 'codex' };

/** Why a conversation on one kind of harness can't go on with the project's, which is another kind. */
export function kindMismatchText(conversation: Harness['kind'], project: Harness['kind']): string {
  return `This conversation ran on ${harnessKindLabel(conversation)}, and the project uses ${harnessKindLabel(project)}.`;
}

/** A chat that was in the Chats window when Looper quit: Looper opens it again at its start. */
export type SavedChat = Extract<OpenConversation, { kind: 'chat' }>;

/** A chat's folder holds how it opened until its first message makes it a run (chat.json then says). */
const OPENING_FILE = 'opening.json';

/**
 * Code Mode, compacted: the names the new session's REPL gets back from the
 * earlier one's, what the agent is told about them (replStateNote), and the
 * script that brings them back (replPrelude), unset when nothing could be kept.
 */
export interface CompactRepl {
  names: string[];
  note: string;
  prelude?: string;
  /** The snapshot's data files in the earlier chat's run folder, in order, which the new one's prelude takes. */
  data?: string[];
}

/** How long after a compaction's REPL snapshot its wake-up turn's start and end are still taken as its, not the agent's. */
const REPL_WAKE_MS = 5000;

class ChatSession {
  readonly id: string;
  readonly taskId: string;
  private readonly dir: string;
  private readonly environmentId: string;
  private readonly harness: Harness;
  /** The environment's Claude Code and Codex harnesses. */
  private readonly harnesses: ChatState['harnesses'];
  /** Harness menu while the agent works: the harness the chat moves to once the turn ends (`go`), which it shows meanwhile. */
  private moveTo?: { id: string; name: string; go: () => void };
  /** The task's extra arguments: only a harness of the task's own kind gets them, since they're flags for that CLI. */
  private readonly extraArgs: string[];
  /** Claude: the harness's and the chat's arguments without their --settings, which join the chat's settings file. */
  private userArgs: string[] = [];
  /** How the chat opened: a chat that moves to another harness opens the same way. */
  readonly opening: ChatOpening;
  private readonly target: Target;
  private readonly ctx: RunContext;
  private readonly acc: ClaudeStreamAccumulator | CodexExecAccumulator;
  private readonly claude: boolean;
  /** Continue in Chat on a run: the run whose conversation this chat goes on with. */
  readonly fromRunId?: string;
  /** Fork from Here: the chat this one was forked from. */
  private readonly forkedFrom?: string;
  /** A compacted chat: the run it was compacted from. */
  private readonly compactedFrom?: string;
  /** A chat an auto compact or a full context opened (ChatOpening's `auto`). */
  private readonly autoCompacted?: 'threshold' | 'full';
  /** A chat compacted in this window: its context at the end of its first turn, which says how large the conversation is compacted. */
  private compactBaseline?: ChatState['context'];
  /** The messages the agent took since its turn began, and those the turn that ended last took: a turn that stops on a full context sends them again. */
  private turnSent: Pending[] = [];
  private lastTurnSent: Pending[] = [];
  /** The manager's: the chat compacts into a new one by itself (auto compact, a full context), which then gets `resend`. */
  onCompact?: (opening: Extract<ChatOpening, { kind: 'compact' }>, resend: Pending[]) => void;
  /** A conversation from outside Looper this chat went on with: its session (thread) id. */
  private readonly resumedSession?: string;
  /** A compacted chat that hasn't sent its first message: the conversation that message takes to the agent. */
  private compacted?: MessageRow[];
  /** The history as compaction keeps it, whole: the rows it shows are only the transcript's last ones. */
  private historyCompact?: MessageRow[];
  /** The history is being read: Fork and Compact wait for it. `newest`: its newest rows (readNewest), shown until it all has been. */
  private historyReading = false;
  private newest?: MessageRow[];
  private readonly historyLabel?: string;
  /** Opened again: the run's conversation is read from its transcript. */
  private readonly reopened: boolean;
  /** The chat is a run (the user sent a message, now or before): it has records and a chat.json. */
  private recorded: boolean;
  /** When this window's first message made its "Chat opened" record. */
  private openedAt?: number;
  private title: string;
  /** Whose name `title` is (the user's, the harness's); unset: the first message's. */
  private titleBy?: TitleBy;
  /** Claude: a Rename… its process hasn't been told yet (it wasn't running). */
  private pendingRename?: string;
  /** Code Mode, compacted: the earlier session's REPL state for this conversation (ChatOpening's `repl`). */
  private readonly repl?: CompactRepl;
  /** A compaction's REPL snapshot woke the session for a turn that asks the model nothing: until then, a turn isn't the agent's. */
  private quietTurnsUntil = 0;
  /** A compacted chat kept the harness's name for the conversation: Claude Code's AI name for the new one doesn't replace it, a rename does. */
  private titleKept = false;
  /** Claude Code was asked to name the chat (askTitle). */
  private titleAsked = false;
  /** The last turn failed on the usage limit. */
  private limit?: UsageLimitHit;
  /** What this turn said about the limit: Claude's rejected rate_limit_event, Codex's usage-limit error. */
  private turnLimit?: { resetsAt?: number };
  /** Continue When Limit Resets. */
  private autoContinue: boolean;
  /** Mute Notifications: no device gets a push for this chat. */
  private muted: boolean;
  /** Continue Anyway: this limit's continue ignores the cache rule of Settings → Chats. */
  private continueAnyway = false;
  private continueTimer: NodeJS.Timeout | null = null;
  private fork?: ForkSource;
  private draft?: ChatDraft;
  /** Opened again at Looper's start: its agent starts with the next message, not before. */
  private readonly restored: boolean;
  private settings: ChatSettings;
  private activeModel?: string;
  private context?: ChatContext;
  /**
   * Claude: the running model's context window. A compaction leaves the
   * context's size unknown until the next reply, and its window as it was.
   */
  private contextWindow?: number;
  /** Claude: each model's context window its result records named (ChatState.modelWindows). */
  private modelWindows: Record<string, number> = {};
  /** Claude: what the running process was started with. */
  private launched?: Launched;
  /** Claude: Looper's settings for a headless process, and the user's --settings that join them. */
  private streamSettings: Record<string, unknown> = {};
  private userSettings: Record<string, unknown>[] = [];
  /** Claude: the chat's own hooks, which an interactive session gets beside the session step's. */
  private chatHooks: Record<string, unknown> = {};
  /** Interactive: Claude Code in a terminal, while it runs, and while it starts. */
  private session: SessionHandle | null = null;
  private sessionStart: Promise<SessionHandle | null> | null = null;
  /** Each interactive session's number: the callbacks of one Looper ended go quiet. */
  private sessionSeq = 0;
  /** Sessions Looper ended (Stop, a restart, the other session type): their end isn't the chat's. */
  private readonly retiredSessions = new WeakSet<SessionHandle>();
  private sessionStartedAt = 0;
  /** Interactive: the transcript the conversation is read from, from where it stood when the chat started reading it. */
  private transcript: { file: string; reader: TranscriptReader } | null = null;
  /** The session (sessionSeq) whose transcript the chat follows: messages go to the mod only once it's the running one's. */
  private transcriptSeq = -1;
  /** Interactive: the queued messages are in the mod's inbox, which it hasn't taken yet: these ones. */
  private inboxWritten = false;
  private inboxIds: string[] = [];
  /** Interactive: the conversation the running session is on, which becomes the chat's once something is said in it. */
  private liveSessionId?: string;
  /** Interactive: the size the window shows the terminal at. */
  private termSize?: { cols: number; rows: number };
  /** The conversation is in Claude Code's Code Mode (its transcript's repl-mode record): Claude Code resumes it only in a terminal. */
  private codeMode = false;
  /** Watch Task Events and looper-watch: what the chat watches. */
  private watches: TaskWatch[];
  /** Codex: its thread has Looper's instructions (ChatInfo.codexInstructed). */
  private codexInstructed = false;
  /** The looper-watch requests being answered, by file name. */
  private readonly takenWatch = new Set<string>();
  /** The interactive session's rows from its mod, ahead of its transcript. */
  private live: LiveRows | null = null;
  private livePolling = false;
  /** Interactive: the mod's and the session's files as last read (their mtimes). */
  private seen = { session: 0, turnEnd: 0, usage: 0 };
  private polling = false;
  /** Interactive: the terminal's output, its newest part (SCREEN_BYTES). */
  private screen = '';
  private status: ChatState['status'] = 'starting';
  private error?: string;
  private history: MessageRow[] = [];
  private proc: OffThreadChild | null = null;
  /** Codex's app server while it forks the thread. */
  private forkProc: OffThreadChild | null = null;
  /** Processes Looper ended (Stop, a restart): their exit isn't the chat's end. */
  private readonly retired = new WeakSet<OffThreadChild>();
  /** A Stop or restart is ending the process: messages wait for the next one. */
  private killing = false;
  /** The run the chat goes on with is writing its report on the conversation: messages wait until it's written. */
  private reporting = false;
  /** The conversation to go on with: claude's session, codex's thread. */
  sessionId?: string;
  private codexTurns = 0;
  private codexRollout?: string;
  /**
   * Messages sent while the agent runs a turn, or while claude's process is
   * replaced. With Claude, one is written to the agent while it runs a tool
   * (`sent`), and leaves the queue when Claude replays it, which it does as it
   * reads it with that tool's result, as Claude Code's own queue works.
   */
  private queued: QueuedMessage[] = [];
  /** Interactive: the messages the mod handed to the agent, which the conversation doesn't show yet. */
  private delivered: QueuedMessage[] = [];
  /** When the handed-over messages were written to the inbox: a turn that started after it could have started with them. */
  private deliveredSince = 0;
  /** When the handed-over messages stop showing, once a turn they could have started ended without them. */
  private deliveredUntil: number | null = null;
  /** How many rows the conversation had when the inbox was written, and when: a message's row comes after them. */
  private inboxRows = 0;
  private inboxAt = 0;
  private queueSeq = 0;
  /** The user's messages waiting for a subagent to read them, by its agent id. */
  private readonly subagentWaiting = new Map<string, string>();
  /** Each message written to claude that it hasn't replayed yet, in order: a queued one's id, or a message sent at once and its row. */
  private unreplayed: (string | { sent: Pending; row: MessageRow })[] = [];
  /** Claude's tool calls of this turn without a result yet. */
  private readonly toolsRunning = new Set<string>();
  private permissions: ChatPermissionRequest[] = [];
  private readonly takenRequests = new Set<string>();
  /** Permission mode changes claude hasn't confirmed yet: request id → the mode to go back to. */
  private readonly modeRequests = new Map<string, string>();
  private controlSeq = 0;
  /** Remote Control: the name the Claude app lists the chat under, while it's on. */
  private remoteName?: string;
  /** The interactive session started with Remote Control (`--remote-control`). */
  private remoteLaunched = false;
  /** Its latest terminal output, while the chat looks there for its Remote Control link; null when it isn't looking. */
  private remoteScan: string | null = null;
  private commands: SlashCommand[] = [];
  /** The commands the user ran from the message box that are still running, by id. */
  private readonly shellCommands: UserCommands;
  private turnEndedAt?: number;
  private readonly startedAt: number;
  /** Stop asked claude to end its turn: the process ends if the turn doesn't. */
  private stopTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: ChatDeps,
    readonly task: Task,
    opening: ChatOpening,
    choice?: HarnessChoice,
    saved?: SavedChat,
  ) {
    this.taskId = task.id;
    this.opening = opening;
    this.restored = !!saved;
    this.startedAt = saved?.startedAt ?? (opening.kind === 'compact' ? opening.startedAt : undefined) ?? Date.now();
    const env = resolveEnvironment(task, d.settings);
    const own = resolveHarness(task, env);
    const info = opening.kind === 'reopen' ? opening.info : undefined;
    const wanted =
      saved?.harnessId ?? choice?.harnessId ?? info?.harnessId ?? (opening.kind === 'fork' || opening.kind === 'compact' || opening.kind === 'resume' || opening.kind === 'continue' ? opening.harnessId : undefined);
    const harness = wanted ? env.harnesses.find((h) => h.id === wanted) : own;
    if (!harness) throw new Error(`The environment "${env.name}" no longer has the harness this chat ran on.`);
    if (harness.kind === 'custom') throw new Error('A chat needs a Claude Code or Codex harness.');
    if (info && info.harnessKind !== harness.kind) {
      throw new Error(`This chat ran on ${harnessKindLabel(info.harnessKind)}, and the task now uses ${harnessKindLabel(harness.kind)}.`);
    }
    if (opening.kind === 'resume' && opening.harnessKind !== harness.kind) throw new Error(kindMismatchText(opening.harnessKind, harness.kind));
    this.environmentId = env.id;
    this.harness = harness.id === own.id && task.agent.command ? { ...harness, command: task.agent.command } : harness;
    this.harnesses = env.harnesses.flatMap((h) => (h.kind === 'custom' ? [] : [{ id: h.id, name: h.name, kind: h.kind }]));
    this.extraArgs = harness.kind === own.kind ? agentArgs(task) : [];
    this.claude = harness.kind === 'claude-code';
    const accOpts = { attachment: attachmentAt(path.join(d.dataDir, 'tasks')) };
    this.acc = this.claude ? new ClaudeStreamAccumulator(accOpts) : new CodexExecAccumulator(accOpts);
    this.id = saved?.id ?? choice?.id ?? (opening.kind === 'reopen' ? opening.runId : newRunId());
    this.reopened = opening.kind === 'reopen';
    this.recorded = this.reopened;
    this.title = info?.title ?? '';
    this.titleBy = info?.titleBy;
    this.autoContinue = info
      ? !!info.autoContinue
      : opening.kind === 'compact' && opening.autoContinue !== undefined
        ? opening.autoContinue
        : d.settings.chats.continueAfterLimit;
    this.muted = info ? !!info.muted : opening.kind === 'compact' && !!opening.muted;
    // Quitting while it waited for the reset: Looper's next start goes on waiting.
    if (saved) {
      this.limit = info?.limit;
      this.continueAnyway = !!info?.continueAnyway;
    }
    const taskSettings: ChatSettings = { model: task.agent.model, effort: task.agent.effort, permissionMode: task.agent.permissionMode ?? '', mode: task.agent.mode };
    this.settings = saved
      ? (info?.settings ?? saved.settings)
      : choice
        ? chatSettingsOn(harness, choice.from, { id: own.id, settings: taskSettings })
        : (info?.settings ?? (opening.kind === 'fork' || opening.kind === 'compact' ? (opening.settings ?? taskSettings) : taskSettings));
    // Codex runs headless; a Claude chat without a session type of its own takes the task's.
    this.settings = { ...this.settings, mode: this.claude ? (this.settings.mode ?? task.agent.mode) : 'headless' };
    this.codeMode = !!info?.codeMode;
    this.watches = info?.watches ?? (opening.kind === 'compact' ? opening.watches : undefined) ?? [];
    this.codexInstructed = !!info?.codexInstructed;
    this.context = info?.context;
    this.contextWindow = info?.context?.window ?? (opening.kind === 'compact' ? opening.window : undefined);
    if (opening.kind === 'continue') {
      this.fromRunId = opening.runId;
      this.historyLabel = `Earlier in run ${opening.runId}`;
      this.sessionId = opening.sessionId;
    } else if (opening.kind === 'reopen') {
      this.fromRunId = info?.fromRunId;
      this.forkedFrom = info?.forkedFrom;
      this.compactedFrom = info?.compactedFrom;
      this.resumedSession = info?.resumedSession;
      this.sessionId = opening.sessionId;
    } else if (opening.kind === 'resume') {
      this.historyLabel = `Earlier in ${harnessKindLabel(opening.harnessKind)}`;
      this.sessionId = opening.sessionId;
      this.resumedSession = opening.sessionId;
    } else if (opening.kind === 'fork') {
      this.forkedFrom = opening.from;
      this.historyLabel = `Forked from run ${opening.from}`;
      this.fork = opening.fork;
      this.history = historyRows(opening.history);
      this.draft = opening.draft;
    } else if (opening.kind === 'compact') {
      this.compactedFrom = opening.from;
      this.fromRunId = opening.fromRunId;
      this.autoCompacted = opening.auto;
      this.historyLabel = opening.label ?? `Compacted from run ${opening.from}`;
      // The newest session's rows get their layer here, once, so a conversation continued in a chat stays one session.
      const rows = layered(opening.history);
      this.opening = { ...opening, history: rows };
      // Its ids (c0, c1…) are compacted.json's, which a reopened chat's history starts with. It shows them all, as before compacting.
      this.history = rows;
      this.historyCompact = rows;
      this.compacted = rows;
      this.draft = opening.draft;
      this.turnEndedAt = opening.turnEndedAt;
      this.repl = opening.repl;
      if (opening.titleBy && opening.title) {
        this.title = opening.title;
        this.titleBy = opening.titleBy;
        this.titleKept = opening.titleBy === 'harness';
        // Claude Code's session gets the name too (rename_session), so its transcript and the Claude app have it.
        if (this.claude) this.pendingRename = opening.title;
      }
    }
    if (saved) {
      this.sessionId ??= saved.sessionId;
      // What waited for the agent's turn comes back in the message box, ahead of what the box held.
      const parts = [...(saved.queued ?? []), ...(saved.draft ? [saved.draft] : [])];
      const text = parts.map((p) => p.text).filter(Boolean).join('\n\n');
      const attachments = parts.flatMap((p) => p.attachments);
      this.draft = text || attachments.length ? { text, attachments } : undefined;
      this.commands = saved.commands ?? [];
      // Quitting cut the turn short: it shows as stopped, as Stop leaves it.
      if (saved.working) this.acc.addNote('Stopped.');
    }
    this.dir = d.runDir(task.id, this.id);
    this.target = createTarget(task, { host: d.host, settings: d.settings });
    this.ctx = {
      task,
      runId: `chat-${this.id}`,
      runDir: this.dir,
      target: this.target,
      settings: d.settings,
      host: d.host,
      log: d.log,
      dataDir: d.dataDir,
      vars: {},
    };
    this.shellCommands = new UserCommands(this.ctx, {
      label: `chat ${this.id}`,
      onChange: () => this.scheduleEmit(),
      onOutput: (id, data) => {
        if (!this.closed) this.d.emit({ type: 'chat:command', chatId: this.id, id, data });
      },
      onPrompt: (id, prompt) => this.d.emit({ type: 'chat:command-prompt', chatId: this.id, id, prompt }),
      askpass: d.askpass,
    });
  }

  /**
   * Where the conversation this chat went on with was read from, for what
   * the chat's own session hasn't written yet: a run's (Continue in Chat on a
   * run), or a transcript from outside Looper (History's Continue in Chat).
   */
  /** The run whose transcript holds a call of the compacted conversation this chat started from (MessageRow.run). */
  compactedRun(toolUseId: string): string | undefined {
    return this.history.find((r) => r.layer !== undefined && r.toolUseId === toolUseId)?.run;
  }

  historySource(): ChatHistorySource | undefined {
    if (this.opening.kind === 'resume') return { transcript: this.opening.transcript, format: this.claude ? 'claude' : 'codex' };
    // A compacted chat holding a run starts from its compacted rows, not the run's conversation.
    return this.fromRunId && !this.compactedFrom ? { runId: this.fromRunId } : undefined;
  }

  // ---------- lifecycle ----------

  start(): void {
    fs.mkdirSync(path.join(this.dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'permissions'), { recursive: true });
    // Code Mode, compacted: the REPL's first script brings back the earlier session's names (the mod runs it).
    if (this.repl?.prelude && !this.recorded) {
      void fs.promises.writeFile(path.join(this.dir, REPL_FILES.prelude), this.repl.prelude).catch((err: unknown) => this.d.log.warn(`chat ${this.id}: cannot write the REPL prelude: ${errMsg(err)}`));
      for (const part of this.repl.data ?? []) {
        void fs.promises.copyFile(part, path.join(this.dir, path.basename(part))).catch((err: unknown) => this.d.log.warn(`chat ${this.id}: cannot copy the REPL data: ${errMsg(err)}`));
      }
    }
    // A looper-watch request an earlier start left behind has nobody waiting on it.
    fs.rmSync(path.join(this.dir, WATCH_DIR), { recursive: true, force: true });
    this.timers.push(setInterval(() => void this.pollWatchRequests(), this.d.settings.signalPollMs));
    // Until its first message, how it opened is what Looper's next start opens it again with.
    if (!this.recorded) writeJsonAtomic(path.join(this.dir, OPENING_FILE), this.opening);
    // Continue in Chat shows the run's conversation; a chat opened again, its own.
    const historyRun = this.reopened ? this.id : this.historyLabel && this.fromRunId && !this.compactedFrom ? this.fromRunId : undefined;
    if (historyRun) {
      this.historyReading = true;
      // A long transcript's newest rows show first, and the whole of it is read after them.
      const newest = this.d.readNewest?.(this.taskId, historyRun).then((rows) => {
        if (!this.historyReading || !rows.length) return;
        this.newest = historyRows(rows);
        this.scheduleEmit();
      });
      void (newest ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => Promise.all([this.d.readHistory(this.taskId, historyRun), this.d.readCompactable(this.taskId, historyRun)]))
        .then(([rows, compact]) => {
          this.history = historyRows(rows);
          this.historyCompact = compact;
        })
        .catch(() => undefined)
        .finally(() => {
          this.historyReading = false;
          this.newest = undefined;
          this.scheduleEmit();
        });
    } else if (this.opening.kind === 'resume' && this.d.readTranscript) {
      // A conversation from outside Looper has no run: its history is its transcript's.
      this.historyReading = true;
      void this.d
        .readTranscript(this.opening.transcript, this.claude ? 'claude' : 'codex')
        .then(({ rows, compact, name }) => {
          this.history = historyRows(rows);
          this.historyCompact = compact;
          if (name) this.nameFromHarness(name);
          this.scheduleEmit();
        })
        .catch(() => undefined)
        .finally(() => {
          this.historyReading = false;
        });
    }
    // Continue in Chat on a conversation that has a name: the chat starts with it.
    if (this.opening.kind === 'continue' && this.d.readName) {
      void this.d
        .readName(this.taskId, this.opening.runId)
        .then((name) => name && this.nameFromHarness(name))
        .catch(() => undefined);
    }
    this.syncContinue();
    if (this.claude) {
      const hook = path.join(this.dir, 'bin', this.target.permissionHookFile);
      writeText(hook, this.target.renderPermissionHook(this.targetFile('permissions')), 0o755);
      this.remoteName = this.d.remoteName?.(this.task, this.harness);
      const pipe = (file: string) => [{ hooks: [{ type: 'command', command: this.target.renderPipeHook(this.targetFile(file)) }] }];
      writeText(path.join(this.dir, 'bin', this.target.subagentHookFile), this.target.renderSubagentHook(this.targetFile(SUBAGENT_INBOX)), 0o755);
      const toSubagents = (event: string) => [{ type: 'command', command: `${this.target.stopHookCommand(this.targetFile('bin', this.target.subagentHookFile))} ${event}` }];
      const own = {
        // The agent's own notifications: the Sessions window puts the chat in Waiting for you.
        Notification: [{ hooks: [{ type: 'command', command: this.target.renderPipeHook(this.targetFile('notification.json')) }] }],
        // The user's messages for a running subagent, with its next tool result.
        SubagentStart: [{ hooks: toSubagents('start') }],
        PostToolUse: [{ matcher: '', hooks: toSubagents('post') }],
      };
      // With Remote Control: each message and finished turn, from here or the Claude app, for its Conversations list.
      const remoteHooks = this.remoteName ? { UserPromptSubmit: pipe('prompt.json'), Stop: pipe('stop.json') } : {};
      // An interactive session gets these beside the session step's own hooks.
      this.chatHooks = { hooks: { ...remoteHooks, ...own } };
      this.streamSettings = {
        ...projectMcpApproval(this.harness),
        hooks: {
          ...remoteHooks,
          // As in a run: the payload names the session and its transcript, which the run window and Continue read,
          // and the session's socket keeps a claude started inside it from the chat's helpers.
          SessionStart: [
            { hooks: [{ type: 'command', command: this.target.renderSessionStartHook(this.targetFile('session.json'), this.targetFile(SOCKET_FILE)) }] },
          ],
          ...own,
          PermissionRequest: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: this.target.stopHookCommand(this.targetFile('bin', this.target.permissionHookFile)),
                  timeout: PERMISSION_TIMEOUT_SEC,
                },
              ],
            },
          ],
        },
      };
      this.timers.push(
        setInterval(() => {
          // An interactive session's permission requests come through the session step (startSession).
          if (this.interactive) void this.pollInteractive();
          else this.pollPermissions();
          this.pollSubagentMessages();
        }, 300),
        setInterval(() => {
          if (this.interactive) void this.pollLive();
        }, LIVE_POLL_MS),
      );
      // The user's --settings join the chat's (Claude Code keeps only the last one given).
      const args = [...this.harness.args, ...this.extraArgs];
      const place = { target: this.target, cwd: this.task.cwd };
      const go = ({ rest, settings: user }: { rest: string[]; settings: Record<string, unknown>[] }): void => {
        writeJsonAtomic(path.join(this.dir, 'settings.json'), mergeClaudeSettings(this.streamSettings, user));
        this.userSettings = user;
        this.userArgs = rest;
        if (this.closed) return;
        // A chat opened again at Looper's start runs nothing until its next message (send starts its agent then).
        if (this.restored) this.setStatus('ready');
        else this.startAgent();
      };
      const fail = (e: unknown): void => {
        if (!this.closed) this.end(`The chat can't start: ${errMsg(e)}`);
      };
      // Only a settings file needs reading; JSON given inline merges at once.
      if (takeFlagValues(args).values.some((v) => !v.trim().startsWith('{'))) void readUserSettings(args, place).then(go).catch(fail);
      else {
        try {
          go(readUserSettingsSync(args, place));
        } catch (e) {
          fail(e);
        }
      }
    } else {
      if (this.sessionId) writeJsonAtomic(path.join(this.dir, 'codex-session.json'), { thread_id: this.sessionId });
      this.setStatus('ready');
      if (!this.restored) this.loadCodexSkills();
    }
  }

  /** Codex's skills for the "/" list, from its app server; without them the list stays empty. */
  private loadCodexSkills(): void {
    const spec = this.launcher('skills', `${this.harness.command} app-server`);
    const child = spawnOffThread(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    void codexListSkills(child, this.task.cwd)
      .then((skills) => {
        this.commands = skills;
        this.scheduleEmit();
      })
      .catch((err: unknown) => this.d.log.warn(`chat ${this.id}: cannot list codex skills: ${errMsg(err)}`))
      .finally(() => {
        void child.spawned.then((pid) => (pid ? killHostTree(pid) : undefined)).catch(() => undefined);
      });
  }

  /**
   * End the chat's processes and forget it. `keep` (quitting Looper): the
   * folder stays, chat nobody wrote in or not, so the next start opens the
   * chat again.
   */
  async close(keep = false): Promise<void> {
    if (this.closed) return;
    if (this.openedAt !== undefined) this.record('closed', Date.now() - this.openedAt);
    this.save();
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.continueTimer) clearTimeout(this.continueTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.forkProc?.kill();
    await Promise.all([this.kill(), this.stopCommands()]);
    // A chat nobody wrote in leaves nothing behind; a run keeps its folder, minus the permission requests.
    const gone = this.recorded || keep ? path.join(this.dir, 'permissions') : this.dir;
    // Not rmSync: on Windows the delete held the main process 10 ms and more (the perf journey's "close a chat").
    await fs.promises.rm(gone, { recursive: true, force: true }).catch((err: unknown) => this.d.log.warn(`chat ${this.id}: cannot delete ${gone}: ${errMsg(err)}`));
  }

  private async kill(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (child) this.retired.add(child);
    // A session still starting stops itself once it has (startInteractive).
    this.sessionStart = null;
    const session = this.session;
    this.session = null;
    this.sessionSeq++;
    if (session) {
      this.retiredSessions.add(session);
      this.takeBackInbox();
      await session.stop('stopped');
      this.endScreen();
    }
    const pid = await child?.spawned;
    if (pid) await killHostTree(pid).catch(() => undefined);
    await this.target.killLeftovers(this.ctx.runId).catch(() => undefined);
  }

  // ---------- commands the user runs from the message box ("!") ----------

  /** Run `input` in the chat's working directory (UserCommands); Stop ends it. */
  runCommand(input: string, id: string): Promise<CommandOutput> {
    if (this.closed) return Promise.reject(new Error('This chat is closed.'));
    return this.shellCommands.run(input, id);
  }

  /** Stop: the commands still running end (`id`: that one alone), with what they printed so far. */
  stopCommands(id?: string): Promise<void> {
    return this.shellCommands.stop(id);
  }

  /** The commands running from the message box: their terminals' output, keys and size. */
  get userCommands(): UserCommands {
    return this.shellCommands;
  }

  /**
   * Stop: end the agent's turn. The conversation goes on with the next
   * message. Claude ends the turn when asked and keeps its process; one that
   * doesn't within a few seconds, and Codex's turn, end with their process.
   */
  async stop(): Promise<void> {
    // The commands the user ran from the message box stop too, whatever the agent is doing.
    await Promise.all([this.stopCommands(), this.stopTurn()]);
  }

  private async stopTurn(): Promise<void> {
    if (this.interactive) {
      // The mod ends the turn; a message waiting in its inbox starts the next one.
      if (!this.session || this.closed || this.killing || this.status !== 'working') return;
      for (const p of this.permissions) this.session.answerPermission(p.id, false);
      this.permissions = [];
      this.session.stopTurn();
      this.scheduleEmit();
      return;
    }
    // An idle agent has no turn to end: its process stays for the next message.
    if (!this.proc || this.closed || this.killing || this.status !== 'working') return;
    // A tool call waiting for an answer would hold the turn: it's refused.
    for (const p of this.permissions) this.writeAnswer(p.id, permissionAnswer(false));
    this.permissions = [];
    if (this.claude && this.status === 'working') {
      if (this.stopTimer) return;
      this.proc.stdin?.write(JSON.stringify({ type: 'control_request', request_id: `interrupt-${++this.controlSeq}`, request: { subtype: 'interrupt' } }) + '\n');
      this.scheduleEmit();
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        if (this.status === 'working') void this.killTurn();
      }, INTERRUPT_GRACE_MS);
      return;
    }
    await this.killTurn();
  }

  private async killTurn(): Promise<void> {
    if (!this.proc || this.closed || this.killing) return;
    this.killing = true;
    await this.kill();
    this.killing = false;
    if (this.closed) return;
    this.unsendQueued();
    this.acc.addNote('Stopped.');
    this.turnEnded();
    this.save();
    this.drainQueue();
  }

  /** The agent finished a turn (or stopped): the queued messages go next. */
  private turnEnded(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.lastTurnSent = this.turnSent;
    this.turnSent = [];
    this.turnEndedAt = Date.now();
    this.setStatus('ready');
    this.moveIfIdle();
  }

  /**
   * Harness menu while the agent works (the conversation has started): the
   * chat shows the harness it moves to, and moves once the turn ends (`go`),
   * with the messages sent meanwhile. Undefined: it stays on its own.
   */
  setMoveTo(harnessId: string | undefined, go?: () => void): void {
    const h = harnessId && go ? this.harnesses.find((x) => x.id === harnessId) : undefined;
    this.moveTo = h && go ? { id: h.id, name: h.name, go } : undefined;
    this.scheduleEmit();
    // Nothing to wait for: a message waiting in the queue goes now.
    if (!this.moveTo) this.drainQueue();
  }

  /** The move to another harness failed: the chat stays on its own, and what waited for the move goes to its agent. */
  moveFailed(err: unknown): void {
    if (this.closed) return;
    this.acc.addNote(`Couldn't move to ${this.moveTo?.name ?? 'the other harness'}: ${errMsg(err)}`);
    this.setMoveTo(undefined);
  }

  /** A pending move goes once the agent is idle; after the caller is done with its own turn bookkeeping. */
  private moveIfIdle(): void {
    if (!this.moveTo || this.closed) return;
    queueMicrotask(() => {
      if (this.moveTo && !this.closed && !this.busy() && !this.killing) this.moveTo.go();
    });
  }

  /** The messages that haven't reached the agent: they go to the session that takes the chat over. */
  waiting(): Pending[] {
    return this.queued.map((q) => ({ text: q.text, attachments: q.attachments }));
  }

  /** Messages sent while a move to another harness was being prepared, back when the move failed: queued, and sent once no move waits. */
  takeBack(messages: Pending[]): void {
    if (messages.length === 0 || this.closed || this.status === 'ended') return;
    for (const m of messages) this.queued.push({ id: `q${++this.queueSeq}`, text: m.text, attachments: m.attachments });
    this.scheduleEmit();
    this.drainQueue();
  }

  /** The conversation the harness resumes (its session or thread), or the one a fork that hasn't sent anything starts from. */
  conversationId(): string | undefined {
    return this.sessionId ?? this.fork?.sessionId;
  }

  // ---------- the queue ----------

  /** Send Now: the queued messages go at once, ending the agent's turn if it's working. */
  async sendNow(): Promise<void> {
    if (this.queued.length === 0) return;
    // Moving to another harness: the turn ends, and the messages go to the new one.
    if (this.moveTo) {
      if (this.status === 'working') await this.stopTurn();
      return;
    }
    if (this.interactive) {
      // The mod starts the next turn with them once this one has ended.
      if (this.status === 'working') await this.stopTurn();
      return;
    }
    if (this.status === 'working') {
      // Claude goes on with the written messages as soon as its turn stops.
      this.writeQueued();
      await this.stopTurn();
    } else this.drainQueue();
  }

  /** Take a queued message out (Cancel, or Edit, which puts it back in the message box); one the agent has already been sent stays. */
  unqueue(messageId: string): QueuedMessage | undefined {
    const m = this.queued.find((q) => q.id === messageId);
    if (!m || m.sent) return undefined;
    // Interactive: the messages come back out of the mod's inbox, unless it has handed them over already.
    if (this.inboxWritten && !this.takeBackInbox()) return undefined;
    this.queued = this.queued.filter((q) => q !== m);
    this.writeInbox();
    this.scheduleEmit();
    return m;
  }

  /**
   * Restart Agent: the harness starts again on the same conversation. A turn
   * in progress ends first, as Stop ends it, and a chat whose session ended
   * goes on. Claude gets a new process at once; Codex starts one per turn
   * anyway, so its next message does.
   */
  async restartAgent(): Promise<void> {
    if (this.closed || this.killing) return;
    const wasWorking = this.status === 'working';
    for (const p of this.permissions) this.writeAnswer(p.id, permissionAnswer(false));
    this.permissions = [];
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.killing = true;
    this.status = 'starting';
    this.scheduleEmit();
    await this.kill();
    this.killing = false;
    if (this.closed) return;
    await this.requeueDelivered();
    this.unsendQueued();
    if (wasWorking) this.acc.addNote('Stopped.');
    this.error = undefined;
    this.status = 'ready';
    if (wasWorking) this.turnEnded();
    if (this.claude) this.startAgent();
    this.acc.addNote(`Restarted ${harnessKindLabel(this.harness.kind)}.`);
    this.save();
    this.scheduleEmit();
    this.drainQueue();
  }

  /**
   * The prompt cache expired: an idle Claude chat's process ends, and the next
   * message starts a new one on the conversation. Returns whether it ended one.
   */
  async stopIdleAgent(): Promise<boolean> {
    if (!this.claude || !this.agentRunning() || this.closed || this.killing || this.busy() || this.queued.length > 0) return false;
    this.killing = true;
    await this.kill();
    this.killing = false;
    this.d.log.info(`[${this.taskId}] chat ${this.id}: stopped the agent, its prompt cache expired`);
    this.scheduleEmit();
    // A message sent while the process was ending waited in the queue: it starts a new one now.
    this.drainQueue();
    return true;
  }

  /**
   * When the chat went idle: its agent's last turn ended (or the chat opened),
   * with nothing running, queued, waiting on the user or on a limit to reset.
   * Null while it isn't idle.
   */
  idleSince(): number | null {
    if (this.closed || this.killing || this.reporting || this.busy() || this.queued.length > 0 || this.shellCommands.size > 0) return null;
    if (this.limit && this.autoContinue) return null;
    return this.turnEndedAt ?? this.startedAt;
  }

  /**
   * The run the chat goes on with writes its report on this conversation:
   * the agent's process ends, and messages wait in the queue until it's
   * written. False when the chat isn't idle.
   */
  async holdForReport(): Promise<boolean> {
    if (this.idleSince() === null) return false;
    this.reporting = true;
    this.acc.addNote('Writing the run’s report.');
    this.scheduleEmit();
    if (this.agentRunning()) {
      this.killing = true;
      await this.kill();
      this.killing = false;
    }
    return true;
  }

  /** The report is written: whether a message came meanwhile, which goes to the agent now. */
  reportWritten(): boolean {
    this.reporting = false;
    const waited = this.queued.length > 0;
    this.drainQueue();
    this.scheduleEmit();
    return waited;
  }

  /** Whether the harness's process runs now (Claude's lives between turns; Codex's only during one). */
  agentRunning(): boolean {
    return !!this.proc || !!this.session || !!this.sessionStart;
  }

  /** Claude: a new process with the chat's settings that resumes the conversation. */
  private async restart(): Promise<void> {
    this.killing = true;
    this.setStatus('starting');
    await this.kill();
    this.killing = false;
    if (this.closed || this.status === 'ended') return;
    await this.requeueDelivered();
    this.unsendQueued();
    this.startAgent();
    this.drainQueue();
  }

  /**
   * Claude Code refused to go on with a Code Mode conversation headless (one
   * whose repl-mode record the chat didn't read): the chat goes back to its
   * terminal, and the messages written to the refused process wait for it.
   */
  private backToTerminal(): void {
    const lost = this.unreplayed.filter((u) => typeof u !== 'string');
    for (const { row } of lost) {
      const at = this.acc.rows.indexOf(row);
      if (at !== -1) this.acc.rows.splice(at, 1);
    }
    this.unsendQueued();
    this.queued = [...lost.map(({ sent }) => ({ id: `q${++this.queueSeq}`, text: sent.text, attachments: sent.attachments })), ...this.queued];
    this.codeMode = true;
    this.settings = { ...this.settings, mode: 'interactive' };
    this.acc.addNote(CODE_MODE_TEXT);
    this.d.log.info(`[${this.taskId}] chat ${this.id}: Claude Code goes on with this Code Mode conversation only in a terminal`);
    this.save();
    this.startAgent();
    this.drainQueue();
  }

  /** Claude's process in the chat's session type. */
  private startAgent(): void {
    if (this.interactive) this.startInteractive();
    else this.startClaude();
  }

  // ---------- the interactive session (claude) ----------

  private get interactive(): boolean {
    return this.claude && this.settings.mode === 'interactive';
  }

  /**
   * Claude Code in a terminal, with Looper's mod (startSession): the chat's
   * messages wait in the mod's inbox, which hands them over as the user's, the
   * conversation comes from the transcript, and Stop goes through the mod. It
   * starts without a prompt, waiting for the first message.
   */
  private startInteractive(): void {
    if (this.session || this.sessionStart || this.closed) return;
    const s = this.settings;
    const effort = resolveEffort(s, this.harness);
    const fork = !this.sessionId && this.fork && 'claudeAt' in this.fork ? this.fork : undefined;
    // A new conversation gets its id from Looper, so a restart before the first message can't lose it.
    const session = this.sessionId ? { id: this.sessionId, resume: true } : fork ? undefined : { id: randomUUID(), resume: false };
    const seq = ++this.sessionSeq;
    const live = () => seq === this.sessionSeq && !this.closed;
    this.sessionStartedAt = Date.now();
    this.launched = { model: s.model, effort, permissionMode: s.permissionMode, interactive: true };
    const remote = this.remoteName;
    this.remoteLaunched = !!remote;
    this.remoteScan = remote ? '' : null;
    this.setStatus('starting');
    const started: Promise<SessionHandle | null> = startSession(
      this.ctx,
      {
        step: 'agent',
        prefix: '',
        launcherName: 'chat',
        harness: this.harness,
        headless: false,
        model: s.model,
        effort,
        permissionMode: s.permissionMode || undefined,
        session,
        // Code Mode, compacted: only a session that takes the compacted conversation starts with the earlier REPL's names.
        ...(this.compacted && this.repl?.prelude ? { replPrelude: REPL_FILES.prelude, replDataParts: this.repl.data?.length ?? 1 } : {}),
        // As headless: a question form needs answers Looper can't collect, so the agent asks in the conversation.
        extraArgs: [
          ...(fork ? ['--resume', fork.sessionId, '--fork-session', '--resume-session-at', fork.claudeAt] : []),
          '--disallowedTools',
          'AskUserQuestion',
          ...(remote ? ['--remote-control', remote] : []),
          ...this.extraArgs,
        ],
        footer: WATCH_FOOTER,
        prompt: '',
        inbox: [CHAT_MESSAGE_FILE],
        watchCommand: AGENT_WATCH,
        settings: this.chatHooks,
        stopGate: false,
        permissions: { waitMs: PERMISSION_TIMEOUT_SEC * 1000, noAnswer: NO_PERMISSION_ANSWER },
        keepOnApiError: true,
        maxRuntimeMs: Infinity,
        maxRuntimeText: '',
        idleGraceMs: Infinity,
        idleText: '',
        onIdleTimeout: 'hold',
      },
      {
        onData: (d) => live() && this.onScreen(d),
        onPermission: (p) => {
          if (!live()) return;
          this.permissions = p ? [p] : [];
          this.scheduleEmit();
        },
      },
    ).then(
      (handle) => {
        if (this.sessionStart !== started) {
          // Ended while it started (Stop, close, the other session type).
          this.retiredSessions.add(handle);
          void handle.stop('stopped');
          return null;
        }
        this.sessionStart = null;
        this.session = handle;
        if (this.termSize) handle.resize(this.termSize.cols, this.termSize.rows);
        void handle.finished.then((end) => this.sessionEnded(handle, end));
        return handle;
      },
      (err: unknown) => {
        if (this.sessionStart !== started) return null;
        this.sessionStart = null;
        this.acc.addNote(`Couldn't start ${this.harness.name}: ${errMsg(err)}`);
        this.setStatus('ready');
        return null;
      },
    );
    this.sessionStart = started;
  }

  /** The interactive session ended by itself: Claude Code exited, or it couldn't start or run. */
  private sessionEnded(handle: SessionHandle, end: SessionEnd): void {
    if (this.retiredSessions.has(handle) || this.closed) return;
    this.session = null;
    this.sessionSeq++;
    this.endScreen();
    this.permissions = [];
    this.takeBackInbox();
    this.showDelivered();
    // As a headless chat's: the process was the conversation, so the chat ends with it.
    if (end.reason === 'exited') {
      this.end(end.headline ? `The session ended: ${end.headline}.` : 'The session ended.');
      return;
    }
    // A start that failed, or a session without Looper's mod: the next message starts Claude Code again on the conversation.
    const text = end.headline ?? 'The session ended.';
    this.acc.addNote(end.body && end.body !== text ? `${text}\n${end.body}` : text);
    this.turnEnded();
    this.save();
  }

  private async pollInteractive(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      await this.readInteractive();
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot read the session: ${errMsg(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /** What the interactive session wrote since the last poll: its start, the conversation, its turns, its usage. */
  private async readInteractive(): Promise<void> {
    const file = (name: string) => path.join(this.dir, name);
    const mtime = (name: string) =>
      fs.promises.stat(file(name)).then(
        (st) => st.mtimeMs,
        () => 0,
      );
    const json = async (name: string): Promise<Rec | null> => {
      try {
        return obj(JSON.parse(await fs.promises.readFile(file(name), 'utf8')));
      } catch {
        return null;
      }
    };
    const running = this.agentRunning();
    // The session's start names its conversation and transcript; the messages go to the mod once the chat reads it.
    const started = await mtime('session.json');
    if (running && started >= this.sessionStartedAt - 1000 && started !== this.seen.session) {
      const ref = await json('session.json');
      this.seen.session = started;
      if (typeof ref?.session_id === 'string') this.liveSessionId = ref.session_id;
      if (typeof ref?.transcript_path === 'string') await this.follow(ref.transcript_path);
      if (this.status === 'starting') this.setStatus('ready');
      this.writeInbox();
    }
    // A conversation is the chat's once something has been said in it, here or in the terminal.
    if (this.liveSessionId && this.recorded && this.sessionId !== this.liveSessionId) this.setSession(this.liveSessionId);
    // A new conversation's transcript appears with its first message.
    const grew = this.transcript ? await this.transcript.reader.read().catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? false : Promise.reject(err))) : false;
    if (grew) {
      const name = this.titleKept && this.acc instanceof ClaudeStreamAccumulator ? this.acc.customTitle : this.acc.sessionName;
      if (name) this.nameFromHarness(name);
      this.scheduleEmit();
    }
    if (this.inboxWritten && !chatMessageWaiting(this.dir)) this.inboxTaken();
    if (this.deliveredUntil !== null && Date.now() >= this.deliveredUntil) this.showDelivered();
    if (!running) return;
    let turnOver = false;
    // The mod records each turn's start and end.
    const [turnStart, turnEnd] = await Promise.all([mtime('turn.json'), mtime(MOD_FILES.turnEnd)]);
    // The turn a compaction's REPL snapshot woke the session for asks the model nothing: it isn't one of the agent's.
    if (Date.now() < this.quietTurnsUntil) this.seen.turnEnd = Math.max(this.seen.turnEnd, turnEnd);
    else if (turnStart >= this.sessionStartedAt - 1000 && turnStart > turnEnd && this.status === 'ready') this.setStatus('working');
    else if (turnEnd > this.seen.turnEnd && turnEnd >= turnStart) {
      this.seen.turnEnd = turnEnd;
      // A turn that started after the mod could have handed the messages over ended without them: they go, after a
      // moment for a row the transcript is still writing. The turn the mod ended to deliver them started before.
      if (this.delivered.length && turnStart >= this.deliveredSince) this.deliveredUntil ??= Date.now() + DELIVERED_GRACE_MS;
      if (this.status === 'working') {
        // Stop ended it (the mod's abort): the conversation says so, as a headless chat's does.
        if ((await json(MOD_FILES.turnEnd))?.aborted === true) this.acc.addNote('Stopped.');
        this.turnEnded();
        this.takeLimit();
        this.save();
        turnOver = true;
      }
    }
    // The mod's record of the session's usage: the context and its window, and the account's limits.
    const usageAt = await mtime(MOD_FILES.usage);
    if (usageAt > this.seen.usage) {
      this.seen.usage = usageAt;
      const usage = await json(MOD_FILES.usage);
      const context = obj(usage?.context);
      if (typeof context?.tokens === 'number') {
        const tokens = context.tokens;
        const window = typeof context.window === 'number' && context.window > 0 ? context.window : this.activeModel ? sharedWindows.pick(this.activeModel, tokens) : undefined;
        if (window) this.contextWindow = window;
        this.context = { tokens, window: this.contextWindow };
      }
      const limits = usage ? modUsageLimits(usage) : null;
      if (limits) this.d.onLimits(limitsKey(this.environmentId, this.harness.id), limits);
      this.scheduleEmit();
    }
    // Remote Control turned off during a turn, or while the session started.
    this.dropRemote();
    // After the usage record, which says how full the context is.
    if (turnOver && !this.compactIfFull()) this.autoCompactIfDue();
  }

  /** Read the session's transcript (a target path) into the conversation, from its end as it is now: the rows before are already shown. */
  private async follow(transcriptPath: string): Promise<void> {
    const env = resolveEnvironment(this.task, this.d.settings);
    const file = await transcriptHostPath(transcriptPath, this.d.host, env.kind === 'wsl' ? env.distro : undefined);
    if (!file) return;
    this.transcriptSeq = this.sessionSeq;
    if (this.transcript?.file === file) return;
    const reader = new TranscriptReader(file, {}, 'claude', (line) => this.onTranscriptLine(line));
    await reader.skipExisting();
    this.transcript = { file, reader };
    this.live = new LiveRows(path.join(this.dir, MOD_FILES.live), (liveId, apiId) => {
      if (this.acc instanceof ClaudeStreamAccumulator) this.acc.sameMessage(liveId, apiId);
    });
  }

  /** The rows the mod handed over since the last read: the conversation shows them before the transcript has them. */
  private async pollLive(): Promise<void> {
    if (this.livePolling || this.closed || !this.live) return;
    this.livePolling = true;
    try {
      if (await this.live.read((rec) => this.onRecord(rec))) this.scheduleEmit();
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot read the rows the session handed over: ${errMsg(err)}`);
    } finally {
      this.livePolling = false;
    }
  }

  private onTranscriptLine(line: string): void {
    let rec: Rec | null;
    try {
      rec = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (rec && (!this.live || this.live.transcriptRow(rec))) this.onRecord(rec);
  }

  /** A record of the session's conversation, from its transcript or from its mod (LiveRows). */
  private onRecord(rec: Rec): void {
    if (rec.type === 'repl-mode' && typeof rec.replMode === 'boolean' && rec.replMode !== this.codeMode) {
      this.codeMode = rec.replMode;
      this.save();
    }
    const before = this.acc.rows.length;
    if (isInterruptedRecord(rec)) this.acc.addNote('Stopped.');
    else this.acc.addParsed(rec);
    if (this.delivered.length && this.acc.rows.slice(before).some((r) => r.kind === 'prompt' || r.kind === 'guidance')) this.showDelivered();
    if (rec.type === 'assistant' && rec.isSidechain !== true) {
      const model = obj(rec.message)?.model;
      if (typeof model === 'string' && !model.startsWith('<')) this.activeModel = model;
    }
    // Something said in the terminal makes the chat a run, as a message sent from here does.
    if (this.openedAt === undefined && this.acc.rows.some((r) => r.kind === 'prompt')) this.markOpened();
  }

  /**
   * The queued messages, as one, into the mod's inbox, once the chat reads the
   * session's transcript, so the conversation shows them when the agent has them.
   */
  private writeInbox(): void {
    // Before the chat follows a new session's transcript, the message's row would come before where it starts reading.
    if (!this.interactive || !this.transcript || this.transcriptSeq !== this.sessionSeq || this.closed || this.killing || this.reporting) return;
    this.takeBackInbox();
    if (this.queued.length === 0) return;
    const text = this.queued
      .map((m) => withFileList(withCommands(m.text, m.attachments), fileAttachments(m.attachments).map((a) => this.target.toTargetPath(a.path))))
      .join('\n\n');
    // A compacted chat's first message takes the earlier conversation to the agent, once; the rows leave it out.
    const compacted = this.compacted ? compactedText(this.compacted, { ...this.d.settings.chats.compaction, path: (x) => this.target.toTargetPath(x), replNote: this.repl?.note }) : undefined;
    writeChatMessage(this.dir, compacted ? `${compacted}\n\n${text}` : text);
    this.inboxWritten = true;
    this.inboxIds = this.queued.map((m) => m.id);
    this.inboxRows = this.acc.rows.length;
    this.inboxAt = Date.now();
  }

  /** The mod handed the inbox's messages to the agent: the transcript shows them from now on. */
  private inboxTaken(): void {
    const taken = new Set(this.inboxIds);
    // They stay where they are until their row comes, so the conversation doesn't close up and open again.
    const arrived = this.acc.rows.slice(this.inboxRows).some((r) => r.kind === 'prompt' || r.kind === 'guidance');
    if (!arrived) {
      this.delivered.push(...this.queued.filter((q) => taken.has(q.id)).map((q) => ({ ...q, delivered: true })));
      this.deliveredSince = this.inboxAt;
    }
    this.turnSent.push(...this.queued.filter((q) => taken.has(q.id)).map((q) => ({ text: q.text, attachments: q.attachments })));
    this.queued = this.queued.filter((q) => !taken.has(q.id));
    this.inboxIds = [];
    this.inboxWritten = false;
    this.compacted = undefined;
    this.scheduleEmit();
  }

  /** The messages the mod handed over are in the conversation, or won't come: they stop showing as queued. */
  private showDelivered(): void {
    this.deliveredUntil = null;
    if (!this.delivered.length) return;
    this.delivered = [];
    this.scheduleEmit();
  }

  /**
   * The harness starts again: a message the mod took that the conversation still doesn't have (after one more read
   * of the transcript, for a row written as it stopped) never reached the agent, so it goes to the new one.
   */
  private async requeueDelivered(): Promise<void> {
    if (!this.delivered.length) return;
    await this.transcript?.reader.read().catch(() => false);
    if (!this.delivered.length) return;
    this.queued = [...this.delivered.map(({ delivered: _d, ...m }) => m), ...this.queued];
    this.delivered = [];
    this.deliveredUntil = null;
    this.scheduleEmit();
  }

  /** Take the inbox's messages back before the mod hands them over; false when it already has. */
  private takeBackInbox(): boolean {
    if (!this.inboxWritten) return true;
    if (takeChatMessage(this.dir)) {
      this.inboxWritten = false;
      this.inboxIds = [];
      return true;
    }
    this.inboxTaken();
    return false;
  }

  private onScreen(data: string): void {
    this.screen = (this.screen + data).slice(-SCREEN_BYTES);
    this.d.emit({ type: 'terminal:data', id: this.id, data });
    if (this.remoteScan !== null) this.findRemoteLink(data);
  }

  /** Claude Code prints its claude.ai address once Remote Control connects: each session start gets a new one. */
  private findRemoteLink(data: string): void {
    this.remoteScan = ((this.remoteScan ?? '') + data).slice(-REMOTE_SCAN_BYTES);
    const link = REMOTE_LINK_RE.exec(stripAnsi(this.remoteScan))?.[0];
    if (!link || !this.remoteName) return;
    this.remoteScan = null;
    this.d.onRemote?.({ id: this.id, taskId: this.taskId, name: this.remoteName, cwd: this.task.cwd, dir: this.dir, link });
  }

  /** Remote Control was turned off: a terminal's Claude Code can't drop it while running, so it starts again without it once no turn is running. */
  private dropRemote(): void {
    if (!this.remoteLaunched || this.remoteName || !this.session || this.busy() || this.killing || this.closed) return;
    this.d.log.info(`[${this.taskId}] chat ${this.id}: Remote Control was turned off, starting Claude Code again without it`);
    void this.restart();
  }

  private endScreen(): void {
    this.d.emit({ type: 'terminal:end', id: this.id });
  }

  /** The terminal's output so far, and whether its session has ended (the next message starts another). */
  terminalOutput(): { data: string; ended: boolean } {
    return { data: this.screen, ended: !this.session && !this.sessionStart };
  }

  writeTerminal(data: string): void {
    this.session?.write(data);
  }

  /** The size the window shows the terminal at: a session that starts later gets it too. */
  resizeTerminal(cols: number, rows: number): void {
    this.termSize = { cols, rows };
    this.session?.resize(cols, rows);
  }

  // ---------- names ----------

  /** The harness named the conversation (or the one it goes on with has a name): the chat takes it, unless the user named it. */
  private nameFromHarness(name: string): void {
    const t = name.trim();
    if (!t || this.titleBy === 'user' || (this.titleBy === 'harness' && this.title === t)) return;
    this.title = t;
    this.titleBy = 'harness';
    this.save();
    this.scheduleEmit();
  }

  /**
   * Rename…: the user's name for the chat, which a running Claude Code also
   * gets (rename_session), so its transcript has it. '' goes back to the
   * automatic title, the first message's.
   */
  rename(name: string): void {
    if (this.closed) return;
    const t = name.trim();
    if (t) {
      this.title = t;
      this.titleBy = 'user';
      if (this.claude) {
        if (this.proc) this.proc.stdin?.write(renameSessionRequest(`rename-${++this.controlSeq}`, t, this.sessionId) + '\n');
        else this.pendingRename = t;
      }
    } else {
      this.titleBy = undefined;
      this.pendingRename = undefined;
      const own = this.acc.rows.some((r) => r.kind === 'prompt');
      this.title = this.recorded ? chatTitle(own ? this.acc.rows : [...this.history, ...this.acc.rows]) : '';
    }
    this.save();
    this.scheduleEmit();
  }

  // ---------- the usage limit ----------

  /** Mute Notifications, on or off. */
  setMuted(on: boolean): void {
    if (this.closed || this.muted === on) return;
    this.muted = on;
    this.save();
    this.scheduleEmit();
  }

  /** Continue When Limit Resets, on or off. */
  setAutoContinue(on: boolean): void {
    if (this.closed || this.autoContinue === on) return;
    this.autoContinue = on;
    if (!on) this.continueAnyway = false;
    this.save();
    this.syncContinue();
    this.scheduleEmit();
  }

  // ---------- watching tasks ----------

  /** The tasks the chat can watch, in the Tasks list's order. */
  private watchTargets(): WatchTarget[] {
    return this.d.watchTargets?.(this.taskId) ?? [];
  }

  /** Watch Task Events or looper-watch: the agent gets the task's run ends or trigger events as messages. */
  watch(w: TaskWatch): void {
    if (this.closed) return;
    const next = withWatch(this.watches, w);
    if (JSON.stringify(next) === JSON.stringify(this.watches)) return;
    this.watches = next;
    this.save();
    this.scheduleEmit();
  }

  /** Stop watching the task: its trigger events (`what`), only those with `eventId` ('' all of them) when given, or everything. */
  unwatch(taskId: string, what?: TaskWatch['what'], eventId?: string): void {
    const gone = (w: TaskWatch) => w.taskId === taskId && (what === undefined || w.what === what) && (eventId === undefined || (w.eventId ?? '') === eventId);
    const next = this.watches.filter((w) => !gone(w));
    if (this.closed || next.length === this.watches.length) return;
    this.watches = next;
    this.save();
    this.scheduleEmit();
  }

  /** Whether the agent gets the ends of the task's runs. */
  watchesRuns(taskId: string): boolean {
    return this.watches.some((w) => w.taskId === taskId && w.what === 'runs');
  }

  /** The task's event lines the agent watches. */
  watchedEvents(taskId: string, lines: readonly string[]): string[] {
    return watchedLines(this.watches, taskId, lines);
  }

  /** Chat → Watch Task Events: every task, with the event ids the chat watches each for. */
  private watchableTasks(): WatchableTask[] {
    return this.watchTargets().map(({ task: t, own, folders }) => ({
      id: t.id,
      name: t.name,
      events: this.watches.filter((w) => w.taskId === t.id && w.what === 'events').map((w) => w.eventId ?? ''),
      own,
      folders,
    }));
  }

  /** The agent's looper-watch requests, each answered with the text the command prints and its exit code. */
  private async pollWatchRequests(): Promise<void> {
    const reqDir = path.join(this.dir, WATCH_DIR, 'requests');
    let names: string[];
    try {
      names = await fs.promises.readdir(reqDir);
    } catch {
      return; // no request yet
    }
    for (const name of names) {
      if (!name.endsWith('.req') || this.takenWatch.has(name)) continue;
      this.takenWatch.add(name);
      let lines: string[];
      try {
        lines = (await fs.promises.readFile(path.join(reqDir, name), 'utf8')).trimStart().split(/\r?\n/);
        await fs.promises.rm(path.join(reqDir, name), { force: true });
      } catch {
        this.takenWatch.delete(name);
        continue;
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      // The op, the caller's folder, then one line per argument.
      const out = this.answerWatch(lines.slice(2));
      const resDir = path.join(this.dir, WATCH_DIR, 'responses');
      const rid = name.slice(0, -'.req'.length);
      try {
        await fs.promises.mkdir(resDir, { recursive: true });
        await fs.promises.writeFile(path.join(resDir, `${rid}.out`), out.text + '\n');
        await fs.promises.writeFile(path.join(resDir, `${rid}.code.tmp`), String(out.code));
        await fs.promises.rename(path.join(resDir, `${rid}.code.tmp`), path.join(resDir, `${rid}.code`));
      } catch (err) {
        this.d.log.warn(`chat ${this.id}: cannot answer ${AGENT_WATCH}: ${errMsg(err)}`);
      }
      this.takenWatch.delete(name);
    }
  }

  private answerWatch(args: string[]): { text: string; code: number } {
    const req = parseWatchArgs(args);
    if ('error' in req) return { text: `${AGENT_WATCH}: ${req.error}\n${WATCH_USAGE}`, code: 2 };
    const targets = this.watchTargets();
    if (req.op === 'tasks') return { text: tasksText(targets, this.watches), code: 0 };
    const taskId = req.op === 'stop' ? req.taskId : req.watch.taskId;
    const task = targets.find((x) => x.task.id === taskId)?.task;
    if (!task) return { text: `${AGENT_WATCH}: Looper has no task "${taskId}". \`${AGENT_WATCH} tasks\` lists them.`, code: 1 };
    if (req.op === 'stop') {
      this.unwatch(taskId);
      return { text: `Stopped watching "${task.name}".`, code: 0 };
    }
    this.watch(req.watch);
    return { text: `Watching "${task.name}": ${watchText(req.watch)}. Each one reaches you as a message while this chat is open.`, code: 0 };
  }

  /** Continue Anyway: the continue goes at the reset, or at once when the reset has passed, whatever the cache rule says. */
  setContinueAnyway(): void {
    if (this.closed || !this.limit || !this.autoContinue || this.continueAnyway) return;
    this.continueAnyway = true;
    this.save();
    this.syncContinue();
    this.scheduleEmit();
  }

  /** The turn ended: it failed on the usage limit when it said so (`turnLimit`) or its error row does. */
  private takeLimit(): void {
    if (this.claude) {
      // Another error (the network, an overloaded API) says nothing about the login.
      const ending = endingError(this.acc.rows);
      if (!ending) this.d.onLogin?.(this.environmentId, this.harness.id, true);
      else if (LOGIN_FAILED_RE.test(ending.text)) this.d.onLogin?.(this.environmentId, this.harness.id, false);
    }
    const now = Date.now();
    const said = this.turnLimit;
    this.turnLimit = undefined;
    const fromRows = usageLimitOf(this.acc.rows, now);
    if (!said && !fromRows) {
      this.continueAnyway = false;
      return;
    }
    const resetsAt = said?.resetsAt ?? fromRows?.resetsAt;
    this.limit = { at: now, ...(resetsAt !== undefined ? { resetsAt } : {}) };
    this.d.log.info(`[${this.taskId}] chat ${this.id}: the usage limit was hit${resetsAt ? `, it resets ${new Date(resetsAt).toISOString()}` : ''}`);
    this.syncContinue();
  }

  /** Schedule (or cancel) the message Continue When Limit Resets sends. */
  private syncContinue(): void {
    if (this.continueTimer) clearTimeout(this.continueTimer);
    this.continueTimer = null;
    if (!this.limit || !this.autoContinue || this.closed || this.status === 'ended') return;
    this.continueTimer = setTimeout(() => this.continueAfterLimit(), continueDelay(this.limit, Date.now()));
  }

  /** The limit has reset: the agent gets CONTINUE_TEXT as the user's message, a Looper note above it. */
  private continueAfterLimit(): void {
    this.continueTimer = null;
    if (this.closed || !this.limit || !this.autoContinue || this.status === 'ended') return;
    if (this.status !== 'ready' || this.killing || this.queued.length > 0 || this.permissions.length > 0) {
      // Something else is going on (a restart): try again shortly.
      this.continueTimer = setTimeout(() => this.continueAfterLimit(), 60_000);
      return;
    }
    // The chat's limit message says so and offers Continue Anyway, and the limit stays for it.
    const rule = this.d.settings.chats.skipExpiredContinue;
    if (!this.continueAnyway && continueSkipped(rule, Date.now(), this.d.cacheUntil?.(this.id), this.context?.tokens)) return;
    this.acc.addNote('The usage limit has reset: continuing.');
    // A limit whose reset time wasn't said tries again hourly, and Continue Anyway goes on applying to those tries.
    const anyway = this.continueAnyway;
    this.dispatch({ text: CONTINUE_TEXT, attachments: [] });
    this.continueAnyway = anyway;
  }

  // ---------- settings ----------

  /** Chat menu: a new model, effort, permission mode or session type for this chat (the task keeps its own). */
  async configure(patch: Partial<ChatSettings>): Promise<void> {
    if (this.closed || this.status === 'ended' || this.killing) return;
    const prev = this.settings;
    const next: ChatSettings = { ...prev, ...patch };
    if (!this.claude && next.mode !== 'headless') throw new Error('A Codex chat runs headless.');
    if (this.codeMode && next.mode === 'headless') throw new Error(CODE_MODE_TEXT);
    // An effort the new model doesn't offer falls back to its default, as in the task editor.
    if ('model' in patch && next.effort) {
      const entry = harnessModels(this.harness).find((m) => m.id === next.model);
      if (entry?.efforts && !entry.efforts.includes(next.effort)) next.effort = undefined;
    }
    // Codex starts a process per turn, and a stopped claude starts one with the next message: both take the settings then.
    if (this.claude && this.agentRunning() && this.launched) {
      if (needsNewProcess(this.launched, next, resolveEffort(next, this.harness))) {
        // The Chat menu keeps these off during a turn: a new process would cut it short.
        if (this.busy()) return;
        this.settings = next;
        this.save();
        await this.restart();
        return;
      }
      if (next.permissionMode !== prev.permissionMode && this.proc) {
        const id = `mode-${++this.controlSeq}`;
        this.modeRequests.set(id, prev.permissionMode);
        this.proc.stdin?.write(permissionModeRequest(id, next.permissionMode) + '\n');
      }
    }
    this.settings = next;
    this.save();
    this.scheduleEmit();
  }

  // ---------- the session ----------

  private targetFile(...parts: string[]): string {
    return joinTarget(this.target.kind, this.target.toTargetPath(this.dir), ...parts);
  }

  /** prelude: lines that run before the harness, which replaces the launcher's shell. */
  private launcher(name: string, body: string, prelude = ''): { command: string; args: string[] } {
    const exec = this.target.kind === 'windows' ? '' : 'exec ';
    return writeLauncher(this.ctx, name, (prelude ? prelude + '\n' : '') + exec + body, this.harness.env, { watchCommand: AGENT_WATCH }).spec;
  }

  /** The chat's model, effort and permission mode, as a run would pass the task's. */
  private startClaude(): void {
    // The stream brings the conversation from now on: an interactive session's transcript is read from its end again next time.
    this.transcript = null;
    this.live = null;
    const q = (s: string) => this.target.quote(s);
    const s = this.settings;
    const parts = [this.harness.command];
    if (s.model) parts.push('--model', q(s.model));
    const effort = resolveEffort(s, this.harness);
    if (effort) parts.push('--effort', q(effort));
    if (s.permissionMode) parts.push('--permission-mode', q(s.permissionMode));
    if (this.sessionId) parts.push('--resume', q(this.sessionId));
    else if (this.fork && 'claudeAt' in this.fork) {
      // A new session holding the conversation up to the message; init names it.
      parts.push('--resume', q(this.fork.sessionId), '--fork-session', '--resume-session-at', q(this.fork.claudeAt));
    }
    // An interactive session of the chat's writes settings of its own to the same file.
    writeJsonAtomic(path.join(this.dir, 'settings.json'), mergeClaudeSettings(this.streamSettings, this.userSettings));
    parts.push('--settings', q(this.targetFile('settings.json')));
    // A question form needs answers Looper can't collect: the agent asks in the conversation instead.
    parts.push('--disallowedTools', 'AskUserQuestion');
    // Replays echo each message when Claude reads it: a queued one shows in the conversation where the agent took it in.
    parts.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages');
    // Under -p Claude Code sends thinking blocks without their text unless the display is set explicitly.
    parts.push('--thinking-display', 'summarized');
    // The agent's own instructions join the user's --append-system-prompt (Claude Code keeps only the last one given).
    const system = mergeSystemPrompt(WATCH_FOOTER, this.userArgs);
    writeText(path.join(this.dir, 'system.txt'), system.text ?? '');
    parts.push('--append-system-prompt', this.target.catFile(this.targetFile('system.txt')));
    for (const arg of system.rest) parts.push(q(arg));
    this.launched = { model: s.model, effort, permissionMode: s.permissionMode, interactive: false };
    this.spawnProc(this.launcher('chat', parts.join(' ')), (_code, stderr) => {
      if (CODE_MODE_RESUME_RE.test(stderr)) {
        this.backToTerminal();
        return;
      }
      // The one process is the whole conversation: once it is gone, so is the chat.
      this.end(exitText('The session ended.', stderr));
    });
    // The command list, before any message: Claude answers it without calling the model. perTaskStopAffordance (Claude
    // Code 2.1.330): Stop ends only the turn; background subagents and workflows keep running, and each one has its own Stop.
    this.proc?.stdin?.write(JSON.stringify({ type: 'control_request', request_id: `init-${++this.controlSeq}`, request: { subtype: 'initialize', perTaskStopAffordance: true } }) + '\n');
    // Each process connects anew, under a new claude.ai address.
    if (this.remoteName) this.proc?.stdin?.write(remoteControlRequest(`rc-${++this.controlSeq}`, this.remoteName) + '\n');
    if (this.pendingRename) {
      this.proc?.stdin?.write(renameSessionRequest(`rename-${++this.controlSeq}`, this.pendingRename, this.sessionId) + '\n');
      this.pendingRename = undefined;
    }
    if (this.status !== 'working') this.setStatus('ready');
  }

  /** Remote Control was turned off: the chat goes on without it. */
  remoteOff(): void {
    if (!this.remoteName) return;
    this.remoteName = undefined;
    this.remoteScan = null;
    this.proc?.stdin?.write(remoteControlRequest(`rc-${++this.controlSeq}`, undefined) + '\n');
    this.dropRemote();
  }

  /** One codex turn: `codex exec`, resuming the thread after the first. */
  private startCodexTurn(p: Pending, compacted?: string): void {
    if (this.fork && 'codexText' in this.fork && !this.sessionId) {
      this.forkCodexThen(this.fork, p);
      return;
    }
    this.codexTurns += 1;
    const q = (s: string) => this.target.quote(s);
    const s = this.settings;
    const attached = fileAttachments(p.attachments);
    const images = attached.filter((x) => x.image && imageMediaType(x.path));
    const files = attached.filter((x) => !images.includes(x)).map((x) => this.target.toTargetPath(x.path));
    const promptFile = `turn-${this.codexTurns}.txt`;
    const prompt = withFileList(withCommands(p.text, p.attachments), files) || 'See the attached image.';
    const text = compacted ? `${compacted}\n\n${prompt}` : prompt;
    // A thread started elsewhere (a run, the History window, a fork) didn't get developer_instructions, which only a new thread takes.
    writeText(path.join(this.dir, promptFile), this.sessionId && !this.codexInstructed ? withLooperInstructions(WATCH_FOOTER, text) : text);
    const parts = [this.harness.command, 'exec', ...codexPermissionArgs(s.permissionMode, false)];
    if (s.model) parts.push('--model', q(s.model));
    const effort = resolveEffort(s, this.harness);
    if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
    parts.push('-c', q('developer_instructions=' + JSON.stringify(WATCH_FOOTER)));
    if (this.sessionId) parts.push('resume', q(this.sessionId));
    parts.push('--json', '--skip-git-repo-check');
    // The equals form: `exec`'s --image takes several values and would swallow the prompt.
    for (const img of images) parts.push(q(`--image=${this.target.toTargetPath(img.path)}`));
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of this.extraArgs) parts.push(q(extra));
    parts.push(this.target.catFile(this.targetFile(promptFile)));
    // The rollout behind the context size lives under codex's home, which only the target knows.
    const prelude = recordCodexHome(this.target.kind, q(this.targetFile('codex-home')));
    this.setStatus('working');
    this.spawnProc(this.launcher(`turn-${this.codexTurns}`, parts.join(' '), prelude), (code, stderr) => {
      if (code !== 0) this.acc.addNote(exitText(`Codex exited with code ${code}.`, stderr));
      else this.codexInstructed = true;
      this.turnEnded();
      this.takeLimit();
      if (this.compactIfFull()) return;
      // Auto compact waits for the context, which the rollout says.
      void this.readCodexContext().finally(() => {
        this.save();
        this.autoCompactIfDue();
      });
      this.drainQueue();
    });
  }

  /**
   * Fork from Here on Codex: `codex exec` can only copy a whole thread, so
   * Codex's app server copies it through the turn, and the message goes to
   * the copy. When the copy fails the message stays unsent, and the next one
   * tries again.
   */
  private forkCodexThen(fork: { sessionId: string; codexText: string; occurrence: number }, p: Pending): void {
    this.setStatus('working');
    const spec = this.launcher('fork', `${this.harness.command} app-server`);
    const child = spawnOffThread(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.forkProc = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-2000);
    });
    this.d.log.info(`[${this.taskId}] chat ${this.id}: forking codex thread ${fork.sessionId}`);
    void codexForkThread(child, fork.sessionId, fork.codexText, fork.occurrence)
      .then(
        (threadId) => {
          if (this.closed) return;
          this.setSession(threadId);
          this.startCodexTurn(p);
        },
        (err: unknown) => {
          if (this.closed) return;
          this.acc.addNote(exitText(`Couldn't fork the conversation: ${errMsg(err)}`, stderr));
          this.setStatus('ready');
          this.drainQueue();
        },
      )
      .finally(() => {
        this.forkProc = null;
        void child.spawned.then((pid) => (pid ? killHostTree(pid) : undefined)).catch(() => undefined);
      });
  }

  /** The conversation the chat goes on with from now: a fork is made once it has its own. */
  private setSession(id: string): void {
    if (this.sessionId === id) return;
    this.sessionId = id;
    this.fork = undefined;
    // Codex reports no transcript path: the run window and Continue find the rollout by the thread id.
    if (!this.claude) writeJsonAtomic(path.join(this.dir, 'codex-session.json'), { thread_id: id });
    if (this.recorded) this.d.onSession?.({ taskId: this.taskId, runId: this.id, sessionId: id });
  }

  /** Send what waited, all of it as one message, once the agent isn't working. */
  private drainQueue(): void {
    if (this.queued.length === 0 || this.killing || this.reporting || this.status === 'ended' || this.closed || this.moveTo) return;
    if (this.interactive) {
      // The mod takes the messages in whenever the agent can read them.
      if (!this.agentRunning()) this.startAgent();
      this.writeInbox();
      return;
    }
    if (this.status === 'working') return;
    const next: Pending = {
      text: this.queued.map((x) => x.text).filter(Boolean).join('\n\n'),
      attachments: this.queued.flatMap((x) => x.attachments),
    };
    this.queued = [];
    this.dispatch(next);
  }

  /** onExit runs only when the process ends by itself, not when Looper ended it. */
  private spawnProc(spec: { command: string; args: string[] }, onExit: (code: number | null, stderr: string) => void): void {
    let stdoutBuf = '';
    let stderrTail = '';
    const child = spawnOffThread(spec.command, spec.args, {
      cwd: this.dir,
      env: childEnv(),
      stdio: [this.claude ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = child;
    const live = () => !this.closed && !this.retired.has(child);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (!live()) return;
      stdoutBuf += d;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr?.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.stdin?.on('error', () => {
      /* the process went away mid-write; its exit reports why */
    });
    child.on('error', (err) => {
      if (live()) this.end(`Couldn't start ${this.harness.name}: ${err.message}`);
    });
    child.on('close', (code) => {
      if (this.proc === child) this.proc = null;
      if (!live()) return;
      if (stdoutBuf.trim()) this.onLine(stdoutBuf.trim());
      onExit(code, stderrTail);
    });
    this.d.log.info(`[${this.taskId}] chat ${this.id}: ${spec.command} ${spec.args.join(' ')}`);
  }

  private onLine(line: string): void {
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      return;
    }
    if (this.claude && isInterruptedRecord(rec)) this.acc.addNote('Stopped.');
    else this.acc.addLine(line);
    if (this.claude) this.onClaudeRecord(rec, line);
    else if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') this.setSession(rec.thread_id);
    else if (rec.type === 'error' || rec.type === 'turn.failed') {
      const msg = rec.type === 'error' ? rec.message : obj(rec.error)?.message;
      if (typeof msg === 'string' && /usage limit/i.test(msg)) {
        const resetsAt = usageLimitReset(msg, Date.now());
        this.turnLimit = resetsAt !== null ? { resetsAt } : {};
      }
    } else if (rec.type === 'turn.completed') this.turnLimit = undefined;
    this.scheduleEmit();
  }

  private onClaudeRecord(rec: Rec, line: string): void {
    if (rec.type === 'system' && rec.subtype === 'init') {
      if (typeof rec.session_id === 'string') this.setSession(rec.session_id);
      if (typeof rec.model === 'string') this.activeModel = rec.model;
      // Each turn starts with one, and an idle process prints none (claude 2.1.330): Claude Code started a turn by itself
      // (another session's message, a background task's end, a wake-up), which works until its result as Looper's own do.
      if (this.status === 'ready' && !this.killing) this.setStatus('working');
    } else if (rec.type === 'system' && rec.subtype === 'commands_changed') {
      this.commands = slashCommandsOf(rec.commands);
    } else if (rec.type === 'system' && rec.subtype === 'session_title_changed') {
      // Claude Code says the session's name at startup when it has one, and after each rename (never an AI title).
      if (typeof rec.title === 'string') this.nameFromHarness(rec.title);
    } else if (rec.type === 'rate_limit_event') {
      const limits = usageLimitsOf(rec);
      if (limits) this.d.onLimits(limitsKey(this.environmentId, this.harness.id), limits);
      // The request was refused for the limit: the turn fails on it.
      const info = obj(rec.rate_limit_info);
      if (info?.status === 'rejected') this.turnLimit = typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {};
    } else if ((rec.type === 'assistant' && rec.parent_tool_use_id == null) || (rec.type === 'system' && rec.subtype === 'compact_boundary')) {
      // A subagent's messages (parent_tool_use_id set) fill its own context, not the chat's.
      const tokens = contextOfLine(line, 'claude');
      if (typeof tokens === 'number') this.context = { tokens, window: this.contextWindow };
      else if (tokens === 'unknown') this.context = undefined;
      const calls = rec.type === 'assistant' ? toolUseIds(rec, 'tool_use') : [];
      for (const id of calls) this.toolsRunning.add(id);
      if (calls.length) this.writeQueued();
      // A turn the Claude app started: the chat is working too.
      if (rec.type === 'assistant' && this.remoteName && this.status === 'ready') this.setStatus('working');
    } else if (rec.type === 'user' && rec.parent_tool_use_id == null) {
      for (const id of toolUseIds(rec, 'tool_result')) this.toolsRunning.delete(id);
      if (rec.isReplay === true && this.unreplayed.length === 0 && this.remoteName && rec.isSynthetic !== true) {
        // Nothing of Looper's is waiting to be read: a message sent from the Claude app.
        const text = userRecordText(rec);
        if (text) {
          this.acc.addPrompt(text);
          this.markOpened();
          this.setStatus('working');
        }
      } else if (rec.isReplay === true && rec.isSynthetic !== true) {
        // Claude read a message: a queued one joins the conversation here. A synthetic one is Claude Code's own delivery.
        const id = this.unreplayed.shift();
        const m = typeof id === 'string' ? this.queued.find((q) => q.id === id) : undefined;
        if (m) {
          this.queued = this.queued.filter((q) => q !== m);
          this.acc.addPrompt(m.text, m.attachments);
          this.turnSent.push({ text: m.text, attachments: m.attachments });
        }
      }
    } else if (rec.type === 'control_response') {
      const res = obj(rec.response);
      const id = typeof res?.request_id === 'string' ? res.request_id : '';
      if (id.startsWith('init-')) {
        const list = slashCommandsOf(obj(res?.response)?.commands);
        if (list.length) this.commands = list;
        return;
      }
      if (id.startsWith('title-')) {
        // An error, or no title: the chat keeps its first message's.
        const title = res?.subtype === 'success' ? obj(res.response)?.title : undefined;
        if (typeof title === 'string') this.nameFromHarness(title);
        return;
      }
      if (id.startsWith('rc-')) {
        const link = obj(res?.response)?.session_url;
        if (res?.subtype === 'error') {
          if (this.remoteName) this.acc.addNote(`Couldn't turn on Remote Control: ${String(res.error ?? 'unknown error')}`);
        } else if (this.remoteName && typeof link === 'string' && link) {
          this.d.onRemote?.({ id: this.id, taskId: this.taskId, name: this.remoteName, cwd: this.task.cwd, dir: this.dir, link });
        }
        return;
      }
      const back = this.modeRequests.get(id);
      if (back === undefined) return;
      this.modeRequests.delete(id);
      if (res?.subtype === 'error') {
        this.settings = { ...this.settings, permissionMode: back };
        this.acc.addNote(`Couldn't change the permission mode: ${String(res.error ?? 'unknown error')}`);
        this.save();
      }
    } else if (rec.type === 'result') {
      const window = claudeContextWindow(rec, this.activeModel);
      if (window) this.contextWindow = window;
      if (this.context && window) this.context = { ...this.context, window };
      const windows = claudeModelWindows(rec);
      this.modelWindows = { ...this.modelWindows, ...windows };
      sharedWindows.learn(windows);
      this.toolsRunning.clear();
      if (this.queued.some((q) => q.sent)) {
        // Messages the agent didn't read yet: Claude starts its next turn with them by itself.
        if (this.stopTimer) {
          clearTimeout(this.stopTimer);
          this.stopTimer = null;
        }
        this.save();
        return;
      }
      this.turnEnded();
      this.takeLimit();
      if (this.compactIfFull()) return;
      this.askTitle();
      this.save();
      this.drainQueue();
      this.autoCompactIfDue();
    }
  }

  /**
   * After the first turn, Claude Code names a chat that has no name yet
   * (generate_session_title, `persist` writes it to the transcript too):
   * print mode doesn't name its sessions by itself. Asked once per chat window.
   */
  private askTitle(): void {
    // A turn refused for the usage limit can't name it either: the next turn asks.
    if (this.titleAsked || this.titleBy || this.limit || !this.proc) return;
    const first = [...this.history, ...this.acc.rows].find((r) => r.kind === 'prompt');
    const description = first?.text.trim().slice(0, MAX_TITLE_DESCRIPTION);
    if (!description) return;
    this.titleAsked = true;
    this.proc.stdin?.write(sessionTitleRequest(`title-${++this.controlSeq}`, description) + '\n');
  }

  /** Codex: the context size and window from the thread's rollout, after each turn. */
  private async readCodexContext(): Promise<void> {
    if (!this.sessionId) return;
    try {
      if (!this.codexRollout) {
        const home = fs.readFileSync(path.join(this.dir, 'codex-home'), 'utf8').trim();
        const env = resolveEnvironment(this.task, this.d.settings);
        const hostHome = await transcriptHostPath(home, this.d.host, env.kind === 'wsl' ? env.distro : undefined);
        if (!hostHome) return;
        this.codexRollout = (await findCodexRollout(path.join(hostHome, 'sessions'), this.sessionId)) ?? undefined;
        if (!this.codexRollout) return;
      }
      const [tokens, window] = await Promise.all([readContextTokens(this.codexRollout, 'codex'), readCodexContextWindow(this.codexRollout)]);
      this.context = tokens === null ? undefined : { tokens, window: window ?? undefined };
      this.scheduleEmit();
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot read codex context: ${errMsg(err)}`);
    }
  }

  /** The user's message: to the agent now, or into the queue while it works. False when the chat can't take it. */
  send(text: string, attachments: Attachment[]): boolean {
    const t = text.trim();
    if (this.closed || this.status === 'ended' || (!t && attachments.length === 0)) return false;
    this.d.onTalk?.({ id: this.id, taskId: this.taskId });
    // Moving to another harness once the turn ends: the message waits for it.
    if (this.moveTo) {
      this.queued.push({ id: `q${++this.queueSeq}`, text: t, attachments });
      this.scheduleEmit();
      this.moveIfIdle();
      return true;
    }
    if (this.killing || this.reporting || (this.status === 'working' && !this.interactive)) {
      this.queued.push({ id: `q${++this.queueSeq}`, text: t, attachments });
      // A tool is running: the agent reads it with that tool's result.
      if (!this.killing && this.toolsRunning.size > 0) this.writeQueued();
      this.scheduleEmit();
      return true;
    }
    this.dispatch({ text: t, attachments });
    return true;
  }

  private dispatch(p: Pending): void {
    // A message ends the wait for the limit, and the continue that was to follow it.
    this.limit = undefined;
    this.turnLimit = undefined;
    this.continueAnyway = false;
    this.syncContinue();
    if (this.interactive) {
      // It waits for the mod, whatever the agent is doing: its transcript shows it once the agent has it, and the chat becomes a run then.
      this.queued.push({ id: `q${++this.queueSeq}`, text: p.text, attachments: p.attachments });
      this.drainQueue();
      this.scheduleEmit();
      return;
    }
    this.turnSent.push(p);
    const row = this.acc.addPrompt(p.text, p.attachments);
    this.markOpened();
    // A compacted chat's first message takes the earlier conversation to the agent, once.
    const compacted = this.compacted
      ? compactedText(this.compacted, { ...this.d.settings.chats.compaction, path: (x) => this.target.toTargetPath(x), replNote: this.repl?.note })
      : undefined;
    this.compacted = undefined;
    if (this.claude) this.writeClaude(p, row, compacted);
    else this.startCodexTurn(p, compacted);
  }

  private writeClaude(p: Pending, row: MessageRow, compacted?: string): void {
    // After a Stop the process is gone: a new one resumes the conversation.
    if (!this.proc) this.startClaude();
    const msg = claudeUserMessage(p.text, p.attachments, (x) => this.target.toTargetPath(x), undefined, compacted);
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
    this.unreplayed.push({ sent: p, row });
    this.setStatus('working');
  }

  /**
   * Claude: write the queued messages to the agent now. Claude reads them
   * with the result of the tool it's running, or, after a Stop, starts its
   * next turn with them.
   */
  private writeQueued(): void {
    if (!this.claude || !this.proc) return;
    let wrote = false;
    for (const m of this.queued) {
      if (m.sent) continue;
      const msg = claudeUserMessage(m.text, m.attachments, (x) => this.target.toTargetPath(x));
      this.proc.stdin?.write(JSON.stringify(msg) + '\n');
      m.sent = true;
      this.unreplayed.push(m.id);
      wrote = true;
    }
    if (wrote) this.scheduleEmit();
  }

  /** The process that held the written messages is gone: they wait in the queue again, to go to the next one. */
  private unsendQueued(): void {
    for (const m of this.queued) m.sent = false;
    this.unreplayed = [];
    this.toolsRunning.clear();
  }

  // ---------- messages for subagents (claude) ----------

  private subagentInbox(agentId: string): string {
    return path.join(this.dir, SUBAGENT_INBOX, agentId);
  }

  /**
   * A message for one of the agent's running subagents. It waits in the
   * subagent's inbox, after anything still waiting there, until the subagent
   * hook hands it over (see Target.renderSubagentHook).
   */
  messageSubagent(agentId: string, text: string): void {
    const t = text.trim();
    if (!this.claude || this.closed || this.status === 'ended' || !t || !SUBAGENT_ID.test(agentId)) return;
    const dir = this.subagentInbox(agentId);
    fs.mkdirSync(dir, { recursive: true });
    queueGuidance(dir, t);
    this.subagentWaiting.set(agentId, readPendingGuidance(dir) ?? t);
    this.scheduleEmit();
  }

  /**
   * Stop on a background command, Monitor, subagent or workflow (Claude's task id): an interactive chat's mod stops it
   * with Claude Code's own TaskStop, and a headless chat's Claude Code gets the stop_task control request. Either way
   * the conversation then says how it ended. Throws with the reason it can't.
   */
  stopBackground(taskId: string): void {
    if (!this.claude) throw new Error(`${this.harness.name} has no background work Looper can stop.`);
    if (this.closed || this.status === 'ended') throw new Error('This chat has ended.');
    if (this.interactive) {
      if (!this.session) throw new Error('The agent isn’t running.');
      this.session.stopBackground(taskId);
      return;
    }
    if (!this.proc?.stdin) throw new Error('The agent isn’t running.');
    this.proc.stdin.write(stopTaskRequest(`stop-task-${++this.controlSeq}`, taskId) + '\n');
  }

  /** Take back what waits for the subagent; undefined when the subagent has already read it. */
  unmessageSubagent(agentId: string): string | undefined {
    if (!this.subagentWaiting.has(agentId)) return undefined;
    this.subagentWaiting.delete(agentId);
    this.scheduleEmit();
    return takePendingGuidance(this.subagentInbox(agentId)) ?? undefined;
  }

  /** A message the hook has handed over leaves the waiting list: the subagent's transcript shows it from then on. */
  private pollSubagentMessages(): void {
    for (const [agentId, text] of this.subagentWaiting) {
      const now = readPendingGuidance(this.subagentInbox(agentId));
      if (now === text) continue;
      if (now === null) this.subagentWaiting.delete(agentId);
      else this.subagentWaiting.set(agentId, now);
      this.scheduleEmit();
    }
  }

  // ---------- permission requests (claude) ----------

  private pollPermissions(): void {
    const dir = path.join(this.dir, 'permissions');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.req') || this.takenRequests.has(name)) continue;
      this.takenRequests.add(name);
      const id = name.slice(0, -4);
      try {
        const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')) as Rec;
        this.permissions.push({ id, tool: String(req.tool_name ?? 'tool'), input: req.tool_input ?? {} });
        this.scheduleEmit();
      } catch (err) {
        // Unreadable: refuse it rather than leave the agent waiting for nobody.
        this.d.log.warn(`chat ${this.id}: unreadable permission request ${name}: ${errMsg(err)}`);
        this.writeAnswer(id, permissionAnswer(false));
      }
    }
  }

  answerPermission(requestId: string, allow: boolean): void {
    const p = this.permissions.find((x) => x.id === requestId);
    if (!p) return;
    this.permissions = this.permissions.filter((x) => x !== p);
    this.writeAnswer(requestId, permissionAnswer(allow));
    this.scheduleEmit();
  }

  private writeAnswer(id: string, json: string): void {
    const file = path.join(this.dir, 'permissions', `${id}.ans`);
    try {
      // Whole or not at all: the hook prints the answer as soon as the file exists.
      fs.writeFileSync(`${file}.tmp`, json);
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot answer permission request ${id}: ${errMsg(err)}`);
    }
  }

  // ---------- state ----------

  private setStatus(status: ChatState['status'], emitNow = true): void {
    if (this.status === 'ended') return;
    this.status = status;
    if (emitNow) this.scheduleEmit();
  }

  private end(error: string): void {
    this.status = 'ended';
    this.error = error;
    this.permissions = [];
    this.d.log.warn(`chat ${this.id} ended: ${error}`);
    this.save();
    this.scheduleEmit();
    this.moveIfIdle();
  }

  /**
   * The window's first message: the chat becomes a run (a chat that only
   * shows a run's conversation isn't one yet), and the run list gets a
   * "Chat opened" record.
   */
  private markOpened(): void {
    if (this.openedAt !== undefined) return;
    this.openedAt = Date.now();
    if (!this.recorded) {
      this.recorded = true;
      if (!this.titleBy) this.title = chatTitle(this.acc.rows);
      // The transcript holds the compacted conversation only as text inside the first message: the run keeps its rows.
      if (this.opening.kind === 'compact') writeJsonAtomic(path.join(this.dir, COMPACTED_FILE), compactedFile(this.opening.history, this.repl?.names));
      // chat.json says how it opens again from now on.
      fs.rmSync(path.join(this.dir, OPENING_FILE), { force: true });
      if (this.sessionId) this.d.onSession?.({ taskId: this.taskId, runId: this.id, sessionId: this.sessionId });
    }
    this.record('opened');
    this.save();
  }

  private record(event: 'opened' | 'closed', durationMs?: number): void {
    const version = this.d.taskVersion(this.taskId);
    this.d.appendRecord({
      ts: new Date().toISOString(),
      taskId: this.taskId,
      runId: this.id,
      phase: 'chat',
      result: 'chat',
      summary: this.title,
      ...(durationMs !== undefined ? { durationMs } : {}),
      detail: {
        event,
        ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
        ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
        ...(this.compactedFrom ? { compactedFrom: this.compactedFrom } : {}),
        ...(this.resumedSession ? { resumedSession: this.resumedSession } : {}),
      },
      ...(version !== undefined ? { taskVersion: version } : {}),
    });
  }

  /** The chat's chat.json: what Continue in Chat opens it again with. */
  save(): void {
    const info = this.closed ? undefined : this.info();
    if (!info) return;
    try {
      this.d.writeInfo(this.taskId, this.id, info);
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot save: ${errMsg(err)}`);
    }
  }

  /** What chat.json says: undefined until the chat is a run. */
  info(): ChatInfo | undefined {
    if (!this.recorded) return undefined;
    return {
      harnessId: this.harness.id,
      harnessKind: this.claude ? 'claude-code' : 'codex',
      title: this.title,
      ...(this.titleBy ? { titleBy: this.titleBy } : {}),
      ...(this.autoContinue ? { autoContinue: true } : {}),
      ...(this.muted ? { muted: true } : {}),
      ...(this.continueAnyway ? { continueAnyway: true } : {}),
      ...(this.limit ? { limit: this.limit } : {}),
      settings: this.settings,
      ...(this.context ? { context: this.context } : {}),
      ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
      ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
      ...(this.compactedFrom ? { compactedFrom: this.compactedFrom } : {}),
      ...(this.resumedSession ? { resumedSession: this.resumedSession } : {}),
      ...(this.codeMode ? { codeMode: true } : {}),
      ...(this.watches.length ? { watches: this.watches } : {}),
      ...(this.codexInstructed ? { codexInstructed: true } : {}),
    };
  }

  /** Fork from Here on the row at `index` of the history and rows: how the new chat starts. Throws with the reason. */
  forkAt(index: number): Extract<ChatOpening, { kind: 'fork' }> {
    if (this.historyReading) throw new Error(HISTORY_READING);
    const rows = [...this.history, ...this.acc.rows];
    const point = forkPoint(rows, index, this.claude ? 'claude-code' : 'codex', this.status === 'working');
    if (!point) throw new Error("The chat can't be forked from this message.");
    let fork: ForkSource | undefined;
    if (point.at) {
      const sessionId = this.sessionId ?? this.fork?.sessionId;
      // A fork that hasn't sent anything yet forks its source again.
      if (!sessionId) throw new Error("The conversation hasn't started yet.");
      if (this.claude) fork = { sessionId, claudeAt: point.at.uuid! };
      else {
        const text = point.at.text.trim();
        const occurrence = rows.slice(0, point.keep).filter((r) => r.kind === 'agent' && r.text.trim() === text).length;
        fork = { sessionId, codexText: text, occurrence };
      }
    }
    return {
      kind: 'fork',
      from: this.id,
      ...(fork ? { fork } : {}),
      harnessId: this.harness.id,
      settings: this.settings,
      history: rows.slice(0, point.keep),
      ...(point.draft ? { draft: { text: point.draft.text, attachments: point.draft.attachments ?? [] } } : {}),
    };
  }

  private scheduleEmit(): void {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.closed) this.d.emit({ type: 'chat', state: this.state() });
    }, 100);
  }

  /**
   * Whether the chat can move to another harness: nothing has been said in
   * it yet, and it doesn't go on with another conversation, since a
   * conversation can't move between harnesses. A compacted conversation is
   * only text the first message takes, so any harness can go on with it.
   */
  harnessFree(): boolean {
    const history = this.history.length === 0 || this.opening.kind === 'compact';
    return !this.recorded && !this.sessionId && !this.fork && history && this.queued.length === 0 && this.status !== 'working';
  }

  /**
   * Compact into New Chat: the conversation as a compacted chat starts from.
   * `auto`: the chat compacts by itself, from `rows` as its rows here when
   * given, and the new chat keeps the message box's text. Throws with the reason it can't.
   */
  compactOpening(auto?: { why: 'threshold' | 'full'; rows?: MessageRow[] }): Extract<ChatOpening, { kind: 'compact' }> {
    if (this.busy()) throw new Error('The agent is still working. Compact the chat once its turn has ended.');
    // Before it has all been read, the history would be compacted without its start.
    if (this.historyReading) throw new Error(HISTORY_READING);
    // Each call says whose transcript holds it: a forked conversation's the run it was forked from, this chat's its own.
    const history = this.historyCompact ?? compactRows(fromRun(this.history, this.forkedFrom));
    const rows = compactRows([...history, ...fromRun(auto?.rows ?? this.acc.rows, this.id)]);
    if (!rows.some((r) => r.kind === 'agent')) throw new Error('The chat has no reply to compact yet.');
    // A chat that hasn't sent a message isn't a run yet: its conversation is the run it went on with.
    const from = this.recorded ? this.id : (this.compactedFrom ?? this.fromRunId ?? this.forkedFrom ?? this.id);
    const opening = {
      kind: 'compact' as const,
      from,
      history: rows,
      harnessId: this.harness.id,
      settings: this.settings,
      window: this.contextWindow,
      // It goes on with the same work: what it watches and Continue When Limit Resets move to the new chat (handOver).
      ...(this.watches.length ? { watches: this.watches } : {}),
      autoContinue: this.autoContinue,
      ...(this.muted ? { muted: true } : {}),
      // As if the conversation went on: the same name, place in the list, finished turn and message box.
      ...(this.titleBy ? { title: this.title, titleBy: this.titleBy } : {}),
      startedAt: this.startedAt,
      ...(this.turnEndedAt !== undefined ? { turnEndedAt: this.turnEndedAt } : {}),
      ...(this.draft ? { draft: this.draft } : {}),
      // The task's run this chat holds goes on in the new chat (ChatManager.compactInto), whose end writes its report.
      ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
    };
    if (!auto) return opening;
    const label = auto.why === 'full' ? `Compacted from run ${from} when its context was full` : `Compacted automatically from run ${from}`;
    return { ...opening, auto: auto.why, label };
  }

  /**
   * The turn stopped because the conversation no longer fits the model's
   * context (CONTEXT_FULL_RE): the chat compacts into a new one, which sends
   * the turn's messages again, then those queued meanwhile. A chat a full
   * context opened doesn't again until its agent has replied, so a
   * conversation too large even compacted doesn't go round. True when it compacts.
   */
  private compactIfFull(): boolean {
    if (!this.onCompact || this.closed || this.killing || this.moveTo || this.status !== 'ready') return false;
    const rows = contextFullRetry(this.acc.rows);
    if (!rows) return false;
    if (this.autoCompacted === 'full' && !rows.some((r) => r.kind === 'agent' && !r.note)) return false;
    let opening: Extract<ChatOpening, { kind: 'compact' }>;
    try {
      opening = this.compactOpening({ why: 'full', rows });
    } catch (err) {
      this.d.log.info(`[${this.taskId}] chat ${this.id}: the context is full, and the chat can't be compacted: ${errMsg(err)}`);
      return false;
    }
    const resend = [...contextFullResend(this.acc.rows, rows, this.lastTurnSent), ...this.queued.map((q) => ({ text: q.text, attachments: q.attachments }))];
    this.d.log.info(`[${this.taskId}] chat ${this.id}: the context is full: compacting, and sending ${resend.length} message(s) again`);
    this.onCompact(opening, resend);
    return true;
  }

  /**
   * Auto compact: at the end of a turn whose context is past the chat's share
   * of its window (Settings → Chats, or the chat's own setting), the chat
   * compacts into a new one. Not while something waits to go to the agent or
   * for the user, nor after a turn that failed. A chat compacted here whose
   * first turn already ends past the share doesn't, since it would every turn.
   */
  private autoCompactIfDue(): void {
    if (!this.onCompact || this.closed || this.killing || this.moveTo || this.status !== 'ready') return;
    if (this.opening.kind === 'compact' && !this.compactBaseline && this.context) this.compactBaseline = this.context;
    if (this.queued.length || this.permissions.length || this.limit || endingError(this.acc.rows)) return;
    const percent = autoCompactPercent(this.settings, this.d.settings.chats.autoCompact);
    if (percent === undefined || !contextPast(this.context, percent) || contextPast(this.compactBaseline, percent)) return;
    let opening: Extract<ChatOpening, { kind: 'compact' }>;
    try {
      opening = this.compactOpening({ why: 'threshold' });
    } catch {
      return;
    }
    this.d.log.info(`[${this.taskId}] chat ${this.id}: the context is past ${percent}% of its window: compacting`);
    this.onCompact(opening, []);
  }

  /**
   * Code Mode, compacting: what the REPL holds, for the new session (its
   * snapshot through the mod, SessionHandle.snapshotRepl), between turns
   * only: the names its scripts defined, after those its own compaction
   * brought back. Undefined when there's nothing to carry or the snapshot
   * failed, and compaction goes on without it.
   */
  async replCarry(): Promise<CompactRepl | undefined> {
    const session = this.session;
    if (!this.codeMode || !session || this.busy() || this.closed) return undefined;
    // The newest session's scripts: an earlier session's rows have a layer (compacted.json).
    const scripts = [...this.history, ...this.acc.rows].flatMap((r) => {
      const code = r.kind === 'tool' && r.tool === 'REPL' && r.layer === undefined ? (r.input as { code?: unknown } | undefined)?.code : undefined;
      return typeof code === 'string' ? [code] : [];
    });
    const before = this.repl?.names ?? (this.compactedFrom ? readCompactedReplNames(this.dir) : []);
    const order = new Set<string>();
    for (const name of [...before, ...(await replNames(scripts))]) {
      order.delete(name);
      order.add(name);
    }
    if (!order.size) return undefined;
    this.quietTurnsUntil = Infinity;
    try {
      const snapshot = await session.snapshotRepl([...order]);
      if ('error' in snapshot) {
        this.d.log.info(`[${this.taskId}] chat ${this.id}: compacting without the REPL's state: ${snapshot.error}`);
        return undefined;
      }
      const p = await replPrelude(snapshot);
      if (!p) return undefined;
      // What didn't come back as it was gets the statement that made it, so the agent can run it again.
      const made = await replDefinitions(scripts, [...p.lost, ...p.changed].map((s) => s.name.split(/[.[]/)[0]));
      const data = replDataFiles(snapshot.parts).map((n) => path.join(this.dir, n));
      return { names: p.names, note: replStateNote(p, made), ...(p.names.length ? { prelude: p.script, data } : {}) };
    } catch (err) {
      this.d.log.info(`[${this.taskId}] chat ${this.id}: compacting without the REPL's state: ${errMsg(err)}`);
      return undefined;
    } finally {
      this.quietTurnsUntil = Date.now() + REPL_WAKE_MS;
    }
  }

  /** Compacted: the new chat watches its tasks and continues after the limit now, so this one, and its run reopened later, don't. */
  handOver(): void {
    if (this.closed) return;
    this.watches = [];
    this.autoContinue = false;
    this.continueAnyway = false;
    this.save();
  }

  /** The new chat couldn't start: this one goes on, with a note why. */
  compactFailed(err: unknown): void {
    this.acc.addNote(`Couldn't compact the chat: ${errMsg(err)}`);
    this.scheduleEmit();
    this.drainQueue();
  }

  /** What a chat on another harness needs from this one. */
  harnessFrom(): HarnessChoice['from'] {
    return { kind: this.harness.kind, settings: this.settings };
  }

  get harnessId(): string {
    return this.harness.id;
  }

  /** Interactive: the size the window showed the terminal at, which a chat compacted from this one starts with. */
  terminalSize(): { cols: number; rows: number } | undefined {
    return this.termSize;
  }

  /** The message box's unsent message, as the window reported it. */
  setDraft(draft: ChatDraft): void {
    this.draft = draft.text || draft.attachments.length ? draft : undefined;
  }

  /** What Looper's next start opens the chat again with. */
  saved(): SavedChat {
    return {
      kind: 'chat',
      id: this.id,
      taskId: this.taskId,
      startedAt: this.startedAt,
      harnessId: this.harness.id,
      settings: this.settings,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.draft ? { draft: this.draft } : {}),
      ...(this.queued.length ? { queued: this.queued.map((q) => ({ text: q.text, attachments: q.attachments })) } : {}),
      ...(this.commands.length ? { commands: this.commands } : {}),
      ...(this.status === 'working' ? { working: true as const } : {}),
    };
  }

  /** The chat is doing something closing would cut short: a turn, or a question to the user. */
  busy(): boolean {
    return this.status === 'working' || this.permissions.length > 0;
  }

  state(): ChatState {
    return {
      id: this.id,
      taskId: this.taskId,
      taskName: this.task.name,
      environmentId: this.environmentId,
      harnessId: this.moveTo?.id ?? this.harness.id,
      harnessName: this.moveTo?.name ?? this.harness.name,
      harnessKind: this.claude ? 'claude-code' : 'codex',
      harnesses: this.harnesses,
      harnessLocked: !this.harnessFree(),
      ...(this.historyLabel ? { historyLabel: this.historyLabel } : {}),
      ...(this.draft ? { draft: this.draft } : {}),
      settings: this.settings,
      autoCompactDefault: { enabled: this.d.settings.chats.autoCompact.enabled, percent: this.d.settings.chats.autoCompact.percent },
      models: harnessModels(this.harness),
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(Object.keys(this.modelWindows).length ? { modelWindows: this.modelWindows } : {}),
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      history: this.newest ?? this.history,
      rows: this.acc.rows,
      permissions: this.permissions,
      queued: this.delivered.length ? [...this.delivered, ...this.queued] : this.queued,
      ...(this.subagentWaiting.size ? { subagentMessages: Object.fromEntries(this.subagentWaiting) } : {}),
      // An interactive session's skills come from its transcript.
      commands: this.interactive && this.acc.commands.length ? this.acc.commands : this.commands,
      commandPrefix: this.claude ? '/' : '$',
      runningCommands: this.shellCommands.size,
      ...(this.turnEndedAt !== undefined ? { turnEndedAt: this.turnEndedAt } : {}),
      startedAt: this.startedAt,
      ...(this.titleBy ? { title: this.title } : {}),
      ...(this.limit ? { limit: this.limit } : {}),
      autoContinue: this.autoContinue,
      ...(this.muted ? { muted: true } : {}),
      ...(this.continueAnyway ? { continueAnyway: true } : {}),
      ...(this.codeMode ? { codeMode: true } : {}),
      ...(this.d.watchTargets ? { watchTasks: this.watchableTasks() } : {}),
    };
  }
}

/** The user record Claude adds when a turn is interrupted: the chat shows "Stopped." in its place. */
export function isInterruptedRecord(rec: Rec): boolean {
  if (rec.type !== 'user') return false;
  const content = obj(rec.message)?.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const text = obj(blocks[0])?.text;
  // "[Request interrupted by user]", or "… for tool use]" when a tool call was running.
  return blocks.length === 1 && typeof text === 'string' && text.startsWith(INTERRUPTED.slice(0, -1));
}

function exitText(fallback: string, stderr: string): string {
  const err = stderr.replace(/^bash: (cannot set terminal process group|no job control in this shell).*$\n?/gm, '').trim();
  return err ? `${fallback}\n${err.split('\n').slice(-6).join('\n')}` : fallback;
}

/** The open task chats, one per chat window. */
export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Each compacted chat's id, and the chat it compacted into: what addresses the old id finds the new chat (following). */
  private readonly compactedTo = new Map<string, string>();
  /** The chats moving to another harness, with the messages sent to them meanwhile: the new session gets them. */
  private readonly moving = new Map<string, Pending[]>();

  constructor(private readonly d: ChatDeps) {}

  /** Start a chat on the task. Throws with the reason. */
  start(task: Task, opening: ChatOpening): ChatState {
    return this.open(new ChatSession(this.d, task, opening));
  }

  /**
   * Open again a chat that was open when Looper quit, as it was, without
   * starting its agent: a chat with a message reopens its run (chat.json,
   * `info`), one without opens the way it first did. Throws with the reason
   * it can't (its folder or harness is gone).
   */
  restore(task: Task, saved: SavedChat, info: ChatInfo | null): ChatState {
    const first = info ? null : readJson<ChatOpening | null>(path.join(this.d.runDir(task.id, saved.id), OPENING_FILE), null);
    if (!info && (!first || first.kind === 'reopen')) throw new Error('Its folder no longer says how it opened.');
    const opening: ChatOpening = info
      ? { kind: 'reopen', runId: saved.id, info, ...(saved.sessionId ? { sessionId: saved.sessionId } : {}) }
      : first!;
    return this.open(new ChatSession(this.d, task, opening, undefined, saved));
  }

  /** The open chats as Looper's next start opens them again, oldest first. */
  saved(): SavedChat[] {
    return [...this.sessions.values()].map((s) => s.saved());
  }

  setDraft(id: string, draft: ChatDraft): void {
    this.sessions.get(id)?.setDraft(draft);
  }

  /**
   * The open chat holding a run's conversation: the run's own chat, a chat
   * that went on with the run, or one on the same session.
   */
  findOpen(taskId: string, runId: string, sessionId: string): ChatState | undefined {
    for (const s of this.sessions.values()) {
      if (s.taskId !== taskId) continue;
      if (s.id === runId || s.fromRunId === runId || s.sessionId === sessionId) return s.state();
    }
    return undefined;
  }

  /** Fork from Here: a new chat with the conversation up to the row at `index` of the chat's history and rows. */
  fork(task: Task, chatId: string, index: number): ChatState {
    const source = this.sessions.get(chatId);
    if (!source) throw new Error('This chat is closed.');
    return this.start(task, source.forkAt(index));
  }

  /**
   * Compact into New Chat: a new chat that starts from the chat's messages,
   * and the chat closes (its run keeps the whole conversation). `started`
   * runs before the old chat closes, so a window can show the new one first.
   */
  async compact(task: Task, chatId: string, started?: (next: ChatState) => void): Promise<ChatState> {
    const source = this.sessions.get(chatId);
    if (!source) throw new Error('This chat is closed.');
    if (this.moving.has(chatId)) throw new Error('The chat is already moving to a new session. Try again once it has.');
    return this.compactInto(source, source.compactOpening(), [], started);
  }

  /** A chat compacts by itself (auto compact, a full context): as Compact into New Chat, then the new chat gets `resend`. */
  private async compactAuto(source: ChatSession, opening: Extract<ChatOpening, { kind: 'compact' }>, resend: Pending[]): Promise<void> {
    if (this.sessions.get(source.id) !== source || this.moving.has(source.id)) return;
    try {
      await this.compactInto(source, opening, resend);
    } catch (err) {
      this.d.log.warn(`chat ${source.id}: cannot compact: ${errMsg(err)}`);
      source.compactFailed(err);
    }
  }

  /**
   * Every compaction, by hand or by itself: the new chat goes on as if the
   * conversation had (what compactOpening carries over), takes the old one's
   * place everywhere that addresses it by id (onCompacted, chat:compacted,
   * `following`), then the old one closes and the new one gets `resend`.
   * Throws, with the old chat still open, when the new one can't start.
   */
  private async compactInto(
    source: ChatSession,
    opening: Extract<ChatOpening, { kind: 'compact' }>,
    resend: Pending[],
    started?: (next: ChatState) => void,
  ): Promise<ChatState> {
    // Messages sent while it compacts wait, and go to the new chat (or back to this one when the new one can't start).
    const held: Pending[] = [];
    this.moving.set(source.id, held);
    let handed = false;
    try {
      // Code Mode: the old session's REPL state, taken while it still runs, comes back in the new one's first turn.
      const repl = await source.replCarry();
      if (this.sessions.get(source.id) !== source) throw new Error('This chat is closed.');
      const next = this.start(source.task, repl ? { ...opening, repl } : opening);
      handed = true;
      const size = source.terminalSize();
      if (size) this.resizeTerminal(next.id, size.cols, size.rows);
      // `started` runs before the old chat closes, so a window can show the new one first.
      started?.(next);
      source.handOver();
      this.compactedTo.set(source.id, next.id);
      // The task's run the chat held goes on in the new one, so the old one's close doesn't end it; the list, the
      // dashboard and the devices move what they keep by the chat's id.
      this.d.onCompacted?.({ taskId: source.taskId, from: source.id, to: next.id });
      this.d.emit({ type: 'chat:compacted', from: source.id, to: next.id });
      await this.close(source.id);
      this.moving.delete(source.id);
      for (const p of [...resend, ...held]) this.send(next.id, p.text, p.attachments);
      return next;
    } finally {
      this.moving.delete(source.id);
      if (!handed) this.sessions.get(source.id)?.takeBack(held);
    }
  }

  /** The open chat a compacted chat's id goes on in, through each compaction since; undefined when none is open. */
  following(id: string): string | undefined {
    const seen = new Set<string>();
    let at = id;
    while (!this.sessions.has(at)) {
      const next = this.compactedTo.get(at);
      if (!next || seen.has(next)) return undefined;
      seen.add(next);
      at = next;
    }
    return at;
  }

  /**
   * Harness menu. A chat nothing has been said in moves to any harness of the
   * task's environment: a new session under the same id, opened the same way;
   * the old one ends and leaves nothing behind. Once the conversation has
   * started it moves only to a harness of the same kind, which resumes it
   * with the next message: at once while the agent is idle, else once its
   * turn ends, and the messages sent meanwhile wait for it.
   */
  async setHarness(task: Task, chatId: string, harnessId: string): Promise<void> {
    const old = this.sessions.get(chatId);
    if (!old || this.moving.has(chatId)) return;
    // Its own harness again: a move waiting for the turn to end is off.
    if (old.harnessId === harnessId) return old.setMoveTo(undefined);
    if (old.harnessFree()) {
      const next = new ChatSession(this.d, task, old.opening, { id: chatId, harnessId, from: old.harnessFrom() });
      return this.replace(old, () => next, false);
    }
    const harness = resolveEnvironment(task, this.d.settings).harnesses.find((h) => h.id === harnessId);
    if (!harness) throw new Error('The environment no longer has that harness.');
    const kind = old.state().harnessKind;
    if (harness.kind !== kind) throw new Error(`The conversation has started on ${harnessKindLabel(kind)}, so it goes on only with a ${harnessKindLabel(kind)} harness.`);
    if (old.busy()) {
      old.setMoveTo(harnessId, () => void this.moveStarted(task, old, harnessId).catch((err: unknown) => old.moveFailed(err)));
      return;
    }
    await this.moveStarted(task, old, harnessId);
  }

  /** A started conversation goes on with another harness of its kind: opened again on it, as Looper's start opens a chat, and its agent starts with the next message. */
  private async moveStarted(task: Task, old: ChatSession, harnessId: string): Promise<void> {
    const conversation = old.conversationId();
    const info = old.info();
    await this.replace(
      old,
      () => {
        const { queued: _queued, working: _working, ...saved } = old.saved();
        const opening: ChatOpening = info
          ? { kind: 'reopen', runId: old.id, info: { ...info, harnessId }, ...(old.sessionId ? { sessionId: old.sessionId } : {}) }
          : old.opening;
        return new ChatSession(this.d, task, opening, undefined, { ...saved, harnessId });
      },
      !!info,
      // Its transcript goes where the new harness looks for it.
      conversation ? () => this.d.moveConversation?.(task, old.harnessId, harnessId, conversation) : undefined,
    );
  }

  /**
   * Put a new session in the chat's place: `prepare` first, then the old one
   * ends (`keep`: its folder stays), and the new one starts with the messages
   * that hadn't reached the old one's agent, and those sent meanwhile.
   */
  private async replace(old: ChatSession, make: () => ChatSession, keep: boolean, prepare?: () => Promise<void> | undefined): Promise<void> {
    const id = old.id;
    // A move already being prepared keeps the messages sent meanwhile.
    if (this.sessions.get(id) !== old || this.moving.has(id)) return;
    const held: Pending[] = [];
    this.moving.set(id, held);
    let handed = false;
    try {
      await prepare?.();
      if (this.sessions.get(id) !== old) return;
      const next = make();
      await old.close(keep);
      if (this.sessions.get(id) !== old) return;
      this.sessions.delete(id);
      this.d.onClose?.(id);
      this.open(next);
      // A run's chat.json names its new harness at once.
      next.save();
      handed = true;
      for (const m of [...old.waiting(), ...held]) next.send(m.text, m.attachments);
    } finally {
      this.moving.delete(id);
      // No new session took over (the copy failed, or the chat closed or moved some other way): what was sent meanwhile goes to the chat's session.
      if (!handed) this.sessions.get(id)?.takeBack(held);
    }
  }

  private open(session: ChatSession): ChatState {
    this.sessions.set(session.id, session);
    session.onCompact = (opening, resend) => void this.compactAuto(session, opening, resend);
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(session.id);
      void session.close();
      throw err;
    }
    if (session.fromRunId) this.d.onOpen?.({ id: session.id, taskId: session.taskId, fromRunId: session.fromRunId });
    return session.state();
  }

  get(id: string): ChatState | undefined {
    return this.sessions.get(id)?.state();
  }

  /** The run whose transcript holds a call of an open compacted chat's earlier conversation; undefined when it has none. */
  compactedRun(id: string, toolUseId: string): string | undefined {
    return this.sessions.get(id)?.compactedRun(toolUseId);
  }

  /** Where an open chat's earlier conversation was read from (ChatSession.historySource). */
  historySource(id: string): ChatHistorySource | undefined {
    return this.sessions.get(id)?.historySource();
  }

  /** Every open chat, oldest first. */
  list(): ChatState[] {
    return [...this.sessions.values()].map((s) => s.state());
  }

  async sendNow(id: string): Promise<void> {
    await this.sessions.get(id)?.sendNow();
  }

  unqueue(id: string, messageId: string): QueuedMessage | undefined {
    return this.sessions.get(id)?.unqueue(messageId);
  }

  taskOf(id: string): string | undefined {
    return this.sessions.get(id)?.taskId;
  }

  /** An interactive chat's terminal, as a terminal session's (TerminalView): undefined for an id that isn't an open chat. */
  terminalOutput(id: string): { data: string; ended: boolean } | undefined {
    return this.sessions.get(id)?.terminalOutput();
  }

  writeTerminal(id: string, data: string): void {
    this.sessions.get(id)?.writeTerminal(data);
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resizeTerminal(cols, rows);
  }

  /** The chats with a window open: run-log pruning leaves their runs alone. */
  openIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  /** Whether the task has a chat open: clearing its run history would delete the chat's folder. */
  hasOpen(taskId: string): boolean {
    return [...this.sessions.values()].some((s) => s.taskId === taskId);
  }

  send(id: string, text: string, attachments: Attachment[]): boolean {
    const held = this.moving.get(id);
    if (held && this.sessions.has(id)) {
      if (!text.trim() && attachments.length === 0) return false;
      held.push({ text: text.trim(), attachments });
      return true;
    }
    return this.sessions.get(id)?.send(text, attachments) ?? false;
  }

  messageSubagent(id: string, agentId: string, text: string): void {
    this.sessions.get(id)?.messageSubagent(agentId, text);
  }

  unmessageSubagent(id: string, agentId: string): string | undefined {
    return this.sessions.get(id)?.unmessageSubagent(agentId);
  }

  async stop(id: string): Promise<void> {
    await this.sessions.get(id)?.stop();
  }

  /** Stop one of the agent's background tasks (ChatSession.stopBackground); throws with the reason it can't. */
  stopBackground(id: string, taskId: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error('This chat is closed.');
    s.stopBackground(taskId);
  }

  /** A command the user ran from the message box ("!"), named `commandId` by its window: its output once it ends, or once Stop ends it. */
  runCommand(id: string, input: string, commandId: string): Promise<CommandOutput> {
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new Error('This chat is closed.'));
    return s.runCommand(input, commandId);
  }

  /** Stop under a running command: that command alone ends. */
  async stopCommand(id: string, commandId: string): Promise<void> {
    await this.sessions.get(id)?.stopCommands(commandId);
  }

  /** The commands running from a chat's message box, while the chat is open. */
  commands(id: string): UserCommands | undefined {
    return this.sessions.get(id)?.userCommands;
  }

  async restartAgent(id: string): Promise<void> {
    await this.sessions.get(id)?.restartAgent();
  }

  /** The prompt cache expired: the idle chat's process ends until its next message. Returns whether it ended one. */
  async stopIdleAgent(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.stopIdleAgent()) ?? false;
  }

  agentRunning(id: string): boolean {
    return this.sessions.get(id)?.agentRunning() ?? false;
  }

  idleSince(id: string): number | null {
    return this.sessions.get(id)?.idleSince() ?? null;
  }

  async holdForReport(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.holdForReport()) ?? false;
  }

  reportWritten(id: string): boolean {
    return this.sessions.get(id)?.reportWritten() ?? false;
  }

  /** The conversation the chat goes on with (claude's session, codex's thread). */
  sessionIdOf(id: string): string | undefined {
    return this.sessions.get(id)?.sessionId;
  }

  async configure(id: string, patch: Partial<ChatSettings>): Promise<void> {
    await this.sessions.get(id)?.configure(patch);
  }

  answer(id: string, requestId: string, allow: boolean): void {
    this.sessions.get(id)?.answerPermission(requestId, allow);
  }

  /** Rename…: the user's name for the chat; '' goes back to the automatic one. */
  rename(id: string, name: string): void {
    this.sessions.get(id)?.rename(name);
  }

  /** Continue When Limit Resets, on or off. */
  setAutoContinue(id: string, on: boolean): void {
    this.sessions.get(id)?.setAutoContinue(on);
  }

  /** Mute Notifications, on or off. */
  setMuted(id: string, on: boolean): void {
    this.sessions.get(id)?.setMuted(on);
  }

  /** Continue Anyway, past Settings → Chats' cache rule. */
  setContinueAnyway(id: string): void {
    this.sessions.get(id)?.setContinueAnyway();
  }

  /** Watch Task Events: watch the task's trigger events with `eventId` as their related id ('' all of them), or stop (`on` false). */
  setWatch(id: string, taskId: string, eventId: string, on: boolean): void {
    const s = this.sessions.get(id);
    const e = eventId.trim();
    if (!on) s?.unwatch(taskId, 'events', e);
    else s?.watch({ taskId, what: 'events', ...(e ? { eventId: e } : {}) });
  }

  /** The open chats whose agents get the ends of the task's runs. */
  runWatchers(taskId: string): string[] {
    return [...this.sessions.values()].filter((s) => s.watchesRuns(taskId)).map((s) => s.id);
  }

  /** The open chats whose agents watch some of the task's event lines, with those lines. */
  eventWatchers(taskId: string, lines: readonly string[]): { chatId: string; lines: string[] }[] {
    return [...this.sessions.values()].map((s) => ({ chatId: s.id, lines: s.watchedEvents(taskId, lines) })).filter((w) => w.lines.length > 0);
  }

  /** Chats in the middle of a turn or waiting on the user: quitting would stop their agents. */
  busy(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.busy()) n++;
    return n;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.d.onClose?.(id);
    await s.close();
    this.d.onClosed?.({ id, taskId: s.taskId, ...(s.sessionId ? { sessionId: s.sessionId } : {}) });
  }

  /** Remote Control was turned off: every chat goes on without it. */
  remoteOff(): void {
    for (const s of this.sessions.values()) s.remoteOff();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** Quitting Looper: every chat's agent stops, and its folder stays for the next start to open it again (restore). */
  async suspendAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close(true)));
  }
}
