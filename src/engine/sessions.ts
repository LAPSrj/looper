import fs from 'node:fs';
import path from 'node:path';
import { chatRows, chatTitle, type ChatContext, type ChatState, type TitleBy, type UsageLimitHit } from '../shared/chat';
import type { MessageRow, MessagesResult } from '../shared/messages';
import { stripMarkdown } from '../shared/messages-md';
import { bareId } from '../shared/model-update';
import { projectIdOf, sameFolder } from '../shared/projects';
import {
  limitsKey,
  permissionText,
  type BackgroundTask,
  type RunAgent,
  type RunPermission,
  type SessionActivity,
  type SlashCommand,
  type SessionSummary,
  type SessionsState,
  type SubagentInfo,
  type UsageLimits,
  type WaitReason,
} from '../shared/sessions';
import type { EngineEvent, HarnessModel, Project, Task } from '../shared/types';
import type { SubagentStats } from './context';
import type { Logger } from './log';
import type { SubagentMeta } from './messages';
import { USAGE_LIMIT_RE, usageLimitReset } from './steps/session';
import type { WorkflowRun } from '../shared/workflows';
import { workflowLaunchesOf, type WorkflowLaunch } from './workflows';
import { modelWindows } from './model-windows';

const POLL_MS = 1000;
/** Transcripts are read every this many polls; a session's context size every CONTEXT_POLLS. */
const READ_POLLS = 2;
const CONTEXT_POLLS = 10;

export interface TerminalEntry {
  id: string;
  taskId: string;
  startedAt: number;
  ended: boolean;
  /** Quitting Looper stopped its harness: it's ready for the key that starts it again. */
  stopped?: boolean;
  /** It runs a command instead of a harness (an addon's): the title it's listed as. */
  command?: string;
}

/** A task run whose agent step is in flight: the Chats window lists it while Show Task Runs is on, and a delegated agent's always. */
export interface RunEntry {
  /** The run id. */
  id: string;
  taskId: string;
  startedAt: number;
  /** The agent finished a turn without signalling done, and the task holds for the user. */
  held: boolean;
  /** The question the agent asked with looper-ask, while it waits for the answer. */
  question: string | null;
  /** The tool call the agent waits for the user to allow. */
  permission?: RunPermission;
  /** The agent isn't in a turn: its next guidance starts one (Scheduler.turnOver). */
  turnOver?: boolean;
  /** A delegated agent's run (looper-delegate): the title its parent gave it, and the task it runs as in its own folder. */
  delegate?: { title: string; task: Task };
}

export interface SessionHubDeps {
  chats: () => ChatState[];
  /** Terminal sessions shown in the Chats window (Remote Control's aren't). */
  terminals: () => TerminalEntry[];
  /** Task runs whose agent is running (only delegated agents' while Show Task Runs is off). */
  runs: () => RunEntry[];
  findTask: (taskId: string) => Task | undefined;
  projects: () => Project[];
  harnessOf: (task: Task) => { kind: 'claude-code' | 'codex' | 'custom'; name: string; limitsKey?: string; models?: HarnessModel[] };
  runDir: (taskId: string, runId: string) => string;
  readRows: (taskId: string, runId: string) => Promise<MessagesResult>;
  subagents: (taskId: string, runId: string) => Promise<SubagentMeta[]>;
  /** A subagent's model, effort and context from its transcript; null before its first response. */
  subagentStats: (taskId: string, runId: string, agentId: string) => Promise<SubagentStats | null>;
  /** The session's workflow runs; `detail` reads their running agents' transcripts too. */
  workflows: (
    taskId: string,
    runId: string,
    opts: { launches?: WorkflowLaunch[]; detail?: boolean; sessionEnded?: boolean },
  ) => Promise<WorkflowRun[]>;
  contextTokens: (taskId: string, runId: string) => Promise<number | null>;
  /** Claude: the model the session's newest response came from, whose window (modelWindows) sizes its context. */
  contextModel?: (taskId: string, runId: string) => Promise<string | null>;
  /** The last request's time and how long its cache lasts, from the transcript. */
  cacheUse: (taskId: string, runId: string) => Promise<{ at?: number; ttlMs?: number }>;
  /** A terminal session's title and whose name it is, once its first turn made it a run. */
  terminalTitle: (taskId: string, runId: string) => { title: string; titleBy?: TitleBy } | undefined;
  /** The harness's name for a terminal session's conversation (Claude Code's custom-title or ai-title, a Codex thread name). */
  sessionName?: (taskId: string, runId: string) => Promise<string | undefined>;
  emit: (e: EngineEvent) => void;
  log: Logger;
  pollMs?: number;
  now?: () => number;
}

