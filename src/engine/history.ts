import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chatTitle, type ChatInfo, type TerminalInfo } from '../shared/chat';
import { compactRows } from '../shared/compact';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { RECENT_CHATS, inFolderFilter, type HistoryConversation, type HistoryFolderFilter, type HistoryItem, type HistoryList, type HistoryListOptions, type HistoryRunFilter, type HistorySource } from '../shared/history';
import type { MessageRow } from '../shared/messages';
import { FOLDER_TASK_PREFIX, normalizeFolder, projectIdOf, projectTaskId, sameFolder } from '../shared/projects';
import { runShown, type RunSummary } from '../shared/runs';
import type { Environment, Harness, Project, Settings, Task } from '../shared/types';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { TranscriptReader, codexHomeOfRollout, codexThreadName, transcriptHostPath, type SubagentMeta, type TranscriptAccumulator } from './messages';
import { readSubagentStats, type SubagentStats } from './context';
import { subagentsOf } from './sessions';
import { writeJsonAtomicAsync } from './store/fsutil';

/** Each subagent's model, effort and context, read from its transcript, by agent id; one not readable yet is left out. */
async function statsOf(metas: SubagentMeta[], read: (agentId: string) => Promise<SubagentStats | null>): Promise<Map<string, SubagentStats>> {
  const found = await Promise.all(metas.map(async (m) => [m.agentId, await read(m.agentId)] as const));
  return new Map(found.filter((f): f is readonly [string, SubagentStats] => f[1] !== null));
}

// ---------- the ledger ----------

/** What started a session Looper recorded: a builder's and a classifier's are Looper's own and never listed. */
export type LedgerKind = 'chat' | 'terminal' | 'remote' | 'run' | 'classifier' | 'builder';

export interface LedgerEntry {
  sessionId: string;
  kind: LedgerKind;
  /** The task, or the project's or folder's stand-in, it ran under. */
  taskId: string;
  taskName?: string;
  runId?: string;
  ts: string;
}

/** The ledger's file in Looper's data folder. */
export const LEDGER_FILE = 'session-ledger.jsonl';

/**
 * Every Claude Code session and Codex thread Looper started, by id, kept
 * apart from the run folders so it outlives run retention: a transcript
 * whose run is gone still shows as what it was (a task run under its task),
 * not as a conversation from outside Looper. A session's first record wins:
 * a chat that went on with a task run's conversation leaves it a task run.
 */
export class SessionLedger {
  private byId: Map<string, LedgerEntry> | null = null;

  constructor(private readonly file: string) {}

  private all(): Map<string, LedgerEntry> {
    if (this.byId) return this.byId;
    const map = new Map<string, LedgerEntry>();
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      /* none yet */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        if (typeof e?.sessionId === 'string' && e.sessionId && !map.has(e.sessionId)) map.set(e.sessionId, e);
      } catch {
        /* a torn line */
      }
    }
    this.byId = map;
    return map;
  }

  get(sessionId: string): LedgerEntry | undefined {
    return this.all().get(sessionId);
  }

  add(e: Omit<LedgerEntry, 'ts'>): void {
    const map = this.all();
    if (!e.sessionId || map.has(e.sessionId)) return;
    const entry: LedgerEntry = { ...e, ts: new Date().toISOString() };
    map.set(e.sessionId, entry);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* it stays known until Looper quits */
    }
  }
}

/**
 * Every session a run folder names: the agent's (and those a context restart
 * ended, `session<N>-…`) and the classifier's (`classify-…`), from the Claude
 * hook payloads and Codex's thread file. `own`: the agent's current session
 * (the plain names), the one the run goes on with.
 */
export async function runSessionRefs(runDir: string): Promise<{ sessionId: string; classifier: boolean; own: boolean }[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(runDir);
  } catch {
    return [];
  }
  // As readRunSessionId: session.json before stop.json.
  names.sort((a, b) => Number(b.endsWith('session.json')) - Number(a.endsWith('session.json')));
  const out: { sessionId: string; classifier: boolean; own: boolean }[] = [];
  const read = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse((await fs.promises.readFile(path.join(runDir, name), 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  for (const name of names) {
    let prefix: string;
    let id: unknown;
    if (name.endsWith('codex-session.json')) {
      prefix = name.slice(0, -'codex-session.json'.length);
      id = (await read(name))?.thread_id;
    } else {
      const m = /^(.*?)(?:session|stop)\.json$/.exec(name);
      if (!m) continue;
      prefix = m[1];
      const raw = await read(name);
      id = raw?.session_id;
      const t = raw?.transcript_path;
      if ((typeof id !== 'string' || !id) && typeof t === 'string' && t.trim().endsWith('.jsonl')) {
        id = t.trim().split(/[\\/]/).pop()!.slice(0, -'.jsonl'.length);
      }
    }
    if (typeof id !== 'string' || !id.trim() || out.some((o) => o.sessionId === id.trim())) continue;
    out.push({ sessionId: id.trim(), classifier: prefix.startsWith('classify-'), own: prefix === '' });
  }
  return out;
}

// ---------- transcripts ----------

/**
 * The folder under `<config dir>/projects` that holds Claude Code's
 * transcripts of a working directory: the folder with every character that
 * isn't a letter or a digit replaced by "-" (checked against
 * ~/.claude/projects: /home/leandro/liaison/.tmp is -home-leandro-liaison--tmp).
 */
export function claudeProjectFolder(cwd: string): string {
  return normalizeFolder(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** What the list shows of a transcript, read once per size and modified time. */
export interface TranscriptMeta {
  /** Claude's title (or the one the user gave it with /rename), else the first message. */
  title: string;
  lastActive: number;
  /** User and agent messages. */
  messages: number;
  sessionId: string;
  /** The folder the conversation started in. */
  cwd?: string;
}

/** A Codex rollout's first record: the thread, where it started, and whether it's a subagent's (Codex's guardian reviews). */
interface CodexHead {
  sessionId: string;
  cwd?: string;
  subagent: boolean;
}

/** The first line of a file, up to `max` bytes. */
async function firstLine(file: string, max = 4 * 1024 * 1024): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    let data = Buffer.alloc(0);
    const chunk = Buffer.alloc(65_536);
    while (data.length < max) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, data.length);
      if (bytesRead === 0) break;
      data = Buffer.concat([data, chunk.subarray(0, bytesRead)]);
      const nl = data.indexOf(0x0a);
      if (nl !== -1) return data.subarray(0, nl).toString('utf8').trim();
    }
    return data.toString('utf8').trim();
  } finally {
    await fh.close();
  }
}

