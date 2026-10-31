import fs from 'node:fs';
import path from 'node:path';
import type { MessageRow } from '../shared/messages';
import type { WorkflowAgent, WorkflowAgentStatus, WorkflowPhase, WorkflowRun, WorkflowStatus } from '../shared/workflows';
import { subagentStatsOfLine } from './context';

/**
 * Claude Code workflow runs (the Workflow tool), read from the files Claude
 * Code writes next to the session's transcript `<session>.jsonl`
 * (claude 2.1.3xx, read from live and finished runs in 2026-06..10):
 *
 * - `<session>/subagents/workflows/<runId>/journal.jsonl`: one record per
 *   event, appended as it happens: `{type:'launched'}` once, then
 *   `{type:'started', key, agentId, label, phase}` when the script's agent()
 *   starts one (older runs leave out label and phase), `{type:'result', key,
 *   agentId, result}` (a string, or the schema's object) and `{type:'failed',
 *   key, agentId}`. No times, no log lines, and nothing marks the run's end.
 *   A resumed run (resumeFromRunId) appends to the same journal without a new
 *   `launched`; an agent that failed before starts again under a new id.
 * - `agent-<id>.meta.json` beside it, written when the agent starts (its mtime
 *   is the start): `{agentType:'workflow-subagent', description: <label>,
 *   workflowPhase, model: <the alias the script asked for>}`. Unlike a plain
 *   subagent's it has no toolUseId.
 * - `agent-<id>.jsonl`: the agent's transcript, in the plain subagent format.
 *   Its mtime is the agent's last activity, so a finished agent's end. A
 *   failed agent's last record is an API error (`isApiErrorMessage`, model
 *   `<synthetic>`) whose text says why.
 * - `<session>/workflows/<runId>.json`, written when the run ends (completed,
 *   failed or killed), after the journal's last line: the run's status, times,
 *   logs, result and `workflowProgress` (each agent's state, times, tokens,
 *   tool calls and result preview). A resumed run overwrites it when it ends
 *   again, so it describes the run only while it's newer than the journal.
 * - `<session>/workflows/scripts/<name>-<runId>.js`: the script (a resumed run
 *   may name another file); its `export const meta = {name, description,
 *   phases: [{title, detail}]}` lists the phases before they start.
 *
 * The parent's transcript has the Workflow call; its result names the task id,
 * transcript dir and script file, and a task notification for that task id
 * reports the end. Files are polled, not watched: they're written by another
 * OS through a 9p mount on Windows (see FileSignalWatcher).
 */

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Results and the run's return value past this are cut. */
const MAX_RESULT = 4000;
/** How much of a running agent's transcript the first read takes from its end. */
const TAIL_START = 256 * 1024;
/** Runs kept per session; the oldest past it are left out. */
const MAX_RUNS = 20;
/** A final state written within this of the journal's last change is the run's end. */
const STATE_SLACK_MS = 1000;
const RUN_ID = /^wf_[\w-]+$/;
const AGENT_ID = /^[\w.-]+$/;

function capText(text: string, max = MAX_RESULT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/** A result as one text: a string as it is, anything else as indented JSON. */
export function resultText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return capText(v);
  try {
    return capText(JSON.stringify(v, null, 2));
  } catch {
    return undefined;
  }
}

/** The folder of a session's own files: its transcript path without `.jsonl`. */
export function sessionDir(transcript: string): string {
  return transcript.replace(/\.jsonl$/i, '');
}

/** Where a session's workflow runs keep their journals and agent transcripts. */
export function workflowRunsDir(transcript: string): string {
  return path.join(sessionDir(transcript), 'subagents', 'workflows');
}

/** A workflow agent's transcript under the session, or null when no run of the session has it. */
export async function workflowAgentTranscript(transcript: string, agentId: string): Promise<string | null> {
  if (!AGENT_ID.test(agentId)) return null;
  const dir = workflowRunsDir(transcript);
  const runs = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const run of runs) {
    if (!RUN_ID.test(run)) continue;
    const file = path.join(dir, run, `agent-${agentId}.jsonl`);
    if (await fs.promises.stat(file).then(() => true, () => false)) return file;
  }
  return null;
}

// ---------- the script's meta ----------

/**
 * A reader for the object literal the script exports as `meta`: objects,
 * arrays, plain strings, numbers and booleans. The script is never run; any
 * other expression (a template with ${}, a call, a name) reads as undefined.
 */
