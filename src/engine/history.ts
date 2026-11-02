import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chatTitle, type ChatInfo, type TerminalInfo } from '../shared/chat';
import { compactRows } from '../shared/compact';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import type { HistoryConversation, HistoryItem, HistorySource } from '../shared/history';
import type { MessageRow } from '../shared/messages';
import { FOLDER_TASK_PREFIX, normalizeFolder, projectIdOf, projectTaskId, sameFolder } from '../shared/projects';
import type { RunSummary } from '../shared/runs';
import type { Environment, Project, Settings, Task } from '../shared/types';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { CodexAccumulator, readRunSessionId, TranscriptAccumulator, transcriptHostPath, type SubagentMeta } from './messages';
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
 * hook payloads and Codex's thread file.
 */
export function runSessionRefs(runDir: string): { sessionId: string; classifier: boolean }[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return [];
  }
  const out: { sessionId: string; classifier: boolean }[] = [];
  const read = (name: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  for (const name of names) {
    let prefix: string;
    let id: unknown;
    if (name.endsWith('codex-session.json')) {
      prefix = name.slice(0, -'codex-session.json'.length);
      id = read(name)?.thread_id;
    } else {
      const m = /^(.*?)(?:session|stop)\.json$/.exec(name);
      if (!m) continue;
      prefix = m[1];
      const raw = read(name);
      id = raw?.session_id;
      const t = raw?.transcript_path;
      if ((typeof id !== 'string' || !id) && typeof t === 'string' && t.trim().endsWith('.jsonl')) {
        id = t.trim().split(/[\\/]/).pop()!.slice(0, -'.jsonl'.length);
      }
    }
    if (typeof id !== 'string' || !id.trim() || out.some((o) => o.sessionId === id)) continue;
    out.push({ sessionId: id.trim(), classifier: prefix.startsWith('classify-') });
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

/** The list's cache of transcripts, by host path: valid while the size and modified time stay the same. */
interface CacheEntry {
  size: number;
  mtimeMs: number;
  format: 'claude' | 'codex';
  /** The environment it was found in, and the project folder it belongs to. */
  envId?: string;
  cwd?: string;
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
  projectId: string;
  mtimeMs: number;
}

interface Entry {
  item: HistoryItem;
  transcript?: HistoryTranscript;
}

const LEDGER_SOURCES: Partial<Record<LedgerKind, HistorySource>> = { chat: 'chat', terminal: 'terminal', remote: 'remote', run: 'run' };

/**
 * The History window's conversations: the recorded runs of every project and
 * its tasks, and the Claude Code and Codex conversations started outside
 * Looper in a project's own folder (not a subfolder). A transcript that one
 * of Looper's run folders or the ledger names isn't listed again. Reading a
 * transcript over \\wsl.localhost is slow, so each one's title, last
 * activity and message count are cached by its size and modified time.
 */
export class HistoryService {
  private entries = new Map<string, Entry>();
  private cache: Map<string, CacheEntry> | null = null;
  private readonly dirs = new Map<string, Promise<ConfigDirs>>();
  private scanning: Promise<HistoryItem[]> | null = null;

  constructor(private readonly d: HistoryDeps) {}

  private cacheFile(): string {
    return path.join(this.d.dataDir, HISTORY_CACHE_FILE);
  }

  private loadCache(): Map<string, CacheEntry> {
    if (this.cache) return this.cache;
    const map = new Map<string, CacheEntry>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) if (v && typeof v.size === 'number' && typeof v.mtimeMs === 'number') map.set(k, v);
    } catch {
      /* none yet, or unreadable: it's only a cache */
    }
    this.cache = map;
    return map;
  }

  private saveCache(): void {
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
  private projectOf(taskId: string, projects: Project[]): Project | undefined {
    const pid = projectIdOf(taskId);
    if (pid) return projects.find((p) => p.id === pid);
    const task = this.d.findTask(taskId);
    if (!task) return undefined;
    if (task.projectId) return projects.find((p) => p.id === task.projectId);
    if (taskId.startsWith(FOLDER_TASK_PREFIX)) return projects.find((p) => p.environmentId === task.environmentId && sameFolder(p.cwd, task.cwd));
    return undefined;
  }

  private taskKind(task: Task | undefined): 'claude-code' | 'codex' | null {
    if (!task) return null;
    try {
      const kind = resolveHarness(task, resolveEnvironment(task, this.d.settings)).kind;
      return kind === 'custom' ? null : kind;
    } catch {
      return null;
    }
  }

  /** Looper's recorded runs of the projects and their tasks, and the session ids their folders name. */
  private runEntries(projects: Project[]): { entries: Entry[]; known: Set<string> } {
    const entries: Entry[] = [];
    const known = new Set<string>();
    const remote = this.d.remoteRuns();
    for (const taskId of this.d.runTaskIds()) {
      const project = this.projectOf(taskId, projects);
      if (!project) continue;
      const task = this.d.findTask(taskId);
      for (const s of this.d.summaries(taskId)) {
        const dir = this.d.runDir(taskId, s.runId);
        for (const r of runSessionRefs(dir)) known.add(r.sessionId);
        const chat = s.result === 'chat' ? this.d.readChatInfo(taskId, s.runId) : null;
        const term = s.result === 'terminal' ? this.d.readTerminalInfo(taskId, s.runId) : null;
        if (chat?.resumedSession) known.add(chat.resumedSession);
        const kind = chat?.harnessKind ?? term?.harnessKind ?? this.taskKind(task);
        const sessionId = kind ? readRunSessionId(dir, kind) : null;
        // No conversation to show: a run that stopped at its check, or a folder retention took.
        if (!kind || !sessionId) continue;
        const source: HistorySource = s.result === 'chat' ? 'chat' : s.result === 'terminal' ? (remote.has(s.runId) ? 'remote' : 'terminal') : 'run';
        const title = (chat?.title || term?.title || (source === 'run' ? s.details : '') || task?.name || 'Untitled chat').trim();
        entries.push({
          item: {
            id: `run:${taskId}:${s.runId}`,
            source,
            projectId: project.id,
            title,
            lastActive: Date.parse(s.endTs) || Date.parse(s.startTs) || 0,
            harnessKind: kind,
            sessionId,
            taskId,
            runId: s.runId,
            ...(source === 'run' ? { taskName: task?.name ?? taskId } : {}),
          },
        });
      }
    }
    return { entries, known };
  }

  /** A transcript as an entry of the list, or null when it isn't listed (Looper's own, or one with no messages). */
  private outsideEntry(file: string, format: 'claude' | 'codex', c: CacheEntry, project: Project, known: Set<string>): Entry | null {
    const meta = c.meta;
    if (!meta || meta.messages === 0 || known.has(meta.sessionId)) return null;
    const ledger = this.d.ledger.get(meta.sessionId);
    const source: HistorySource | undefined = ledger ? LEDGER_SOURCES[ledger.kind] : format === 'claude' ? 'claude-code' : 'codex';
    if (!source) return null;
    const harnessKind = format === 'claude' ? 'claude-code' : 'codex';
    const id = `file:${crypto.createHash('sha1').update(file).digest('hex').slice(0, 16)}`;
    const taskName = ledger?.kind === 'run' ? (this.d.findTask(ledger.taskId)?.name ?? ledger.taskName) : undefined;
    return {
      item: {
        id,
        source,
        projectId: project.id,
        title: meta.title || 'Untitled chat',
        lastActive: meta.lastActive,
        harnessKind,
        sessionId: meta.sessionId,
        taskId: ledger?.taskId ?? projectTaskId(project.id),
        ...(source === 'run' ? { taskName: taskName ?? ledger?.taskId } : {}),
      },
      transcript: { path: file, format, sessionId: meta.sessionId, harnessKind, title: meta.title, projectId: project.id, mtimeMs: c.mtimeMs },
    };
  }

  /** The cache entry of a file as it is now: read again when its size or modified time changed. */
  private async fresh(file: string, format: 'claude' | 'codex', seen: Map<string, CacheEntry>, full: (head: CodexHead | null | undefined) => boolean): Promise<CacheEntry | null> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return null;
    }
    const old = this.loadCache().get(file);
    const c: CacheEntry = old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.format === format ? { ...old } : { size: st.size, mtimeMs: st.mtimeMs, format };
    try {
      if (format === 'codex' && c.head === undefined) c.head = await codexHead(file);
      if (!c.meta && full(c.head)) {
        const meta = await transcriptMeta(file, format, st.mtimeMs);
        c.meta = c.head ? { ...meta, sessionId: c.head.sessionId } : meta;
      }
    } catch (err) {
      this.d.log.warn(`history: cannot read ${file}: ${errMsg(err)}`);
      return null;
    }
    seen.set(file, c);
    return c;
  }

  private async listFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    return names.filter(match).map((n) => path.join(dir, n));
  }

  /** `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
  private async codexRollouts(home: string): Promise<string[]> {
    const root = path.join(home, 'sessions');
    const out: string[] = [];
    const sub = async (dir: string) => (await fs.promises.readdir(dir).catch(() => [] as string[])).map((n) => path.join(dir, n));
    for (const year of await sub(root)) {
      for (const month of await sub(year)) {
        for (const day of await sub(month)) out.push(...(await this.listFiles(day, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))));
      }
    }
    return out;
  }

  /** The conversations from outside Looper's runs, read from the environments' folders. */
  private async scanOutside(projects: Project[], known: Set<string>): Promise<Entry[]> {
    const seen = new Map<string, CacheEntry>();
    const out: Entry[] = [];
    const envs = new Map<string, Environment>();
    for (const p of projects) {
      const env = this.d.settings.environments.find((e) => e.id === p.environmentId);
      if (env) envs.set(env.id, env);
    }
    for (const env of envs.values()) {
      const inEnv = projects.filter((p) => p.environmentId === env.id);
      const dirs = await this.configDirs(env).catch((): ConfigDirs => ({ claude: [], codex: [] }));
      for (const config of dirs.claude) {
        for (const project of inEnv) {
          const folder = path.join(config, 'projects', claudeProjectFolder(project.cwd));
          for (const file of await this.listFiles(folder, (n) => n.endsWith('.jsonl'))) {
            const c = await this.fresh(file, 'claude', seen, () => true);
            if (!c) continue;
            c.envId = env.id;
            c.cwd = c.meta?.cwd ?? project.cwd;
            // The folder's name is lossy (a "-" and a "/" both become "-"): only the project's exact folder counts.
            if (!sameFolder(c.cwd, project.cwd)) continue;
            const e = this.outsideEntry(file, 'claude', c, project, known);
            if (e) out.push(e);
          }
        }
      }
      for (const home of dirs.codex) {
        for (const file of await this.codexRollouts(home)) {
          const projectOf = (head: CodexHead | null | undefined) => (head && !head.subagent && head.cwd ? inEnv.find((p) => sameFolder(p.cwd, head.cwd!)) : undefined);
          const c = await this.fresh(file, 'codex', seen, (head) => !!projectOf(head));
          const project = c ? projectOf(c.head) : undefined;
          if (!c || !project) continue;
          c.envId = env.id;
          c.cwd = project.cwd;
          const e = this.outsideEntry(file, 'codex', c, project, known);
          if (e) out.push(e);
        }
      }
    }
    this.cache = seen;
    this.saveCache();
    return out;
  }

  /** The cached conversations from outside Looper, without reading a folder. */
  private cachedOutside(projects: Project[], known: Set<string>): Entry[] {
    const out: Entry[] = [];
    for (const [file, c] of this.loadCache()) {
      if (!c.meta || !c.cwd || !c.envId) continue;
      const project = projects.find((p) => p.environmentId === c.envId && sameFolder(p.cwd, c.cwd!));
      const e = project ? this.outsideEntry(file, c.format, c, project, known) : null;
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * The list. `fresh`: read the folders again (slow over \\wsl.localhost);
   * else the cached conversations from outside Looper, which show first.
   */
  async list(fresh: boolean): Promise<HistoryItem[]> {
    if (fresh && this.scanning) return this.scanning;
    const run = async (): Promise<HistoryItem[]> => {
      const projects = this.d.projects();
      const { entries, known } = this.runEntries(projects);
      const outside = fresh ? await this.scanOutside(projects, known) : this.cachedOutside(projects, known);
      const all = [...entries, ...outside];
      // An item the window shows keeps working until the next list.
      const next = new Map(fresh ? [] : this.entries);
      for (const e of all) next.set(e.item.id, e);
      this.entries = next;
      return all.map((e) => e.item);
    };
    if (!fresh) return run();
    this.scanning = run().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
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

  /** The listed conversations whose user or agent messages (not tool calls) contain the text, without regard to case. */
  async search(query: string): Promise<string[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ids = [...this.entries.keys()];
    const found: string[] = [];
    const BATCH = 4;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(
        ids.slice(i, i + BATCH).map(async (id) => {
          const rows = await this.compactable(id).catch(() => [] as MessageRow[]);
          if (rows.some((r) => (r.kind === 'prompt' || r.kind === 'guidance' || r.kind === 'agent') && r.text.toLowerCase().includes(q))) found.push(id);
        }),
      );
    }
    return found;
  }
}