/** A record's top-level cwd: Claude Code writes it ahead of the message, so the first one in the line is the record's. */
const CWD_RE = /"cwd":("(?:[^"\\]|\\.)*")/;

const lastTime = (rows: MessageRow[]): number => {
  let t = 0;
  for (const r of rows) {
    const ms = r.ts ? Date.parse(r.ts) : NaN;
    if (ms > t) t = ms;
  }
  return t;
};

const said = (rows: MessageRow[]) => rows.filter((r) => r.kind === 'prompt' || r.kind === 'agent').length;

/** A transcript's rows, read as a chat's are (TranscriptReader: a chunk at a time, without the records nothing reads). */
async function readTranscript(file: string, format: 'claude' | 'codex'): Promise<{ acc: TranscriptAccumulator; extra: { cwd?: string } }> {
  const extra: { cwd?: string } = {};
  const reader: TranscriptReader = new TranscriptReader(file, {}, format, (line) => {
    if (format === 'claude' && extra.cwd === undefined) {
      const m = CWD_RE.exec(line);
      if (m) {
        try {
          extra.cwd = JSON.parse(m[1]) as string;
        } catch {
          /* not a string after all */
        }
      }
    }
    reader.acc.addLine(line);
  });
  await reader.read();
  return { acc: reader.acc, extra };
}

/** A transcript's title, last activity and message count, from one pass over it. */
export async function transcriptMeta(file: string, format: 'claude' | 'codex', mtimeMs: number): Promise<TranscriptMeta> {
  const { acc, extra } = await readTranscript(file, format);
  const rows = acc.rows;
  const messages = said(rows);
  // Claude's name for it: the last custom-title (an empty one takes the user's name away), else its ai-title.
  const title = acc.sessionName || (messages ? chatTitle(rows) : '');
  // Claude names the file after the session; a Codex rollout's thread id is in its first record (codexHead).
  const sessionId = path.basename(file, '.jsonl');
  return { title, lastActive: lastTime(rows) || mtimeMs, messages, sessionId, ...(extra.cwd ? { cwd: extra.cwd } : {}) };
}

/**
 * A transcript as a chat shows its history: its rows, the whole conversation
 * as compaction keeps it, and the harness's name for it (Claude Code's from
 * the transcript, a Codex thread's from its home's session index).
 */
export async function transcriptHistory(file: string, format: 'claude' | 'codex'): Promise<{ rows: MessageRow[]; compact: MessageRow[]; name?: string }> {
  const { acc } = await readTranscript(file, format);
  const home = format === 'codex' ? codexHomeOfRollout(file) : undefined;
  const head = home ? await codexHead(file) : null;
  const name = format === 'claude' ? acc.sessionName : home && head ? await codexThreadName(home, head.sessionId) : undefined;
  return { rows: acc.rows, compact: compactRows(acc.rows), ...(name ? { name } : {}) };
}

async function codexHead(file: string): Promise<CodexHead | null> {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(await firstLine(file)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const p = rec.payload as Record<string, unknown> | undefined;
  if (rec.type !== 'session_meta' || !p || typeof p.id !== 'string') return null;
  // A thread Codex started for itself (a guardian review) names its parent in an object `source`; the user's say "cli", "exec"…
  const subagent = p.source !== undefined && typeof p.source !== 'string';
  return { sessionId: p.id, ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}), subagent };
}

// ---------- the config folders ----------

/** An environment's Claude Code config folders and Codex homes, as host paths. */
export interface ConfigDirs {
  claude: string[];
  codex: string[];
}

/**
 * Where an environment's harnesses keep their conversations: Claude Code's
 * config folder (CLAUDE_CONFIG_DIR when the harness or the shell sets it,
 * else ~/.claude) and Codex's home (CODEX_HOME, else ~/.codex), asked in
 * the environment itself (its shell, through WSL when it's across), once per
 * harness setup.
 */
export async function probeConfigDirs(env: Environment, host: HostKind): Promise<ConfigDirs> {
  const side = envSide(env, host);
  // Harnesses of a kind with the same variables keep the same folder: each is asked once.
  const probes = new Map<string, Harness>();
  for (const h of env.harnesses) {
    if (h.kind !== 'custom') probes.set(envPrefix(side, h.env) + h.kind, h);
  }
  const out: ConfigDirs = { claude: [], codex: [] };
  await Promise.all(
    [...probes.values()].map(async (h) => {
      const dir = await probeHarnessHome(env, h, host).catch(() => undefined);
      const list = h.kind === 'claude-code' ? out.claude : out.codex;
      if (dir && !list.includes(dir)) list.push(dir);
    }),
  );
  return out;
}

/**
 * Where a harness keeps its conversations, as a host path: Claude Code's
 * config folder (CLAUDE_CONFIG_DIR, else ~/.claude) or Codex's home
 * (CODEX_HOME, else ~/.codex), asked in the environment with the harness's
 * variables. Undefined for a custom harness, or a folder the host can't reach.
 */