class LiteralReader {
  i = 0;
  constructor(private readonly s: string) {}

  private skip(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') this.i++;
      else if (this.s.startsWith('//', this.i)) {
        const nl = this.s.indexOf('\n', this.i);
        this.i = nl === -1 ? this.s.length : nl + 1;
      } else if (this.s.startsWith('/*', this.i)) {
        const end = this.s.indexOf('*/', this.i + 2);
        this.i = end === -1 ? this.s.length : end + 2;
      } else return;
    }
  }

  value(depth = 0): unknown {
    if (depth > 20) throw new Error('too deep');
    this.skip();
    const c = this.s[this.i];
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === "'" || c === '"' || c === '`') return this.string(c);
    const m = /^(?:-?\d+(?:\.\d+)?|true|false|null)\b/.exec(this.s.slice(this.i, this.i + 32));
    if (m) {
      this.i += m[0].length;
      return JSON.parse(m[0]) as unknown;
    }
    this.other();
    return undefined;
  }

  /** Skips an expression it can't read, up to the next , } or ] at its own depth. */
  private other(): void {
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "'" || c === '"' || c === '`') {
        this.string(c);
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) return;
        depth--;
      } else if (c === ',' && depth === 0) return;
      this.i++;
    }
  }

  private string(q: string): string | undefined {
    this.i++;
    let out = '';
    let plain = true;
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === q) return plain ? out : undefined;
      if (c === '\\') {
        const e = this.s[this.i++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '\n' ? '' : (e ?? '');
      } else if (q === '`' && c === '$' && this.s[this.i] === '{') {
        plain = false;
        this.i++;
        this.other();
        this.i++;
      } else out += c;
    }
    throw new Error('unterminated string');
  }

  private key(): string {
    this.skip();
    const c = this.s[this.i];
    if (c === "'" || c === '"') return this.string(c) ?? '';
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) throw new Error('bad key');
    this.i += m[0].length;
    return m[0];
  }

  private object(depth: number): Rec {
    this.i++;
    const out: Rec = {};
    for (;;) {
      this.skip();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const k = this.key();
      this.skip();
      if (this.s[this.i] !== ':') throw new Error('bad object');
      this.i++;
      out[k] = this.value(depth + 1);
      this.skip();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new Error('bad object');
    }
  }

  private array(depth: number): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.skip();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      out.push(this.value(depth + 1));
      this.skip();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') throw new Error('bad array');
    }
  }
}

export interface ScriptMeta {
  name?: string;
  description?: string;
  phases: { title: string; detail?: string }[];
}