/** A hook file's time and its payload, read again only when the time changes. */
interface HookFile {
  at: number;
  payload: Record<string, unknown> | null;
}

interface Track {
  /** When the user last looked at the session. */
  seenAt: number;
  /** When the user marked the session unread: it waits as a finished turn until they open it again (seen). */
  unreadAt?: number;
  hooks: Record<'prompt' | 'stop' | 'notification', HookFile | null>;
  rows: MessageRow[];
  /** A task run's guidance its agent hasn't picked up yet. */
  pendingGuidance?: string;
  /** A task run's skills, from its transcript. */
  commands?: SlashCommand[];
  /** Claude: the model the session's newest response came from. */
  activeModel?: string;
  subagentMetas: SubagentMeta[];
  /** What each subagent's transcript says, read while the window shows the session; a finished one's isn't read again. */
  subagentStats: Map<string, SubagentStats>;
  /** How background tasks ended that the transcript has no row for: subagents a subagent started. */
  ended?: NonNullable<MessagesResult['ended']>;
  workflows: WorkflowRun[];
  context?: ChatContext;
  reading: boolean;
  /** When the current permission request, and the session's end, were first seen. */
  permissionAt?: number;
  endedAt?: number;
  /** When Stop sent a terminal session Esc: its turn is over though no Stop hook says so. */
  stoppedAt?: number;
  cache?: { at?: number; ttlMs?: number };
  /** A terminal session's name in its harness, read with its transcript. */
  harnessTitle?: string;
}

const HOOK_FILES = { prompt: 'prompt.json', stop: 'stop.json', notification: 'notification.json' } as const;

/** codex's TUI names the session in a side thread; its notify isn't a turn of the user's. */
const isTitleThread = (payload: Record<string, unknown> | null): boolean => {
  const inputs = payload?.['input-messages'];
  return Array.isArray(inputs) && typeof inputs[0] === 'string' && inputs[0].startsWith('Generate a concise, single-line task title');
};

/** The first line of a message, as plain text, for the list. */
function oneLine(text: string): string {
  const line = stripMarkdown(text.trim().split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** A list row's preview: the agent's latest text message (or API error) since the user's last one, never a tool call or its result. */
export function latestLine(rows: MessageRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'prompt') return undefined;
    if ((r.kind === 'agent' || r.kind === 'error') && r.text.trim()) return oneLine(r.text);
  }
  return undefined;
}

/** The API error (usage limit, overloaded…) the conversation ended its latest turn on, with when it came; undefined once the user has written again or the agent has said more. */
export function endingError(rows: MessageRow[]): { text: string; at?: number } | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'prompt' || r.kind === 'agent') return undefined;
    if (r.kind === 'error' && r.text.trim()) {
      const at = r.ts ? Date.parse(r.ts) : NaN;
      return { text: oneLine(r.text), ...(Number.isFinite(at) ? { at } : {}) };
    }
  }
  return undefined;
}

/** An error that is the usage limit: Claude's "You've hit your session limit · resets 5:50am", Codex's "You've hit your usage limit…". */
const LIMIT_ERROR_RE = new RegExp(`${USAGE_LIMIT_RE.source}|usage limit`, 'i');

/**
 * The usage limit the conversation's latest turn ended on: when it was hit,
 * and when the error says it resets. Undefined when the turn didn't end on
 * the limit, or once the user has written again or the agent has said more.
 */
export function usageLimitOf(rows: MessageRow[], now: number): UsageLimitHit | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'prompt' || r.kind === 'agent') return undefined;
    if (r.kind !== 'error' || !r.text.trim()) continue;
    if (!LIMIT_ERROR_RE.test(r.text)) return undefined;
    const ts = r.ts ? Date.parse(r.ts) : NaN;
    const at = Number.isFinite(ts) ? ts : now;
    const resetsAt = usageLimitReset(r.text, at);
    return { at, ...(resetsAt !== null ? { resetsAt } : {}) };
  }
  return undefined;
}

/**
 * A summary's limit state: while the limit holds (until it resets, or with
 * no reset time until the next message), then `restored` until the user looks
 * at the session after the reset (`seenAt`). Undefined after that.
 */
export function limitState(limit: UsageLimitHit | undefined, now: number, seenAt: number): SessionSummary['limit'] {
  if (!limit) return undefined;
  if (limit.resetsAt === undefined || now < limit.resetsAt) return limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt };
  return seenAt < limit.resetsAt ? { resetsAt: limit.resetsAt, restored: true } : undefined;
}