export async function probeHarnessHome(env: Environment, harness: Harness, host: HostKind): Promise<string | undefined> {
  if (harness.kind === 'custom') return undefined;
  const side = envSide(env, host);
  const scripts = {
    'claude-code': side === 'posix' ? `printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` : "if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }",
    codex: side === 'posix' ? `printf '%s\\n' "\${CODEX_HOME:-$HOME/.codex}"` : "if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }",
  };
  const printed = await runProbe(env, host, envPrefix(side, harness.env) + scripts[harness.kind]);
  const target = printed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return target ? transcriptHostPath(target, host, env.kind === 'wsl' ? env.distro : undefined) : undefined;
}

// ---------- the service ----------

/**
 * The stand-in id the chats and terminals opened in a folder without a
 * project are recorded under: one per folder and environment, so its run
 * history stays together. Windows paths compare without case.
 */
export function folderStandInId(environmentId: string, cwd: string): string {
  const key = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? cwd.toLowerCase() : cwd;
  return FOLDER_TASK_PREFIX + crypto.createHash('sha1').update(`${environmentId}\n${key}`).digest('hex').slice(0, 12);
}

export interface HistoryDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  projects: () => Project[];
  /** Every task id with run history: tasks, and the projects' and folders' stand-ins. */
  runTaskIds: () => string[];
  findTask: (id: string) => Task | undefined;
  summaries: (taskId: string) => Promise<RunSummary[]>;
  runDir: (taskId: string, runId: string) => string;
  readChatInfo: (taskId: string, runId: string) => Promise<ChatInfo | null>;
  readTerminalInfo: (taskId: string, runId: string) => Promise<TerminalInfo | null>;
  /** The harness Run Options put a task run on instead of the task's; null when it ran on the task's. */
  readRunHarness: (taskId: string, runId: string) => Promise<string | null>;
  /** The runs that are Remote Control's own conversations. */
  remoteRuns: () => Set<string>;
  /** A run's conversation (a subagent's with `agentId`). */
  readRun: (taskId: string, runId: string, agentId?: string) => Promise<MessageRow[]>;
  /** A run's whole conversation as compaction keeps it. */
  compactableRun: (taskId: string, runId: string) => Promise<MessageRow[]>;
  runSubagents: (taskId: string, runId: string) => Promise<SubagentMeta[]>;
  /** A run's subagent's model, effort and context, from its transcript's newest response. */
  runSubagentStats: (taskId: string, runId: string, agentId: string) => Promise<SubagentStats | null>;
  subagentsAt: (hostPath: string) => Promise<SubagentMeta[]>;
  ledger: SessionLedger;
  /** Tests give the folders; Looper asks the environment (probeConfigDirs). */
  configDirs?: (env: Environment) => Promise<ConfigDirs>;
}

/** The list's cache of transcripts, by host path: what's read of one is valid while its size and modified time stay the same. */
interface CacheEntry {
  size: number;
  mtimeMs: number;
  format: 'claude' | 'codex';
  /** The environments whose folders it was found in (two can share one, a WSL distro's for each). */
  envIds: string[];
  head?: CodexHead | null;
  meta?: TranscriptMeta;
}

export const HISTORY_CACHE_FILE = 'history-cache.json';

/** A conversation from a transcript rather than a run folder. */
export interface HistoryTranscript {
  path: string;
  format: 'claude' | 'codex';
  sessionId: string;
  harnessKind: 'claude-code' | 'codex';
  title: string;
  environmentId: string;
  /** The folder it ran in, as the environment sees it. */
  folder: string;
  projectId?: string;
  mtimeMs: number;
}

interface Entry {
  item: HistoryItem;
  transcript?: HistoryTranscript;
}

/** A transcript file found in an environment's folders, before it's read. */
interface FileRef {
  path: string;
  format: 'claude' | 'codex';
  envIds: string[];
  size: number;
  mtimeMs: number;
  /** A Claude transcript's folder under `projects`, named after the working directory (claudeProjectFolder). */
  dir?: string;
}

/** One task's runs in the list, and the session ids its run folders hold. */
interface TaskEntries {
  runs: Entry[];
  known: string[];
}

/** A run's own record, read for a chat or terminal session, with the result it was read for. */
interface RunInfo {
  result: string;
  chat: ChatInfo | null;
  term: TerminalInfo | null;
  /** A task run Run Options put on another harness: that harness. */
  harnessId: string | null;
}

/** What the list is built from: Looper's runs by task, and every transcript file found. */
interface HistoryIndex {
  tasks: Map<string, TaskEntries>;
  files: FileRef[];
}

const LEDGER_SOURCES: Partial<Record<LedgerKind, HistorySource>> = { chat: 'chat', terminal: 'terminal', remote: 'remote', run: 'run' };

/** Whether a task run passes Task History's filters. */
export function runPasses(item: Pick<HistoryItem, 'taskId' | 'result'>, f: HistoryRunFilter): boolean {
  const result = item.result ?? '';
  return (!f.taskId || item.taskId === f.taskId) && (!f.result || result === f.result) && runShown({ result }, f);
}

/** Files read at a time: a stat or a transcript over \\wsl.localhost waits on the network more than the disk. */
const STAT_AT_ONCE = 32;
const READ_AT_ONCE = 8;
/** A run writes its records in bursts: its task is read again once they stop. */
const CHANGE_WAIT_MS = 100;
/** How old the last read of the agents' folders can be before a Recent menu starts another. */
const RESCAN_AFTER_MS = 60_000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const readdir = (dir: string): Promise<string[]> => fs.promises.readdir(dir).catch(() => [] as string[]);

/**
 * The History window's conversations: Looper's recorded runs, and every
 * Claude Code and Codex conversation in the environments' config folders,
 * whatever folder it ran in. A transcript that one of Looper's run folders or
 * the ledger names isn't listed again. There can be thousands of transcripts
 * of several MB each, so the list finds the files by modified time and reads
 * only the newest it shows (Show More reads the next ones); what it read of
 * each is cached by its size and modified time.
 */
