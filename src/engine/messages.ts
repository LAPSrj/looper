import fs from 'node:fs';
import path from 'node:path';
import type { MessageImage, MessageRow, MessagesResult, PatchHunk } from '../shared/messages';
import type { Settings, Task } from '../shared/types';
import type { HostKind } from './host';
import { convertWslPath } from './host';
import type { Logger } from './log';

/** Oldest rows past this are dropped; a looper run rarely gets near it. */
const MAX_ROWS = 1000;
/** Full-text cap per row; transcripts can carry megabyte tool results. */
const MAX_TEXT = 65_536;
const MAX_PREVIEW = 200;
/** Transcript readers kept warm for polling; least recently used beyond this are dropped. */
const MAX_READERS = 16;
/** Images kept per transcript (oldest evicted) and the largest base64 payload accepted. */
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 10_000_000;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\n… (truncated)' : text;
}

/** First meaningful line, system-reminder-style tag blocks stripped, whitespace collapsed. */
function previewOf(text: string): string {
  let t = text.replace(/<(\w[\w-]*)>[\s\S]*?<\/\1>/g, '').replace(/<[^>\n]+>/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) t = text.replace(/\s+/g, ' ').trim();
  return t.slice(0, MAX_PREVIEW);
}

/** The input fields most tools center on, tried in order for the table preview. */
const PREVIEW_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill'];

function toolPreview(input: unknown): string {
  if (typeof input !== 'object' || input === null) return previewOf(String(input ?? ''));
  const obj = input as Record<string, unknown>;
  for (const key of PREVIEW_KEYS) {
    if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return previewOf(obj[key] as string);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return previewOf(v);
  }
  try {
    return previewOf(JSON.stringify(obj));
  } catch {
    return '';
  }
}

/** Tool input as readable text: one `key: value` per field, long values as blocks. */
function formatToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input ?? '');
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    let s: string;
    if (typeof v === 'string') s = v;
    else {
      try {
        s = JSON.stringify(v, null, 2) ?? String(v);
      } catch {
        s = String(v);
      }
    }
    parts.push(s.includes('\n') || s.length > 80 ? `${k}:\n${s}` : `${k}: ${s}`);
  }
  return parts.join('\n');
}

/** Text of a tool_result content field: a string, or an array of text blocks.
 * Blocks without text (e.g. ToolSearch's tool_reference) fall back to JSON so
 * the result never renders empty. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
    if (content.length === 0) return '';
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '';
    }
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

type Rec = Record<string, unknown>;

/** Diff-line budget across a row's hunks; a patch past it is cut off. */
const MAX_PATCH_LINES = 2000;

