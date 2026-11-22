import type { CommandOutput } from './bash-mode';
import type { MessageRow } from './messages';
import { stripMarkdown } from './messages-md';
import { baseName } from './paths';
import type { SlashCommand, UsageLimits } from './sessions';
import type { HarnessModel } from './types';

/**
 * A file the user attached to a chat message, or dropped or pasted into a
 * Looper terminal; or a command the user ran from the message box ("!"),
 * which has no file.
 */
export interface Attachment {
  /** The file's own name, as the user knows it; a command's is "! <command>". */
  name: string;
  /** Host path of Looper's copy, under the task's attachments folder: clicking it opens this. '' for a command. */
  path: string;
  /** An image the agent gets to see itself (PNG, JPEG, GIF or WebP). */
  image: boolean;
  /** A command and its output, which go to the agent with the message. */
  command?: CommandOutput;
}

/** A file's own name: its base name without the stamp Looper puts in front of an attachment copy's. */
export function attachmentName(file: string): string {
  return baseName(file).replace(/^\d{8}-\d{6}-[a-z0-9]{4}-/, '');
}

/** A file handed to Looper to attach: a pasted image's bytes, or a dropped or picked file's host path. */
export type AttachmentInput = { name: string; data: Uint8Array } | { name: string; path: string };

/** A tool call the agent waits on: Allow or Deny in the chat window. */
export interface ChatPermissionRequest {
  id: string;
  tool: string;
  input: unknown;
}

/** The chat's own model, effort, permission mode and session type: the task's to start with (on the task's harness), then the Chat menu's. */
export interface ChatSettings {
  /** Unset: the CLI's default model. */
  model?: string;
  /** Unset: the model's default effort (see resolveEffort). */
  effort?: string;
  /** A PERMISSION_MODES value; '' passes no mode. */
  permissionMode: string;
  /**
   * Interactive: Claude Code in a terminal, its conversation read from its
   * transcript; headless: Claude Code's stream-json, or Codex. Unset: the
   * task's session type. A Codex chat is always headless.
   */
  mode?: 'interactive' | 'headless';
  /**
   * At the end of a turn, compact into a new chat once the context is past
   * Settings → Chats' share of the window. Unset: as Settings → Chats says.
   */
  autoCompact?: boolean;
}

/** The menus above a chat's message box, each one of the Chat menu's lists. */
export type ChatSettingMenu = 'harness' | 'model' | 'effort' | 'permission' | 'mode' | 'compact';

/** Settings → Chats' auto compact: on for every chat without a setting of its own, and the share of the context window it compacts past. */
export interface AutoCompactSetting {
  enabled: boolean;
  percent: number;
}

/** The share of the context window (percent) past which the chat compacts at the end of a turn; undefined when it doesn't. */
export function autoCompactPercent(settings: Pick<ChatSettings, 'autoCompact'>, app: AutoCompactSetting): number | undefined {
  return (settings.autoCompact ?? app.enabled) ? app.percent : undefined;
}

/** Whether a context is past `percent` of its window; never when the window isn't known. */
export function contextPast(context: ChatContext | undefined, percent: number): boolean {
  return !!context?.window && context.tokens * 100 >= context.window * percent;
}

/** Whether the chat runs its agent in a terminal (ChatSettings.mode). */
export const chatInteractive = (chat: Pick<ChatState, 'harnessKind' | 'settings'>): boolean =>
  chat.harnessKind === 'claude-code' && chat.settings.mode === 'interactive';

/** How full the conversation is: tokens in context, and the model's window when the CLI reports it. */
export interface ChatContext {
  tokens: number;
  window?: number;
}

/**
 * A task chat (Open Project in Chat, Continue in Chat, Fork from Here): the
 * task's harness in a Looper chat window, headless or (Claude Code) in a
 * terminal the chat shows beside its conversation. Once the user
 * sends a message it is a run of the task: its id is the run id, its folder
 * the run folder, and it shows in the run list. It has no time limits and no
 * dashboard row.
 */