export class HistoryService {
  private entries = new Map<string, Entry>();
  private cache: Map<string, CacheEntry> | null = null;
  private cacheLoad: Promise<Map<string, CacheEntry>> | null = null;
  private cacheDirty = false;
  private saving: Promise<void> = Promise.resolve();
  private readonly dirs = new Map<string, Promise<ConfigDirs>>();
  private index: HistoryIndex | null = null;
  private building: Promise<HistoryIndex> | null = null;
  private scanning: Promise<HistoryIndex> | null = null;
  private scannedAt = 0;
  /** Tasks whose runs changed since the index read them. */
  private changed = new Set<string>();
  private changeTimer: NodeJS.Timeout | null = null;
  /** The Recent menus' lists, by folder, ready before a menu asks. */
  private recentLists = new Map<string, HistoryItem[]>();
  private recentRun: Promise<void> | null = null;
  private recentAgain = false;
  /** Each chat's and terminal session's info, by `taskId/runId`. */
  private infos = new Map<string, RunInfo>();

  constructor(private readonly d: HistoryDeps) {}

  private cacheFile(): string {
    return path.join(this.d.dataDir, HISTORY_CACHE_FILE);
  }

  /** The cache, read once without holding the thread on the disk; everything that reads it waits on this first. */
  private loadCache(): Promise<Map<string, CacheEntry>> {
    this.cacheLoad ??= fs.promises.readFile(this.cacheFile(), 'utf8').then(
      (text) => {
        const map = new Map<string, CacheEntry>();
        try {
          const raw = JSON.parse(text) as Record<string, CacheEntry>;
          for (const [k, v] of Object.entries(raw)) {
            if (v && typeof v.size === 'number' && typeof v.mtimeMs === 'number' && Array.isArray(v.envIds) && v.envIds.length) map.set(k, v);
          }
        } catch {
          /* unreadable: it's only a cache */
        }
        return map;
      },
      () => new Map<string, CacheEntry>(),
    );
    return this.cacheLoad.then((map) => (this.cache ??= map));
  }

  /** The loaded cache, for code that runs after loadCache. */
  private cached(): Map<string, CacheEntry> {
    return (this.cache ??= new Map());
  }

  private saveCache(): Promise<void> {
    if (!this.cacheDirty) return this.saving;
    this.cacheDirty = false;
    this.saving = this.saving.then(() =>
      writeJsonAtomicAsync(this.cacheFile(), Object.fromEntries(this.cached())).catch((err: unknown) => this.d.log.warn(`history: cannot save the cache: ${errMsg(err)}`)),
    );
    return this.saving;
  }

  /** The environment's folders, asked once per environment and harness setup. */
  private configDirs(env: Environment): Promise<ConfigDirs> {
    const key = JSON.stringify([env.id, env.kind, env.distro, env.shell, env.harnesses.map((h) => [h.kind, h.env])]);
    let found = this.dirs.get(key);
    if (!found) {
      found = this.d.configDirs ? this.d.configDirs(env) : probeConfigDirs(env, this.d.host);
      this.dirs.set(key, found);
      // An environment that didn't answer (WSL still starting) is asked again next time.
      void found.then(
        (d) => {
          if (d.claude.length + d.codex.length === 0) this.dirs.delete(key);
        },
        () => this.dirs.delete(key),
      );
    }
    return found;
  }

  /** The project a task id's runs belong to: a project's stand-in, a task of a project, or a folder stand-in on a project's folder. */
  private projectOf(taskId: string, task: Task, projects: Project[]): Project | undefined {
    const pid = projectIdOf(taskId) ?? task.projectId;
    if (pid) return projects.find((p) => p.id === pid);
    return projects.find((p) => p.environmentId === task.environmentId && sameFolder(p.cwd, task.cwd));
  }

  /** `harnessId`: the harness Run Options put the run on, else the task's. */
  private taskKind(task: Task, harnessId?: string | null): 'claude-code' | 'codex' | null {
    try {
      const env = resolveEnvironment(task, this.d.settings);
      const kind = (harnessId ? env.harnesses.find((h) => h.id === harnessId) : undefined)?.kind ?? resolveHarness(task, env).kind;
      return kind === 'custom' ? null : kind;
    } catch {
      return null;
    }
  }

  /** What each ended task run's folder names, by folder: it doesn't change once the run is over. */
  private readonly runRefs = new Map<string, { sessionId: string; classifier: boolean; own: boolean }[]>();

  /** A run folder's sessions, read without holding up the main process; a task run that ended is read once. */
  private async refsOf(dir: string, ended: boolean): Promise<{ sessionId: string; classifier: boolean; own: boolean }[]> {
    const kept = this.runRefs.get(dir);
    if (kept) return kept;
    const refs = await runSessionRefs(dir);
    if (ended) this.runRefs.set(dir, refs);
    return refs;
  }

  /**
   * Looper's recorded runs, and the session ids their folders name. There
   * can be thousands of run folders, so they're read asynchronously, a task at
   * a time, letting the windows go on between tasks.
   */
  private async runEntries(projects: Project[]): Promise<Map<string, TaskEntries>> {
    const tasks = new Map<string, TaskEntries>();
    const remote = this.d.remoteRuns();
    for (const taskId of this.d.runTaskIds()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const entries = await this.taskEntries(taskId, projects, remote);
      if (entries) tasks.set(taskId, entries);
    }
    return tasks;
  }