/** Hunks parsed out of a unified diff (codex FileChange updates carry one). */
function parseUnifiedDiff(diff: string): PatchHunk[] | undefined {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let total = 0;
  for (const line of diff.split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      current = {
        oldStart: Number(head[1]),
        oldLines: head[2] !== undefined ? Number(head[2]) : 1,
        newStart: Number(head[3]),
        newLines: head[4] !== undefined ? Number(head[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || !/^[ +-]/.test(line)) continue;
    total += 1;
    if (total > MAX_PATCH_LINES) break;
    current.lines.push(line);
  }
  return hunks.length > 0 ? hunks : undefined;
}

/** The harness's structuredPatch from a toolUseResult, loosely validated. */
function takePatch(tur: unknown): PatchHunk[] | undefined {
  const sp = (tur as Rec | undefined)?.structuredPatch;
  if (!Array.isArray(sp) || sp.length === 0) return undefined;
  const hunks: PatchHunk[] = [];
  let total = 0;
  for (const h of sp as Rec[]) {
    if (!h || !Array.isArray(h.lines)) continue;
    const lines = (h.lines as unknown[]).filter((l): l is string => typeof l === 'string');
    total += lines.length;
    if (total > MAX_PATCH_LINES) break;
    hunks.push({
      oldStart: Number(h.oldStart) || 0,
      oldLines: Number(h.oldLines) || 0,
      newStart: Number(h.newStart) || 0,
      newLines: Number(h.newLines) || 0,
      lines,
    });
  }
  return hunks.length > 0 ? hunks : undefined;
}

export interface AccumulatorOpts {
  /** A subagent's own transcript, where every record is marked isSidechain. */
  sidechain?: boolean;
  /** Every record becomes a row of pretty-printed JSON, nothing skipped. */
  raw?: boolean;
  /** Rows come from the classifier's conversation (marks them and prefixes their ids). */
  source?: 'classifier';
}

/** Row-id prefix of classifier rows, so a run's merged list never collides. */
export const CLASSIFIER_ROW_PREFIX = 'c';

/**
 * Folds transcript records into display rows. Only `user`/`assistant` records
 * count; sidechain and meta records, and the transcript's bookkeeping types
 * (attachment, queue-operation, ai-title…) are skipped. Tool results attach to
 * their tool_use row instead of appearing as user messages.
 */
export class TranscriptAccumulator {
  rows: MessageRow[] = [];
  dropped = 0;
  /** Image payloads by row id; the rows only carry a marker. */
  readonly images = new Map<string, MessageImage>();
  private nextId = 0;
  private byToolId = new Map<string, MessageRow>();

  constructor(protected readonly opts: AccumulatorOpts = {}) {}

  reset(): void {
    this.rows = [];
    this.dropped = 0;
    this.nextId = 0;
    this.byToolId.clear();
    this.images.clear();
  }

  addLine(line: string): void {
    if (this.opts.raw) {
      this.addRawLine(line);
      return;
    }
    let rec: Rec;
    try {
      const v: unknown = JSON.parse(line);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
      rec = v as Rec;
    } catch {
      return; // torn or foreign line
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    if (rec.isMeta === true) return;
    // The main transcript may inline sidechain records; they belong to the subagent view.
    if (!this.opts.sidechain && rec.isSidechain === true) return;
    const msg = rec.message;
    if (msg === null || typeof msg !== 'object') return;
    const content = (msg as Rec).content;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;

    if (rec.type === 'user') {
      if (typeof content === 'string') {
        this.push({ kind: 'prompt', ts, text: content });
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content as Rec[]) {
        if (block?.type === 'tool_result') {
          const row = typeof block.tool_use_id === 'string' ? this.byToolId.get(block.tool_use_id) : undefined;
          if (!row) continue;
          row.result = cap(resultText(block.content), MAX_TEXT);
          if (block.is_error === true) row.resultError = true;
          this.takeImage(row, block.content);
          const patch = takePatch(rec.toolUseResult);
          if (patch) row.patch = patch;
          // The record-level toolUseResult carries the subagent id of a Task call.
          const agentId = (rec.toolUseResult as Rec | undefined)?.agentId;
          if (typeof agentId === 'string' && agentId) row.agentId = agentId;
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          this.push({ kind: 'prompt', ts, text: block.text });
        } else if (block?.type === 'image') {
          const row = this.push({ kind: 'prompt', ts, text: '(image)' });
          this.takeImage(row, [block]);
        }
      }
      return;
    }

    if (!Array.isArray(content)) return;
    for (const block of content as Rec[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.push({ kind: 'agent', ts, text: block.text });
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        this.push({ kind: 'thinking', ts, text: block.thinking });
      } else if (block?.type === 'tool_use') {
        const row = this.push({
          kind: 'tool',
          ts,
          tool: typeof block.name === 'string' ? block.name : 'tool',
          text: formatToolInput(block.input),
          preview: toolPreview(block.input),
        });
        const input = block.input as Rec | undefined;
        const file = input?.file_path ?? input?.notebook_path;
        if (typeof file === 'string' && file.trim()) row.file = file.trim();
        // The structured input, for custom renders. Oversized inputs fall back to the text form.
        try {
          const size = JSON.stringify(block.input)?.length ?? 0;
          if (size > 0 && size <= MAX_TEXT) row.input = block.input;
        } catch {
          /* unserializable input stays text-only */
        }
        if (typeof block.id === 'string') this.byToolId.set(block.id, row);
      }
    }
  }

  /** Raw mode: the record as pretty-printed JSON, typed by its transcript `type`. */
  protected addRawLine(line: string): void {
    let text = line;
    let ts: string | undefined;
    let type = '?';
    try {
      const v: unknown = JSON.parse(line);
      text = JSON.stringify(v, null, 2);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const r = v as Rec;
        if (typeof r.type === 'string') type = r.type;
        if (typeof r.timestamp === 'string') ts = r.timestamp;
      }
    } catch {
      /* torn or foreign line: keep it verbatim */
    }
    this.push({ kind: 'raw', ts, tool: type, text, preview: line.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW) });
  }

  /** Keep the first image block's payload engine-side and mark the row. */
  private takeImage(row: MessageRow, content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as Rec[]) {
      if (block?.type !== 'image') continue;
      const source = block.source as Rec | undefined;
      const data = source?.data;
      const mediaType = source?.media_type;
      if (source?.type !== 'base64' || typeof data !== 'string' || typeof mediaType !== 'string') continue;
      if (data.length > MAX_IMAGE_BYTES) continue;
      row.image = { mediaType };
      this.images.set(row.id, { mediaType, data });
      while (this.images.size > MAX_IMAGES) {
        const oldest = this.images.keys().next().value;
        if (oldest === undefined) break;
        this.images.delete(oldest);
      }
      return;
    }
  }

  protected push(r: { kind: MessageRow['kind']; ts?: string; text: string; tool?: string; preview?: string }): MessageRow {
    const row: MessageRow = {
      id: (this.opts.source === 'classifier' ? CLASSIFIER_ROW_PREFIX : '') + String(this.nextId++),
      ts: r.ts,
      kind: r.kind,
      source: this.opts.source,
      tool: r.tool,
      preview: r.preview ?? previewOf(r.text),
      text: cap(r.text, MAX_TEXT),
    };
    this.rows.push(row);
    if (this.rows.length > MAX_ROWS) {
      this.rows.shift();
      this.dropped++;
    }
    return row;
  }
}

