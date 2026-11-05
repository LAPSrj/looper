import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { agentArgs } from '../shared/projects';
import { fileAttachments, withCommands, type CommandOutput } from '../shared/bash-mode';
import { CommandStream } from './command-output';
import {
  CONTINUE_TEXT,
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
  type TitleBy,
  type UsageLimitHit,
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
import { compactRows, compactedText } from '../shared/compact';
import type { MessageRow } from '../shared/messages';
import type { EngineEvent, Harness, RunRecord, Settings, Task } from '../shared/types';
import { queueGuidance, readPendingGuidance, takePendingGuidance } from './guidance';
import { ClaudeStreamAccumulator, CodexExecAccumulator } from './builder/stream';
import { contextOfLine, readCodexContextWindow, readContextTokens } from './context';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { COMPACTED_FILE, findCodexRollout, transcriptHostPath } from './messages';
import { claudeModelWindows, modelWindows as sharedWindows } from './model-windows';
import { childEnv, stripShellNoise, writeLauncher, type RunContext } from './steps/common';
import { usageLimitOf } from './sessions';
import { recordCodexHome, usageLimitReset } from './steps/session';
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

/** The chat folder's folder of subagent inboxes, one per agent id. */
const SUBAGENT_INBOX = 'subagent-inbox';

/** A Claude Code agent id ("a030e1626c74e4140"), which names a folder. */
const SUBAGENT_ID = /^[A-Za-z0-9_-]+$/;

/** The message the agent gets: the user's text, then the paths of the files it reads itself. */
export function withFileList(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f}`).join('\n');
  return `${text}\n\nAttached files (read them from these paths):\n${list}`.trim();
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
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'on'>,
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
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'on'>,
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
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'on'>,
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
 * Claude runs one process for the whole chat, and only the permission mode
 * changes while it runs (Bypass excepted: the CLI refuses it unless started
 * with it). A new model, effort or Bypass needs a new process that resumes
 * the conversation.
 */
export function needsNewProcess(
  launched: { model?: string; effort?: string; bypass: boolean },
  next: ChatSettings,
  nextEffort: string | undefined,
): boolean {
  return launched.model !== next.model || launched.effort !== nextEffort || (next.permissionMode === 'bypassPermissions' && !launched.bypass);
}

export interface ChatDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  emit: (e: EngineEvent) => void;
  /** The folder of a run: a chat's id is its run id. */
  runDir: (taskId: string, runId: string) => string;
  /** The conversation a run recorded, as rows: a run's (Continue in Chat) or a chat's own (opened again). */
  readHistory: (taskId: string, runId: string) => Promise<MessageRow[]>;
  /** The same conversation whole, as a compacted one keeps it (compactRows): what Compact starts from. */
  readCompactable: (taskId: string, runId: string) => Promise<MessageRow[]>;
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

/** Where in a chat's folder the output of the user's "!" commands too long to send is saved. */
const COMMANDS_DIR = 'commands';
/** A running "!" command's output goes to the window at most this often. */
const COMMAND_OUTPUT_MS = 100;

/** How long Stop waits for Claude to end its turn by itself before ending the process. */
const INTERRUPT_GRACE_MS = 5000;

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
  | { kind: 'continue'; runId: string; sessionId: string }
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
      draft?: ChatState['draft'];
    }
  /**
   * Continue in Chat on a conversation from outside Looper (the History
   * window): a chat in the project, or a folder's stand-in, that resumes the
   * harness's own session, its history read from the transcript at
   * `transcript` (a host path). `harnessId`: the environment's harness to go
   * on with; unset: the project's.
   */
  | { kind: 'resume'; sessionId: string; harnessKind: 'claude-code' | 'codex'; transcript: string; harnessId?: string };

/** Why a conversation on one kind of harness can't go on with the project's, which is another kind. */
export function kindMismatchText(conversation: Harness['kind'], project: Harness['kind']): string {
  return `This conversation ran on ${harnessKindLabel(conversation)}, and the project uses ${harnessKindLabel(project)}.`;
}

/** A chat that was in the Chats window when Looper quit: Looper opens it again at its start. */
export type SavedChat = Extract<OpenConversation, { kind: 'chat' }>;

/** A chat's folder holds how it opened until its first message makes it a run (chat.json then says). */
const OPENING_FILE = 'opening.json';

class ChatSession {
  readonly id: string;
  readonly taskId: string;
  private readonly dir: string;
  private readonly environmentId: string;
  private readonly harness: Harness;
  /** The environment's Claude Code and Codex harnesses. */
  private readonly harnesses: { id: string; name: string }[];
  /** The task's extra arguments: only a harness of the task's own kind gets them, since they're flags for that CLI. */
  private readonly extraArgs: string[];
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
  /** A conversation from outside Looper this chat went on with: its session (thread) id. */
  private readonly resumedSession?: string;
  /** A compacted chat that hasn't sent its first message: the conversation that message takes to the agent. */
  private compacted?: MessageRow[];
  /** The history as compaction keeps it, whole: the rows it shows are only the transcript's last ones. */
  private historyCompact?: MessageRow[];
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
  /** Claude Code was asked to name the chat (askTitle). */
  private titleAsked = false;
  /** The last turn failed on the usage limit. */
  private limit?: UsageLimitHit;
  /** What this turn said about the limit: Claude's rejected rate_limit_event, Codex's usage-limit error. */
  private turnLimit?: { resetsAt?: number };
  /** Continue When Limit Resets. */
  private autoContinue: boolean;
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
  /** Claude: each model's context window its result records named (ChatState.modelWindows). */
  private modelWindows: Record<string, number> = {};
  /** Claude: what the running process was started with. */
  private launched?: { model?: string; effort?: string; bypass: boolean };
  private status: ChatState['status'] = 'starting';
  private error?: string;
  private history: MessageRow[] = [];
  private proc: ChildProcess | null = null;
  /** Codex's app server while it forks the thread. */
  private forkProc: ChildProcess | null = null;
  /** Processes Looper ended (Stop, a restart): their exit isn't the chat's end. */
  private readonly retired = new WeakSet<ChildProcess>();
  /** A Stop or restart is ending the process: messages wait for the next one. */
  private killing = false;
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
  private queueSeq = 0;
  /** The user's messages waiting for a subagent to read them, by its agent id. */
  private readonly subagentWaiting = new Map<string, string>();
  /** Each message written to claude that it hasn't replayed yet, in order: a queued one's id, or null for a message sent at once. */
  private unreplayed: (string | null)[] = [];
  /** Claude's tool calls of this turn without a result yet. */
  private readonly toolsRunning = new Set<string>();
  private permissions: ChatPermissionRequest[] = [];
  private readonly takenRequests = new Set<string>();
  /** Permission mode changes claude hasn't confirmed yet: request id → the mode to go back to. */
  private readonly modeRequests = new Map<string, string>();
  private controlSeq = 0;
  /** Remote Control: the name the Claude app lists the chat under, while it's on. */
  private remoteName?: string;
  private commands: SlashCommand[] = [];
  /** The commands the user ran from the message box that are still running, by id. */
  private readonly shellCommands = new Map<string, { child: ChildProcess; marker: string; stopped: boolean }>();
  private commandSeq = 0;
  private turnEndedAt?: number;
  private readonly startedAt: number;
  /** Stop asked claude to end its turn: the process ends if the turn doesn't. */
  private stopTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: ChatDeps,
    private readonly task: Task,
    opening: ChatOpening,
    choice?: HarnessChoice,
    saved?: SavedChat,
  ) {
    this.taskId = task.id;
    this.opening = opening;
    this.restored = !!saved;
    this.startedAt = saved?.startedAt ?? Date.now();
    const env = resolveEnvironment(task, d.settings);
    const own = resolveHarness(task, env);
    const info = opening.kind === 'reopen' ? opening.info : undefined;
    const wanted =
      saved?.harnessId ?? choice?.harnessId ?? info?.harnessId ?? (opening.kind === 'fork' || opening.kind === 'compact' || opening.kind === 'resume' ? opening.harnessId : undefined);
    const harness = wanted ? env.harnesses.find((h) => h.id === wanted) : own;
    if (!harness) throw new Error(`The environment "${env.name}" no longer has the harness this chat ran on.`);
    if (harness.kind === 'custom') throw new Error('A chat needs a Claude Code or Codex harness.');
    if (info && info.harnessKind !== harness.kind) {
      throw new Error(`This chat ran on ${harnessKindLabel(info.harnessKind)}, and the task now uses ${harnessKindLabel(harness.kind)}.`);
    }
    if (opening.kind === 'resume' && opening.harnessKind !== harness.kind) throw new Error(kindMismatchText(opening.harnessKind, harness.kind));
    this.environmentId = env.id;
    this.harness = harness.id === own.id && task.agent.command ? { ...harness, command: task.agent.command } : harness;
    this.harnesses = env.harnesses.filter((h) => h.kind !== 'custom').map((h) => ({ id: h.id, name: h.name }));
    this.extraArgs = harness.kind === own.kind ? agentArgs(task) : [];
    this.claude = harness.kind === 'claude-code';
    this.acc = this.claude ? new ClaudeStreamAccumulator() : new CodexExecAccumulator();
    this.id = saved?.id ?? choice?.id ?? (opening.kind === 'reopen' ? opening.runId : newRunId());
    this.reopened = opening.kind === 'reopen';
    this.recorded = this.reopened;
    this.title = info?.title ?? '';
    this.titleBy = info?.titleBy;
    this.autoContinue = info ? !!info.autoContinue : d.settings.chats.continueAfterLimit;
    // Quitting while it waited for the reset: Looper's next start goes on waiting.
    if (saved) {
      this.limit = info?.limit;
      this.continueAnyway = !!info?.continueAnyway;
    }
    const taskSettings: ChatSettings = { model: task.agent.model, effort: task.agent.effort, permissionMode: task.agent.permissionMode ?? '' };
    this.settings = saved
      ? (info?.settings ?? saved.settings)
      : choice
        ? chatSettingsOn(harness, choice.from, { id: own.id, settings: taskSettings })
        : (info?.settings ?? (opening.kind === 'fork' || opening.kind === 'compact' ? (opening.settings ?? taskSettings) : taskSettings));
    this.context = info?.context;
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
      this.historyLabel = opening.label ?? `Compacted from run ${opening.from}`;
      // Its ids (c0, c1…) are compacted.json's, which a reopened chat's history starts with.
      this.history = opening.history;
      this.historyCompact = opening.history;
      this.compacted = opening.history;
      this.draft = opening.draft;
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
  }

  // ---------- lifecycle ----------

  start(): void {
    fs.mkdirSync(path.join(this.dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'permissions'), { recursive: true });
    // Until its first message, how it opened is what Looper's next start opens it again with.
    if (!this.recorded) writeJsonAtomic(path.join(this.dir, OPENING_FILE), this.opening);
    // Continue in Chat shows the run's conversation; a chat opened again, its own.
    const historyRun = this.reopened ? this.id : this.historyLabel && this.fromRunId ? this.fromRunId : undefined;
    if (historyRun) {
      void Promise.all([this.d.readHistory(this.taskId, historyRun), this.d.readCompactable(this.taskId, historyRun)])
        .then(([rows, compact]) => {
          this.history = historyRows(rows);
          this.historyCompact = compact;
          this.scheduleEmit();
        })
        .catch(() => undefined);
    } else if (this.opening.kind === 'resume' && this.d.readTranscript) {
      // A conversation from outside Looper has no run: its history is its transcript's.
      void this.d
        .readTranscript(this.opening.transcript, this.claude ? 'claude' : 'codex')
        .then(({ rows, compact, name }) => {
          this.history = historyRows(rows);
          this.historyCompact = compact;
          if (name) this.nameFromHarness(name);
          this.scheduleEmit();
        })
        .catch(() => undefined);
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
      writeJsonAtomic(path.join(this.dir, 'settings.json'), {
        ...projectMcpApproval(this.harness),
        hooks: {
          // With Remote Control: each message and finished turn, from here or the Claude app, for its Conversations list.
          ...(this.remoteName ? { UserPromptSubmit: pipe('prompt.json'), Stop: pipe('stop.json') } : {}),
          // As in a run: the payload names the session and its transcript, which the run window and Continue read.
          SessionStart: [{ hooks: [{ type: 'command', command: this.target.renderPipeHook(this.targetFile('session.json')) }] }],
          // The agent's own notifications: the Sessions window puts the chat in Waiting for you.
          Notification: [{ hooks: [{ type: 'command', command: this.target.renderPipeHook(this.targetFile('notification.json')) }] }],
          // The user's messages for a running subagent, with its next tool result.
          SubagentStart: [{ hooks: toSubagents('start') }],
          PostToolUse: [{ matcher: '', hooks: toSubagents('post') }],
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
      });
      this.timers.push(
        setInterval(() => {
          this.pollPermissions();
          this.pollSubagentMessages();
        }, 300),
      );
      // A chat opened again at Looper's start runs nothing until its next message (writeClaude starts claude then).
      if (this.restored) this.setStatus('ready');
      else this.startClaude();
    } else {
      if (this.sessionId) writeJsonAtomic(path.join(this.dir, 'codex-session.json'), { thread_id: this.sessionId });
      this.setStatus('ready');
      if (!this.restored) this.loadCodexSkills();
    }
  }

  /** Codex's skills for the "/" list, from its app server; without them the list stays empty. */
  private loadCodexSkills(): void {
    const spec = this.launcher('skills', `${this.harness.command} app-server`);
    const child = spawn(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    void codexListSkills(child, this.task.cwd)
      .then((skills) => {
        this.commands = skills;
        this.scheduleEmit();
      })
      .catch((err: unknown) => this.d.log.warn(`chat ${this.id}: cannot list codex skills: ${errMsg(err)}`))
      .finally(() => {
        if (child.pid) void killHostTree(child.pid).catch(() => undefined);
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
    try {
      fs.rmSync(gone, { recursive: true, force: true });
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot delete ${gone}: ${errMsg(err)}`);
    }
  }

  private async kill(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (child) this.retired.add(child);
    if (child?.pid) await killHostTree(child.pid).catch(() => undefined);
    await this.target.killLeftovers(this.ctx.runId).catch(() => undefined);
  }

  // ---------- commands the user runs from the message box ("!") ----------

  /**
   * Run `input` in the chat's working directory on its target (a WSL or
   * remote chat runs it there), through a launcher as the agent's own
   * processes start: its stdout and stderr once it ends. It runs whatever the
   * agent is doing, and Stop ends it. Its processes carry a run marker of
   * their own, so stopping it leaves the agent's alone.
   */
  runCommand(input: string, id: string): Promise<CommandOutput> {
    const command = input.trim();
    if (this.closed) return Promise.reject(new Error('This chat is closed.'));
    if (!command) return Promise.reject(new Error('There is no command to run.'));
    // The window names it (its live output and its Stop find it by the name), within what a file name can hold.
    if (!/^[\w-]{1,64}$/.test(id) || this.shellCommands.has(id)) return Promise.reject(new Error('The command has no usable id.'));
    const n = ++this.commandSeq;
    const marker = `${this.ctx.runId}-cmd${n}`;
    const spec = writeLauncher({ ...this.ctx, runId: marker }, `command-${n}`, command).spec;
    // Output too long to send goes whole to a file in the chat's folder, which the agent reads by its own path.
    const stream = (name: 'stdout' | 'stderr', clean?: (s: string) => string) =>
      new CommandStream(path.join(this.dir, COMMANDS_DIR, `${id}-${name}.txt`), this.targetFile(COMMANDS_DIR, `${id}-${name}.txt`), clean);
    const stdout = stream('stdout');
    // The launcher's interactive bash warns that it has no job control: that's the shell's, not the command's.
    const stderr = stream('stderr', stripShellNoise);
    return new Promise((resolve) => {
      const child = spawn(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const running = { child, marker, stopped: false };
      this.shellCommands.set(id, running);
      this.scheduleEmit();
      // The window shows the output as it comes, a batch at most every COMMAND_OUTPUT_MS.
      let timer: NodeJS.Timeout | null = null;
      const show = () => {
        timer = null;
        if (!this.closed) this.d.emit({ type: 'chat:command', chatId: this.id, id, stdout: stdout.live(), stderr: stderr.live() });
      };
      const took = () => {
        if (!timer) timer = setTimeout(show, COMMAND_OUTPUT_MS);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        stdout.push(d);
        took();
      });
      child.stderr?.on('data', (d: string) => {
        stderr.push(d);
        took();
      });
      let done = false;
      const end = async (exitCode: number | null, error?: string) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
        this.shellCommands.delete(id);
        this.scheduleEmit();
        const errText = error ? (err.text ? `${err.text}\n${error}` : error) : err.text;
        const saved = out.saved || err.saved ? { ...(out.saved ? { stdout: out.saved } : {}), ...(err.saved ? { stderr: err.saved } : {}) } : undefined;
        resolve({
          id,
          input: command,
          stdout: out.text,
          stderr: errText,
          exitCode: running.stopped ? null : exitCode,
          ...(running.stopped ? { stopped: true } : {}),
          ...(saved ? { saved } : {}),
        });
      };
      child.on('error', (e) => void end(null, `Couldn't run the command: ${e.message}`));
      child.on('close', (code) => void end(code));
      this.d.log.info(`[${this.taskId}] chat ${this.id}: running the user's command ${id}`);
    });
  }

  /** Stop: the commands still running end (`id`: that one alone), with what they printed so far. */
  async stopCommands(id?: string): Promise<void> {
    await Promise.all(
      [...this.shellCommands.entries()]
        .filter(([key]) => id === undefined || key === id)
        .map(async ([, c]) => {
          c.stopped = true;
          // The launcher's shell first, and for good: an interactive bash ignores SIGTERM, and would go on to the command's next line.
          if (c.child.pid) await killHostTree(c.child.pid, 'SIGKILL').catch(() => undefined);
          await this.target.killLeftovers(c.marker).catch(() => undefined);
        }),
    );
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
    this.turnEndedAt = Date.now();
    this.setStatus('ready');
  }

  // ---------- the queue ----------

  /** Send Now: the queued messages go at once, ending the agent's turn if it's working. */
  async sendNow(): Promise<void> {
    if (this.queued.length === 0) return;
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
    this.queued = this.queued.filter((q) => q !== m);
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
    this.unsendQueued();
    if (wasWorking) this.acc.addNote('Stopped.');
    this.error = undefined;
    this.status = 'ready';
    if (wasWorking) this.turnEnded();
    if (this.claude) this.startClaude();
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
    if (!this.claude || !this.proc || this.closed || this.killing || this.busy() || this.queued.length > 0) return false;
    this.killing = true;
    await this.kill();
    this.killing = false;
    this.d.log.info(`[${this.taskId}] chat ${this.id}: stopped the agent, its prompt cache expired`);
    this.scheduleEmit();
    // A message sent while the process was ending waited in the queue: it starts a new one now.
    this.drainQueue();
    return true;
  }

  /** Whether the harness's process runs now (Claude's lives between turns; Codex's only during one). */
  agentRunning(): boolean {
    return !!this.proc;
  }

  /** Claude: a new process with the chat's settings that resumes the conversation. */
  private async restart(): Promise<void> {
    this.killing = true;
    this.setStatus('starting');
    await this.kill();
    this.killing = false;
    if (this.closed || this.status === 'ended') return;
    this.unsendQueued();
    this.startClaude();
    this.drainQueue();
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

  /** Continue When Limit Resets, on or off. */
  setAutoContinue(on: boolean): void {
    if (this.closed || this.autoContinue === on) return;
    this.autoContinue = on;
    if (!on) this.continueAnyway = false;
    this.save();
    this.syncContinue();
    this.scheduleEmit();
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

  /** Chat menu: a new model, effort or permission mode for this chat (the task keeps its own). */
  async configure(patch: Partial<ChatSettings>): Promise<void> {
    if (this.closed || this.status === 'ended' || this.killing) return;
    const prev = this.settings;
    const next: ChatSettings = { ...prev, ...patch };
    // An effort the new model doesn't offer falls back to its default, as in the task editor.
    if ('model' in patch && next.effort) {
      const entry = harnessModels(this.harness).find((m) => m.id === next.model);
      if (entry?.efforts && !entry.efforts.includes(next.effort)) next.effort = undefined;
    }
    // Codex starts a process per turn, and a stopped claude starts one with the next message: both take the settings then.
    if (this.claude && this.proc && this.launched) {
      if (needsNewProcess(this.launched, next, resolveEffort(next, this.harness))) {
        // The Chat menu keeps these off during a turn: a new process would cut it short.
        if (this.busy()) return;
        this.settings = next;
        this.save();
        await this.restart();
        return;
      }
      if (next.permissionMode !== prev.permissionMode) {
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
    return writeLauncher(this.ctx, name, (prelude ? prelude + '\n' : '') + exec + body, this.harness.env).spec;
  }

  /** The chat's model, effort and permission mode, as a run would pass the task's. */
  private startClaude(): void {
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
    parts.push('--settings', q(this.targetFile('settings.json')));
    // A question form needs answers Looper can't collect: the agent asks in the conversation instead.
    parts.push('--disallowedTools', 'AskUserQuestion');
    // Replays echo each message when Claude reads it: a queued one shows in the conversation where the agent took it in.
    parts.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages');
    // Under -p Claude Code sends thinking blocks without their text unless the display is set explicitly.
    parts.push('--thinking-display', 'summarized');
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of this.extraArgs) parts.push(q(extra));
    this.launched = { model: s.model, effort, bypass: s.permissionMode === 'bypassPermissions' };
    this.spawnProc(this.launcher('chat', parts.join(' ')), (_code, stderr) => {
      // The one process is the whole conversation: once it is gone, so is the chat.
      this.end(exitText('The session ended.', stderr));
    });
    // The command list, before any message: Claude answers it without calling the model.
    this.proc?.stdin?.write(JSON.stringify({ type: 'control_request', request_id: `init-${++this.controlSeq}`, request: { subtype: 'initialize' } }) + '\n');
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
    this.proc?.stdin?.write(remoteControlRequest(`rc-${++this.controlSeq}`, undefined) + '\n');
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
    writeText(path.join(this.dir, promptFile), compacted ? `${compacted}\n\n${prompt}` : prompt);
    const parts = [this.harness.command, 'exec', ...codexPermissionArgs(s.permissionMode, false)];
    if (s.model) parts.push('--model', q(s.model));
    const effort = resolveEffort(s, this.harness);
    if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
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
      this.turnEnded();
      this.takeLimit();
      void this.readCodexContext().finally(() => this.save());
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
    const child = spawn(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        if (child.pid) void killHostTree(child.pid).catch(() => undefined);
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
    if (this.queued.length === 0 || this.killing || this.status === 'working' || this.status === 'ended' || this.closed) return;
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
    const child = spawn(spec.command, spec.args, {
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
      if (typeof tokens === 'number') this.context = { tokens, window: this.context?.window };
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
      } else if (rec.isReplay === true) {
        // Claude read a message: a queued one joins the conversation here.
        const id = this.unreplayed.shift();
        const m = id ? this.queued.find((q) => q.id === id) : undefined;
        if (m) {
          this.queued = this.queued.filter((q) => q !== m);
          this.acc.addPrompt(m.text, m.attachments);
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
      this.askTitle();
      this.save();
      this.drainQueue();
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

  /** The user's message: to the agent now, or into the queue while it works. */
  send(text: string, attachments: Attachment[]): void {
    const t = text.trim();
    if (this.closed || this.status === 'ended' || (!t && attachments.length === 0)) return;
    if (this.killing || this.status === 'working') {
      this.queued.push({ id: `q${++this.queueSeq}`, text: t, attachments });
      // A tool is running: the agent reads it with that tool's result.
      if (!this.killing && this.toolsRunning.size > 0) this.writeQueued();
      this.scheduleEmit();
      return;
    }
    this.dispatch({ text: t, attachments });
  }

  private dispatch(p: Pending): void {
    // A message ends the wait for the limit, and the continue that was to follow it.
    this.limit = undefined;
    this.turnLimit = undefined;
    this.continueAnyway = false;
    this.syncContinue();
    this.acc.addPrompt(p.text, p.attachments);
    this.markOpened();
    // A compacted chat's first message takes the earlier conversation to the agent, once.
    const compacted = this.compacted ? compactedText(this.compacted, (x) => this.target.toTargetPath(x)) : undefined;
    this.compacted = undefined;
    if (this.claude) this.writeClaude(p, compacted);
    else this.startCodexTurn(p, compacted);
  }

  private writeClaude(p: Pending, compacted?: string): void {
    // After a Stop the process is gone: a new one resumes the conversation.
    if (!this.proc) this.startClaude();
    const msg = claudeUserMessage(p.text, p.attachments, (x) => this.target.toTargetPath(x), undefined, compacted);
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
    this.unreplayed.push(null);
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
      if (this.opening.kind === 'compact') writeJsonAtomic(path.join(this.dir, COMPACTED_FILE), this.opening.history);
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
  private save(): void {
    if (this.closed || !this.recorded) return;
    try {
      this.d.writeInfo(this.taskId, this.id, {
        harnessId: this.harness.id,
        harnessKind: this.claude ? 'claude-code' : 'codex',
        title: this.title,
        ...(this.titleBy ? { titleBy: this.titleBy } : {}),
        ...(this.autoContinue ? { autoContinue: true } : {}),
        ...(this.continueAnyway ? { continueAnyway: true } : {}),
        ...(this.limit ? { limit: this.limit } : {}),
        settings: this.settings,
        ...(this.context ? { context: this.context } : {}),
        ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
        ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
        ...(this.compactedFrom ? { compactedFrom: this.compactedFrom } : {}),
        ...(this.resumedSession ? { resumedSession: this.resumedSession } : {}),
      });
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot save: ${errMsg(err)}`);
    }
  }

  /** Fork from Here on the row at `index` of the history and rows: how the new chat starts. Throws with the reason. */
  forkAt(index: number): Extract<ChatOpening, { kind: 'fork' }> {
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

  /** Compact into New Chat: the conversation as a compacted chat starts from. Throws with the reason it can't. */
  compactOpening(): Extract<ChatOpening, { kind: 'compact' }> {
    if (this.busy()) throw new Error('The agent is still working. Compact the chat once its turn has ended.');
    // The live rows' accumulator keeps a compact copy of each row it drops too.
    const history = this.historyCompact ?? compactRows(this.history);
    const rows = compactRows([...history, ...this.acc.evicted, ...this.acc.rows]);
    if (!rows.some((r) => r.kind === 'agent')) throw new Error('The chat has no reply to compact yet.');
    // A chat that hasn't sent a message isn't a run yet: its conversation is the run it went on with.
    const from = this.recorded ? this.id : (this.fromRunId ?? this.compactedFrom ?? this.forkedFrom ?? this.id);
    return { kind: 'compact', from, history: rows, harnessId: this.harness.id, settings: this.settings };
  }

  /** What a chat on another harness needs from this one. */
  harnessFrom(): HarnessChoice['from'] {
    return { kind: this.harness.kind, settings: this.settings };
  }

  get harnessId(): string {
    return this.harness.id;
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
      harnessId: this.harness.id,
      harnessName: this.harness.name,
      harnessKind: this.claude ? 'claude-code' : 'codex',
      harnesses: this.harnesses,
      harnessLocked: !this.harnessFree(),
      ...(this.historyLabel ? { historyLabel: this.historyLabel } : {}),
      ...(this.draft ? { draft: this.draft } : {}),
      settings: this.settings,
      models: harnessModels(this.harness),
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(Object.keys(this.modelWindows).length ? { modelWindows: this.modelWindows } : {}),
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      history: this.history,
      rows: this.acc.rows,
      permissions: this.permissions,
      queued: this.queued,
      ...(this.subagentWaiting.size ? { subagentMessages: Object.fromEntries(this.subagentWaiting) } : {}),
      commands: this.commands,
      commandPrefix: this.claude ? '/' : '$',
      runningCommands: this.shellCommands.size,
      ...(this.turnEndedAt !== undefined ? { turnEndedAt: this.turnEndedAt } : {}),
      startedAt: this.startedAt,
      ...(this.titleBy ? { title: this.title } : {}),
      ...(this.limit ? { limit: this.limit } : {}),
      autoContinue: this.autoContinue,
      ...(this.continueAnyway ? { continueAnyway: true } : {}),
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
    const next = this.start(task, source.compactOpening());
    started?.(next);
    await this.close(chatId);
    return next;
  }

  /**
   * Harness menu: a chat nothing has been said in moves to another harness of
   * the task's environment. It's a new session under the same id, opened the
   * same way; the old one ends and leaves nothing behind.
   */
  async setHarness(task: Task, chatId: string, harnessId: string): Promise<void> {
    const old = this.sessions.get(chatId);
    if (!old || old.harnessId === harnessId) return;
    if (!old.harnessFree()) throw new Error('The conversation has started, so it stays on its harness.');
    const next = new ChatSession(this.d, task, old.opening, { id: chatId, harnessId, from: old.harnessFrom() });
    await old.close();
    if (this.sessions.get(chatId) !== old) return;
    this.sessions.delete(chatId);
    this.d.onClose?.(chatId);
    this.open(next);
  }

  private open(session: ChatSession): ChatState {
    this.sessions.set(session.id, session);
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(session.id);
      void session.close();
      throw err;
    }
    return session.state();
  }

  get(id: string): ChatState | undefined {
    return this.sessions.get(id)?.state();
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

  /** The chats with a window open: run-log pruning leaves their runs alone. */
  openIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  /** Whether the task has a chat open: clearing its run history would delete the chat's folder. */
  hasOpen(taskId: string): boolean {
    return [...this.sessions.values()].some((s) => s.taskId === taskId);
  }

  send(id: string, text: string, attachments: Attachment[]): void {
    this.sessions.get(id)?.send(text, attachments);
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

  /** Continue Anyway, past Settings → Chats' cache rule. */
  setContinueAnyway(id: string): void {
    this.sessions.get(id)?.setContinueAnyway();
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