/** The name, description and phases a workflow script's `export const meta` declares; null when it has none it can read. */
export function parseScriptMeta(script: string): ScriptMeta | null {
  const m = /export\s+const\s+meta\s*=\s*(?=\{)/.exec(script);
  if (!m) return null;
  let meta: Rec | null;
  try {
    const r = new LiteralReader(script);
    r.i = m.index + m[0].length;
    meta = obj(r.value());
  } catch {
    return null;
  }
  if (!meta) return null;
  return {
    ...(str(meta.name) ? { name: str(meta.name) } : {}),
    ...(str(meta.description) ? { description: str(meta.description) } : {}),
    phases: phasesOf(meta.phases),
  };
}

function phasesOf(v: unknown): { title: string; detail?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { title: string; detail?: string }[] = [];
  for (const p of v) {
    const title = str(obj(p)?.title);
    const detail = str(obj(p)?.detail);
    if (title) out.push({ title, ...(detail ? { detail } : {}) });
  }
  return out;
}

// ---------- the parent's Workflow calls ----------

/** A Workflow call in the parent's conversation, from its result text and (once known) its background status. */
export interface WorkflowLaunch {
  runId: string;
  taskId?: string;
  transcriptDir: string;
  scriptPath?: string;
  summary?: string;
  /** When the call was made (ms since the epoch). */
  at?: number;
  /** How its task notification says it ended; running until then. Unknown when the row doesn't track it. */
  status?: WorkflowStatus;
}

/**
 * The Workflow calls a conversation's rows made, oldest first. The result
 * reads "Workflow launched in background. Task ID: <id>\nSummary: …\n
 * Transcript dir: <dir>\nScript file: <file>\n…" (claude 2.1.314).
 */
export function workflowLaunchesOf(rows: MessageRow[]): WorkflowLaunch[] {
  const out: WorkflowLaunch[] = [];
  for (const r of rows) {
    if (r.kind !== 'tool' || r.tool !== 'Workflow' || !r.result || r.resultError) continue;
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(r.result!)?.[1]?.trim();
    const transcriptDir = field('Transcript dir');
    const runId = transcriptDir?.split(/[\\/]/).filter(Boolean).pop();
    if (!transcriptDir || !runId || !RUN_ID.test(runId)) continue;
    const taskId = /Task ID: (\S+)/.exec(r.result)?.[1];
    const at = r.ts ? Date.parse(r.ts) : NaN;
    const bg = r.background?.status;
    out.push({
      runId,
      transcriptDir,
      ...(taskId ? { taskId } : {}),
      ...(field('Script file') ? { scriptPath: field('Script file') } : {}),
      ...(field('Summary') ? { summary: field('Summary') } : {}),
      ...(Number.isFinite(at) ? { at } : {}),
      ...(bg ? { status: bg === 'completed' ? 'completed' : bg === 'running' ? 'running' : bg === 'failed' ? 'failed' : 'stopped' } : {}),
    });
  }
  return out;
}

// ---------- incremental file reading ----------

/** New complete lines of a growing file, reading only what was appended since the last call. */
export class LineTail {
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);
  private started = false;

  /** `fromEnd`: the first read takes only this many bytes from the end (and drops the partial first line). */
  constructor(
    readonly file: string,
    private readonly fromEnd?: number,
  ) {}

  /** The lines appended since the last read; throws when the file can't be read (yet). */
  async read(): Promise<string[]> {
    const st = await fs.promises.stat(this.file);
    let skipFirst = false;
    if (!this.started) {
      this.started = true;
      if (this.fromEnd !== undefined && st.size > this.fromEnd) {
        this.offset = st.size - this.fromEnd;
        skipFirst = true;
      }
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }
    if (st.size === this.offset) return [];
    const fh = await fs.promises.open(this.file, 'r');
    const lines: string[] = [];
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      let data = Buffer.concat([this.remainder, buf.subarray(0, bytesRead)]);
      let nl: number;
      while ((nl = data.indexOf(0x0a)) !== -1) {
        const line = data.subarray(0, nl).toString('utf8').trim();
        data = data.subarray(nl + 1);
        if (skipFirst) skipFirst = false;
        else if (line) lines.push(line);
      }
      this.remainder = Buffer.from(data);
    } finally {
      await fh.close();
    }
    return lines;
  }
}

// ---------- the journal ----------

export type JournalEvent =
  | { type: 'launched' }
  | { type: 'started'; key: string; agentId: string; label?: string; phase?: string }
  | { type: 'result'; key: string; agentId: string; result: unknown }
  | { type: 'failed'; key: string; agentId: string };

/** One journal line as an event; null for a torn line or a type it doesn't know. */
export function parseJournalLine(line: string): JournalEvent | null {
  let rec: Rec | null;
  try {
    rec = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!rec) return null;
  if (rec.type === 'launched') return { type: 'launched' };
  const key = typeof rec.key === 'string' ? rec.key : '';
  const agentId = str(rec.agentId);
  if (!agentId || !AGENT_ID.test(agentId)) return null;
  if (rec.type === 'started') {
    return { type: 'started', key, agentId, ...(str(rec.label) ? { label: str(rec.label) } : {}), ...(str(rec.phase) ? { phase: str(rec.phase) } : {}) };
  }
  if (rec.type === 'result') return { type: 'result', key, agentId, result: rec.result };
  if (rec.type === 'failed') return { type: 'failed', key, agentId };
  return null;
}

// ---------- the final state ----------