/**
 * Folds codex rollout records into display rows. A rollout line is
 * `{timestamp, ordinal, type, payload}`; the conversation lives in
 * `response_item` payloads (user/assistant messages, reasoning) and in
 * `event_msg`/`item_completed` items (command executions, file changes).
 * Message items appear in both streams, so only the response_item copy is
 * rendered; bookkeeping records (session_meta, world_state, turn_context,
 * token counts) are skipped. Format captured live from codex-cli 0.154.0.
 */
export class CodexAccumulator extends TranscriptAccumulator {
  addLine(line: string): void {
    if (this.opts.raw) {
      this.addRawLine(line);
      return;
    }
    let rec: Rec;
    try {
      const v: unknown = JSON.parse(line);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
      rec = v as Rec;
    } catch {
      return; // torn or foreign line
    }
    const payload = rec.payload;
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as Rec;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    if (rec.type === 'response_item') this.addResponseItem(p, ts);
    else if (rec.type === 'event_msg' && p.type === 'item_completed') this.addItem(p.item as Rec | undefined, ts);
  }

  /** User prompts, assistant messages and reasoning summaries. */
  private addResponseItem(p: Rec, ts?: string): void {
    if (p.type === 'message') {
      // Developer records are injected instructions (skills, plugins…), and a
      // user text that is one wrapped <tag>…</tag> block is injected context.
      if (p.role !== 'user' && p.role !== 'assistant') return;
      if (!Array.isArray(p.content)) return;
      for (const block of p.content as Rec[]) {
        const text = typeof block?.text === 'string' ? block.text : '';
        if (!text.trim()) continue;
        if (block.type === 'input_text' && p.role === 'user') {
          if (/^<([\w-]+)>[\s\S]*<\/\1>\s*$/.test(text.trim())) continue;
          this.push({ kind: 'prompt', ts, text });
        } else if (block.type === 'output_text' && p.role === 'assistant') {
          this.push({ kind: 'agent', ts, text });
        }
      }
    } else if (p.type === 'reasoning' && Array.isArray(p.summary)) {
      // Rollouts carry reasoning encrypted; only the summary is displayable.
      const text = (p.summary as Rec[])
        .map((b) => (typeof b?.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n\n');
      if (text.trim()) this.push({ kind: 'thinking', ts, text });
    }
  }

  /** Executed commands and file changes (messages ride response_item instead). */
  private addItem(item: Rec | undefined, ts?: string): void {
    if (!item) return;
    if (item.type === 'CommandExecution') {
      // command is the spawned argv; its last element is the command line.
      const argv = Array.isArray(item.command) ? (item.command as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      const command = argv.length > 0 ? argv[argv.length - 1] : '';
      const row = this.push({ kind: 'tool', ts, tool: 'Bash', text: command, preview: previewOf(command) });
      row.input = { command };
      const out = [item.aggregated_output, item.stdout, item.stderr].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      );
      if (out !== undefined) row.result = cap(out, MAX_TEXT);
      if ((typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed') row.resultError = true;
    } else if (item.type === 'FileChange' && item.changes !== null && typeof item.changes === 'object') {
      for (const [file, change] of Object.entries(item.changes as Rec)) {
        const c = change as Rec | null;
        const content = typeof c?.content === 'string' ? c.content : undefined;
        const diff = typeof c?.unified_diff === 'string' ? c.unified_diff : undefined;
        const movePath = typeof c?.move_path === 'string' && c.move_path ? c.move_path : undefined;
        if (c?.type === 'add' && content !== undefined) {
          const row = this.push({ kind: 'tool', ts, tool: 'Write', text: content, preview: file });
          row.file = file;
          row.input = { content };
        } else if (diff !== undefined) {
          // Updates and deletes carry a unified diff; renames add move_path.
          const preview = movePath ? `${file} → ${movePath}` : file;
          const row = this.push({ kind: 'tool', ts, tool: 'Edit', text: diff, preview });
          row.file = file;
          row.input = movePath ? { move_path: movePath } : {};
          const patch = parseUnifiedDiff(diff);
          if (patch) row.patch = patch;
        } else {
          const text = (() => {
            try {
              return JSON.stringify(c, null, 2);
            } catch {
              return String(c);
            }
          })();
          const row = this.push({ kind: 'tool', ts, tool: 'Patch', text, preview: file });
          row.file = file;
        }
        if (item.status === 'failed') this.rows[this.rows.length - 1].resultError = true;
      }
    }
  }
}

/**
 * Incremental transcript tail: only bytes appended since the last read are
 * parsed, so 2-second polling stays cheap even over a \\wsl.localhost mount.
 * Lines split on raw \n bytes before decoding, so a read boundary inside a
 * UTF-8 sequence or a line cannot corrupt anything.
 */
export class TranscriptReader {
  readonly acc: TranscriptAccumulator;
  private readonly candidates: string[];
  private file: string | null = null;
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);

  /** Several candidate paths may be given (e.g. a subagent under either parent transcript): the first that exists wins. */
  constructor(file: string | string[], opts: AccumulatorOpts = {}, format: 'claude' | 'codex' = 'claude') {
    this.candidates = Array.isArray(file) ? file : [file];
    this.acc = format === 'codex' ? new CodexAccumulator(opts) : new TranscriptAccumulator(opts);
  }

  /** The candidate that exists, kept once found. Throws (like stat) when none does yet. */
  private async resolve(): Promise<string> {
    if (this.file) return this.file;
    let lastErr: unknown;
    for (const c of this.candidates) {
      try {
        await fs.promises.stat(c);
        this.file = c;
        return c;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('no transcript');
  }

  async read(): Promise<void> {
    const file = await this.resolve();
    const st = await fs.promises.stat(file);
    if (st.size < this.offset) {
      // The file shrank (should not happen to a transcript): start over.
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.acc.reset();
    }
    if (st.size === this.offset) return;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      let data = Buffer.concat([this.remainder, buf.subarray(0, bytesRead)]);
      let nl: number;
      while ((nl = data.indexOf(0x0a)) !== -1) {
        const line = data.subarray(0, nl).toString('utf8').trim();
        data = data.subarray(nl + 1);
        if (line) this.acc.addLine(line);
      }
      this.remainder = Buffer.from(data);
    } finally {
      await fh.close();
    }
  }
}

/**
 * The SessionStart/Stop hook payloads both name the transcript file. The
 * prefix selects the step: '' = the agent's session, 'classify-' = the
 * classifier's.
 */
export function readTranscriptRef(runDir: string, prefix = ''): string | null {
  for (const name of [prefix + 'session.json', prefix + 'stop.json']) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8').replace(/^﻿/, ''));
      const t = (raw as Rec | null)?.transcript_path;
      if (typeof t === 'string' && t.trim()) return t.trim();
    } catch {
      /* absent or torn: try the next */
    }
  }
  return null;
}

/**
 * The codex transcript reference a run dir carries: the thread id (written by
 * the session on the first thread.started / notify event) and the target-native
 * codex home (written by the launcher — only the target knows its own home, and
 * codex never reports the rollout path).
 */
export function readCodexRef(runDir: string, prefix = ''): { threadId: string; codexHome: string } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(runDir, prefix + 'codex-session.json'), 'utf8'));
    const threadId = (raw as Rec | null)?.thread_id;
    const codexHome = fs.readFileSync(path.join(runDir, prefix + 'codex-home'), 'utf8').trim();
    if (typeof threadId === 'string' && threadId && codexHome) return { threadId, codexHome };
  } catch {
    /* absent or torn */
  }
  return null;
}