/** Most of the agent's recent messages a dashboard card gets: the newest ones, cut to this many characters in all. */
const RECENT_CHARS = 4000;

/** The agent's messages since the user's last one, as plain text, the newest last, cut to RECENT_CHARS from the newest back. */
export function recentMessages(rows: MessageRow[]): string[] {
  let from = rows.length;
  while (from > 0 && rows[from - 1].kind !== 'prompt') from--;
  const out: string[] = [];
  let left = RECENT_CHARS;
  for (let i = rows.length - 1; i >= from && left > 0; i--) {
    const r = rows[i];
    if (r.kind !== 'agent' && r.kind !== 'error') continue;
    const text = stripMarkdown(r.text.trim());
    if (!text) continue;
    out.unshift(text.length > left ? `…${text.slice(text.length - left)}` : text);
    left -= text.length;
  }
  return out;
}

/** The background commands, Monitors, subagents and workflows a conversation's rows (and its Code Mode scripts) started, newest first. */
export function backgroundOf(rows: MessageRow[]): BackgroundTask[] {
  const out: BackgroundTask[] = [];
  for (const r of rows.flatMap((row) => (row.started ? [row, ...row.started] : [row]))) {
    if (!r.background) continue;
    if (r.tool === 'Workflow') {
      const launch = workflowLaunchesOf([r])[0];
      out.push({
        id: r.background.id,
        kind: 'workflow',
        label: launch?.summary ?? 'Workflow',
        ...(launch ? { workflowRunId: launch.runId } : {}),
        status: r.background.status,
        ...(r.background.summary ? { summary: r.background.summary } : {}),
        ...(r.ts ? { startedAt: r.ts } : {}),
      });
      continue;
    }
    const input = (r.input ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const agent = r.tool === 'Agent' || r.tool === 'Task';
    out.push({
      id: r.background.id,
      kind: agent ? 'agent' : r.tool === 'Monitor' ? 'monitor' : 'command',
      label: str(input.description) ?? str(input.command) ?? r.preview,
      ...(str(input.command) ? { command: str(input.command) } : {}),
      status: r.background.status,
      ...(r.background.summary ? { summary: r.background.summary } : {}),
      ...(r.ts ? { startedAt: r.ts } : {}),
      ...(r.background.outputFile ? { outputFile: r.background.outputFile } : {}),
    });
  }
  return out.reverse();
}

/**
 * Each subagent's status, from the Agent call's row: done once it has a
 * result, or by its background notification; and when that call was made. A
 * call a Code Mode script made is under its REPL row (`started`): it gives the
 * time, and a foreground one's result, while a background one's notification
 * (`ended`) says how it went, as it does for a subagent a subagent started.
 * `stats` adds what its transcript says about its model, effort and context,
 * and the context window of that model: the session's own (`windows`, a chat's
 * modelWindows), else one Looper has seen it run with (modelWindows).
 */
export function subagentsOf(
  metas: SubagentMeta[],
  rows: MessageRow[],
  stats?: Map<string, SubagentStats>,
  windows?: Record<string, number>,
  ended?: MessagesResult['ended'],
): SubagentInfo[] {
  const scripted = rows.flatMap((r) => r.started ?? []);
  return metas.map((m) => {
    const call = (rs: MessageRow[]) => rs.find((r) => r.toolUseId === m.toolUseId) ?? rs.find((r) => r.agentId === m.agentId || r.background?.id === m.agentId);
    const top = call(rows);
    const byScript = top ? undefined : call(scripted);
    const row = top ?? (byScript && !byScript.background ? byScript : undefined);
    const startedAt = (top ?? byScript)?.ts;
    let status: SubagentInfo['status'] = 'running';
    if (row?.background) status = row.background.status === 'running' ? 'running' : row.background.status === 'completed' ? 'done' : 'failed';
    else if (row?.result !== undefined) status = row.resultError ? 'failed' : 'done';
    else if (!row && ended?.[m.agentId]) {
      // A subagent a subagent started: its Agent call is in that subagent's transcript, and this one has only its notification.
      const how = ended[m.agentId];
      status = how === 'running' ? 'running' : how === 'completed' ? 'done' : 'failed';
    } else if (!row?.background && !ended?.[m.agentId] && (m.finished || stats?.get(m.agentId)?.stopped)) {
      // Nothing else says how it went, but Claude Code's meta file says it finished, or its own transcript ends on a
      // finished turn: it stopped (agents asked for by a Code Mode script or another subagent, or started before a
      // compaction, have no result row, or one that never came).
      status = 'done';
    }
    const s = stats?.get(m.agentId);
    const window = s?.model ? (windows?.[bareId(s.model)] ?? modelWindows.pick(s.model, s.tokens)) : undefined;
    return {
      agentId: m.agentId,
      toolUseId: m.toolUseId,
      type: m.type,
      description: m.description,
      ...(m.model ? { model: m.model } : {}),
      status,
      ...(startedAt ? { startedAt } : {}),
      ...(s?.model ? { modelId: s.model } : {}),
      ...(s?.effort ? { effort: s.effort } : {}),
      ...(s ? { contextTokens: s.tokens } : {}),
      ...(window ? { contextWindow: window } : {}),
    };
  });
}

/** When the user last interrupted the agent (Esc), from the "[Request interrupted by user…]" message Claude records; 0 for never. */
export function interruptedAt(rows: MessageRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'prompt' && r.text.startsWith('[Request interrupted by user')) return r.ts ? Date.parse(r.ts) || 0 : 0;
  }
  return 0;
}

