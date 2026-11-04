import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chatTitle, type ChatInfo, type TerminalInfo } from '../shared/chat';
import { compactRows } from '../shared/compact';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { inFolderFilter, type HistoryConversation, type HistoryItem, type HistoryList, type HistoryListOptions, type HistorySource } from '../shared/history';
import type { MessageRow } from '../shared/messages';
import { FOLDER_TASK_PREFIX, normalizeFolder, projectIdOf, projectTaskId, sameFolder } from '../shared/projects';
import type { RunSummary } from '../shared/runs';
import type { Environment, Project, Settings, Task } from '../shared/types';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { CodexAccumulator, TranscriptAccumulator, transcriptHostPath, type SubagentMeta } from './messages';
import { subagentsOf } from './sessions';
import { writeJsonAtomic } from './store/fsutil';

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

async function eachLine(file: string, fn: (line: string) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) fn(line);
  }
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

/** A transcript's rows, every one its accumulator kept (the ones past its row limit compacted). */
async function readTranscript(file: string, format: 'claude' | 'codex'): Promise<{ acc: TranscriptAccumulator; extra: { aiTitle: string; customTitle: string | null; cwd?: string } }> {
  const acc = format === 'codex' ? new CodexAccumulator() : new TranscriptAccumulator();
  const extra: { aiTitle: string; customTitle: string | null; cwd?: string } = { aiTitle: '', customTitle: null };
  await eachLine(file, (line) => {
    if (format === 'claude') {
      if (extra.cwd === undefined) {
        const m = CWD_RE.exec(line);
        if (m) {
          try {
            extra.cwd = JSON.parse(m[1]) as string;
          } catch {
            /* not a string after all */
          }
        }
      }
      if (line.includes('"ai-title"') || line.includes('"custom-title"')) {
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) extra.aiTitle = rec.aiTitle.trim();
          // The last one counts, and an empty one takes the name away (Claude Code's /rename).
          else if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') extra.customTitle = rec.customTitle.trim();
        } catch {
          /* a torn line */
        }
      }
    }
    acc.addLine(line);
  });
  return { acc, extra };
}

/** A transcript's title, last activity and message count, from one pass over it. */
export async function transcriptMeta(file: string, format: 'claude' | 'codex', mtimeMs: number): Promise<TranscriptMeta> {
  const { acc, extra } = await readTranscript(file, format);
  const rows = [...acc.evicted, ...acc.rows];
  const messages = said(rows);
  const title = extra.customTitle || extra.aiTitle || (messages ? chatTitle(rows) : '');
  // Claude names the file after the session; a Codex rollout's thread id is in its first record (codexHead).
  const sessionId = path.basename(file, '.jsonl');
  return { title, lastActive: lastTime(rows) || mtimeMs, messages, sessionId, ...(extra.cwd ? { cwd: extra.cwd } : {}) };
}