/**
 * Locate the thread's rollout under `<codexHome>/sessions/YYYY/MM/DD/` —
 * the file is `rollout-<start time>-<thread id>.jsonl`, so the thread id in
 * the name is the key; newest date dirs are searched first. A resumed thread
 * appends to its original rollout, so one file covers a rolling conversation.
 */
export async function findCodexRollout(sessionsDir: string, threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  const list = async (dir: string): Promise<string[]> =>
    (await fs.promises.readdir(dir).catch(() => [] as string[])).sort().reverse();
  for (const year of await list(sessionsDir)) {
    for (const month of await list(path.join(sessionsDir, year))) {
      for (const day of await list(path.join(sessionsDir, year, month))) {
        for (const file of await list(path.join(sessionsDir, year, month, day))) {
          if (file.endsWith(suffix)) return path.join(sessionsDir, year, month, day, file);
        }
      }
    }
  }
  return null;
}

export interface MessagesDeps {
  getTask(id: string): Task | undefined;
  runDir(taskId: string, runId: string): string;
  host: HostKind;
  settings: Settings;
  log: Logger;
}

/**
 * Serves the Messages view from the harness's own transcripts — claude's JSONL
 * files (located via the hook payloads in the run dir) and codex's rollout
 * files (located via the thread id + codex home the run dir records).
 * A run's view merges the classifier's conversation (when the run had one)
 * ahead of the agent's — the classifier always finishes before the agent
 * starts, so plain concatenation keeps the order. Transcript paths are
 * target-native; they are translated to host paths once and the readers are
 * cached per run for cheap incremental polling.
 */