/** The last reply's time and until when its prompt cache lasts. */
function replyTimes(cache: Track['cache'], fallback: number | undefined): { lastReplyAt?: number; cacheUntil?: number } {
  const at = cache?.at ?? fallback;
  return {
    ...(at !== undefined ? { lastReplyAt: at } : {}),
    ...(cache?.at !== undefined && cache.ttlMs !== undefined ? { cacheUntil: cache.at + cache.ttlMs } : {}),
  };
}

/**
 * The Chats window's model: every open chat and Looper terminal session (and
 * each delegated agent's run, and with Show Task Runs on every task run's
 * agent) as a list row (status, why it
 * waits for the user, its latest line, context), and for the session the
 * window shows, its background work and subagents. Chats report their state
 * themselves; terminal sessions are read from the files their hooks write and
 * from their transcripts; task runs from the scheduler and their transcripts.
 */
export class SessionHub {
  private readonly tracks = new Map<string, Track>();
  private readonly limits: Record<string, UsageLimits> = {};
  private watched = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private polls = 0;
  private lastSent = '';
  private readonly lastActivity = new Map<string, string>();
  /** Group Chats By None's order, by session id: kept while Looper runs, never saved. */
  private order: string[] = [];

  constructor(private readonly d: SessionHubDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.d.pollMs ?? POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.timer = null;
    this.emitTimer = null;
  }

  /** Guidance went to a run or came back from it: its conversation and what waits are read again now, not at the next read. */
  reread(id: string): void {
    void this.readSession(id, true);
  }