  /** One task's runs in the list; null when the task is gone. */
  private async taskEntries(taskId: string, projects: Project[], remote: Set<string>): Promise<TaskEntries | null> {
    const task = this.d.findTask(taskId);
    if (!task) return null;
    const runs: Entry[] = [];
    const known: string[] = [];
    const project = this.projectOf(taskId, task, projects);
    const summaries = await this.d.summaries(taskId);
    // Chats and terminal sessions name their session on their first message, whenever that comes.
    const refs = await mapLimit(summaries, STAT_AT_ONCE, (s) =>
      // In progress: started, held, or between the classifier's go-ahead ('act') and the agent's first record.
      this.refsOf(this.d.runDir(taskId, s.runId), !['started', 'held', 'act', 'chat', 'terminal'].includes(s.result)),
    );
    const infos = await mapLimit(summaries, STAT_AT_ONCE, (s) => this.infoOf(taskId, s));
    summaries.forEach((s, i) => {
      for (const r of refs[i]) known.push(r.sessionId);
      const { chat, term } = infos[i];
      if (chat?.resumedSession) known.push(chat.resumedSession);
      const kind = chat?.harnessKind ?? term?.harnessKind ?? this.taskKind(task, infos[i].harnessId);
      const sessionId = kind ? (refs[i].find((r) => r.own)?.sessionId ?? null) : null;
      const source: HistorySource = s.result === 'chat' ? 'chat' : s.result === 'terminal' ? (remote.has(s.runId) ? 'remote' : 'terminal') : 'run';
      // No conversation to show: a chat's or terminal session's folder retention took. A task run that stopped at its check
      // is still a run in Task History, with nothing to read.
      if (source !== 'run' && (!kind || !sessionId)) return;
      const title = (chat?.title || term?.title || (source === 'run' ? s.details : '') || task.name || 'Untitled chat').trim();
      runs.push({
        item: {
          id: `run:${taskId}:${s.runId}`,
          source,
          ...(project ? { projectId: project.id } : {}),
          folder: normalizeFolder(task.cwd),
          environmentId: task.environmentId,
          title,
          lastActive: Date.parse(s.endTs) || Date.parse(s.startTs) || 0,
          harnessKind: kind ?? 'claude-code',
          ...(sessionId ? { sessionId } : {}),
          taskId,
          runId: s.runId,
          ...(source === 'run' ? { taskName: task.name, result: s.result } : {}),
        },
      });
    });
    return { runs, known };
  }

  /** A chat's or terminal session's own record, kept until the run store says the run changed. */
  private async infoOf(taskId: string, s: RunSummary): Promise<RunInfo> {
    const key = `${taskId}/${s.runId}`;
    const kept = this.infos.get(key);
    if (kept && kept.result === s.result) return kept;
    const info: RunInfo = {
      result: s.result,
      chat: s.result === 'chat' ? await this.d.readChatInfo(taskId, s.runId) : null,
      term: s.result === 'terminal' ? await this.d.readTerminalInfo(taskId, s.runId) : null,
      harnessId: s.result === 'chat' || s.result === 'terminal' ? null : await this.d.readRunHarness(taskId, s.runId),
    };
    this.infos.set(key, info);
    return info;
  }

  /** The index's runs, every task's: the chats and terminal sessions of Looper's, and the task runs. */
  private allRuns(index: HistoryIndex): Entry[] {
    return [...index.tasks.values()].flatMap((t) => t.runs);
  }

  /** The conversations of Looper's own in the index: the task runs are Task History's. */
  private conversationRuns(index: HistoryIndex): Entry[] {
    return this.allRuns(index).filter((e) => e.item.source !== 'run');
  }

  /** The session ids Looper's run folders hold, whose transcripts aren't listed again. */
  private allKnown(index: HistoryIndex): Set<string> {
    const known = new Set<string>();
    for (const t of index.tasks.values()) for (const id of t.known) known.add(id);
    return known;
  }

  /** Every transcript in the environments' folders, each file once (config folders can share a `projects` folder through a link). */
  private async scanFiles(): Promise<FileRef[]> {
    const refs: Omit<FileRef, 'size' | 'mtimeMs'>[] = [];
    const names = new Set<string>();
    /** Each folder read, by its real path, and the environments that use it: their files share the list. */
    const roots = new Map<string, string[]>();
    const add = (ref: Omit<FileRef, 'size' | 'mtimeMs'>) => {
      // Claude names a transcript after its session and Codex after its time and thread: a name found twice is the same conversation.
      const key = `${ref.format}:${path.basename(ref.path)}`;
      if (names.has(key)) return;
      names.add(key);
      refs.push(ref);
    };
    /** The environments of a folder not read yet; null when another environment's read it, which now shares it. */
    const newRoot = async (dir: string, envId: string): Promise<string[] | null> => {
      const real = await fs.promises.realpath(dir).catch(() => dir);
      const known = roots.get(real);
      if (known) {
        if (!known.includes(envId)) known.push(envId);
        return null;
      }
      const envIds = [envId];
      roots.set(real, envIds);
      return envIds;
    };
    for (const env of this.d.settings.environments) {
      const dirs = await this.configDirs(env).catch((): ConfigDirs => ({ claude: [], codex: [] }));
      for (const config of dirs.claude) {
        const root = path.join(config, 'projects');
        const envIds = await newRoot(root, env.id);
        if (!envIds) continue;
        const folders = await readdir(root);
        const lists = await mapLimit(folders, STAT_AT_ONCE, (dir) => readdir(path.join(root, dir)));
        folders.forEach((dir, i) => {
          for (const n of lists[i]) if (n.endsWith('.jsonl')) add({ path: path.join(root, dir, n), format: 'claude', envIds, dir });
        });
      }
      for (const home of dirs.codex) {
        const root = path.join(home, 'sessions');
        const envIds = await newRoot(root, env.id);
        if (!envIds) continue;
        for (const file of await codexRollouts(root)) add({ path: file, format: 'codex', envIds });
      }
    }
    const stats = await mapLimit(refs, STAT_AT_ONCE, (r) => fs.promises.stat(r.path).catch(() => null));
    return refs.flatMap((r, i) => {
      const st = stats[i];
      return st?.isFile() ? [{ ...r, size: st.size, mtimeMs: st.mtimeMs }] : [];
    });
  }