export interface ChatState {
  /** The chat's run id. */
  id: string;
  /** Which of the chat's events this state is as of, and from which encoder (chat-delta.ts): the next event applies to it. */
  seq?: number;
  epoch?: number;
  taskId: string;
  taskName: string;
  environmentId: string;
  harnessId: string;
  harnessName: string;
  harnessKind: 'claude-code' | 'codex';
  /** The Claude Code and Codex harnesses of the task's environment: the Harness menu's list. */
  harnesses: { id: string; name: string; kind: 'claude-code' | 'codex' }[];
  /** The conversation has started (or goes on with another one), so it moves only to a harness of its kind. */
  harnessLocked: boolean;
  /** The divider above the earlier conversation ("Earlier in run …"); unset shows it without one. */
  historyLabel?: string;
  /**
   * What the message box starts with: the message box's unsent message as
   * the window last reported it (also across a restart of Looper), or with
   * Fork from Here on the user's own message, that message.
   */
  draft?: ChatDraft;
  settings: ChatSettings;
  /** Settings → Chats' auto compact, which the chat follows unless `settings.autoCompact` says otherwise. */
  autoCompactDefault: AutoCompactSetting;
  /** The harness's model presets: the Chat menu's Model list and the status bar's names. */
  models: HarnessModel[];
  /** The model the CLI says it runs (Claude Code's init), e.g. when the chat uses the default. */
  activeModel?: string;
  context?: ChatContext;
  /** Claude: each model's context window by its id without a `[1m]` suffix, from the turns' result records, its subagents' models too. */
  modelWindows?: Record<string, number>;
  status: 'starting' | 'ready' | 'working' | 'ended';
  /** Why the session ended, or why the last turn failed. */
  error?: string;
  /**
   * The conversation before this window: the run's (Continue in Chat), the
   * chat's own when it opens again, or the forked chat's up to the fork.
   */
  history: MessageRow[];
  rows: MessageRow[];
  /** Tool calls waiting for the user's answer, oldest first. */
  permissions: ChatPermissionRequest[];
  /** Messages sent while the agent works: they go to it together when its turn ends, or at once with Send Now. */
  queued: QueuedMessage[];
  /** The user's messages waiting for a subagent to read them, by its agent id (Claude Code). */
  subagentMessages?: Record<string, string>;
  /** The harness's slash commands and skills, for the message box's "/" list. */
  commands: SlashCommand[];
  /** What a picked command is written with: "/" for Claude Code, "$" for a Codex skill. */
  commandPrefix: '/' | '$';
  /** How many commands the user ran from the message box ("!") are still running: Stop stops them. */
  runningCommands: number;
  /** When the agent last finished a turn (ms since the epoch). */
  turnEndedAt?: number;
  startedAt: number;
  /** A name the user (Rename…) or the harness gave the chat; unset: its first message titles it. */
  title?: string;
  /** The last turn failed on the usage limit; it ends with the next message. */
  limit?: UsageLimitHit;
  /** Continue When Limit Resets: once the limit resets, Looper sends the agent CONTINUE_TEXT. */
  autoContinue: boolean;
  /** Mute Notifications: no device gets a push for this chat. */
  muted?: true;
  /** Continue Anyway: this limit's continue goes even though the cache has expired (Settings → Chats). */
  continueAnyway?: boolean;
  /** The conversation is in Claude Code's Code Mode, which Claude Code goes on with only in a terminal: the chat stays interactive. */
  codeMode?: boolean;
  /** Chat → Watch Task Events: every task in the Tasks list's order, with the event ids it watches each for. */
  watchTasks?: WatchableTask[];
}

/** A task in Chat → Watch Task Events, and the event ids the chat watches it for ('' for all its events). */
export interface WatchableTask {
  id: string;
  name: string;
  events: string[];
  /** It's in the chat's project; the others are under Other Projects. */
  own: boolean;
  /** The Tasks list's folders it's in, from the top level down. */
  folders: { id: string; name: string }[];
}

/**
 * What a chat watches of a task of its project (Watch Task Events, looper-watch): the end of each of its runs
 * (`runs`), or its trigger events (`events`), only those whose related id is `eventId` when it has one.
 */
export interface TaskWatch {
  taskId: string;
  what: 'runs' | 'events';
  eventId?: string;
}

/** A turn that failed on the usage limit: when, and when the limit resets (ms since the epoch) when the harness said. */
export interface UsageLimitHit {
  at: number;
  resetsAt?: number;
}

/** The message Continue When Limit Resets sends the agent. */
export const CONTINUE_TEXT = 'Continue.';
/** How long after the reset time the message goes: the harnesses give the time to the minute. */
export const CONTINUE_MARGIN_MS = 60_000;
/** How often it tries again when the harness didn't say when the limit resets. */
export const CONTINUE_RETRY_MS = 3_600_000;

