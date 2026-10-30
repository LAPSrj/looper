import fs from 'node:fs';
import path from 'node:path';
import { chatTitle, type ChatContext, type ChatState } from '../shared/chat';
import type { MessageRow, MessagesResult } from '../shared/messages';
import { stripMarkdown } from '../shared/messages-md';
import { projectIdOf } from '../shared/projects';
import type {
  BackgroundTask,
  SessionActivity,
  SessionSummary,
  SessionsState,
  SubagentInfo,
  UsageLimits,
  WaitReason,
} from '../shared/sessions';
import type { EngineEvent, Project, Task } from '../shared/types';
import type { SubagentStats } from './context';
import type { Logger } from './log';
import type { SubagentMeta } from './messages';

const POLL_MS = 1000;
/** Transcripts are read every this many polls; a session's context size every CONTEXT_POLLS. */
const READ_POLLS = 2;
const CONTEXT_POLLS = 10;

export interface TerminalEntry {
  id: string;
  taskId: string;
  startedAt: number;
  ended: boolean;
}

export interface SessionHubDeps {
  chats: () => ChatState[];
  /** Terminal sessions shown in the Sessions window (Remote Control's aren't). */
  terminals: () => TerminalEntry[];
  findTask: (taskId: string) => Task | undefined;
  projects: () => Project[];
  harnessOf: (task: Task) => { kind: 'claude-code' | 'codex' | 'custom'; name: string };
  runDir: (taskId: string, runId: string) => string;
  readRows: (taskId: string, runId: string) => Promise<MessagesResult>;
  subagents: (taskId: string, runId: string) => Promise<SubagentMeta[]>;
  /** A subagent's model, effort and context from its transcript; null before its first response. */
  subagentStats: (taskId: string, runId: string, agentId: string) => Promise<SubagentStats | null>;
  contextTokens: (taskId: string, runId: string) => Promise<number | null>;
  /** Claude: the last request's time and how long the cache it wrote lasts, from the transcript. */
  cacheUse: (taskId: string, runId: string) => Promise<{ at?: number; ttlMs?: number }>;
  /** A terminal session's title, once its first turn made it a run. */
  terminalTitle: (taskId: string, runId: string) => string | undefined;
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
  hooks: Record<'prompt' | 'stop' | 'notification', HookFile | null>;
  rows: MessageRow[];
  subagentMetas: SubagentMeta[];
  /** What each subagent's transcript says, read while the window shows the session; a finished one's isn't read again. */
  subagentStats: Map<string, SubagentStats>;
  context?: ChatContext;
  reading: boolean;
  /** When the current permission request, and the session's end, were first seen. */
  permissionAt?: number;
  endedAt?: number;
  /** When Stop sent a terminal session Esc: its turn is over though no Stop hook says so. */
  stoppedAt?: number;
  cache?: { at?: number; ttlMs?: number };
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

/** What a session's latest rows say it's doing: the tool it's using while it works, else its last message. */
export function latestLine(rows: MessageRow[], working: boolean): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'tool' && working) return `${r.tool ?? 'Tool'} ${r.preview}`.trim();
    if (r.kind === 'agent') return oneLine(r.text);
    if (r.kind === 'prompt' && !working) return undefined;
  }
  return undefined;
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
    if (r.kind !== 'agent') continue;
    const text = stripMarkdown(r.text.trim());
    if (!text) continue;
    out.unshift(text.length > left ? `…${text.slice(text.length - left)}` : text);
    left -= text.length;
  }
  return out;
}