/** A transcript as a chat shows its history: its rows, and the whole conversation as compaction keeps it. */
export async function transcriptHistory(file: string, format: 'claude' | 'codex'): Promise<{ rows: MessageRow[]; compact: MessageRow[] }> {
  const { acc } = await readTranscript(file, format);
  return { rows: acc.rows, compact: compactRows([...acc.evicted, ...acc.rows]) };
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
  const scripts = {
    'claude-code': side === 'posix' ? `printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` : "if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }",
    codex: side === 'posix' ? `printf '%s\\n' "\${CODEX_HOME:-$HOME/.codex}"` : "if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }",
  };
  const probes = new Map<string, 'claude-code' | 'codex'>();
  for (const h of env.harnesses) {
    if (h.kind === 'custom') continue;
    probes.set(envPrefix(side, h.env) + scripts[h.kind], h.kind);
  }
  const out: ConfigDirs = { claude: [], codex: [] };
  await Promise.all(
    [...probes].map(async ([script, kind]) => {
      const printed = await runProbe(env, host, script).catch(() => '');
      const target = printed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      const dir = target ? await transcriptHostPath(target, host, env.kind === 'wsl' ? env.distro : undefined) : undefined;
      const list = kind === 'claude-code' ? out.claude : out.codex;
      if (dir && !list.includes(dir)) list.push(dir);
    }),
  );
  return out;
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
  summaries: (taskId: string) => RunSummary[];
  runDir: (taskId: string, runId: string) => string;
  readChatInfo: (taskId: string, runId: string) => ChatInfo | null;
  readTerminalInfo: (taskId: string, runId: string) => TerminalInfo | null;
  /** The runs that are Remote Control's own conversations. */
  remoteRuns: () => Set<string>;
  /** A run's conversation (a subagent's with `agentId`). */
  readRun: (taskId: string, runId: string, agentId?: string) => Promise<MessageRow[]>;
  /** A run's whole conversation as compaction keeps it. */
  compactableRun: (taskId: string, runId: string) => Promise<MessageRow[]>;
  runSubagents: (taskId: string, runId: string) => Promise<SubagentMeta[]>;
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

/** What the list is built from: Looper's runs, the session ids they hold, and every transcript file found. */
interface HistoryIndex {
  runs: Entry[];
  known: Set<string>;
  files: FileRef[];
}

const LEDGER_SOURCES: Partial<Record<LedgerKind, HistorySource>> = { chat: 'chat', terminal: 'terminal', remote: 'remote', run: 'run' };

/** Files read at a time: a stat or a transcript over \\wsl.localhost waits on the network more than the disk. */
const STAT_AT_ONCE = 32;
const READ_AT_ONCE = 8;

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
  private cacheDirty = false;
  private readonly dirs = new Map<string, Promise<ConfigDirs>>();
  private index: HistoryIndex | null = null;
  private scanning: Promise<HistoryIndex> | null = null;

  constructor(private readonly d: HistoryDeps) {}

  private cacheFile(): string {
    return path.join(this.d.dataDir, HISTORY_CACHE_FILE);
  }

  private loadCache(): Map<string, CacheEntry> {
    if (this.cache) return this.cache;
    const map = new Map<string, CacheEntry>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.size === 'number' && typeof v.mtimeMs === 'number' && Array.isArray(v.envIds) && v.envIds.length) map.set(k, v);
      }
    } catch {
      /* none yet, or unreadable: it's only a cache */
    }
    this.cache = map;
    return map;
  }

  private saveCache(): void {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    try {
      writeJsonAtomic(this.cacheFile(), Object.fromEntries(this.loadCache()));
    } catch (err) {
      this.d.log.warn(`history: cannot save the cache: ${errMsg(err)}`);
    }
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

  private taskKind(task: Task): 'claude-code' | 'codex' | null {
    try {
      const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
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
  private async runEntries(projects: Project[]): Promise<{ runs: Entry[]; known: Set<string> }> {
    const runs: Entry[] = [];
    const known = new Set<string>();
    const remote = this.d.remoteRuns();
    for (const taskId of this.d.runTaskIds()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const task = this.d.findTask(taskId);
      if (!task) continue;
      const project = this.projectOf(taskId, task, projects);
      const summaries = this.d.summaries(taskId);
      // Chats and terminal sessions name their session on their first message, whenever that comes.
      const refs = await mapLimit(summaries, STAT_AT_ONCE, (s) =>
        // In progress: started, held, or between the classifier's go-ahead ('act') and the agent's first record.
        this.refsOf(this.d.runDir(taskId, s.runId), !['started', 'held', 'act', 'chat', 'terminal'].includes(s.result)),
      );
      summaries.forEach((s, i) => {
        for (const r of refs[i]) known.add(r.sessionId);
        const chat = s.result === 'chat' ? this.d.readChatInfo(taskId, s.runId) : null;
        const term = s.result === 'terminal' ? this.d.readTerminalInfo(taskId, s.runId) : null;
        if (chat?.resumedSession) known.add(chat.resumedSession);
        const kind = chat?.harnessKind ?? term?.harnessKind ?? this.taskKind(task);
        const sessionId = kind ? (refs[i].find((r) => r.own)?.sessionId ?? null) : null;
        // No conversation to show: a run that stopped at its check, or a folder retention took.
        if (!kind || !sessionId) return;
        const source: HistorySource = s.result === 'chat' ? 'chat' : s.result === 'terminal' ? (remote.has(s.runId) ? 'remote' : 'terminal') : 'run';
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
            harnessKind: kind,
            sessionId,
            taskId,
            runId: s.runId,
            ...(source === 'run' ? { taskName: task.name } : {}),
          },
        });
      });
    }
    return { runs, known };
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
  private cachedFiles(): FileRef[] {
    return [...this.loadCache()].map(([file, c]) => ({
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
      const { runs, known } = await this.runEntries(this.d.projects());
      const files = await this.scanFiles();
      const old = this.loadCache();
      const next = new Map<string, CacheEntry>();
      for (const f of files) {
        const c = old.get(f.path);
        next.set(f.path, c && c.size === f.size && c.mtimeMs === f.mtimeMs && c.format === f.format ? { ...c, envIds: f.envIds } : { size: f.size, mtimeMs: f.mtimeMs, format: f.format, envIds: f.envIds });
      }
      this.cache = next;
      this.cacheDirty = true;
      this.index = { runs, known, files };
      return this.index;
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /** A transcript as an entry of the list, read when the cache doesn't have it; null when it isn't listed (Looper's own, a subagent's, or one with no messages). */
  private async resolve(f: FileRef, known: Set<string>, projects: Project[]): Promise<Entry | null> {
    const cache = this.loadCache();
    const old = cache.get(f.path);
    const c: CacheEntry = old && old.size === f.size && old.mtimeMs === f.mtimeMs && old.format === f.format ? old : { size: f.size, mtimeMs: f.mtimeMs, format: f.format, envIds: f.envIds };
    try {
      if (f.format === 'codex' && c.head === undefined) {
        c.head = await codexHead(f.path);
        this.cacheDirty = true;
      }
      if (f.format === 'codex' && (!c.head || c.head.subagent)) return null;
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
    if (o.fresh) index = await this.rescan();
    else if (this.index) index = this.index;
    else index = this.index = { ...(await this.runEntries(projects)), files: this.cachedFiles() };

    const project = o.folder.startsWith('project:') ? projects.find((p) => `project:${p.id}` === o.folder) : undefined;
    if (o.folder.startsWith('project:') && !project) return { items: [], more: false };
    // Claude files a folder of their own: a project's are in its folder's (the exact folder is checked once read).
    const projectDir = project ? claudeProjectFolder(project.cwd) : undefined;
    const passes = (e: Entry) => (o.showRuns || e.item.source !== 'run') && inFolderFilter(e.item, o.folder);
    type Candidate = { ts: number; run?: Entry; file?: FileRef };
    const candidates: Candidate[] = [
      ...index.runs.filter(passes).map((run) => ({ ts: run.item.lastActive, run })),
      ...index.files.filter((f) => !projectDir || f.format !== 'claude' || f.dir === projectDir).map((file) => ({ ts: file.mtimeMs, file })),
    ].sort((a, b) => b.ts - a.ts);

    const found: Entry[] = [];
    let at = 0;
    // An item the window showed keeps working until it's listed again.
    const show = (e: Entry) => this.entries.set(e.item.id, e);
    while (at < candidates.length && found.length < o.limit) {
      const batch = candidates.slice(at, at + Math.min(READ_AT_ONCE, o.limit - found.length));
      at += batch.length;
      const got = await Promise.all(batch.map((c) => (c.run ? Promise.resolve(c.run) : this.resolve(c.file!, index.known, projects))));
      const before = found.length;
      for (const e of got) if (e && passes(e)) found.push(e);
      // Only a batch that read a transcript took long enough to be worth showing on its way.
      if (progress && found.length > before && batch.some((c) => c.file)) {
        found.slice(before).forEach(show);
        progress({ items: found.map((e) => e.item), more: true });
      }
    }
    this.saveCache();
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
      return { rows, subagents: subagentsOf(await this.d.runSubagents(item.taskId, item.runId), rows) };
    }
    if (!transcript) return null;
    if (agentId !== undefined) {
      const file = path.join(transcript.path.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
      const acc = new TranscriptAccumulator({ sidechain: true });
      await eachLine(file, (l) => acc.addLine(l)).catch(() => undefined);
      return { rows: acc.rows, subagents: [] };
    }
    const { acc } = await readTranscript(transcript.path, transcript.format);
    const metas = transcript.format === 'claude' ? await this.d.subagentsAt(transcript.path) : [];
    return { rows: acc.rows, subagents: subagentsOf(metas, acc.rows) };
  }

  /** The whole conversation as compaction keeps it: Continue Compacted starts from it, and Search reads it. */
  async compactable(id: string): Promise<MessageRow[]> {
    const e = this.entries.get(id);
    if (!e) return [];
    if (e.item.runId) return this.d.compactableRun(e.item.taskId, e.item.runId);
    if (!e.transcript) return [];
    const { acc } = await readTranscript(e.transcript.path, e.transcript.format);
    return compactRows([...acc.evicted, ...acc.rows]);
  }

  /** Of the conversations the window has listed, the ones whose user or agent messages (not tool calls) contain the text, without regard to case. */
  async search(query: string, ids: string[]): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const listed = ids.filter((id) => this.entries.has(id));
    const hits = await mapLimit(listed, 4, async (id) => {
      const rows = await this.compactable(id).catch(() => [] as MessageRow[]);
      return rows.some((r) => (r.kind === 'prompt' || r.kind === 'guidance' || r.kind === 'agent') && r.text.toLowerCase().includes(q));
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