/**
 * How long Continue When Limit Resets waits from `now`: until just after the
 * reset time, at once when that has passed; an hour when the time is unknown,
 * or when it was already past as the turn failed (the limit is longer than it said).
 */
export function continueDelay(limit: UsageLimitHit, now: number): number {
  if (limit.resetsAt === undefined || limit.resetsAt <= limit.at) return CONTINUE_RETRY_MS;
  return Math.max(0, limit.resetsAt + CONTINUE_MARGIN_MS - now);
}

/** When Continue When Limit Resets sends; undefined when the harness didn't say when the limit resets. */
export const continueAt = (limit: UsageLimitHit): number | undefined => (limit.resetsAt === undefined ? undefined : limit.resetsAt + CONTINUE_MARGIN_MS);

/**
 * Whether Settings → Chats' cache rule stops a continue sent at `at`: the
 * prompt cache will have expired by then and the context is over the size. At
 * size 0 any context counts, even one whose size isn't known. A harness that
 * reports no cache time isn't stopped.
 */
export function continueSkipped(
  rule: { enabled: boolean; aboveTokens: number },
  at: number,
  cacheUntil: number | undefined,
  tokens: number | undefined,
): boolean {
  if (!rule.enabled || cacheUntil === undefined || cacheUntil > at) return false;
  return rule.aboveTokens === 0 || (tokens ?? 0) > rule.aboveTokens;
}

/** Whose name a chat or terminal session has: the user's (Rename…) or the harness's; unset, its first message titles it. */
export type TitleBy = 'user' | 'harness';

/** A message box's unsent message and files. */
export interface ChatDraft {
  text: string;
  attachments: Attachment[];
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  /** Claude: already written to the agent, which reads it with its next tool result; it can't be edited any more. */
  sent?: boolean;
  /** Interactive: the mod handed it to the agent, and it shows here until the conversation has it. */
  delivered?: boolean;
}

/** What a chat's run folder records about it (chat.json): Continue in Chat opens the chat again from it. */
export interface ChatInfo {
  /** The harness the chat ran on, from the task's environment; unset: the task's own. */
  harnessId?: string;
  harnessKind: 'claude-code' | 'codex';
  /** The chat's name (`titleBy`), else the first line of its first message. */
  title: string;
  /** Whose name `title` is; a harness's name never replaces the user's. */
  titleBy?: TitleBy;
  /** Continue When Limit Resets. */
  autoContinue?: boolean;
  /** Mute Notifications. */
  muted?: boolean;
  /** Continue Anyway. */
  continueAnyway?: boolean;
  /** The last turn failed on the usage limit: Looper's next start goes on waiting for the reset. */
  limit?: UsageLimitHit;
  settings: ChatSettings;
  context?: ChatContext;
  /** Continue in Chat on a run: the run whose conversation the chat went on with. */
  fromRunId?: string;
  /** Fork from Here: the chat it was forked from. */
  forkedFrom?: string;
  /** Compact into New Chat or Continue Compacted: the run it was compacted from. */
  compactedFrom?: string;
  /** Continue in Chat on a conversation from outside Looper (the History window): the Claude Code session or Codex thread it went on with. */
  resumedSession?: string;
  /** The conversation is in Claude Code's Code Mode (ChatState.codeMode). */
  codeMode?: boolean;
  /** Watch Task Events and looper-watch: what the chat watches. */
  watches?: TaskWatch[];
  /** Codex: its thread has Looper's instructions, because the chat started it with them or a message took them there. */
  codexInstructed?: boolean;
}

/**
 * What a terminal session's run folder records about it (terminal.json): a
 * Looper or system terminal window on the task's harness becomes a run once
 * its conversation has a finished turn.
 */
export interface TerminalInfo {
  harnessKind: 'claude-code' | 'codex';
  /** The session's name (`titleBy`), else the first line of the conversation's first message. */
  title: string;
  /** Whose name `title` is; a harness's name never replaces the user's. */
  titleBy?: TitleBy;
  /** Continue in Terminal on a run: the run whose conversation the session went on with. */
  fromRunId?: string;
}