/** The background commands and subagents a conversation's rows started, newest first. */
export function backgroundOf(rows: MessageRow[]): BackgroundTask[] {
  const out: BackgroundTask[] = [];
  for (const r of rows) {
    if (!r.background) continue;
    const input = (r.input ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const agent = r.tool === 'Agent' || r.tool === 'Task';
    out.push({
      id: r.background.id,
      kind: agent ? 'agent' : 'command',
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
 * result, or by its background notification. `stats` adds what its
 * transcript says about its model, effort and context.
 */
export function subagentsOf(metas: SubagentMeta[], rows: MessageRow[], stats?: Map<string, SubagentStats>): SubagentInfo[] {
  return metas.map((m) => {
    const row = rows.find((r) => r.agentId === m.agentId || r.background?.id === m.agentId);
    let status: SubagentInfo['status'] = 'running';
    if (row?.background) status = row.background.status === 'running' ? 'running' : row.background.status === 'completed' ? 'done' : 'failed';
    else if (row?.result !== undefined) status = row.resultError ? 'failed' : 'done';
    const s = stats?.get(m.agentId);
    return {
      agentId: m.agentId,
      toolUseId: m.toolUseId,
      type: m.type,
      description: m.description,
      ...(m.model ? { model: m.model } : {}),
      background: m.background,
      status,
      ...(s?.model ? { modelId: s.model } : {}),
      ...(s?.effort ? { effort: s.effort } : {}),
      ...(s ? { contextTokens: s.tokens } : {}),
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

/** The last reply's time and, with Claude, until when its prompt cache lasts. */
function replyTimes(cache: Track['cache'], fallback: number | undefined): { lastReplyAt?: number; cacheUntil?: number } {
  const at = cache?.at ?? fallback;
  return {
    ...(at !== undefined ? { lastReplyAt: at } : {}),
    ...(cache?.at !== undefined && cache.ttlMs !== undefined ? { cacheUntil: cache.at + cache.ttlMs } : {}),
  };
}

/** What a permission request asks, in words. */
function permissionText(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return 'Wants to run a command';
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'Wants to change a file';
  return `Wants to use ${tool}`;
}

/**
 * The Sessions window's model: every open chat and Looper terminal session as
 * a list row (status, why it waits for the user, its latest line, context),
 * and for the session the window shows, its background work and subagents.
 * Chats report their state themselves; terminal sessions are read from the
 * files their hooks write and from their transcripts.
 */
export class SessionHub {
  private readonly tracks = new Map<string, Track>();
  private limits: UsageLimits = {};
  private watched: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private polls = 0;
  private lastSent = '';
  private lastActivity = '';

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

  /** A chat changed, or a session opened or closed: the list follows shortly. */
  changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitState();
    }, 150);
  }

  setLimits(limits: UsageLimits): void {
    this.limits = { ...this.limits, ...limits };
    this.changed();
  }

  /** The user looked at the session: a finished turn or a notification stops waiting. */
  seen(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.seenAt = this.now();
    this.changed();
  }

  /** Stop sent a terminal session Esc: the agent's turn is over. */
  stopped(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.stoppedAt = this.now();
    this.changed();
  }

  /** The session the Sessions window shows: its activity is read and sent. Null when it shows none. */
  watch(id: string | null): void {
    this.watched = id;
    this.lastActivity = '';
    if (id) void this.readSession(id, true);
  }

  state(): SessionsState {
    return { sessions: this.summaries(), limits: this.limits };
  }

  /** The watched session's activity as it stands. */
  activity(id: string): SessionActivity | null {
    const t = this.tracks.get(id);
    const entry = this.entries().find((e) => e.id === id);
    if (!t || !entry) return null;
    return {
      id,
      ...(entry.kind === 'terminal' ? { rows: t.rows } : {}),
      background: backgroundOf(t.rows),
      subagents: subagentsOf(t.subagentMetas, t.rows, t.subagentStats),
    };
  }

  /** A background command's output file, in the session's own path form. */
  backgroundFile(id: string, taskId: string): string | undefined {
    const t = this.tracks.get(id);
    return t ? backgroundOf(t.rows).find((b) => b.id === taskId)?.outputFile : undefined;
  }

  private entries(): ({ kind: 'chat'; chat: ChatState; id: string; taskId: string; startedAt: number } | ({ kind: 'terminal' } & TerminalEntry))[] {
    return [
      ...this.d.chats().map((chat) => ({ kind: 'chat' as const, chat, id: chat.id, taskId: chat.taskId, startedAt: chat.startedAt })),
      ...this.d.terminals().map((t) => ({ kind: 'terminal' as const, ...t })),
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
    const task = this.d.findTask(e.taskId);
    const kind = task ? this.d.harnessOf(task).kind : 'custom';
    if (kind === 'custom') return;
    t.reading = true;
    try {
      const r = await this.d.readRows(e.taskId, e.id);
      if (r.status === 'ok') t.rows = r.rows.filter((row) => row.kind !== 'raw');
      if (kind === 'claude-code') t.subagentMetas = await this.d.subagents(e.taskId, e.id);
      if (kind === 'claude-code' && (force || this.watched === id)) {
        for (const a of subagentsOf(t.subagentMetas, t.rows)) {
          if (a.status !== 'running' && t.subagentStats.has(a.agentId)) continue;
          const stats = await this.d.subagentStats(e.taskId, e.id, a.agentId);
          if (stats) t.subagentStats.set(a.agentId, stats);
        }
      }
      const now = force || this.watched === id || this.polls % CONTEXT_POLLS === 0;
      if (kind === 'claude-code' && now) t.cache = await this.d.cacheUse(e.taskId, e.id);
      if (e.kind === 'terminal' && (force || this.polls % CONTEXT_POLLS === 0)) {
        const tokens = await this.d.contextTokens(e.taskId, e.id);
        t.context = tokens === null ? undefined : { tokens, window: t.context?.window };
      }
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
    if (!this.watched) return;
    const activity = this.activity(this.watched);
    if (!activity) return;
    const aKey = JSON.stringify([activity.id, activity.rows?.length, activity.rows?.at(-1), activity.background, activity.subagents]);
    if (aKey === this.lastActivity) return;
    this.lastActivity = aKey;
    this.d.emit({ type: 'session:activity', activity });
  }

  private summaries(): SessionSummary[] {
    const projects = this.d.projects();
    const order = new Map(projects.map((p, i) => [p.id, i]));
    const out = this.entries().map((e) => (e.kind === 'chat' ? this.chatSummary(e.chat, projects) : this.terminalSummary(e, projects)));
    const rank = (s: SessionSummary) => (s.projectId !== undefined ? (order.get(s.projectId) ?? projects.length) : projects.length);
    return out.sort((a, b) => rank(a) - rank(b) || a.groupName.localeCompare(b.groupName) || a.startedAt - b.startedAt);
  }

  private place(taskId: string, projects: Project[]): { task?: Task; projectId?: string; groupName: string } {
    const task = this.d.findTask(taskId);
    const projectId = projectIdOf(taskId) ?? task?.projectId;
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    return { task, projectId: project?.id, groupName: project?.name ?? task?.name ?? taskId };
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
    const rows = [...c.history, ...c.rows];
    const recent = recentMessages(rows);
    const working = c.status === 'working';
    t.permissionAt = c.permissions.length > 0 ? (t.permissionAt ?? this.now()) : undefined;
    if (c.status === 'ended') t.endedAt ??= this.now();
    let waiting: SessionSummary['waiting'];
    if (c.permissions.length > 0) waiting = { reason: 'permission', text: permissionText(c.permissions[0].tool), since: t.permissionAt! };
    else if (c.status === 'ended') {
      if (t.endedAt! > t.seenAt) waiting = { reason: 'error', text: oneLine(c.error ?? 'The session ended.'), since: t.endedAt! };
    } else waiting = this.notification(t, 0);
    if (!waiting && c.status === 'ready' && c.turnEndedAt !== undefined && c.turnEndedAt > t.seenAt) {
      waiting = { reason: 'turn', text: 'Finished its turn', since: c.turnEndedAt };
    }
    const background = backgroundOf(t.rows).filter((b) => b.status === 'running').length;
    return {
      id: c.id,
      kind: 'chat',
      taskId: c.taskId,
      ...(projectId ? { projectId } : {}),
      groupName,
      title: rows.some((r) => r.kind === 'prompt') ? chatTitle(rows) : 'New chat',
      harnessKind: c.harnessKind,
      harnessName: c.harnessName,
      status: c.status,
      ...(waiting ? { waiting } : {}),
      ...(c.permissions.length > 0 ? { permissionId: c.permissions[0].id } : {}),
      ...((latestLine(c.rows, working) ?? latestLine(c.history, false)) ? { latest: latestLine(c.rows, working) ?? latestLine(c.history, false) } : {}),
      ...(recent.length ? { recent } : {}),
      ...(c.context ? { context: c.context } : {}),
      startedAt: c.startedAt,
      background,
      ...replyTimes(t.cache, c.turnEndedAt),
    };
  }

  private terminalSummary(e: TerminalEntry, projects: Project[]): SessionSummary {
    const t = this.track(e.id, e.startedAt);
    const { task, projectId, groupName } = this.place(e.taskId, projects);
    const harness = task ? this.d.harnessOf(task) : { kind: 'custom' as const, name: 'Terminal' };
    const prompt = t.hooks.prompt?.at ?? 0;
    const stopHook = t.hooks.stop && !isTitleThread(t.hooks.stop.payload) && t.hooks.stop.at > e.startedAt ? t.hooks.stop : null;
    const stop = stopHook?.at ?? 0;
    // A turn the user stopped (Looper's Stop, or Esc in the terminal) gets no Stop hook.
    const turnOver = Math.max(stop, t.stoppedAt ?? 0, interruptedAt(t.rows));
    const status: SessionSummary['status'] = e.ended ? 'ended' : harness.kind === 'claude-code' && prompt > turnOver ? 'working' : 'ready';
    if (e.ended) t.endedAt ??= this.now();
    let waiting: SessionSummary['waiting'];
    if (e.ended) {
      if (t.endedAt! > t.seenAt) waiting = { reason: 'error', text: 'The session ended.', since: t.endedAt! };
    } else waiting = this.notification(t, Math.max(prompt, stop));
    if (!waiting && status === 'ready' && stop > t.seenAt) waiting = { reason: 'turn', text: 'Finished its turn', since: stop };
    const lastMessage = stopHook?.payload?.last_assistant_message ?? stopHook?.payload?.['last-assistant-message'];
    const latest = status === 'working' ? latestLine(t.rows, true) : typeof lastMessage === 'string' ? oneLine(lastMessage) : latestLine(t.rows, false);
    const recent = recentMessages(t.rows);
    const title = this.d.terminalTitle(e.taskId, e.id) ?? (t.rows.some((r) => r.kind === 'prompt') ? chatTitle(t.rows) : 'Terminal');
    return {
      id: e.id,
      kind: 'terminal',
      taskId: e.taskId,
      ...(projectId ? { projectId } : {}),
      groupName,
      title,
      harnessKind: harness.kind,
      harnessName: harness.name,
      status,
      ...(waiting ? { waiting } : {}),
      ...(latest ? { latest } : {}),
      ...(recent.length ? { recent } : {}),
      ...(t.context ? { context: t.context } : {}),
      startedAt: e.startedAt,
      background: backgroundOf(t.rows).filter((b) => b.status === 'running').length,
      ...replyTimes(t.cache, stopHook?.at),
    };
  }
}