export class MessagesService {
  private readers = new Map<string, TranscriptReader>();

  constructor(private readonly deps: MessagesDeps) {}

  async read(taskId: string, runId: string, agentId?: string, raw = false): Promise<MessagesResult> {
    const none = (status: 'no-session' | 'no-transcript'): MessagesResult => ({ status, rows: [], dropped: 0 });
    if (agentId !== undefined) {
      const reader = await this.subagentReader(taskId, runId, agentId, raw);
      if (typeof reader === 'string') return none(reader);
      try {
        await reader.read();
      } catch {
        return none('no-transcript'); // not written yet, or cleaned up by the harness
      }
      return { status: 'ok', rows: reader.acc.rows, dropped: reader.acc.dropped };
    }
    const rows: MessageRow[] = [];
    let dropped = 0;
    let refs = 0;
    let readable = 0;
    for (const source of ['classifier', 'agent'] as const) {
      const reader = await this.mainReader(taskId, runId, source, raw);
      if (typeof reader === 'string') continue;
      refs += 1;
      try {
        await reader.read();
        readable += 1;
      } catch {
        continue; // this step's transcript is not written yet (or was cleaned up)
      }
      rows.push(...reader.acc.rows);
      dropped += reader.acc.dropped;
    }
    if (refs === 0) return none('no-session');
    if (readable === 0) return none('no-transcript');
    return { status: 'ok', rows, dropped };
  }

  /** The image payload behind a row's marker, or null when unavailable. */
  async readImage(taskId: string, runId: string, rowId: string, agentId?: string): Promise<MessageImage | null> {
    const reader =
      agentId !== undefined
        ? await this.subagentReader(taskId, runId, agentId, false)
        : await this.mainReader(taskId, runId, rowId.startsWith(CLASSIFIER_ROW_PREFIX) ? 'classifier' : 'agent', false);
    if (typeof reader === 'string') return null;
    try {
      await reader.read();
    } catch {
      /* rows already parsed may still hold the image */
    }
    return reader.acc.images.get(rowId) ?? null;
  }

