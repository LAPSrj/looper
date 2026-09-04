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

/** Text of a tool_result content field: a string, or an array of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
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
}

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

  constructor(private readonly opts: AccumulatorOpts = {}) {}

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
  private addRawLine(line: string): void {
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

  private push(r: { kind: MessageRow['kind']; ts?: string; text: string; tool?: string; preview?: string }): MessageRow {
    const row: MessageRow = {
      id: String(this.nextId++),
      ts: r.ts,
      kind: r.kind,
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
 * Incremental transcript tail: only bytes appended since the last read are
 * parsed, so 2-second polling stays cheap even over a \\wsl.localhost mount.
 * Lines split on raw \n bytes before decoding, so a read boundary inside a
 * UTF-8 sequence or a line cannot corrupt anything.
 */
export class TranscriptReader {
  readonly acc: TranscriptAccumulator;
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(
    readonly file: string,
    opts: AccumulatorOpts = {},
  ) {
    this.acc = new TranscriptAccumulator(opts);
  }

  async read(): Promise<void> {
    const st = await fs.promises.stat(this.file);
    if (st.size < this.offset) {
      // The file shrank (should not happen to a transcript): start over.
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.acc.reset();
    }
    if (st.size === this.offset) return;
    const fh = await fs.promises.open(this.file, 'r');
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

/** The SessionStart/Stop hook payloads both name the transcript file. */
export function readTranscriptRef(runDir: string): string | null {
  for (const name of ['session.json', 'stop.json']) {
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

export interface MessagesDeps {
  getTask(id: string): Task | undefined;
  runDir(taskId: string, runId: string): string;
  host: HostKind;
  settings: Settings;
  log: Logger;
}

/**
 * Serves the Messages view from the harness's own transcript (the JSONL under
 * the Claude config dir), located via the hook payloads in the run dir. The
 * transcript path is target-native; it is translated to a host path once and
 * the reader is cached per run for cheap incremental polling.
 */
export class MessagesService {
  private readers = new Map<string, TranscriptReader>();

  constructor(private readonly deps: MessagesDeps) {}

  async read(taskId: string, runId: string, agentId?: string, raw = false): Promise<MessagesResult> {
    const none = (status: 'no-session' | 'no-transcript'): MessagesResult => ({ status, rows: [], dropped: 0 });
    const reader = await this.getReader(taskId, runId, agentId, raw);
    if (typeof reader === 'string') return none(reader);
    try {
      await reader.read();
    } catch {
      return none('no-transcript'); // not written yet, or cleaned up by the harness
    }
    return { status: 'ok', rows: reader.acc.rows, dropped: reader.acc.dropped };
  }

  /** The image payload behind a row's marker, or null when unavailable. */
  async readImage(taskId: string, runId: string, rowId: string, agentId?: string): Promise<MessageImage | null> {
    const reader = await this.getReader(taskId, runId, agentId, false);
    if (typeof reader === 'string') return null;
    try {
      await reader.read();
    } catch {
      /* rows already parsed may still hold the image */
    }
    return reader.acc.images.get(rowId) ?? null;
  }

  private async getReader(
    taskId: string,
    runId: string,
    agentId: string | undefined,
    raw: boolean,
  ): Promise<TranscriptReader | 'no-session' | 'no-transcript'> {
    if (agentId !== undefined && !/^[\w.-]+$/.test(agentId)) return 'no-transcript';
    const targetPath = readTranscriptRef(this.deps.runDir(taskId, runId));
    if (!targetPath) return 'no-session';

    const key = `${taskId} ${runId} ${agentId ?? ''}`;
    let reader = this.readers.get(key);
    if (!reader) {
      const hostPath = await this.toHostPath(targetPath, taskId);
      if (!hostPath) return 'no-transcript';
      const file = agentId
        ? path.join(hostPath.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`)
        : hostPath;
      reader = new TranscriptReader(file, { sidechain: agentId !== undefined, raw });
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