/**
 * Where Fork from Here cuts the conversation `rows` (a chat's history and
 * rows, in order) at the row at `index`. `at` is the message the new chat's
 * conversation ends with, unset when it starts empty; `keep` is how many rows
 * it shows; `draft` is the user's own message, which goes back into the
 * message box. Claude forks at any of its messages (by the message's
 * transcript id). Codex forks only at the end of a turn, so only an agent
 * message no other one follows within its turn qualifies, and not while the
 * turn is still running. Null when the row can't be forked from.
 */
export function forkPoint(
  rows: MessageRow[],
  index: number,
  harnessKind: 'claude-code' | 'codex',
  working: boolean,
): { at?: MessageRow; keep: number; draft?: MessageRow } | null {
  const row = rows[index];
  if (!row) return null;
  const forkable = (i: number): boolean => {
    const r = rows[i];
    if (r.kind !== 'agent' || r.source === 'classifier') return false;
    if (harnessKind === 'claude-code') return !!r.uuid;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].kind === 'prompt') return true;
      if (rows[j].kind === 'agent') return false;
    }
    return !working;
  };
  if (row.kind === 'agent') return forkable(index) ? { at: row, keep: index + 1 } : null;
  if (row.kind !== 'prompt') return null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].kind !== 'agent' || rows[i].source === 'classifier') continue;
    // The last agent message before the user's: the conversation the message was sent into.
    return forkable(i) ? { at: rows[i], keep: i + 1, draft: row } : null;
  }
  return { keep: 0, draft: row };
}

/**
 * The usage limits in Claude's rate_limit_event record: its unifiedWindows
 * give each window's used share and reset time (in seconds). Null when the
 * record has neither window.
 */
export function usageLimitsOf(rec: Record<string, unknown>): UsageLimits | null {
  const info = rec.rate_limit_info as Record<string, unknown> | undefined;
  const windows = info?.unifiedWindows as Record<string, Record<string, unknown> | undefined> | undefined;
  const take = (w: Record<string, unknown> | undefined) =>
    typeof w?.utilization === 'number' && typeof w.resetsAt === 'number' ? { used: w.utilization, resetsAt: w.resetsAt * 1000 } : undefined;
  const fiveHour = take(windows?.five_hour);
  const sevenDay = take(windows?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** Claude's command list (an initialize answer or a commands_changed record) as the "/" list. */
export function slashCommandsOf(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const c of list as Record<string, unknown>[]) {
    if (typeof c?.name !== 'string' || !c.name) continue;
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      ...(typeof c.argumentHint === 'string' && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    });
  }
  return out;
}

/** 950 → "950", 42_310 → "42k", 1_000_000 → "1M", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/** "42k of 1M context (4%)", or "42k context" before the window is known. */
export function contextText(c: ChatContext): string {
  if (!c.window) return `${formatTokens(c.tokens)} context`;
  return `${formatTokens(c.tokens)} of ${formatTokens(c.window)} context (${Math.round((c.tokens / c.window) * 100)}%)`;
}

/** A chat's whole conversation: the history it went on from, then its own rows. */
export function chatRows(chat: Pick<ChatState, 'history' | 'rows'>): MessageRow[] {
  return [...chat.history, ...chat.rows];
}

/** Whether nothing has been said in the chat yet: no user or agent message in its history or rows, and none queued. */
export function chatIsEmpty(chat: Pick<ChatState, 'history' | 'rows' | 'queued'>): boolean {
  const said = (r: MessageRow) => r.kind === 'prompt' || r.kind === 'guidance' || r.kind === 'agent';
  return chat.queued.length === 0 && !chat.history.some(said) && !chat.rows.some(said);
}

/** Whether Compact into New Chat can start from the chat: the agent has replied, and isn't working or waiting on a permission answer. */
export function chatCanCompact(chat: Pick<ChatState, 'history' | 'rows' | 'status' | 'permissions'>): boolean {
  if (chat.status === 'working' || chat.permissions.length > 0) return false;
  const replied = (r: MessageRow) => r.kind === 'agent' && !r.note && r.source !== 'classifier';
  return chat.history.some(replied) || chat.rows.some(replied);
}

/** A chat's title: the first line of its first message, without Markdown markers. */
export function chatTitle(rows: MessageRow[]): string {
  const first = rows.find((r) => r.kind === 'prompt');
  const text = first?.text ?? '';
  const line = stripMarkdown(text.trim().split('\n')[0] ?? '').trim();
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return first?.attachments?.length ? first.attachments.map((a) => a.name).join(', ') : 'Untitled chat';
}