  /** The files the cache knows, without reading any folder. */
  private async cachedFiles(): Promise<FileRef[]> {
    return [...(await this.loadCache())].map(([file, c]) => ({
      path: file,
      format: c.format,
      envIds: c.envIds,
      size: c.size,
      mtimeMs: c.mtimeMs,
      ...(c.format === 'claude' ? { dir: path.basename(path.dirname(file)) } : {}),
    }));
  }

  /** Read the folders again; the cache keeps what it read of the files still there. */
  private rescan(): Promise<HistoryIndex> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const tasks = await this.runEntries(this.d.projects());
      const files = await this.scanFiles();
      const old = await this.loadCache();
      const next = new Map<string, CacheEntry>();
      for (const f of files) {
        const c = old.get(f.path);
        next.set(f.path, c && c.size === f.size && c.mtimeMs === f.mtimeMs && c.format === f.format ? { ...c, envIds: f.envIds } : { size: f.size, mtimeMs: f.mtimeMs, format: f.format, envIds: f.envIds });
      }
      this.cache = next;
      this.cacheDirty = true;
      this.index = { tasks, files };
      this.scannedAt = Date.now();
      return this.index;
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /** The index, built from Looper's runs and the cache's files the first time, without reading the agents' folders. */
  private async currentIndex(): Promise<HistoryIndex> {
    if (this.index) return this.index;
    this.building ??= (async () => {
      const tasks = await this.runEntries(this.d.projects());
      const files = await this.cachedFiles();
      // A rescan that finished meanwhile read more.
      this.index ??= { tasks, files };
      return this.index;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  /**
   * A task's runs changed (a record, a chat's title or session): its part of the index is read again shortly,
   * then the Recent menus' lists, so they show a chat or run as soon as it ends.
   */
  taskChanged(taskId: string, runId?: string): void {
    if (runId) this.infos.delete(`${taskId}/${runId}`);
    else for (const key of [...this.infos.keys()]) if (key.startsWith(`${taskId}/`)) this.infos.delete(key);
    this.changed.add(taskId);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.applyChanges().catch((err: unknown) => this.d.log.warn(`history: cannot update the list: ${errMsg(err)}`));
    }, CHANGE_WAIT_MS);
  }

  private async applyChanges(): Promise<void> {
    // A build or rescan reads every task: what changed during it is read again after it.
    await this.building?.catch(() => undefined);
    await this.scanning?.catch(() => undefined);
    if (!this.index) {
      this.changed.clear();
      return;
    }
    const ids = [...this.changed];
    this.changed.clear();
    const projects = this.d.projects();
    const remote = this.d.remoteRuns();
    for (const id of ids) {
      const entries = await this.taskEntries(id, projects, remote);
      if (entries) this.index.tasks.set(id, entries);
      else this.index.tasks.delete(id);
    }
    await this.refreshRecent();
  }

  /**
   * The Recent menus' list for `folder` ('' or `project:<id>`), ready at once; undefined until it has been worked out
   * (the first seconds after start). Asking starts a rescan of the agents' folders
   * when the last is over a minute old, so a conversation from outside Looper shows from the next menu.
   */
  recent(folder: HistoryFolderFilter): HistoryItem[] | undefined {
    if (this.index && !this.scanning && Date.now() - this.scannedAt > RESCAN_AFTER_MS) void this.rescanQuietly();
    const list = this.recentLists.get(folder);
    // A project added since the lists were worked out.
    if (!list && this.index) void this.refreshRecent();
    return list;
  }

  /** Builds the index and the Recent menus' lists from Looper's runs and the cache; the first menu starts the agents' folders' rescan. */
  async warm(): Promise<void> {
    await this.currentIndex();
    await this.refreshRecent();
  }

  private async rescanQuietly(): Promise<void> {
    try {
      await this.rescan();
      await this.refreshRecent();
    } catch (err) {
      this.d.log.warn(`history: cannot read the folders: ${errMsg(err)}`);
    }
  }

  /** Works out every Recent menu's list again: all conversations, and each project's. One at a time; a call meanwhile runs again after. */
  private refreshRecent(): Promise<void> {
    if (this.recentRun) {
      this.recentAgain = true;
      return this.recentRun;
    }
    this.recentRun = (async () => {
      try {
        do {
          this.recentAgain = false;
          this.recentLists = await this.recentListsOf();
        } while (this.recentAgain);
      } catch (err) {
        this.d.log.warn(`history: cannot work out the Recent menus: ${errMsg(err)}`);
      }
    })().finally(() => {
      this.recentRun = null;
    });
    return this.recentRun;
  }

  /**
   * Every Recent menu's list in one pass, the same as list() gives for each folder: the conversations sorted once, newest
   * first, each added to the all list and its project's while they have room. A transcript is read only while a list it
   * could be in has room, so a project with few conversations doesn't read the others'.
   */
  private async recentListsOf(): Promise<Map<string, HistoryItem[]>> {
    await this.loadCache();
    const index = await this.currentIndex();
    const known = this.allKnown(index);
    const projects = this.d.projects();
    const lists = new Map<string, Entry[]>([['', []], ...projects.map((p) => [`project:${p.id}`, []] as [string, Entry[]])]);
    const byDir = new Map<string, string[]>();
    for (const p of projects) {
      const dir = claudeProjectFolder(p.cwd);
      byDir.set(dir, [...(byDir.get(dir) ?? []), `project:${p.id}`]);
    }
    const room = (key: string) => (lists.get(key)?.length ?? RECENT_CHATS) < RECENT_CHATS;
    let projectsWithRoom = projects.length;
    const wanted = (f: FileRef) => room('') || (f.format === 'claude' ? (byDir.get(f.dir ?? '') ?? []).some(room) : projectsWithRoom > 0);
    const add = (e: Entry) => {
      // A task run whose folder retention took is Task History's, not a conversation to continue.
      if (e.item.source === 'run') return;
      if (room('')) lists.get('')!.push(e);
      const key = e.item.projectId ? `project:${e.item.projectId}` : '';
      if (key && room(key)) {
        lists.get(key)!.push(e);
        if (!room(key)) projectsWithRoom--;
      }
    };
    const candidates: { ts: number; run?: Entry; file?: FileRef }[] = [
      ...this.conversationRuns(index).map((run) => ({ ts: run.item.lastActive, run })),
      ...index.files.map((file) => ({ ts: file.mtimeMs, file })),
    ].sort((a, b) => b.ts - a.ts);
    let at = 0;
    let sinceYield = 0;
    while (at < candidates.length && (room('') || projectsWithRoom > 0)) {
      const batch = candidates.slice(at, at + READ_AT_ONCE);
      at += batch.length;
      const got = await Promise.all(batch.map((c) => (c.run ? c.run : wanted(c.file!) ? this.resolve(c.file!, known, projects) : null)));
      for (const e of got) if (e) add(e);
      sinceYield += batch.length;
      if (sinceYield >= 2000) {
        sinceYield = 0;
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    await this.saveCache();
    const out = new Map<string, HistoryItem[]>();
    for (const [key, entries] of lists) {
      for (const e of entries) this.entries.set(e.item.id, e);
      out.set(key, entries.map((e) => e.item));
    }
    return out;
  }

  /** A transcript as an entry of the list, read when the cache doesn't have it; null when it isn't listed (Looper's own, a subagent's, or one with no messages). */
  private async resolve(f: FileRef, known: Set<string>, projects: Project[]): Promise<Entry | null> {
    const cache = this.cached();
    const old = cache.get(f.path);
    const c: CacheEntry = old && old.size === f.size && old.mtimeMs === f.mtimeMs && old.format === f.format ? old : { size: f.size, mtimeMs: f.mtimeMs, format: f.format, envIds: f.envIds };
    try {
      if (f.format === 'codex' && c.head === undefined) {
        c.head = await codexHead(f.path);
        this.cacheDirty = true;
      }
      if (f.format === 'codex' && (!c.head || c.head.subagent)) return null;
      // Looper's own sessions aren't listed: known by name (Claude names the file after it) before the whole file is read.
      const id = f.format === 'claude' ? path.basename(f.path, '.jsonl') : c.head?.sessionId;
      const own = id ? this.d.ledger.get(id) : undefined;
      if (id && (known.has(id) || (own && !LEDGER_SOURCES[own.kind]))) return null;
      if (!c.meta) {
        const meta = await transcriptMeta(f.path, f.format, f.mtimeMs);
        c.meta = c.head ? { ...meta, sessionId: c.head.sessionId } : meta;
        this.cacheDirty = true;
      }
    } catch (err) {
      this.d.log.warn(`history: cannot read ${f.path}: ${errMsg(err)}`);
      return null;
    } finally {
      cache.set(f.path, c);
    }
    const meta = c.meta;
    if (meta.messages === 0 || known.has(meta.sessionId)) return null;
    const ledger = this.d.ledger.get(meta.sessionId);
    const source: HistorySource | undefined = ledger ? LEDGER_SOURCES[ledger.kind] : f.format === 'claude' ? 'claude-code' : 'codex';
    if (!source) return null;
    const folder = normalizeFolder((f.format === 'claude' ? meta.cwd : c.head?.cwd) ?? '');
    const project = folder ? projects.find((p) => f.envIds.includes(p.environmentId) && sameFolder(p.cwd, folder)) : undefined;
    const envId = project?.environmentId ?? f.envIds[0];
    const harnessKind = f.format === 'claude' ? 'claude-code' : 'codex';
    const taskName = ledger?.kind === 'run' ? (this.d.findTask(ledger.taskId)?.name ?? ledger.taskName) : undefined;
    const taskId = ledger?.taskId ?? (project ? projectTaskId(project.id) : folderStandInId(envId, folder));
    return {
      item: {
        id: `file:${crypto.createHash('sha1').update(f.path).digest('hex').slice(0, 16)}`,
        source,
        ...(project ? { projectId: project.id } : {}),
        folder,
        environmentId: envId,
        title: meta.title || 'Untitled chat',
        lastActive: meta.lastActive,
        harnessKind,
        sessionId: meta.sessionId,
        taskId,
        ...(source === 'run' ? { taskName: taskName ?? ledger?.taskId } : {}),
      },
      transcript: {
        path: f.path,
        format: f.format,
        sessionId: meta.sessionId,
        harnessKind,
        title: meta.title,
        environmentId: envId,
        folder,
        ...(project ? { projectId: project.id } : {}),
        mtimeMs: f.mtimeMs,
      },
    };
  }

  /**
   * The newest `limit` conversations that pass the View menu's filters.
   * `fresh` reads the folders again (slow over \\wsl.localhost); else it
   * lists the files found last, or the cached ones, which show at once.
   * `progress` gets the list so far each time more of it is read, so a
   * window can show the conversations as they come.
   */
  async list(o: HistoryListOptions, progress?: (partial: HistoryList) => void): Promise<HistoryList> {
    const projects = this.d.projects();
    let index: HistoryIndex;
    await this.loadCache();
    // Task runs are all in the index, which keeps current as their records are written: no folders to read.
    if (o.fresh && !o.runs) {
      index = await this.rescan();
      // The Recent menus, once worked out, get what the History window's refresh found.
      if (this.recentLists.size > 0) void this.refreshRecent();
    } else index = await this.currentIndex();
    const known = this.allKnown(index);

    const project = o.folder.startsWith('project:') ? projects.find((p) => `project:${p.id}` === o.folder) : undefined;
    if (o.folder.startsWith('project:') && !project) return { items: [], more: false };
    // Claude files a folder of their own: a project's are in its folder's (the exact folder is checked once read).
    const projectDir = project ? claudeProjectFolder(project.cwd) : undefined;
    const runs = o.runs;
    // The conversations are the chats, terminal sessions and transcripts; Task History's are the task runs.
    const passes = (e: Entry) => (runs ? e.item.source === 'run' && runPasses(e.item, runs) : e.item.source !== 'run') && inFolderFilter(e.item, o.folder);
    type Candidate = { ts: number; run?: Entry; file?: FileRef };
    const candidates: Candidate[] = [
      ...this.allRuns(index).filter(passes).map((run) => ({ ts: run.item.lastActive, run })),
      ...(runs ? [] : index.files.filter((f) => !projectDir || f.format !== 'claude' || f.dir === projectDir).map((file) => ({ ts: file.mtimeMs, file }))),
    ].sort((a, b) => b.ts - a.ts);

    const found: Entry[] = [];
    let at = 0;
    // An item the window showed keeps working until it's listed again.
    const show = (e: Entry) => this.entries.set(e.item.id, e);
    while (at < candidates.length && found.length < o.limit) {
      const batch = candidates.slice(at, at + Math.min(READ_AT_ONCE, o.limit - found.length));
      at += batch.length;
      const got = await Promise.all(batch.map((c) => (c.run ? Promise.resolve(c.run) : this.resolve(c.file!, known, projects))));
      const before = found.length;
      for (const e of got) if (e && passes(e)) found.push(e);
      // Only a batch that read a transcript took long enough to be worth showing on its way.
      if (progress && found.length > before && batch.some((c) => c.file)) {
        found.slice(before).forEach(show);
        progress({ items: found.map((e) => e.item), more: true });
      }
    }
    await this.saveCache();
    const shown = found.slice(0, o.limit);
    shown.forEach(show);
    return { items: shown.map((e) => e.item), more: found.length > o.limit || at < candidates.length };
  }

  item(id: string): HistoryItem | undefined {
    return this.entries.get(id)?.item;
  }

  /** The transcript behind a conversation that has no run folder; undefined for a run's. */
  transcript(id: string): HistoryTranscript | undefined {
    return this.entries.get(id)?.transcript;
  }

  /** When the transcript of a conversation from outside Looper changed last, read now; undefined for a run's, or once it's gone. */
  async changedAt(id: string): Promise<number | undefined> {
    const t = this.transcript(id);
    if (!t) return undefined;
    return fs.promises.stat(t.path).then(
      (st) => st.mtimeMs,
      () => undefined,
    );
  }

  /** A conversation's rows and subagents (a subagent's rows with `agentId`); null when it's no longer listed. */
  async read(id: string, agentId?: string): Promise<HistoryConversation | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    const { item, transcript } = e;
    if (agentId !== undefined && !/^[\w.-]+$/.test(agentId)) return null;
    if (item.runId) {
      const rows = await this.d.readRun(item.taskId, item.runId, agentId);
      if (agentId !== undefined) return { rows, subagents: [] };
      const metas = await this.d.runSubagents(item.taskId, item.runId);
      const stats = await statsOf(metas, (a) => this.d.runSubagentStats(item.taskId, item.runId!, a));
      return { rows, subagents: subagentsOf(metas, rows, stats) };
    }
    if (!transcript) return null;
    if (agentId !== undefined) {
      const file = path.join(transcript.path.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
      const reader = new TranscriptReader(file, { sidechain: true });
      await reader.read().catch(() => undefined);
      return { rows: reader.acc.rows, subagents: [] };
    }
    const { acc } = await readTranscript(transcript.path, transcript.format);
    const metas = transcript.format === 'claude' ? await this.d.subagentsAt(transcript.path) : [];
    const dir = path.join(transcript.path.replace(/\.jsonl$/i, ''), 'subagents');
    const stats = await statsOf(metas, (a) => readSubagentStats(path.join(dir, `agent-${a}.jsonl`)).catch(() => null));
    return { rows: acc.rows, subagents: subagentsOf(metas, acc.rows, stats), ...(acc.scriptCalls.size ? { scriptCalls: Object.fromEntries(acc.scriptCalls) } : {}) };
  }

  /** The whole conversation as compaction keeps it: Continue Compacted starts from it, and Search reads it. */
  async compactable(id: string): Promise<MessageRow[]> {
    const e = this.entries.get(id);
    if (!e) return [];
    if (e.item.runId) return this.d.compactableRun(e.item.taskId, e.item.runId);
    if (!e.transcript) return [];
    const { acc } = await readTranscript(e.transcript.path, e.transcript.format);
    return compactRows(acc.rows);
  }

  /** Of the conversations the window has listed, the ones whose user or agent messages (not tool calls) contain the text, without regard to case. */
  async search(query: string, ids: string[]): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const listed = ids.filter((id) => this.entries.has(id));
    const hits = await mapLimit(listed, 4, async (id) => {
      const rows = await this.compactable(id).catch(() => [] as MessageRow[]);
      return rows.some((r) => (r.kind === 'prompt' || r.kind === 'guidance' || r.kind === 'events' || r.kind === 'delegate' || r.kind === 'taskEvents' || r.kind === 'peer' || r.kind === 'agent') && r.text.toLowerCase().includes(q));
    });
    return listed.filter((_id, i) => hits[i]);
  }
}

/** `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
async function codexRollouts(root: string): Promise<string[]> {
  const sub = async (dir: string) => (await readdir(dir)).map((n) => path.join(dir, n));
  const out: string[] = [];
  for (const year of await sub(root)) {
    for (const month of await sub(year)) {
      for (const day of await sub(month)) out.push(...(await readdir(day)).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl')).map((n) => path.join(day, n)));
    }
  }
  return out;
}