interface FinalAgent {
  agentId: string;
  label?: string;
  phase?: string;
  model?: string;
  state?: string;
  startedAt?: number;
  durationMs?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

export interface FinalState {
  /** When Claude Code wrote it (ms since the epoch). */
  writtenAt: number;
  status: WorkflowStatus;
  taskId?: string;
  name?: string;
  summary?: string;
  startedAt?: number;
  durationMs?: number;
  phases: { title: string; detail?: string }[];
  logs: string[];
  result?: string;
  error?: string;
  script?: string;
  agents: FinalAgent[];
}

/** Claude Code's word for how a run ended, as a WorkflowStatus: killed is stopped. */
function endStatus(s: unknown): WorkflowStatus {
  if (s === 'completed') return 'completed';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled') return 'stopped';
  return 'failed';
}

/** The run state file Claude Code writes when a run ends; null when it isn't one. */
export function parseFinalState(raw: unknown): FinalState | null {
  const r = obj(raw);
  const writtenAt = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (!r || !Number.isFinite(writtenAt)) return null;
  const agents: FinalAgent[] = [];
  for (const p of Array.isArray(r.workflowProgress) ? r.workflowProgress : []) {
    const a = obj(p);
    const agentId = str(a?.agentId);
    if (!a || a.type !== 'workflow_agent' || !agentId) continue;
    agents.push({
      agentId,
      ...(str(a.label) ? { label: str(a.label) } : {}),
      ...(str(a.phaseTitle) ? { phase: str(a.phaseTitle) } : {}),
      ...(str(a.model) ? { model: str(a.model) } : {}),
      ...(str(a.state) ? { state: str(a.state) } : {}),
      ...(num(a.startedAt) !== undefined ? { startedAt: num(a.startedAt) } : {}),
      ...(num(a.durationMs) !== undefined ? { durationMs: num(a.durationMs) } : {}),
      ...(num(a.tokens) !== undefined ? { tokens: num(a.tokens) } : {}),
      ...(num(a.toolCalls) !== undefined ? { toolCalls: num(a.toolCalls) } : {}),
      ...(str(a.lastToolName) ? { lastToolName: str(a.lastToolName) } : {}),
      ...(str(a.lastToolSummary) ? { lastToolSummary: str(a.lastToolSummary) } : {}),
      ...(str(a.resultPreview) ? { resultPreview: str(a.resultPreview) } : {}),
    });
  }
  const error = typeof r.error === 'string' ? r.error.split('\n')[0].trim() : undefined;
  const result = resultText(r.result);
  return {
    writtenAt,
    status: endStatus(r.status),
    ...(str(r.taskId) ? { taskId: str(r.taskId) } : {}),
    ...(str(r.workflowName) ? { name: str(r.workflowName) } : {}),
    ...(str(r.summary) ? { summary: str(r.summary) } : {}),
    ...(num(r.startTime) !== undefined ? { startedAt: num(r.startTime) } : {}),
    ...(num(r.durationMs) !== undefined ? { durationMs: num(r.durationMs) } : {}),
    phases: phasesOf(r.phases),
    logs: Array.isArray(r.logs) ? r.logs.filter((l): l is string => typeof l === 'string') : [],
    ...(result !== undefined ? { result } : {}),
    ...(error ? { error } : {}),
    ...(typeof r.script === 'string' ? { script: r.script } : {}),
    agents,
  };
}

// ---------- an agent's transcript ----------

/** The input fields a tool centers on, tried in order for its one line. */
const PREVIEW_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill'];

function toolLine(input: unknown): string {
  const o = obj(input);
  const v = o ? (PREVIEW_KEYS.map((k) => str(o[k])).find(Boolean) ?? Object.values(o).map(str).find(Boolean)) : str(input);
  const line = (v ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** What an agent's transcript says so far: its latest tool call and response, and the API error it ended with. */
interface AgentFacts {
  lastTool?: { name: string; preview: string };
  modelId?: string;
  effort?: string;
  contextTokens?: number;
  error?: string;
}

/** Folds an agent transcript's lines into its facts; only assistant records are parsed. */
export function addAgentLine(facts: AgentFacts, line: string): void {
  if (!line.includes('"role":"assistant"')) return;
  let rec: Rec | null;
  try {
    rec = obj(JSON.parse(line));
  } catch {
    return;
  }
  if (rec?.type !== 'assistant') return;
  const msg = obj(rec.message);
  const content = Array.isArray(msg?.content) ? (msg.content as unknown[]) : [];
  if (rec.isApiErrorMessage === true) {
    const text = content.map((b) => str(obj(b)?.text)).find(Boolean);
    facts.error = text ?? (str(rec.error) || 'The agent stopped on an error.');
    return;
  }
  for (const b of content) {
    const block = obj(b);
    if (block?.type === 'tool_use' && typeof block.name === 'string') facts.lastTool = { name: block.name, preview: toolLine(block.input) };
  }
  const stats = subagentStatsOfLine(line);
  if (stats) {
    if (stats.model) facts.modelId = stats.model;
    if (stats.effort) facts.effort = stats.effort;
    facts.contextTokens = stats.tokens;
  }
}

// ---------- one run ----------

interface AgentTrack {
  agentId: string;
  /** The order it started in. */
  order: number;
  label?: string;
  phase?: string;
  model?: string;
  status: 'running' | 'done' | 'failed';
  result?: string;
  startedAt?: number;
  /** Its transcript's mtime: the last activity, so a finished agent's end. */
  lastAt?: number;
  metaRead: boolean;
  tail?: LineTail;
  facts: AgentFacts;
  /** Its transcript was read after it finished: what it says won't change. */
  settled: boolean;
}

export interface ReadOptions {
  /** The parent's Workflow call for this run, newest last: its status, when known, is the run's. */
  launch?: WorkflowLaunch;
  /** Read the running agents' transcripts too (latest tool call, model, context): for the session on screen. */
  detail?: boolean;
  /** The session ended: a run with no end recorded stopped with it. */
  sessionEnded?: boolean;
}

/** One workflow run's files, read again only where they changed. */
export class WorkflowRunReader {
  readonly runId: string;
  private readonly journal: LineTail;
  private journalMtime = 0;
  private readonly agents = new Map<string, AgentTrack>();
  private final: FinalState | null = null;
  private finalMtime = 0;
  private meta: ScriptMeta | null = null;
  private metaFrom: string | null = null;

  constructor(
    readonly dir: string,
    /** The session's own folder (its transcript path without .jsonl). */
    private readonly session: string,
  ) {
    this.runId = path.basename(dir);
    this.journal = new LineTail(path.join(dir, 'journal.jsonl'));
  }

  private agent(agentId: string): AgentTrack {
    let a = this.agents.get(agentId);
    if (!a) {
      a = { agentId, order: this.agents.size, status: 'running', metaRead: false, facts: {}, settled: false };
      this.agents.set(agentId, a);
    }
    return a;
  }

  private async readJournal(): Promise<void> {
    let lines: string[];
    try {
      this.journalMtime = Math.round((await fs.promises.stat(this.journal.file)).mtimeMs);
      lines = await this.journal.read();
    } catch {
      return; // not written yet
    }
    for (const line of lines) {
      const e = parseJournalLine(line);
      if (!e || e.type === 'launched') continue;
      const a = this.agent(e.agentId);
      if (e.type === 'started') {
        a.label = e.label ?? a.label;
        a.phase = e.phase ?? a.phase;
      } else if (e.type === 'result') {
        a.status = 'done';
        a.result = resultText(e.result);
      } else a.status = 'failed';
    }
  }

  private async readFinal(): Promise<void> {
    const file = path.join(this.session, 'workflows', `${this.runId}.json`);
    let mtime: number;
    try {
      mtime = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      this.final = null;
      return;
    }
    if (mtime === this.finalMtime) return;
    try {
      this.final = parseFinalState(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      this.finalMtime = mtime;
    } catch {
      /* still being written: read it on the next poll */
    }
  }

  /** The script's meta, from the launch's script file, the session's scripts folder, or the final state's copy. */
  private async readMeta(launch?: WorkflowLaunch): Promise<void> {
    if (this.final?.script && this.metaFrom !== 'final') {
      this.meta = parseScriptMeta(this.final.script);
      this.metaFrom = 'final';
      return;
    }
    if (this.metaFrom) return;
    const scripts = path.join(this.session, 'workflows', 'scripts');
    const named = (await fs.promises.readdir(scripts).catch(() => [] as string[])).find((n) => n.endsWith(`-${this.runId}.js`));
    const candidates = [...(launch?.scriptPath ? [launch.scriptPath] : []), ...(named ? [path.join(scripts, named)] : [])];
    for (const file of candidates) {
      try {
        this.meta = parseScriptMeta(await fs.promises.readFile(file, 'utf8'));
        this.metaFrom = file;
        return;
      } catch {
        /* another OS's path, or gone: try the next */
      }
    }
  }

  private async readAgentMeta(a: AgentTrack): Promise<void> {
    if (a.metaRead) return;
    const file = path.join(this.dir, `agent-${a.agentId}.meta.json`);
    try {
      const [st, text] = await Promise.all([fs.promises.stat(file), fs.promises.readFile(file, 'utf8')]);
      const m = obj(JSON.parse(text));
      a.startedAt = Math.round(st.mtimeMs);
      a.label ??= str(m?.description);
      a.phase ??= str(m?.workflowPhase);
      a.model = str(m?.model);
      a.metaRead = true;
    } catch {
      /* not written yet, or torn */
    }
  }

  /** The transcript's mtime (the agent's last activity) and, with `lines`, what its new lines say. */
  private async readAgentTranscript(a: AgentTrack, lines: boolean): Promise<void> {
    if (a.settled) return;
    const file = path.join(this.dir, `agent-${a.agentId}.jsonl`);
    try {
      a.lastAt = Math.round((await fs.promises.stat(file)).mtimeMs);
    } catch {
      return; // not written yet
    }
    if (!lines) return;
    a.tail ??= new LineTail(file, TAIL_START);
    try {
      for (const line of await a.tail.read()) addAgentLine(a.facts, line);
    } catch {
      return;
    }
    // A failed agent's error line may land after the journal's failure: it's read again until it has one.
    if (a.status === 'done' || (a.status === 'failed' && a.facts.error)) {
      a.settled = true;
      a.tail = undefined;
    }
  }

  /** Whether the final state describes this run as it is now, not a launch before a resume. */
  private finalIsCurrent(): boolean {
    return this.final !== null && this.final.writtenAt + STATE_SLACK_MS >= this.journalMtime;
  }

  async read(opts: ReadOptions = {}): Promise<WorkflowRun> {
    await this.readJournal();
    await this.readFinal();
    await this.readMeta(opts.launch);
    const current = this.finalIsCurrent() ? this.final : null;
    // The parent's task notification ends the run; without one (the row doesn't track it), the final state does.
    // A resumed run is running again though the final state of its earlier launch is still there.
    let status: WorkflowStatus;
    if (opts.launch?.status && opts.launch.status !== 'running') status = current?.status ?? opts.launch.status;
    else if (opts.launch?.status === 'running') status = opts.sessionEnded ? (current?.status ?? 'stopped') : 'running';
    else if (current) status = current.status;
    else status = opts.sessionEnded ? 'stopped' : 'running';
    const ended = status !== 'running';

    const finalAgents = new Map((current?.agents ?? []).map((a) => [a.agentId, a]));
    for (const fa of current?.agents ?? []) {
      const a = this.agent(fa.agentId);
      a.label ??= fa.label;
      a.phase ??= fa.phase;
      if (a.status === 'running' && fa.state === 'done') a.status = 'done';
      else if (a.status === 'running' && fa.state === 'error') a.status = 'failed';
    }
    await Promise.all(
      [...this.agents.values()].map(async (a) => {
        await this.readAgentMeta(a);
        const fa = finalAgents.get(a.agentId);
        // The final state has a finished agent's times, tool and result; a failed agent's transcript tells why,
        // so it's read even for a session that isn't on screen.
        if (!fa || fa.durationMs === undefined || a.status === 'failed') {
          await this.readAgentTranscript(a, a.status === 'failed' || (!fa && opts.detail === true));
        }
      }),
    );

    const endedAt = ended
      ? current?.startedAt !== undefined && current.durationMs !== undefined
        ? current.startedAt + current.durationMs
        : (current?.writtenAt ?? this.journalMtime)
      : undefined;
    const agents = [...this.agents.values()]
      .sort((x, y) => x.order - y.order)
      .map((a) => this.agentView(a, finalAgents.get(a.agentId), endedAt));
    const phases = this.phasesOf(agents, current);
    const startedAt = current?.startedAt ?? opts.launch?.at ?? minOf(agents.map((a) => a.startedAt));
    const description = this.meta?.description ?? current?.summary ?? opts.launch?.summary;
    const taskId = opts.launch?.taskId ?? current?.taskId;
    return {
      runId: this.runId,
      ...(taskId ? { taskId } : {}),
      name: this.meta?.name ?? current?.name ?? this.runId,
      ...(description ? { description } : {}),
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      phases,
      logs: current?.logs ?? [],
      ...(current?.result !== undefined ? { result: current.result } : {}),
      ...(current?.error ? { error: current.error } : {}),
    };
  }

  /** `runEndedAt`: when the run ended, undefined while it runs; an agent it stopped ended then at the latest. */
  private agentView(a: AgentTrack, fa: FinalAgent | undefined, runEndedAt: number | undefined): WorkflowAgent {
    const status: WorkflowAgentStatus = a.status === 'running' && runEndedAt !== undefined ? 'stopped' : a.status;
    const startedAt = fa?.startedAt ?? a.startedAt;
    const endedAt =
      status === 'running'
        ? undefined
        : fa?.startedAt !== undefined && fa.durationMs !== undefined
          ? fa.startedAt + fa.durationMs
          : status === 'stopped' && runEndedAt !== undefined
            ? Math.min(a.lastAt ?? runEndedAt, runEndedAt)
            : (a.lastAt ?? runEndedAt);
    const lastTool = a.facts.lastTool ?? (fa?.lastToolName ? { name: fa.lastToolName, preview: fa.lastToolSummary ?? '' } : undefined);
    const modelId = a.facts.modelId ?? fa?.model;
    const result = a.result ?? fa?.resultPreview;
    return {
      agentId: a.agentId,
      label: a.label ?? fa?.label ?? a.agentId,
      ...(a.phase ? { phase: a.phase } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(modelId ? { modelId } : {}),
      ...(a.facts.effort ? { effort: a.facts.effort } : {}),
      ...(a.facts.contextTokens !== undefined ? { contextTokens: a.facts.contextTokens } : {}),
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(lastTool ? { lastTool } : {}),
      ...(fa?.toolCalls !== undefined ? { toolCalls: fa.toolCalls } : {}),
      ...(fa?.tokens !== undefined ? { tokens: fa.tokens } : {}),
      ...(result !== undefined && status === 'done' ? { result } : {}),
      ...(status === 'failed' && a.facts.error ? { error: a.facts.error } : {}),
    };
  }

  /** The script's phases in order, then any other phase an agent named in the order they started; agents with none last. */
  private phasesOf(agents: WorkflowAgent[], current: FinalState | null): WorkflowPhase[] {
    const declared = this.meta?.phases.length ? this.meta.phases : (current?.phases ?? []);
    const phases: WorkflowPhase[] = declared.map((p) => ({ ...p, agents: [] }));
    const byTitle = new Map(phases.map((p) => [p.title, p]));
    let none: WorkflowPhase | undefined;
    for (const a of agents) {
      if (!a.phase) {
        none ??= { title: '', agents: [] };
        none.agents.push(a);
        continue;
      }
      let p = byTitle.get(a.phase);
      if (!p) {
        p = { title: a.phase, agents: [] };
        phases.push(p);
        byTitle.set(a.phase, p);
      }
      p.agents.push(a);
    }
    return none ? [...phases, none] : phases;
  }
}

function minOf(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length ? Math.min(...defined) : undefined;
}

// ---------- a session's runs ----------

/** A session's workflow runs, newest first; each run's files are read again only where they changed. */
export class SessionWorkflows {
  private readonly runs = new Map<string, WorkflowRunReader>();

  /** `transcript`: the session's transcript, as a path this host can open. */
  constructor(readonly transcript: string) {}

  /** The run folders under the session, newest first (by the journal's last change), at most MAX_RUNS. */
  private async runDirs(): Promise<string[]> {
    const dir = workflowRunsDir(this.transcript);
    const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => RUN_ID.test(n));
    const dated = await Promise.all(
      names.map(async (n) => ({
        dir: path.join(dir, n),
        at: await fs.promises.stat(path.join(dir, n, 'journal.jsonl')).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      })),
    );
    return dated
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RUNS)
      .map((d) => d.dir);
  }

  /**
   * Every run's state now. `launches` are the parent's Workflow calls (see
   * workflowLaunchesOf): a run's newest one gives its status and task id.
   */
  async read(opts: { launches?: WorkflowLaunch[]; detail?: boolean; sessionEnded?: boolean } = {}): Promise<WorkflowRun[]> {
    const dirs = await this.runDirs();
    const keep = new Set(dirs);
    for (const d of [...this.runs.keys()]) if (!keep.has(d)) this.runs.delete(d);
    const launchOf = new Map<string, WorkflowLaunch>();
    for (const l of opts.launches ?? []) launchOf.set(l.runId, l);
    return Promise.all(
      dirs.map((d) => {
        let r = this.runs.get(d);
        if (!r) {
          r = new WorkflowRunReader(d, sessionDir(this.transcript));
          this.runs.set(d, r);
        }
        return r.read({ launch: launchOf.get(r.runId), detail: opts.detail, sessionEnded: opts.sessionEnded });
      }),
    );
  }
}