  /** One step's main conversation reader, from that step's transcript ref (claude hooks, or the codex ref pair). */
  private async mainReader(
    taskId: string,
    runId: string,
    source: 'agent' | 'classifier',
    raw: boolean,
  ): Promise<TranscriptReader | 'no-session' | 'no-transcript'> {
    const runDir = this.deps.runDir(taskId, runId);
    const prefix = source === 'classifier' ? 'classify-' : '';
    const accOpts: AccumulatorOpts = { raw, source: source === 'classifier' ? 'classifier' : undefined };
    const targetPath = readTranscriptRef(runDir, prefix);
    if (targetPath) {
      return this.cached(`${taskId} ${runId} ${source} ${raw}`, async () => {
        const hostPath = await this.toHostPath(targetPath, taskId);
        if (!hostPath) return null;
        return new TranscriptReader(hostPath, accOpts);
      });
    }
    const codexRef = readCodexRef(runDir, prefix);
    if (!codexRef) return 'no-session';
    return this.cached(`${taskId} ${runId} ${source} ${raw}`, async () => {
      const hostHome = await this.toHostPath(codexRef.codexHome, taskId);
      if (!hostHome) return null;
      const rollout = await findCodexRollout(path.join(hostHome, 'sessions'), codexRef.threadId);
      if (!rollout) return null; // not written yet; retried on the next poll
      return new TranscriptReader(rollout, accOpts, 'codex');
    });
  }

  /**
   * A subagent's reader. The parent may be either step's session, so both
   * transcript dirs are candidates; the one whose file exists wins.
   */
  private async subagentReader(
    taskId: string,
    runId: string,
    agentId: string,
    raw: boolean,
  ): Promise<TranscriptReader | 'no-session' | 'no-transcript'> {
    if (!/^[\w.-]+$/.test(agentId)) return 'no-transcript';
    const runDir = this.deps.runDir(taskId, runId);
    const refs = [readTranscriptRef(runDir), readTranscriptRef(runDir, 'classify-')].filter(
      (r): r is string => r !== null,
    );
    if (refs.length === 0) return 'no-session';
    return this.cached(`${taskId} ${runId} sub:${agentId} ${raw}`, async () => {
      const candidates: string[] = [];
      for (const ref of refs) {
        const hostPath = await this.toHostPath(ref, taskId);
        if (hostPath) candidates.push(path.join(hostPath.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`));
      }
      if (candidates.length === 0) return null;
      return new TranscriptReader(candidates, { sidechain: true, raw });
    });
  }

  /** Reader cache with LRU eviction; `make` runs only on a miss. */
  private async cached(
    key: string,
    make: () => Promise<TranscriptReader | null>,
  ): Promise<TranscriptReader | 'no-transcript'> {
    let reader = this.readers.get(key);
    if (!reader) {
      const made = await make();
      if (!made) return 'no-transcript';
      reader = made;
    }
    // Refresh LRU order; evict the oldest beyond the cap.
    this.readers.delete(key);
    this.readers.set(key, reader);
    while (this.readers.size > MAX_READERS) {
      const oldest = this.readers.keys().next().value;
      if (oldest === undefined) break;
      this.readers.delete(oldest);
    }
    return reader;
  }

  /** Translate the transcript path from the run target's form to the engine host's. */
  private async toHostPath(p: string, taskId: string): Promise<string | undefined> {
    const isWindowsPath = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
    if (this.deps.host === 'windows') {
      if (isWindowsPath) return p;
      const task = this.deps.getTask(taskId);
      const env = task ? this.deps.settings.environments.find((e) => e.id === task.environmentId) : undefined;
      const distro = env?.kind === 'wsl' ? env.distro : undefined;
      const converted = await convertWslPath(p, 'windows', distro);
      if (!converted) this.deps.log.warn(`${taskId}: cannot map transcript path ${p} to a host path`);
      return converted;
    }
    if (isWindowsPath) return convertWslPath(p, 'posix');
    return p;
  }
}