  /** A chat changed, or a session opened or closed: the list follows shortly. */
  changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitState();
    }, 150);
  }

  setLimits(key: string, limits: UsageLimits): void {
    this.limits[key] = { ...this.limits[key], ...limits };
    this.changed();
  }

  /** The user looked at the session: a finished turn or a notification stops waiting. */
  seen(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.seenAt = Math.max(this.now(), t.unreadAt ?? 0);
    this.changed();
  }

  /** The user marked the session unread: it shows as a finished turn again until they open it. */
  markUnread(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.unreadAt = Math.max(this.now(), t.seenAt + 1);
    this.changed();
  }

  /** Stop sent a terminal session Esc, or a stopped one started again: the agent's turn is over. */
  stopped(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.stoppedAt = this.now();
    this.changed();
  }

  /** Sessions opened again at Looper's start: what they did before it quit isn't news (no turn or notification waits for you). */
  restored(ids: Iterable<string>): void {
    for (const id of ids) this.track(id, this.now());
    this.changed();
  }

  /** The sessions the Chats windows show (on any device): their activity is read and sent. */
  watch(ids: Iterable<string>): void {
    const next = new Set(ids);
    for (const id of next) {
      if (this.watched.has(id)) continue;
      this.lastActivity.delete(id);
      void this.readSession(id, true);
    }
    for (const id of this.watched) if (!next.has(id)) this.lastActivity.delete(id);
    this.watched = next;
  }

  /**
   * A chat compacted into `to`: the new chat takes its place in Group Chats
   * By None's order, and what the user has seen of it, as if it were the same chat.
   */
  moved(from: string, to: string): void {
    this.order = this.order.map((id) => (id === from ? to : id));
    const old = this.tracks.get(from);
    if (old) {
      const t = this.track(to, old.seenAt);
      t.seenAt = old.seenAt;
      if (old.unreadAt !== undefined) t.unreadAt = old.unreadAt;
    }
    this.changed();
  }

  /** The list's rows dragged into this order with Group Chats By None. */
  reorder(ids: string[]): void {
    this.order = [...new Set(ids)];
    this.changed();
  }

  state(): SessionsState {
    const sessions = this.summaries();
    // A closed session's id goes from the order.
    this.order = this.order.filter((id) => sessions.some((s) => s.id === id));
    return { sessions, limits: { ...this.limits }, order: [...this.order] };
  }

  /** The watched session's activity as it stands. */
  activity(id: string): SessionActivity | null {
    const t = this.tracks.get(id);
    const entry = this.entries().find((e) => e.id === id);
    if (!t || !entry) return null;
    const agent = entry.kind === 'run' ? this.runAgent(entry, t) : undefined;
    return {
      id,
      ...(entry.kind !== 'chat' ? { rows: t.rows } : {}),
      ...(t.pendingGuidance ? { pendingGuidance: t.pendingGuidance } : {}),
      ...(entry.kind !== 'chat' && t.commands?.length ? { commands: t.commands } : {}),
      ...(agent ? { agent } : {}),
      background: backgroundOf(t.rows),
      subagents: subagentsOf(t.subagentMetas, t.rows, t.subagentStats, entry.kind === 'chat' ? entry.chat.modelWindows : undefined, t.ended),
      workflows: t.workflows,
    };
  }

  /** A task run's agent as the task (a delegated agent's own) runs it; undefined on a custom harness. */
  private runAgent(e: RunEntry, t: Track): RunAgent | undefined {
    const task = e.delegate?.task ?? this.d.findTask(e.taskId);
    if (!task) return undefined;
    const h = this.d.harnessOf(task);
    if (h.kind === 'custom') return undefined;
    const a = task.agent;
    return {
      harnessName: h.name,
      harnessKind: h.kind,
      models: h.models ?? [],
      settings: { ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}), permissionMode: a.permissionMode ?? '', mode: a.mode },
      ...(t.activeModel ? { activeModel: t.activeModel } : {}),
      commandPrefix: h.kind === 'codex' ? '$' : '/',
    };
  }

  /** A terminal session's or task run's skills, from its transcript, without the rest of its activity. */
  commands(id: string): SlashCommand[] {
    return this.tracks.get(id)?.commands ?? [];
  }

  /** A background command's output file, in the session's own path form. */
  backgroundFile(id: string, taskId: string): string | undefined {
    const t = this.tracks.get(id);
    return t ? backgroundOf(t.rows).find((b) => b.id === taskId)?.outputFile : undefined;
  }

  /** A listed task run's task (a delegated agent's parent's); undefined when the list has no such run (Show Task Runs off, or the run is over). */
  runTask(id: string): string | undefined {
    return this.d.runs().find((r) => r.id === id)?.taskId;
  }

  private entries(): (
    | { kind: 'chat'; chat: ChatState; id: string; taskId: string; startedAt: number }
    | ({ kind: 'terminal' } & TerminalEntry)
    | ({ kind: 'run' } & RunEntry)
  )[] {
    return [
      ...this.d.chats().map((chat) => ({ kind: 'chat' as const, chat, id: chat.id, taskId: chat.taskId, startedAt: chat.startedAt })),
      ...this.d.terminals().map((t) => ({ kind: 'terminal' as const, ...t })),
      ...this.d.runs().map((r) => ({ kind: 'run' as const, ...r })),
    ];
  }

  private track(id: string, startedAt: number): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        seenAt: startedAt,
        hooks: { prompt: null, stop: null, notification: null },
        rows: [],
        subagentMetas: [],
        subagentStats: new Map(),
        workflows: [],
        reading: false,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** A hook file's time and payload, read again only when it changed. */
  private readHook(dir: string, kind: keyof typeof HOOK_FILES, prev: HookFile | null): HookFile | null {
    const file = path.join(dir, HOOK_FILES[kind]);
    let at: number;
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (prev && prev.at === at) return prev;
    try {
      return { at, payload: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, unknown> };
    } catch {
      return prev; // still being written
    }
  }

  private async poll(): Promise<void> {
    this.polls += 1;
    const entries = this.entries();
    const live = new Set(entries.map((e) => e.id));
    for (const id of [...this.tracks.keys()]) if (!live.has(id)) this.tracks.delete(id);
    for (const e of entries) {
      const t = this.track(e.id, e.startedAt);
      const dir = this.d.runDir(e.taskId, e.id);
      for (const k of Object.keys(HOOK_FILES) as (keyof typeof HOOK_FILES)[]) t.hooks[k] = this.readHook(dir, k, t.hooks[k]);
    }
    if (this.polls % READ_POLLS === 0) await Promise.all(entries.map((e) => this.readSession(e.id, false)));
    this.emitState();
  }

  /** Read a session's transcript (background work, subagents; a terminal's conversation) and, now and then, its context. */
  private async readSession(id: string, force: boolean): Promise<void> {
    const e = this.entries().find((x) => x.id === id);
    if (!e) return;
    const t = this.track(e.id, e.startedAt);
    if (t.reading) return;
    const task = (e.kind === 'run' ? e.delegate?.task : undefined) ?? this.d.findTask(e.taskId);
    const kind = task ? this.d.harnessOf(task).kind : 'custom';
    if (kind === 'custom') return;
    t.reading = true;
    try {
      const r = await this.d.readRows(e.taskId, e.id);
      if (r.status === 'ok') {
        t.rows = r.rows.filter((row) => row.kind !== 'raw');
        t.ended = r.ended;
      }
      t.pendingGuidance = e.kind === 'run' ? r.pendingGuidance : undefined;
      if (e.kind !== 'chat' && r.commands) t.commands = r.commands;
      if (kind === 'claude-code') t.subagentMetas = await this.d.subagents(e.taskId, e.id);
      if (kind === 'claude-code' && (force || this.watched.has(id))) {
        for (const a of subagentsOf(t.subagentMetas, t.rows, undefined, undefined, t.ended)) {
          if (a.status !== 'running' && t.subagentStats.has(a.agentId)) continue;
          const stats = await this.d.subagentStats(e.taskId, e.id, a.agentId);
          if (stats) t.subagentStats.set(a.agentId, stats);
        }
        // Only a session on screen shows its workflows, so only its runs are read.
        const sessionEnded = e.kind === 'chat' ? e.chat.status === 'ended' : e.kind === 'terminal' && (e.ended || !!e.stopped);
        t.workflows = await this.d.workflows(e.taskId, e.id, { launches: workflowLaunchesOf(t.rows), detail: true, sessionEnded });
      }
      const now = force || this.watched.has(id) || this.polls % CONTEXT_POLLS === 0;
      if (now) t.cache = await this.d.cacheUse(e.taskId, e.id);
      if (e.kind !== 'chat' && (force || this.polls % CONTEXT_POLLS === 0)) {
        const tokens = await this.d.contextTokens(e.taskId, e.id);
        const model = tokens !== null && kind === 'claude-code' ? await this.d.contextModel?.(e.taskId, e.id) : null;
        t.context = tokens === null ? undefined : { tokens, window: (model ? modelWindows.pick(model, tokens) : undefined) ?? t.context?.window };
        if (model) t.activeModel = model;
      }
      if (e.kind === 'terminal' && this.d.sessionName) t.harnessTitle = await this.d.sessionName(e.taskId, e.id);
    } catch (err) {
      this.d.log.warn(`sessions: cannot read ${id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      t.reading = false;
    }
    if (force) this.emitState();
  }

  private emitState(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key !== this.lastSent) {
      this.lastSent = key;
      this.d.emit({ type: 'sessions', state });
    }
    for (const id of this.watched) {
      const activity = this.activity(id);
      if (!activity) continue;
      const aKey = JSON.stringify([
        activity.rows?.length,
        activity.rows?.at(-1),
        activity.pendingGuidance,
        activity.commands?.length,
        activity.agent,
        activity.background,
        activity.subagents,
        activity.workflows,
      ]);
      if (aKey === this.lastActivity.get(id)) continue;
      this.lastActivity.set(id, aKey);
      this.d.emit({ type: 'session:activity', activity });
    }
  }

  private summaries(): SessionSummary[] {
    const projects = this.d.projects();
    const order = new Map(projects.map((p, i) => [p.id, i]));
    const out = this.entries().map((e) =>
      e.kind === 'chat' ? this.chatSummary(e.chat, projects) : e.kind === 'terminal' ? this.terminalSummary(e, projects) : this.runSummary(e, projects),
    );
    const rank = (s: SessionSummary) => (s.projectId !== undefined ? (order.get(s.projectId) ?? projects.length) : projects.length);
    return out.sort((a, b) => rank(a) - rank(b) || a.groupName.localeCompare(b.groupName) || a.startedAt - b.startedAt);
  }

  private place(taskId: string, projects: Project[]): { task?: Task; projectId?: string; groupName: string } {
    const task = this.d.findTask(taskId);
    const projectId = projectIdOf(taskId) ?? task?.projectId;
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    return { task, projectId: project?.id, groupName: project?.name ?? task?.name ?? taskId };
  }

  /** The group of what works in `folder`: its project's, else the folder's own, as a chat opened there with Other Folder… is. */
  private folderPlace(folder: string, projects: Project[]): { projectId?: string; groupName: string } {
    const project = projects.find((p) => sameFolder(p.cwd, folder));
    return project ? { projectId: project.id, groupName: project.name } : { groupName: folder };
  }

  /** A notification newer than both the user's last look and the agent's last turn. */
  private notification(t: Track, after: number): { reason: WaitReason; text: string; since: number } | undefined {
    const n = t.hooks.notification;
    if (!n || n.at <= Math.max(t.seenAt, after)) return undefined;
    const type = n.payload?.notification_type;
    const text = typeof n.payload?.message === 'string' ? oneLine(n.payload.message) : 'Notification';
    if (type === 'permission_prompt') return { reason: 'permission', text, since: n.at };
    if (type === 'push_notification') return { reason: 'notification', text, since: n.at };
    return undefined;
  }

  private chatSummary(c: ChatState, projects: Project[]): SessionSummary {
    const t = this.track(c.id, c.startedAt);
    const { projectId, groupName } = this.place(c.taskId, projects);
    const rows = chatRows(c);
    const recent = recentMessages(rows);
    const latest = latestLine(rows);
    t.permissionAt = c.permissions.length > 0 ? (t.permissionAt ?? this.now()) : undefined;
    if (c.status === 'ended') t.endedAt ??= this.now();
    let waiting: SessionSummary['waiting'];
    if (c.permissions.length > 0) waiting = { reason: 'permission', text: permissionText(c.permissions[0].tool), since: t.permissionAt! };
    else if (c.status === 'ended') {
      if (t.endedAt! > t.seenAt) waiting = { reason: 'error', text: oneLine(c.error ?? 'The session ended.'), since: t.endedAt! };
    } else waiting = this.notification(t, 0);
    // A turn that ended on an API error (usage limit…) failed: it isn't "Ready" news until the user has looked.
    const failure = c.status === 'ready' ? endingError(rows) : undefined;
    if (!waiting && failure) {
      const since = failure.at ?? c.turnEndedAt ?? c.startedAt;
      if (since > t.seenAt) waiting = { reason: 'error', text: failure.text, since };
    }
    if (!waiting && c.status === 'ready' && c.turnEndedAt !== undefined && c.turnEndedAt > t.seenAt) {
      waiting = { reason: 'turn', text: 'Finished its turn', since: c.turnEndedAt };
    }
    if (!waiting && c.status === 'ready' && t.unreadAt !== undefined && t.unreadAt > t.seenAt) {
      waiting = { reason: 'turn', text: 'Marked as unread', since: t.unreadAt, unread: true };
    }
    const background = backgroundOf(t.rows).filter((b) => b.status === 'running').length;
    const limit = c.status === 'ready' ? limitState(c.limit, this.now(), t.seenAt) : undefined;
    return {
      id: c.id,
      kind: 'chat',
      taskId: c.taskId,
      ...(projectId ? { projectId } : {}),
      groupName,
      title: c.title || (rows.some((r) => r.kind === 'prompt') ? chatTitle(rows) : 'New chat'),
      harnessKind: c.harnessKind,
      harnessName: c.harnessName,
      limitsKey: limitsKey(c.environmentId, c.harnessId),
      status: c.status,
      ...(waiting ? { waiting } : {}),
      ...(c.muted ? { muted: true } : {}),
      ...(c.permissions.length > 0 ? { permissionId: c.permissions[0].id } : {}),
      ...(latest ? { latest } : {}),
      ...(recent.length ? { recent } : {}),
      ...(c.context ? { context: c.context } : {}),
      startedAt: c.startedAt,
      background,
      ...replyTimes(t.cache, c.turnEndedAt),
      ...(limit ? { limit } : {}),
    };
  }

  private terminalSummary(e: TerminalEntry, projects: Project[]): SessionSummary {
    const t = this.track(e.id, e.startedAt);
    const { task, projectId, groupName } = this.place(e.taskId, projects);
    const harness = task && !e.command ? this.d.harnessOf(task) : { kind: 'custom' as const, name: 'Terminal' };
    const prompt = t.hooks.prompt?.at ?? 0;
    const stopHook = t.hooks.stop && !isTitleThread(t.hooks.stop.payload) && t.hooks.stop.at > e.startedAt ? t.hooks.stop : null;
    const stop = stopHook?.at ?? 0;
    // A turn the user stopped (Looper's Stop, or Esc in the terminal) gets no Stop hook.
    const turnOver = Math.max(stop, t.stoppedAt ?? 0, interruptedAt(t.rows));
    const status: SessionSummary['status'] = e.ended
      ? 'ended'
      : !e.stopped && harness.kind === 'claude-code' && prompt > turnOver
        ? 'working'
        : 'ready';
    if (e.ended) t.endedAt ??= this.now();
    let waiting: SessionSummary['waiting'];
    if (e.ended) {
      if (t.endedAt! > t.seenAt) waiting = { reason: 'error', text: 'The session ended.', since: t.endedAt! };
    } else waiting = this.notification(t, Math.max(prompt, stop));
    if (!waiting && status === 'ready' && stop > t.seenAt) waiting = { reason: 'turn', text: 'Finished its turn', since: stop };
    if (!waiting && status === 'ready' && t.unreadAt !== undefined && t.unreadAt > t.seenAt) waiting = { reason: 'turn', text: 'Marked as unread', since: t.unreadAt, unread: true };
    const lastMessage = stopHook?.payload?.last_assistant_message ?? stopHook?.payload?.['last-assistant-message'];
    const latest = status !== 'working' && typeof lastMessage === 'string' && lastMessage.trim() ? oneLine(lastMessage) : latestLine(t.rows);
    const recent = recentMessages(t.rows);
    // The user's name, then the harness's, then the one its first turn recorded, then its first message.
    const info = this.d.terminalTitle(e.taskId, e.id);
    const title =
      e.command ??
      (info?.titleBy === 'user' ? info.title : undefined) ??
      t.harnessTitle ??
      info?.title ??
      (t.rows.some((r) => r.kind === 'prompt') ? chatTitle(t.rows) : 'Terminal');
    const limit = status === 'ready' ? limitState(usageLimitOf(t.rows, this.now()), this.now(), t.seenAt) : undefined;
    return {
      id: e.id,
      kind: 'terminal',
      taskId: e.taskId,
      ...(projectId ? { projectId } : {}),
      groupName,
      title,
      harnessKind: harness.kind,
      harnessName: harness.name,
      ...(harness.limitsKey ? { limitsKey: harness.limitsKey } : {}),
      status,
      ...(e.stopped ? { stopped: true } : {}),
      ...(waiting ? { waiting } : {}),
      ...(latest ? { latest } : {}),
      ...(recent.length ? { recent } : {}),
      ...(t.context ? { context: t.context } : {}),
      startedAt: e.startedAt,
      background: backgroundOf(t.rows).filter((b) => b.status === 'running').length,
      ...replyTimes(t.cache, stopHook?.at),
      ...(limit ? { limit } : {}),
    };
  }

  /**
   * A task run's agent: working until its turn is over, it holds for the user or asks a question, which waits until the run goes on.
   * A delegated agent's is listed under the project or folder it works in, and its questions are its parent agent's to answer.
   */
  private runSummary(e: RunEntry, projects: Project[]): SessionSummary {
    const t = this.track(e.id, e.startedAt);
    const placed = this.place(e.taskId, projects);
    const { task } = placed;
    const own = e.delegate?.task ?? task;
    const { projectId, groupName } = e.delegate ? this.folderPlace(e.delegate.task.cwd, projects) : placed;
    const harness = own ? this.d.harnessOf(own) : { kind: 'custom' as const, name: 'Agent' };
    const asksUser = e.question !== null && !e.delegate;
    const waits = asksUser || e.held || !!e.permission;
    t.permissionAt = waits ? (t.permissionAt ?? this.now()) : undefined;
    const waiting: SessionSummary['waiting'] = e.permission
      ? { reason: 'permission', text: permissionText(e.permission.tool), since: t.permissionAt! }
      : waits
        ? { reason: 'notification', text: asksUser ? 'Waiting for your answer' : 'Waiting for you', since: t.permissionAt! }
        : undefined;
    const latest = latestLine(t.rows);
    const recent = recentMessages(t.rows);
    return {
      id: e.id,
      kind: 'run',
      taskId: e.taskId,
      ...(projectId ? { projectId } : {}),
      groupName,
      title: e.delegate?.title ?? task?.name ?? e.taskId,
      ...(e.delegate ? { startedBy: task?.name ?? e.taskId } : {}),
      harnessKind: harness.kind,
      harnessName: harness.name,
      ...(harness.limitsKey ? { limitsKey: harness.limitsKey } : {}),
      status: waits || e.turnOver ? 'ready' : 'working',
      ...(waiting ? { waiting } : {}),
      ...(e.question !== null ? { question: e.question } : {}),
      ...(e.permission ? { permission: e.permission } : {}),
      ...(latest ? { latest } : {}),
      ...(recent.length ? { recent } : {}),
      ...(t.context ? { context: t.context } : {}),
      startedAt: e.startedAt,
      background: backgroundOf(t.rows).filter((b) => b.status === 'running').length,
      ...replyTimes(t.cache, undefined),
    };
  }
}
