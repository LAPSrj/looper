import fs from 'node:fs';
import path from 'node:path';
import {
  SENT_IMAGE_RE,
  delegateText,
  eventsText,
  guidanceText,
  peerMessages,
  taskEventsText,
  CHANGE_TOOLS,
  scriptCallsPage,
  toolImageId,
  type MessageImage,
  type MessageRow,
  type MessagesResult,
  type PatchHunk,
  type ScriptCalls,
  type SentFiles,
} from '../shared/messages';
import { commandAttachment, parseCommands, parseFileList, parseOutputOnly, withOutput } from '../shared/bash-mode';
import type { Attachment } from '../shared/chat';
import { parseTaskNotification, type BackgroundTask, type SlashCommand } from '../shared/sessions';
import { compactRows, proseRows, withoutCompacted } from '../shared/compact';
import { readCodexLastResponse, readContextTokens, readSubagentStats, type SubagentStats } from './context';
import { readPendingGuidance } from './guidance';
import { MOD_FILES } from './claude-mod';
import { writeJsonAtomicAsync } from './store/fsutil';
import type { Settings, Task } from '../shared/types';
import type { HostKind } from './host';
import { convertWslPath } from './host';
import { errMsg, type Logger } from './log';
import type { WorkflowRun } from '../shared/workflows';
import { SessionWorkflows, workflowAgentTranscript, type WorkflowLaunch } from './workflows';
import { readOutputFrom } from './output-read';
import type { OutputRead } from '../shared/output-tail';

/** The most transcript row ids kept to tell a row whose copy from the mod comes after it (LiveRows). */
const TRANSCRIPT_IDS_KEPT = 2000;
/** The responses whose mod and API message ids a TranscriptAccumulator keeps: only the newest ones' rows still arrive. */
const MESSAGE_IDS_KEPT = 64;

function messageIdOf(rec: Rec): string | undefined {
  const id = (rec.message as Rec | null | undefined)?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * The rows an interactive Claude Code session's mod hands over as they are
 * made (MOD_FILES.live), for one reader of the conversation, which reads its
 * transcript too: each row shows from whichever copy comes first. A file goes
 * once the transcript has its row, and the session step removes what's left
 * when the session ends, so a reader that hasn't read a file yet gets its row
 * from the transcript.
 */
export class LiveRows {
  /** The rows shown from the mod's copy, by id, with their files and message ids, until the transcript has them. */
  private readonly shown = new Map<string, { file: string; messageId?: string }>();
  /** The transcript's newest row ids, with their message ids, for a copy from the mod that comes after the row showed. */
  private readonly fromTranscript = new Map<string, string | undefined>();
  /** The last file read: the names sort in the order the rows were made. */
  private last = '';

  /**
   * `sameMessage`: a row's two copies showed that the mod's message id (`live-…`, as the mod can't see the API's)
   * and the transcript's name one response.
   */
  constructor(
    private readonly dir: string,
    private readonly sameMessage: (liveId: string, apiId: string) => void,
  ) {}

  /** Whether the transcript's record shows: not when the mod's copy did. */
  transcriptRow(rec: Rec): boolean {
    const uuid = rec.uuid;
    if (typeof uuid !== 'string') return true;
    const messageId = messageIdOf(rec);
    const shown = this.shown.get(uuid);
    if (shown !== undefined) {
      this.shown.delete(uuid);
      void fs.promises.rm(shown.file, { force: true }).catch(() => undefined);
      if (shown.messageId && messageId) this.sameMessage(shown.messageId, messageId);
      return false;
    }
    this.fromTranscript.set(uuid, messageId);
    if (this.fromTranscript.size > TRANSCRIPT_IDS_KEPT) this.fromTranscript.delete(this.fromTranscript.keys().next().value as string);
    return true;
  }

  /** Hands each record the mod wrote since the last read to `add`, in order, but one the transcript showed first. Whether it added any. */
  async read(add: (rec: Rec, line: string) => void): Promise<boolean> {
    const names = (await fs.promises.readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json') && n > this.last).sort();
    let added = false;
    for (const name of names) {
      const file = path.join(this.dir, name);
      const line = await fs.promises.readFile(file, 'utf8').catch(() => null);
      let rec: unknown = null;
      try {
        rec = line === null ? null : JSON.parse(line);
      } catch {
        /* still being written */
      }
      // A file still being written: it and the files after it wait for the next read.
      if (line === null || rec === null || typeof rec !== 'object' || Array.isArray(rec)) break;
      this.last = name;
      const uuid = (rec as Rec).uuid;
      if (typeof uuid === 'string' && this.fromTranscript.has(uuid)) {
        const apiId = this.fromTranscript.get(uuid);
        this.fromTranscript.delete(uuid);
        const liveId = messageIdOf(rec as Rec);
        if (liveId && apiId) this.sameMessage(liveId, apiId);
        await fs.promises.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (typeof uuid === 'string') this.shown.set(uuid, { file, messageId: messageIdOf(rec as Rec) });
      add(rec as Rec, line);
      added = true;
    }
    return added;
  }
}

/** The transcript bytes the live folder's sweep reads at a time; a longer line doubles it. */
const SWEEP_CHUNK = 4 * 1024 * 1024;
const ROW_ID = /"uuid":"([0-9a-f-]{36})"/g;
const LIVE_FILE_ID = /-([0-9a-f-]{36})\.json$/;
const RESULT_ID = /"tool_use_id":"([\w-]+)"/g;
const LIVE_CALL_FILE_ID = /-call-([\w-]+)\.json$/;

/**
 * Keeps an interactive Claude Code session's live folder (LiveRows) down to the
 * rows its transcript doesn't have yet, whether or not anyone reads the
 * conversation: a file goes once the transcript has the row its name ends in,
 * and a script call's (`-call-<id>`) once the transcript has the call's result.
 */
export class LiveSweep {
  private offset = 0;
  private chunk = SWEEP_CHUNK;
  /** The transcript's newest row ids, for a file the mod writes after the transcript has its row. */
  private readonly ids = new Set<string>();
  /** The calls whose results the transcript has, newest kept. */
  private readonly results = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly transcript: string,
  ) {}

  async sweep(): Promise<void> {
    const fh = await fs.promises.open(this.transcript, 'r').catch(() => null);
    if (!fh) return;
    try {
      const { size } = await fh.stat();
      if (size < this.offset) this.offset = 0;
      while (size > this.offset) {
        const buf = Buffer.alloc(Math.min(size - this.offset, this.chunk));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        const end = bytesRead > 0 ? buf.lastIndexOf(10, bytesRead - 1) : -1;
        if (end < 0) {
          // A line still being written, or one longer than a chunk.
          if (bytesRead === this.chunk) this.chunk *= 2;
          break;
        }
        this.offset += end + 1;
        this.chunk = SWEEP_CHUNK;
        const text = buf.toString('utf8', 0, end);
        for (const m of text.matchAll(ROW_ID)) {
          this.ids.add(m[1]);
          if (this.ids.size > TRANSCRIPT_IDS_KEPT) this.ids.delete(this.ids.values().next().value as string);
        }
        for (const m of text.matchAll(RESULT_ID)) {
          this.results.add(m[1]);
          if (this.results.size > TRANSCRIPT_IDS_KEPT) this.results.delete(this.results.values().next().value as string);
        }
      }
    } finally {
      await fh.close();
    }
    const names = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        const id = LIVE_FILE_ID.exec(name)?.[1];
        const call = id ? undefined : LIVE_CALL_FILE_ID.exec(name)?.[1];
        if ((id && this.ids.has(id)) || (call && this.results.has(call))) await fs.promises.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
      }),
    );
  }
}

/** Full-text cap per row; transcripts can carry megabyte tool results. */
const MAX_TEXT = 65_536;
/** Code Mode: the delivered scripts kept to find whose calls a batch of them is (several can end together). */
const SETTLED_KEPT = 16;
const MAX_PREVIEW = 200;
/** Readers kept warm for polling; least recently used beyond this are dropped (a transcript's, once unused for READER_KEEP_MS). */
const MAX_READERS = 16;
/**
 * A transcript reader used this recently stays, past MAX_READERS: the Chats dashboard's poll reads every open session
 * every 2 s, and with more open than that each dropped one read its whole transcript again on the next poll (20 chats:
 * 200-300 MB every 15 s, held by the main process until its next collection).
 */
const READER_KEEP_MS = 60_000;
/** MessagesService.newest: the end of a transcript it reads, and the shortest transcript it reads it of (below, the whole is as quick). */
const NEWEST_BYTES = 4 * 1024 * 1024;
const NEWEST_MIN = 32 * 1024 * 1024;
/** Image payloads an accumulator holds (oldest evicted; a transcript's images are only where they are, all kept), and the largest base64 payload accepted. */
const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 10_000_000;

/** Where a line is in the transcript a TranscriptReader read it from. */
export interface LineAt {
  offset: number;
  length: number;
}

/**
 * The image a row's marker stands for: its payload, or a transcript's record that holds it and which of its images
 * it is (the tool call's result, or the message's block), read again when it's shown. Kept as payloads, a 1,000-row
 * chat's screenshots held 31 MB for as long as its reader stayed cached.
 */
export type StoredImage = MessageImage | { mediaType: string; at: LineAt; toolUseId?: string; block?: number };

/** The first base64 image in a message's or a tool result's content, if it's no larger than MAX_IMAGE_BYTES. */
function imageOf(content: unknown): MessageImage | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as Rec[]) {
    if (block?.type !== 'image') continue;
    const source = block.source as Rec | undefined;
    const data = source?.data;
    const mediaType = source?.media_type;
    if (source?.type !== 'base64' || typeof data !== 'string' || typeof mediaType !== 'string') continue;
    if (data.length > MAX_IMAGE_BYTES) continue;
    return { mediaType, data };
  }
  return null;
}

/** A StoredImage's payload: a transcript's is read again from its record in `file`. Null when the record doesn't hold it. */
async function imagePayload(stored: StoredImage | null | undefined, file: string | null): Promise<MessageImage | null> {
  if (!stored) return null;
  if ('data' in stored) return stored;
  if (!file) return null;
  const buf = Buffer.allocUnsafe(stored.at.length);
  const fh = await fs.promises.open(file, 'r').catch(() => null);
  if (!fh) return null; // the transcript is gone
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, stored.at.offset);
    if (bytesRead < buf.length) return null;
  } finally {
    await fh.close();
  }
  let rec: Rec | null;
  try {
    rec = JSON.parse(buf.toString('utf8')) as Rec | null;
  } catch {
    return null;
  }
  const content = (rec?.message as Rec | undefined)?.content;
  if (!Array.isArray(content)) return null;
  if (stored.toolUseId !== undefined) return imageOf((content as Rec[]).find((b) => b?.type === 'tool_result' && b.tool_use_id === stored.toolUseId)?.content);
  return stored.block !== undefined ? imageOf([content[stored.block]]) : null;
}

/** A REPL row's calls with these failed calls (their indices, in order) and running count; `running` and `failures` show only while there are some. */
function callCounts(calls: NonNullable<MessageRow['calls']>, failures: number[], running: number): NonNullable<MessageRow['calls']> {
  const rest = { ...calls };
  delete rest.running;
  delete rest.failures;
  return { ...rest, failed: failures.length, ...(failures.length ? { failures } : {}), ...(running > 0 ? { running } : {}) };
}

/**
 * `s` as a string of its own. V8 keeps a slice of a longer string as a view of it, so a row's 64 kB cap of a 400 kB
 * tool result kept all 400 kB for as long as the row lived (300 of them: 116 MB against 39 MB).
 */
function ownCopy(s: string): string {
  return JSON.parse(JSON.stringify(s)) as string;
}

function cap(text: string, max: number): string {
  return text.length > max ? ownCopy(text.slice(0, max) + '\n… (truncated)') : text;
}

/** The first `max` characters, without keeping the rest (ownCopy). */
function clip(text: string, max: number): string {
  return text.length > max ? ownCopy(text.slice(0, max)) : text;
}

/** First meaningful line, system-reminder-style tag blocks stripped, whitespace collapsed. */
function previewOf(text: string): string {
  let t = text.replace(/<(\w[\w-]*)>[\s\S]*?<\/\1>/g, '').replace(/<[^>\n]+>/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) t = text.replace(/\s+/g, ' ').trim();
  return clip(t, MAX_PREVIEW);
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

/**
 * What a Code Mode script's call returned, from its record's toolUseResult (its tool_result is empty, claude
 * 2.1.329), as the tool's own result reads: a Read's lines numbered from where it started, a command's output, and
 * any other tool's answer as JSON. An image has no text.
 */
export function scriptCallResult(tur: unknown): string {
  if (typeof tur === 'string') return tur;
  const t = tur as Rec | null;
  if (t?.type === 'image') return '';
  const file = t?.file as Rec | undefined;
  if (typeof file?.content === 'string') {
    const start = typeof file.startLine === 'number' ? file.startLine : 1;
    return file.content
      .replace(/\n$/, '')
      .split('\n')
      .map((line, n) => `${String(start + n).padStart(6)}\t${line}`)
      .join('\n');
  }
  if (typeof t?.stdout === 'string' || typeof t?.stderr === 'string') return [t.stdout, t.stderr].filter((s) => typeof s === 'string' && s).join('\n');
  try {
    return JSON.stringify(tur, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** Text of a tool_result content field: a string, or an array of text blocks.
 * Blocks without text (e.g. ToolSearch's tool_reference) fall back to JSON so
 * the result never renders empty. Image blocks are left out: their payload
 * stays engine-side (takeImage). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
    const rest = content.filter((b) => (b as Rec | null)?.type !== 'image');
    if (rest.length === 0) return '';
    try {
      return JSON.stringify(rest, null, 2);
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

/** Claude's notice that a background command, Monitor, subagent or workflow ended (parseTaskNotification). */
const isTaskNotification = (text: string): boolean => TASK_NOTIFICATION_START.test(text);
/**
 * A task notification starts the text, or follows the notice Claude Code puts before it when it hands one over as a
 * message of its own ("<system-reminder>[SYSTEM NOTIFICATION - NOT USER INPUT] …", which a Poll result's event and a
 * user turn both carry): either way it's no message of the user's.
 */
const TASK_NOTIFICATION_START = /^\s*(?:<system-reminder>\s*)?(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?)?<task-notification>/;

/**
 * "/name args" from the record Claude Code writes when the user runs a slash
 * command or skill: only command-message, command-name and command-args tags
 * ("<command-message>pick-up</command-message>\n<command-name>/pick-up</command-name>",
 * seen in claude 2.1.x transcripts and stream-json replays). Null for any other text.
 */
export function slashCommandText(text: string): string | null {
  const t = text.trim();
  if (!/^(?:<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>\s*)+$/.test(t)) return null;
  const found = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1].trim();
  if (!found) return null;
  const name = found.startsWith('/') ? found : `/${found}`;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1].trim();
  return args ? `${name} ${args}` : name;
}

/** A "completed" task notification of a subagent that still waits on work it started itself. */
const WAITING_ON_OWN_WORK = /waiting on its own background work|background work of its own still running/;

/** How a blocking Stop hook's reason reaches the agent: a meta user message (claude 2.1.x). */
const STOP_HOOK_FEEDBACK = 'Stop hook feedback:';

/** Rows of what the agent was given: a turn that starts with one of them isn't the one before going on. */
const INPUT_KINDS = new Set<MessageRow['kind']>(['prompt', 'guidance', 'events', 'delegate', 'taskEvents', 'peer', 'task']);

/** A message's text: the string itself, or its text blocks joined by newlines. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Rec[])
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** What a workflow agent's first message says before the task: "[Workflow harness — computed task] …" (an em dash, claude 2.1.314). */
const WORKFLOW_FRAME = /^\[Workflow harness\s*[—–-]\s*computed task\]/;
const WORKFLOW_FRAME_END = 'The computed task text follows:';

/**
 * The task in the message a workflow script's agent starts with: the harness's
 * framing (up to "The computed task text follows:") is cut, and the two spaces
 * it indents every line of the task with are taken off. Null for any other text.
 */
export function workflowTaskText(text: string): string | null {
  const t = text.trimStart();
  if (!WORKFLOW_FRAME.test(t)) return null;
  const end = t.indexOf(WORKFLOW_FRAME_END);
  const body = end === -1 ? t.replace(WORKFLOW_FRAME, '') : t.slice(end + WORKFLOW_FRAME_END.length);
  return body
    .split('\n')
    .map((l) => l.replace(/^ {1,2}/, ''))
    .join('\n')
    .trim();
}

const isScalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);

/**
 * A workflow agent's StructuredOutput input as the agent's reply: its string
 * fields as text (labelled with their names when there are several), then any
 * other field as a "name: value" list. Empty when it has nothing to show.
 */
export function structuredOutputText(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const entries = Object.entries(input as Rec).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const strings = entries.filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  const others = entries.filter(
    (e) => typeof e[1] !== 'string' && !(Array.isArray(e[1]) && e[1].length === 0) && !(typeof e[1] === 'object' && Object.keys(e[1] as object).length === 0),
  );
  const parts = strings.map(([k, v]) => (strings.length > 1 ? `**${k}**\n\n${v}` : v));
  const list = others.map(([k, v]) => {
    if (isScalar(v)) return `- **${k}**: ${String(v)}`;
    if (Array.isArray(v) && v.length > 0 && v.every(isScalar)) return `- **${k}**:\n${v.map((x) => `  - ${String(x)}`).join('\n')}`;
    try {
      return `- **${k}**: ${JSON.stringify(v)}`;
    } catch {
      return `- **${k}**: ${String(v)}`;
    }
  });
  if (list.length > 0) parts.push(list.join('\n'));
  return parts.join('\n\n');
}

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

/**
 * The files a SendUserFile call sent. Its result's toolUseResult lists what was
 * delivered, each with its absolute path and size ({caption, display,
 * attachments: [{path, size, isImage, media_type, file_uuid}]}, claude 2.1.x);
 * without it the call's own `files` stand in. Null when no file is named.
 */
function sentFilesOf(input: unknown, tur: unknown): SentFiles | null {
  const inp = (input ?? {}) as Rec;
  const delivered = (tur as Rec | undefined)?.attachments;
  const items: { path: string; size?: number }[] = [];
  if (Array.isArray(delivered)) {
    for (const a of delivered as Rec[]) {
      if (typeof a?.path === 'string' && a.path.trim()) {
        items.push({ path: a.path.trim(), ...(typeof a.size === 'number' && a.size >= 0 ? { size: a.size } : {}) });
      }
    }
  }
  if (items.length === 0 && Array.isArray(inp.files)) {
    for (const f of inp.files) if (typeof f === 'string' && f.trim()) items.push({ path: f.trim() });
  }
  if (items.length === 0) return null;
  const attach = inp.display === 'attach' || (tur as Rec | undefined)?.display === 'attach';
  const captionText = [inp.caption, (tur as Rec | undefined)?.caption].find((c): c is string => typeof c === 'string' && c.trim() !== '');
  return {
    ...(captionText ? { caption: captionText.trim() } : {}),
    files: items.map((i) => ({
      path: i.path,
      name: i.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || i.path,
      inline: !attach && SENT_IMAGE_RE.test(i.path),
      ...(i.size !== undefined ? { size: i.size } : {}),
    })),
  };
}

export interface AccumulatorOpts {
  /** A subagent's own transcript, where every record is marked isSidechain. */
  sidechain?: boolean;
  /** Every record becomes a row of pretty-printed JSON, nothing skipped. */
  raw?: boolean;
  /** Rows come from the classifier's conversation (marks them and prefixes their ids). */
  source?: 'classifier';
  /** Rows come from an agent session a context restart ended: its number, which prefixes their ids. */
  session?: number;
  /** Looper's copy of a file the user attached, from the path the agent read it at: the message shows it as an attachment. */
  attachment?: (agentPath: string) => Attachment | null;
}

/** Row-id prefix of classifier rows, so a run's merged list never collides. */
export const CLASSIFIER_ROW_PREFIX = 'c';

/**
 * File prefix an agent session's run-dir files (session.json, stop.json,
 * done…) get once a context restart ends it, numbered from 1, so the next
 * session starts with the plain names.
 */
export function restartPrefix(session: number): string {
  return `session${session}-`;
}

/** Row-id prefix of an ended session's rows. */
function sessionRowPrefix(session: number): string {
  return `s${session}-`;
}

/** Which conversation a row of the merged list came from, by its id prefix. */
function rowSource(rowId: string): 'classifier' | 'agent' | number {
  if (rowId.startsWith(CLASSIFIER_ROW_PREFIX)) return 'classifier';
  const m = /^s(\d+)-/.exec(rowId);
  return m ? Number(m[1]) : 'agent';
}

/** The numbers of the agent sessions context restarts ended in this run, oldest first. */
export function endedSessions(runDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return [];
  }
  const found = new Set<number>();
  for (const n of names) {
    const m = /^session(\d+)-/.exec(n);
    if (m) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The skills in a harness's list for the agent, a "- name: description" line
 * each: Claude's skill_listing (a plugin's skill is "plugin:name"), Codex's
 * "### Available skills", whose lines end with "(file: …)".
 */
export function skillsListed(text: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const line of text.split('\n')) {
    const m = /^- (\S+?)(?:: (.*))?$/.exec(line.trimEnd());
    if (m) out.push({ name: m[1], description: (m[2] ?? '').replace(/\s*\(file: [^)]*\)$/, '').trim() });
  }
  return out;
}

/**
 * Folds transcript records into display rows. Only `user`/`assistant` records
 * count; sidechain and meta records, and the transcript's bookkeeping types
 * (attachment, queue-operation, ai-title…) are skipped, except where they carry
 * the user's guidance. Tool results attach to their tool_use row instead of
 * appearing as user messages.
 */
export class TranscriptAccumulator {
  rows: MessageRow[] = [];
  /** Code Mode: the tool calls each script made, by its REPL call's tool_use id, oldest first; its row counts them (`calls`). */
  readonly scriptCalls = new Map<string, MessageRow[]>();
  /** Code Mode: the REPL rows whose results were delivered last, with when each script ended. */
  private settled: { row: MessageRow; at: string }[] = [];
  /** Code Mode: the REPL row whose script made each call, by the call's tool_use id, until its result arrives. */
  private callOwners = new Map<string, MessageRow>();
  /** Code Mode: the REPL row each script call is under, by the call's tool_use id. */
  private callRepl = new Map<string, MessageRow>();
  /** Code Mode: the files each script's calls read or changed, by its REPL call's tool_use id. */
  private scriptFiles = new Map<string, Map<string, { changed: boolean; index: number }>>();
  /** Image payloads by row id, or where a transcript has them (StoredImage); the rows only carry a marker. */
  readonly images = new Map<string, StoredImage>();
  /** Where the line addLine is folding is in its transcript, when a TranscriptReader reads one: its images stay there. */
  lineAt: LineAt | undefined;
  /** The rows of `images` that hold their payload, oldest first: only these are evicted past MAX_IMAGES. */
  private readonly payloadIds = new Set<string>();
  private nextId = 0;
  private byToolId = new Map<string, MessageRow>();
  /** Rows that started background work, by Claude's background task id (a subagent's is its agent id). */
  private byBackgroundId = new Map<string, MessageRow>();
  /**
   * How a background task ended, by its id, from its notifications: a subagent a subagent started has its Agent call
   * in the subagent's transcript, and one a Code Mode script started is under the script's REPL call, so neither
   * has a row of its own among the rows, only the notification.
   */
  readonly ended = new Map<string, BackgroundTask['status']>();
  /** The subagents this session started, by agent id: their type (web-fetch), which names their messages. */
  private agentTypes = new Map<string, string>();
  /** The agent rows StructuredOutput calls became, by the call's tool_use id, until their results arrive. */
  private structuredAnswers = new Map<string, MessageRow>();
  /** Code Mode: the REPL calls Claude Code dispatched, by their eval number, until a Poll delivers their result. */
  private replByEval = new Map<string, MessageRow>();
  /** Code Mode: the Poll calls (plumbing that delivers dispatched results), by tool_use id. */
  private pollIds = new Set<string>();
  /** The id of the record addLine is folding: its rows get it. */
  private recordUuid: string | undefined;
  /**
   * The newest agent message's reply rows, by the API message's id, while no tool call of that message and no
   * input came after them. A message without a tool call ended its turn, so a Stop hook that makes the agent go
   * on, or a reply that comes before any new input, supersedes these rows. `calls`: the message ids of the tool
   * calls since, one of which sameMessage may yet show is this message under the mod's id.
   */
  private turnEnd: { messageId: string; rows: MessageRow[]; calls: Set<string> } | undefined;
  /** The API message id of each of the mod's message ids (LiveRows), for the newest responses. */
  private readonly messageIds = new Map<string, string>();
  /** Claude's own name for the session (its ai-title records), the latest. */
  aiTitle = '';
  /** The name the user gave it in Claude Code (/rename, or a host's rename_session), the latest; '' takes it away. */
  customTitle = '';
  /** The skills the harness lists for the agent (Claude's skill_listing records, Codex's skills instructions), by name. */
  private skills = new Map<string, SlashCommand>();

  constructor(protected readonly opts: AccumulatorOpts = {}) {}

  /** The skills the session offers the agent, in the order they were first listed. */
  get commands(): SlashCommand[] {
    return [...this.skills.values()];
  }

  protected takeSkills(list: SlashCommand[]): void {
    for (const s of list) this.skills.set(s.name, s);
  }

  /** The session's name in Claude Code: the user's, else Claude's own; '' before it has one. */
  get sessionName(): string {
    return this.customTitle || this.aiTitle;
  }

  reset(): void {
    this.rows = [];
    this.aiTitle = '';
    this.customTitle = '';
    this.skills.clear();
    this.scriptCalls.clear();
    this.settled = [];
    this.callOwners.clear();
    this.callRepl.clear();
    this.scriptFiles.clear();
    this.nextId = 0;
    this.byToolId.clear();
    this.structuredAnswers.clear();
    this.replByEval.clear();
    this.pollIds.clear();
    this.byBackgroundId.clear();
    this.ended.clear();
    this.images.clear();
    this.payloadIds.clear();
    this.turnEnd = undefined;
    this.messageIds.clear();
  }

  /** The mod's `liveId` and the transcript's `apiId` name one response (LiveRows). */
  sameMessage(liveId: string, apiId: string): void {
    if (liveId === apiId) return;
    this.messageIds.set(liveId, apiId);
    if (this.messageIds.size > MESSAGE_IDS_KEPT) this.messageIds.delete(this.messageIds.keys().next().value as string);
    const end = this.turnEnd;
    if (!end) return;
    if (end.messageId === liveId) end.messageId = apiId;
    if (end.calls.delete(liveId)) end.calls.add(apiId);
    if (end.calls.has(end.messageId)) this.turnEnd = undefined;
  }

  /**
   * A Bash call run in the background (its result names the task id and the
   * file its output goes to), an Agent call launched in the background, a
   * Workflow call (its result's toolUseResult is `{status:'async_launched',
   * taskId, taskType:'local_workflow', runId, …}`, claude 2.1.314), or a
   * Monitor (`{taskId, timeoutMs, persistent}`, and its result starts "Monitor
   * started (task b5mejbp4l, …", claude 2.1.325). A Code Mode script's call goes
   * on its REPL row's `started` too, since the conversation's rows don't hold it.
   */
  private takeBackground(row: MessageRow, tur: Rec | undefined, result: string | undefined): void {
    let id: string | undefined;
    if (typeof tur?.backgroundTaskId === 'string' && tur.backgroundTaskId) id = tur.backgroundTaskId;
    else if (tur?.isAsync === true && typeof tur.agentId === 'string' && tur.agentId) id = tur.agentId;
    else if (tur?.taskType === 'local_workflow' && typeof tur.taskId === 'string' && tur.taskId) id = tur.taskId;
    else if (row.tool === 'Monitor') id = (typeof tur?.taskId === 'string' && tur.taskId ? tur.taskId : undefined) ?? /^Monitor started \(task (\w+)/.exec(result ?? '')?.[1];
    if (!id) return;
    // The transcript's copy of a script's call the mod handed over: the row already says how its work stands.
    if (row.background?.id === id) return;
    const outputFile =
      (typeof tur?.outputFile === 'string' && tur.outputFile ? tur.outputFile : undefined) ??
      /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(result ?? '')?.[1];
    row.background = { id, status: 'running', ...(outputFile ? { outputFile } : {}) };
    this.byBackgroundId.set(id, row);
    const repl = row.toolUseId ? this.callRepl.get(row.toolUseId) : undefined;
    if (repl) repl.started = [...(repl.started ?? []), row];
  }

  /**
   * A stream's task event (stream-json, claude 2.1.330): a background task the stop_task control request stopped
   * says so only here until the agent's next turn. Its summary is the task's description, not how it ended, and a
   * subagent's completion can still be waiting on its own work, so only a stop counts.
   */
  private takeTaskEvent(rec: Rec): void {
    const row = typeof rec.task_id === 'string' ? this.byBackgroundId.get(rec.task_id) : undefined;
    if (row?.background?.status !== 'running' || (rec.status !== 'stopped' && rec.status !== 'killed')) return;
    row.background = { ...row.background, status: 'stopped' };
  }

  /**
   * A background command's or subagent's task notification: its row gets how it ended.
   * A subagent that stopped with background work of its own still running is reported
   * as completed ("… is waiting on its own background work", with a note that it may
   * resume and notify again, claude 2.1.316), but it's still running.
   */
  private takeNotification(text: string): void {
    this.turnEnd = undefined;
    const n = parseTaskNotification(text);
    const row = n ? this.byBackgroundId.get(n.id) : undefined;
    if (!n) return;
    // Kept for any task, with a row or not: a call a Code Mode script made is under its REPL call, not among the rows.
    if (n.status === 'completed' && WAITING_ON_OWN_WORK.test(text)) this.ended.set(n.id, 'running');
    else this.ended.set(n.id, n.status);
    if (!row?.background) return;
    if (n.status === 'completed' && WAITING_ON_OWN_WORK.test(text)) {
      row.background = { ...row.background, status: 'running' };
      delete row.background.summary;
      return;
    }
    row.background = {
      ...row.background,
      status: n.status,
      ...(n.summary ? { summary: n.summary } : {}),
      ...(n.outputFile && !row.background.outputFile ? { outputFile: n.outputFile } : {}),
    };
  }

  /**
   * A SendMessage that woke an agent which had finished ("Resuming agent a3bb017", its result's resumedAgentId or
   * revivedAgentId): it runs again until its next notification, whatever its last one said.
   */
  private takeResume(tur: Rec | undefined): void {
    const id = tur?.resumedAgentId ?? tur?.revivedAgentId;
    if (typeof id !== 'string' || !id) return;
    this.ended.set(id, 'running');
    const row = this.byBackgroundId.get(id);
    if (!row?.background || row.background.status === 'running') return;
    row.background = { ...row.background, status: 'running' };
    delete row.background.summary;
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
    this.addParsed(rec);
  }

  /** A notification Claude queued for a task's end: a task with no row of its own here (a subagent's subagent) ended, though nothing else in this transcript says so. */
  private noteQueuedEnd(text: string): void {
    const n = parseTaskNotification(text);
    if (!n) return;
    if (n.status === 'completed' && WAITING_ON_OWN_WORK.test(text)) this.ended.set(n.id, 'running');
    else this.ended.set(n.id, n.status);
  }

  /** A record addLine has parsed, or one the mod handed over (LiveRows). */
  addParsed(rec: Rec): void {
    if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string' && isTaskNotification(rec.content)) this.noteQueuedEnd(rec.content);
    this.recordUuid = typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : undefined;
    try {
      this.addRecord(rec);
    } finally {
      this.recordUuid = undefined;
    }
  }

  private addRecord(rec: Rec): void {
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) this.aiTitle = rec.aiTitle.trim();
    else if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') this.customTitle = rec.customTitle.trim();
    // The main transcript may inline sidechain records; they belong to the subagent view.
    if (!this.opts.sidechain && rec.isSidechain === true) return;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    // Of the bookkeeping records only the user's guidance shows: a PostToolUse
    // hook hands it over as additional context (an attachment record), a Stop
    // hook as a meta user message ("Stop hook feedback:\n…").
    if (rec.type === 'attachment') {
      const att = rec.attachment as Rec | undefined;
      // A message queued for the agent (the user's, another session's, a subagent's report) or Looper's mod's starts a turn.
      if (att?.type === 'queued_command' || att?.type === 'plugin_note') this.turnEnd = undefined;
      if (att?.type === 'hook_additional_context' && Array.isArray(att.content)) {
        for (const c of att.content) if (typeof c === 'string') this.pushGuidance(c, ts);
        // A Stop hook's context makes the agent go on, as a block does (claude 2.1.328).
        if (att.hookEvent === 'Stop' || att.hookEvent === 'SubagentStop') this.supersedeTurnEnd();
      }
      // Looper's mod hands guidance over mid-turn as a note of its own (claude-mod.ts, claude 2.1.327), and tells the agent
      // when it stopped a background task (backgroundStoppedNote): the task's end, from when the note is stored, before the
      // agent's next request carries it (heldContent, claude 2.1.330).
      if (att?.type === 'plugin_note' && att.plugin === 'looper') {
        if (Array.isArray(att.heldContent)) for (const c of att.heldContent) if (typeof c === 'string' && isTaskNotification(c)) this.takeNotification(c);
        if (Array.isArray(att.content)) {
          for (const c of att.content) {
            if (typeof c !== 'string') continue;
            if (isTaskNotification(c)) this.takeNotification(c);
            else this.takeModNote(c, ts);
          }
        }
      }
      // A background command or subagent ended: Claude queues its notification for the agent.
      if (att?.type === 'queued_command' && att.commandMode === 'task-notification' && typeof att.prompt === 'string') {
        this.takeNotification(att.prompt);
      }
      if (att?.type === 'skill_listing' && typeof att.content === 'string') this.takeSkills(skillsListed(att.content));
      // Code Mode hands scripts' results over beside the conversation when no Poll call waits for them (claude 2.1.328):
      // the transcript keeps each event as the engine made it, and the mod hands over the rendering, which lists their nonces.
      if (att?.type === 'poll_events') {
        if (Array.isArray(att.envelopes)) for (const e of att.envelopes) if (typeof e === 'string') this.takeReplEvent(e);
        if (Array.isArray(rec.rendered)) this.takeReplResults(rec.rendered.map((r) => (r as Rec | null)?.content).filter((c) => typeof c === 'string').join('\n'));
      }
      // A prompt typed while the agent worked reaches it inside the running turn: it shows where the agent read it.
      if (att?.type === 'queued_command' && att.commandMode === 'prompt' && typeof att.prompt === 'string' && att.prompt.trim()) {
        // A subagent's message names it (claude 2.1.330); the Agent call a script made is written only once the script ends.
        const origin = att.origin as Rec | undefined;
        if (origin?.kind === 'peer') this.nameAgent(origin.from, origin.name);
        if (!this.pushGuidance(att.prompt, ts)) this.pushPrompt(att.prompt, ts);
      }
      return;
    }
    // A headless turn's end (stream-json): the next reply answers new input, even input the stream doesn't show, such as a cron job's prompt.
    if (rec.type === 'result') this.turnEnd = undefined;
    if (rec.type === 'system' && rec.subtype === 'task_notification') this.takeTaskEvent(rec);
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    const msg = rec.message;
    if (msg === null || typeof msg !== 'object') return;
    const content = (msg as Rec).content;
    if (rec.isMeta === true) {
      if (rec.type !== 'user') return;
      if (this.takeSkill(rec, content)) return;
      const text = textOf(content);
      const stopBlock = text.trimStart().startsWith(STOP_HOOK_FEEDBACK);
      // A wake-up or another session's message starts a turn. Mid-turn meta text (an image's size) follows a tool call.
      if (this.rows.at(-1)?.kind !== 'tool' && !stopBlock) this.turnEnd = undefined;
      // A background job's end can come as a meta record too (a stream's isSynthetic).
      if (isTaskNotification(text)) this.takeNotification(text);
      else if (text) this.pushGuidance(text, ts);
      if (stopBlock) this.supersedeTurnEnd();
      return;
    }

    if (rec.type === 'user') {
      // In -p mode a background job's end comes as a user message of its own: no prompt of the user's.
      const only = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 ? (content[0] as Rec)?.text : undefined;
      if (typeof only === 'string' && isTaskNotification(only)) {
        this.takeNotification(only);
        return;
      }
      // A slash command or skill the user ran: the user's turn is "/name args"; the skill's
      // content follows as a meta record, which stays hidden.
      const command = typeof only === 'string' ? slashCommandText(only) : null;
      if (command !== null) {
        this.push({ kind: 'prompt', ts, text: command });
        return;
      }
      if (typeof content === 'string') {
        // Guidance typed into an idle interactive session arrives as a plain prompt.
        if (!this.pushGuidance(content, ts)) this.pushPrompt(content, ts);
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content as Rec[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && this.pollIds.delete(block.tool_use_id)) {
          this.takeReplResults(resultText(block.content));
        } else if (block?.type === 'tool_result') {
          this.takeResume(rec.toolUseResult as Rec | undefined);
          // A StructuredOutput call already became the agent's reply; a rejected one (schema mismatch) is retried, so its reply goes.
          const answer = typeof block.tool_use_id === 'string' ? this.structuredAnswers.get(block.tool_use_id) : undefined;
          if (answer) {
            this.structuredAnswers.delete(block.tool_use_id as string);
            if (block.is_error === true) {
              const at = this.rows.indexOf(answer);
              if (at !== -1) this.rows.splice(at, 1);
            }
            continue;
          }
          const row = typeof block.tool_use_id === 'string' ? this.byToolId.get(block.tool_use_id) : undefined;
          if (!row) continue;
          row.result = cap(resultText(block.content), MAX_TEXT);
          // A Code Mode script's call records what it returned only in the record's toolUseResult.
          if (!row.result && rec.isVirtual === true && rec.toolUseResult !== undefined) row.result = cap(scriptCallResult(rec.toolUseResult), MAX_TEXT);
          if (block.is_error === true) row.resultError = true;
          const owner = this.callOwners.get(block.tool_use_id as string);
          if (owner?.calls) {
            this.callOwners.delete(block.tool_use_id as string);
            const at = block.is_error === true ? (this.scriptCalls.get(owner.toolUseId!)?.indexOf(row) ?? -1) : -1;
            const failures = owner.calls.failures ?? [];
            owner.calls = callCounts(owner.calls, at === -1 ? failures : [...failures, at].sort((a, b) => a - b), (owner.calls.running ?? 0) - 1);
          }
          // Code Mode ran the script in the background: its result comes with a later Poll.
          const dispatched = row.tool === 'REPL' ? /^\(dispatched #(\d+)\)$/.exec(row.result.trim()) : null;
          if (dispatched) {
            delete row.result;
            this.replByEval.set(dispatched[1], row);
          }
          this.takeImage(row, block.content, { toolUseId: block.tool_use_id as string });
          const patch = takePatch(rec.toolUseResult);
          if (patch) row.patch = patch;
          // The record-level toolUseResult carries the subagent id of a Task call.
          const tur = rec.toolUseResult as Rec | undefined;
          const agentId = tur?.agentId;
          if (typeof agentId === 'string' && agentId) row.agentId = agentId;
          this.nameAgent(agentId, tur?.agentType ?? (row.input as Rec | undefined)?.subagent_type);
          this.takeBackground(row, tur, row.result);
          // SendUserFile: the result confirms delivery, so the call becomes the agent's message with its files.
          if (row.tool === 'SendUserFile' && block.is_error !== true && !row.sent) {
            const sent = sentFilesOf(row.input, tur);
            if (sent) {
              row.sent = sent;
              row.preview = sent.caption ? previewOf(sent.caption) : sent.files.map((f) => f.name).join(', ').slice(0, MAX_PREVIEW);
              // A script's call is under its REPL call, which the conversation shows as a call: the message goes after it.
              if (row.toolUseId && this.callRepl.has(row.toolUseId)) {
                const shown = this.push({ kind: 'tool', ts, tool: row.tool, text: row.text, preview: row.preview });
                Object.assign(shown, { input: row.input, result: row.result, sent, fromScript: true });
              }
            }
          }
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!this.pushGuidance(block.text, ts)) this.pushPrompt(block.text, ts);
        } else if (block?.type === 'image') {
          const row = this.push({ kind: 'prompt', ts, text: '(image)' });
          this.takeImage(row, [block], { block: (content as Rec[]).indexOf(block) });
        }
      }
      return;
    }

    if (!Array.isArray(content)) return;
    // Claude Code records an API error (usage limit, overloaded…) as an assistant message: a transcript
    // marks it isApiErrorMessage, a stream-json line is_api_error_message (claude 2.1.316).
    const apiError = rec.isApiErrorMessage === true || rec.is_api_error_message === true;
    if (apiError) {
      const text = textOf(content) || (typeof rec.error === 'string' && rec.error ? `API error: ${rec.error}` : 'The request failed.');
      this.push({ kind: 'error', ts, text });
      return;
    }
    if (rec.isVirtual === true && this.takeScriptCalls(content as Rec[], ts, rec.liveScriptCall === true)) return;
    const ownId = messageIdOf(rec);
    const messageId = ownId && (this.messageIds.get(ownId) ?? ownId);
    for (const block of content as Rec[]) {
      if (block?.type === 'tool_use' && this.turnEnd) {
        if (this.turnEnd.messageId === messageId) this.turnEnd = undefined;
        else if (messageId) this.turnEnd.calls.add(messageId);
      }
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.takeReply(this.push({ kind: 'agent', ts, text: block.text }), messageId);
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        this.push({ kind: 'thinking', ts, text: block.thinking });
      } else if (block?.type === 'tool_use' && block.name === 'Poll' && typeof block.id === 'string') {
        // Code Mode's Poll only delivers the results of scripts it dispatched: they go to their REPL rows.
        this.pollIds.add(block.id);
      } else if (block?.type === 'tool_use' && block.name === 'StructuredOutput' && structuredOutputText(block.input)) {
        // A workflow agent's answer: the script reads this call, and the conversation shows it as the agent's reply.
        const row = this.push({ kind: 'agent', ts, text: structuredOutputText(block.input) });
        if (typeof block.id === 'string' && block.id) this.structuredAnswers.set(block.id, row);
      } else if (block?.type === 'tool_use') {
        this.rows.push(this.toolRow(block, ts));
      }
    }
  }

  /** A tool call's row, which the tool's result fills in (byToolId). */
  private toolRow(block: Rec, ts: string | undefined): MessageRow {
    const row = this.newRow({
      kind: 'tool',
      ts,
      tool: typeof block.name === 'string' ? block.name : 'tool',
      text: formatToolInput(block.input),
      preview: toolPreview(block.input),
    });
    if (typeof block.id === 'string' && block.id) row.toolUseId = block.id;
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
    return row;
  }

  /**
   * Code Mode writes the tool calls a script made (isVirtual records) once the script's result is delivered, each
   * stamped with when it was written, a few ms after the script ended (claude 2.1.329): they go under the REPL row
   * whose script ended last before then. Looper's mod hands each call over as it starts (`live`), before the script
   * has ended: it goes under the newest script still running, and the transcript's copy moves it if another script
   * made it. A reader that comes to the transcript after the script's result was delivered (a chat opened, or one
   * poll covering the whole script) sees no script running when it reads the mod's calls: they go under the script
   * that ended first after they started, as the transcript's copies, written a moment after the result, would put
   * them. False when no delivered script can have made them.
   */
  private takeScriptCalls(content: Rec[], ts: string | undefined, live: boolean): boolean {
    let owner: { row: MessageRow; at: string } | undefined;
    if (!live) for (const s of this.settled) if ((ts === undefined || s.at <= ts) && (!owner || s.at >= owner.at)) owner = s;
    const row = live ? (this.runningRepl() ?? this.endedAfter(ts)) : owner?.row;
    // A call the mod saw start with no script it can belong to waits for the transcript's copy.
    if (!row?.toolUseId) return live;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const had = typeof block.id === 'string' ? this.callRepl.get(block.id) : undefined;
      if (had) {
        if (had !== row && !live) this.moveScriptCall(block.id as string, had, row);
        continue;
      }
      this.addScriptCall(row, this.toolRow(block, ts));
    }
    return true;
  }

  /** Code Mode: the delivered script that ended first at or after `ts` (a call started before it ended). */
  private endedAfter(ts: string | undefined): MessageRow | undefined {
    if (ts === undefined) return undefined;
    let found: { row: MessageRow; at: string } | undefined;
    for (const s of this.settled) if (s.at >= ts && (!found || s.at < found.at)) found = s;
    return found?.row;
  }

  /** Code Mode: the newest REPL row whose script hasn't ended. */
  private runningRepl(): MessageRow | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r.kind === 'tool' && r.tool === 'REPL' && r.toolUseId && r.result === undefined) return r;
    }
    return undefined;
  }

  private addScriptCall(repl: MessageRow, call: MessageRow): void {
    const calls = this.scriptCalls.get(repl.toolUseId!) ?? [];
    this.scriptCalls.set(repl.toolUseId!, calls);
    const files = this.scriptFiles.get(repl.toolUseId!) ?? new Map<string, { changed: boolean; index: number }>();
    this.scriptFiles.set(repl.toolUseId!, files);
    calls.push(call);
    const open = call.result === undefined;
    if (call.toolUseId) {
      this.callRepl.set(call.toolUseId, repl);
      if (open) this.callOwners.set(call.toolUseId, repl);
    }
    if (call.file) files.set(call.file, { changed: !!files.get(call.file)?.changed || CHANGE_TOOLS.has(call.tool ?? ''), index: calls.length - 1 });
    if (call.background && !repl.started?.includes(call)) repl.started = [...(repl.started ?? []), call];
    repl.calls = callCounts(
      { count: calls.length, failed: 0, ...(files.size ? { files: [...files].map(([path, f]) => ({ path, ...f })) } : {}) },
      call.resultError ? [...(repl.calls?.failures ?? []), calls.length - 1] : (repl.calls?.failures ?? []),
      (repl.calls?.running ?? 0) + (open ? 1 : 0),
    );
  }

  /** A call the mod put under one running script that another one made, as the transcript says. */
  private moveScriptCall(id: string, from: MessageRow, to: MessageRow): void {
    const list = this.scriptCalls.get(from.toolUseId!) ?? [];
    const at = list.findIndex((c) => c.toolUseId === id);
    if (at === -1) return;
    const [call] = list.splice(at, 1);
    this.callOwners.delete(id);
    this.scriptFiles.delete(from.toolUseId!);
    this.scriptCalls.delete(from.toolUseId!);
    delete from.calls;
    delete from.started;
    for (const c of list) this.addScriptCall(from, c);
    if (!list.length) this.scriptCalls.set(from.toolUseId!, []);
    this.addScriptCall(to, call);
  }

  /** A REPL row's script ended at `at` (its repl-eval event's): the calls it made come after its result. */
  private settle(row: MessageRow, attrs: string): void {
    const at = /\bat="([^"]+)"/.exec(attrs)?.[1];
    if (!at) return;
    this.settled.push({ row, at });
    if (this.settled.length > SETTLED_KEPT) this.settled.shift();
  }

  /** A reply of message `messageId`: it supersedes the replies of the message before when that one ended its turn (see turnEnd). */
  private takeReply(row: MessageRow, messageId: string | undefined): void {
    if (!messageId) {
      this.turnEnd = undefined;
      return;
    }
    if (this.turnEnd?.messageId === messageId) {
      this.turnEnd.rows.push(row);
      return;
    }
    this.supersedeTurnEnd();
    this.turnEnd = { messageId, rows: [row], calls: new Set() };
  }

  /** The agent went on past the reply that ended its turn: that reply stays superseded, whatever comes before its next one. */
  private supersedeTurnEnd(): void {
    for (const r of this.turnEnd?.rows ?? []) r.superseded = true;
    this.turnEnd = undefined;
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
    this.push({ kind: 'raw', ts, tool: type, text, preview: clip(line.replace(/\s+/g, ' ').trim(), MAX_PREVIEW) });
  }

  /**
   * The skill's content Claude Code adds after a Skill call, as a meta user
   * record ("Base directory for this skill: …" and the SKILL.md text) naming
   * the call in sourceToolUseID (seen in claude 2.1.x transcripts). Without
   * that field, a skill text right after a Skill call is that call's. A skill
   * the user ran as a slash command has no Skill call, so its content stays
   * hidden. True when the record was the call's skill content.
   */
  private takeSkill(rec: Rec, content: unknown): boolean {
    const text = textOf(content);
    if (!text.trim()) return false;
    const source = typeof rec.sourceToolUseID === 'string' ? this.byToolId.get(rec.sourceToolUseID) : undefined;
    const last = this.rows[this.rows.length - 1];
    // A stream has no sourceToolUseID, and a built-in skill's text has no "Base directory" line, so any
    // meta text right after a Skill call that has none yet is its skill, unless it's hook feedback or a task notification.
    const row =
      source ??
      (last?.kind === 'tool' &&
      last.tool === 'Skill' &&
      last.skill === undefined &&
      guidanceText(text) === null &&
      eventsText(text) === null &&
      delegateText(text) === null &&
      taskEventsText(text) === null &&
      peerMessages(text) === null &&
      !isTaskNotification(text)
        ? last
        : undefined);
    if (row?.tool !== 'Skill') return false;
    row.skill = cap(text, MAX_TEXT);
    return true;
  }

  /** The user's prompt row, or a task row when a workflow script computed the text for one of its agents. */
  protected pushPrompt(raw: string, ts?: string): void {
    // A compacted chat's first message starts with the earlier conversation, which the chat keeps as rows of its own (compacted.json).
    const full = withoutCompacted(raw);
    if (!full.trim()) return;
    // Claude Code's own bash mode records a command's output as a message after its input: it fills in that command.
    const output = parseOutputOnly(full);
    const last = this.rows[this.rows.length - 1];
    const waiting = last?.kind === 'prompt' ? last.attachments?.[last.attachments.length - 1] : undefined;
    if (output && waiting?.command && waiting.command.exitCode === null && !waiting.command.stopped && !waiting.command.stdout && !waiting.command.stderr) {
      last!.attachments = [...last!.attachments!.slice(0, -1), commandAttachment(withOutput(waiting.command, output))];
      return;
    }
    // The commands the user ran from the message box (or Claude Code's bash mode), and the files the agent read by path, show as the message's attachments.
    const { commands, text: said } = parseCommands(full, `cmd${this.nextId}`);
    const { files, text } = this.fileList(said);
    const task = commands.length || files.length ? null : workflowTaskText(text);
    if (task !== null) this.push({ kind: 'task', ts, text: task });
    else {
      const row = this.push({ kind: 'prompt', ts, text, preview: text || !commands.length ? undefined : previewOf(commands.map((c) => `! ${c.input}`).join(', ')) });
      if (files.length || commands.length) row.attachments = [...files, ...commands.map(commandAttachment)];
    }
  }

  /** The files withFileList listed in a message, when the accumulator knows Looper's attachment copies. */
  private fileList(text: string): { files: Attachment[]; text: string } {
    return this.opts.attachment ? parseFileList(text, this.opts.attachment) : { files: [], text };
  }

  /**
   * A Code Mode Poll's delivery: each authentic `repl-eval` event (its nonce is
   * in the delivery's list; any other is text quoted inside a result) settles
   * the REPL row it names by eval number (claude 2.1.327).
   */
  private takeReplResults(text: string): void {
    const listed = /authentic event nonces for this delivery: ([^—\n<]+)/.exec(text)?.[1] ?? '';
    const nonces = new Set(listed.split(/[\s,]+/).filter(Boolean));
    for (const m of text.matchAll(/<event nonce="([^"]+)" kind="repl-eval"([^>]*)>([\s\S]*?)<\/event>/g)) {
      const evalNo = /\beval="(\d+)"/.exec(m[2])?.[1];
      const row = evalNo !== undefined && nonces.has(m[1]) ? this.replByEval.get(evalNo) : undefined;
      if (row) this.settleRepl(row, evalNo!, m[2], m[3]);
    }
    // A background task's end comes in the same delivery, as an event of its own.
    for (const m of text.matchAll(/<event nonce="([^"]+)" kind="task-notification"[^>]*>([\s\S]*?)<\/event>/g)) {
      if (nonces.has(m[1])) this.takeNotification(m[2]);
    }
  }

  /** One event the engine delivered (a poll_events record's own): nothing quoted it, so no nonce list vouches for it. */
  private takeReplEvent(envelope: string): void {
    if (/^<event nonce="[^"]+" kind="task-notification"/.test(envelope.trim())) {
      this.takeNotification(envelope);
      return;
    }
    const m = /^<event nonce="[^"]+" kind="repl-eval"([^>]*)>([\s\S]*)<\/event>$/.exec(envelope.trim());
    const evalNo = m ? /\beval="(\d+)"/.exec(m[1])?.[1] : undefined;
    const row = evalNo !== undefined ? this.replByEval.get(evalNo) : undefined;
    if (row) this.settleRepl(row, evalNo!, m![1], m![2]);
  }

  /**
   * A script's repl-eval event fills in its REPL row: its result, or the error that ended it, and the lines it
   * logged. An event with neither (output logged after it ended) leaves the row as it is.
   */
  private settleRepl(row: MessageRow, evalNo: string, attrs: string, body: string): void {
    const logs = [...body.matchAll(/<log>([\s\S]*?)<\/log>/g)].map((l) => l[1].trim());
    const result = /<result>([\s\S]*)<\/result>/.exec(body);
    const error = result ? null : /<error>([\s\S]*)<\/error>/.exec(body);
    const end = result ?? error;
    if (!end) return;
    this.replByEval.delete(evalNo);
    row.result = cap(end[1].trim(), MAX_TEXT);
    if (logs.length) row.logs = cap(logs.join('\n'), MAX_TEXT);
    if (error) row.resultError = true;
    this.settle(row, attrs);
  }

  /** The image a tool call's result carried, by the call's tool_use id (TranscriptReader.toolImage reads a transcript's). */
  toolImage(toolUseId: string): StoredImage | null {
    const row = this.byToolId.get(toolUseId);
    return (row && this.images.get(row.id)) ?? null;
  }

  /**
   * Keep the first image block's payload engine-side and mark the row: a transcript's stays in it, found again by
   * `which` (the tool call whose result it is, or the message's block).
   */
  private takeImage(row: MessageRow, content: unknown, which: { toolUseId: string } | { block: number }): void {
    const image = imageOf(content);
    if (!image) return;
    row.image = { mediaType: image.mediaType };
    if (this.lineAt) {
      this.images.set(row.id, { mediaType: image.mediaType, at: this.lineAt, ...which });
      return;
    }
    this.images.set(row.id, image);
    this.payloadIds.add(row.id);
    for (const oldest of this.payloadIds) {
      if (this.payloadIds.size <= MAX_IMAGES) break;
      this.payloadIds.delete(oldest);
      this.images.delete(oldest);
    }
  }

  /** A message a chat sends its agent, as its row: Looper's related events or task events, else the user's prompt. */
  protected promptRow(text: string): MessageRow {
    const ts = new Date().toISOString();
    const events = eventsText(text);
    if (events !== null) return this.push({ kind: 'events', ts, text: events });
    const taskEvents = taskEventsText(text);
    if (taskEvents !== null) return this.push({ kind: 'taskEvents', ts, text: taskEvents });
    return this.push({ kind: 'prompt', ts, text });
  }

  /** A subagent's type, from its Agent call or its message: the messages it already sent take it too. */
  private nameAgent(id: unknown, type: unknown): void {
    if (typeof id !== 'string' || !id || typeof type !== 'string' || !type || this.agentTypes.has(id)) return;
    this.agentTypes.set(id, type);
    for (const r of this.rows) if (r.kind === 'peer' && r.from === id) r.from = type;
  }

  /** A message Looper's mod handed the agent mid-turn: a run's guidance, related events or delegated agents' messages show; its notice doesn't. */
  protected takeModNote(text: string, ts?: string): void {
    this.pushGuidance(text, ts);
  }

  /**
   * Rows of their own when `text` is a guidance, events, delegated agents' or task events message (see GUIDANCE_PREFIX,
   * EVENTS_PREFIX, DELEGATE_PREFIX, TASK_EVENTS_PREFIX) or other sessions' messages (peerMessages); false when it is none.
   */
  protected pushGuidance(text: string, ts?: string): boolean {
    const g = guidanceText(text);
    if (g !== null) {
      // The commands the user ran from the run's message box show as the guidance's attachments, as a prompt's do.
      const { commands, text: said } = parseCommands(g, `cmd${this.nextId}`);
      const { files, text: rest } = this.fileList(said);
      const row = this.push({ kind: 'guidance', ts, text: rest, preview: rest || !commands.length ? undefined : previewOf(commands.map((c) => `! ${c.input}`).join(', ')) });
      if (files.length || commands.length) row.attachments = [...files, ...commands.map(commandAttachment)];
      return true;
    }
    const events = eventsText(text);
    if (events !== null) {
      this.push({ kind: 'events', ts, text: events });
      return true;
    }
    const delegated = delegateText(text);
    if (delegated !== null) {
      this.push({ kind: 'delegate', ts, text: delegated });
      return true;
    }
    const taskEvents = taskEventsText(text);
    if (taskEvents !== null) {
      this.push({ kind: 'taskEvents', ts, text: taskEvents });
      return true;
    }
    const peers = peerMessages(text);
    if (!peers) return false;
    for (const p of peers) {
      const row = this.push({ kind: 'peer', ts, text: p.text });
      if (p.from) row.from = this.agentTypes.get(p.from) ?? p.from;
    }
    return true;
  }

  protected push(r: { kind: MessageRow['kind']; ts?: string; text: string; tool?: string; preview?: string }): MessageRow {
    const row = this.newRow(r);
    if (INPUT_KINDS.has(r.kind)) this.turnEnd = undefined;
    this.rows.push(row);
    return row;
  }

  private newRow(r: { kind: MessageRow['kind']; ts?: string; text: string; tool?: string; preview?: string }): MessageRow {
    const row: MessageRow = {
      id:
        (this.opts.source === 'classifier'
          ? CLASSIFIER_ROW_PREFIX
          : this.opts.session !== undefined
            ? sessionRowPrefix(this.opts.session)
            : '') + String(this.nextId++),
      ts: r.ts,
      kind: r.kind,
      source: this.opts.source,
      tool: r.tool,
      preview: r.preview ?? previewOf(r.text),
      text: cap(r.text, MAX_TEXT),
    };
    if (this.recordUuid) row.uuid = this.recordUuid;
    return row;
  }
}

/** Looper's instructions ahead of a Codex chat's message: the conversation shows the message without them. */
const LOOPER_INSTRUCTIONS_RE = /^<looper_instructions>\n[\s\S]*?\n<\/looper_instructions>\n\n/;

/** The message with Looper's instructions ahead of it, for a Codex thread that started without them. */
export const withLooperInstructions = (instructions: string, text: string): string => `<looper_instructions>\n${instructions}\n</looper_instructions>\n\n${text}`;

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
    else if (rec.type === 'event_msg' && p.type === 'task_complete') {
      // A turn that failed (the usage limit…) ends with its error (codex_error_info "usage_limit_exceeded", seen in a rollout).
      const message = (p.error as Rec | null | undefined)?.message;
      if (typeof message === 'string' && message.trim()) this.push({ kind: 'error', ts, text: message.trim() });
    }
  }

  /** User prompts, assistant messages and reasoning summaries. */
  private addResponseItem(p: Rec, ts?: string): void {
    if (p.type === 'message') {
      // Developer records are injected instructions (skills, plugins…), and a
      // user text that is one wrapped <tag>…</tag> block is injected context.
      // The user's guidance shows either way: the PostToolUse hook's context
      // lands as a developer record (seen live, codex-cli 0.159.0), guidance
      // typed into an idle TUI as a user one.
      if (p.role !== 'user' && p.role !== 'assistant' && p.role !== 'developer') return;
      if (!Array.isArray(p.content)) return;
      for (const block of p.content as Rec[]) {
        const text = typeof block?.text === 'string' ? block.text : '';
        if (!text.trim()) continue;
        if (p.role !== 'assistant' && this.pushGuidance(text, ts)) continue;
        if (p.role === 'developer') {
          const skills = /### Available skills\n([\s\S]*?)(?:\n#|\n<\/skills_instructions>|$)/.exec(text);
          if (skills) this.takeSkills(skillsListed(skills[1]));
          continue;
        }
        if (block.type === 'input_text' && p.role === 'user') {
          // Injected context is one <tag>…</tag> block, after a heading line for the AGENTS.md
          // instructions ("# AGENTS.md instructions", seen live in codex-cli 0.163.0).
          if (/^(?:#[^\n]*\n+)?<([\w-]+)>[\s\S]*<\/\1>\s*$/.test(text.trim())) continue;
          this.pushPrompt(text.replace(LOOPER_INSTRUCTIONS_RE, ''), ts);
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

/** How long a transcript read parses before it lets the rest of the main process run. */
const READ_SLICE_MS = 10;
/** The bytes a transcript read takes from its file at a time: read whole, a transcript held as much memory again as its size. */
const READ_CHUNK = 1024 * 1024;

/**
 * The record types anything reads from a Claude Code transcript: the accumulator's (addRecord), and repl-mode, which a
 * chat follows. A line that starts with another type ({"type":"queue-operation", api-request, file-history-snapshot…)
 * is skipped before it's decoded or parsed: Claude Code's bookkeeping was 82% of a 160 MB transcript and 76% of another.
 * A queue-operation that holds a task notification is read: a subagent's end can be known only from it (noteQueuedEnd).
 */
const READ_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'result', 'ai-title', 'custom-title', 'repl-mode']);
const TYPE_FIRST = Buffer.from('{"type":"');
const TASK_NOTIFICATION = Buffer.from('<task-notification>');

/** Whether a line's record has a type nothing reads (READ_TYPES), told by the type it starts with. */
function unread(line: Buffer): boolean {
  if (line.length < TYPE_FIRST.length || line.compare(TYPE_FIRST, 0, TYPE_FIRST.length, 0, TYPE_FIRST.length) !== 0) return false;
  const end = line.subarray(TYPE_FIRST.length, TYPE_FIRST.length + 41).indexOf(0x22);
  if (end === -1) return false;
  const type = line.toString('latin1', TYPE_FIRST.length, TYPE_FIRST.length + end);
  if (type === 'queue-operation') return line.indexOf(TASK_NOTIFICATION) === -1;
  return !READ_TYPES.has(type);
}

/** Keys whose long values are base64 payloads: an image block's data, and the copy of a Read image in its toolUseResult. */
const PAYLOAD_KEYS = [Buffer.from('"data":"'), Buffer.from('"base64":"')];
/** A line longer than this has its payloads cut before it's decoded (clipPayloads). */
const CLIP_LINE = 256 * 1024;

/**
 * A long line decoded with each base64 payload in it (PAYLOAD_KEYS, a string without escapes) cut to MAX_TEXT + 1
 * characters, which everything that reads the parsed record treats as the whole: text is capped at MAX_TEXT, and an
 * image is only marked, then read again whole from its line when it's shown (imagePayload). Decoded whole, each
 * screenshot's line made 3-4 MB of strings that were garbage as soon as it was parsed.
 */
function clipPayloads(line: Buffer): string {
  const cuts: [number, number][] = [];
  for (const key of PAYLOAD_KEYS) {
    for (let i = line.indexOf(key); i !== -1; ) {
      const start = i + key.length;
      const end = line.indexOf(0x22, start);
      if (end === -1) break;
      const escape = line.indexOf(0x5c, start);
      if (end - start > MAX_TEXT + 1 && (escape === -1 || escape > end)) cuts.push([start + MAX_TEXT + 1, end]);
      i = line.indexOf(key, end);
    }
  }
  if (!cuts.length) return line.toString('utf8');
  cuts.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let from = 0;
  for (const [cut, end] of cuts) {
    parts.push(line.toString('utf8', from, cut));
    from = end;
  }
  parts.push(line.toString('utf8', from));
  return parts.join('');
}

/**
 * Incremental transcript tail: only bytes appended since the last read are
 * parsed, so 2-second polling stays cheap even over a \\wsl.localhost mount.
 * Lines split on raw \n bytes before decoding, so a read boundary inside a
 * UTF-8 sequence or a line cannot corrupt anything.
 */
let readers = 0;

export class TranscriptReader {
  readonly acc: TranscriptAccumulator;
  /** Names this reader, and counts its reads that found something new: together they tell a caller whether its rows are current. */
  private readonly id = ++readers;
  private rev = 0;
  get version(): string {
    return `${this.id}:${this.rev}`;
  }
  private readonly candidates: string[];
  private file: string | null = null;
  /** Where the next line starts: a line the file doesn't have the end of yet is read again from here. */
  private offset = 0;
  /** How much of the file has been read, so a poll that finds it the same size reads nothing. */
  private end = 0;
  /** Lines of a record type nothing reads are skipped: a Claude transcript's, unless every line shows (raw). */
  private readonly skipUnread: boolean;
  /** The next line is only the end of one (readTail started inside it): skipped. */
  private torn = false;

  /**
   * Several candidate paths may be given (e.g. a subagent under either parent
   * transcript): the first that exists wins. `sink`: each line goes there
   * instead of into `acc` (an interactive chat folds them into its own).
   */
  /** An interactive Claude Code session's rows from its mod, ahead of the transcript (LiveRows). */
  private readonly live: LiveRows | null;

  /** `liveDir`: the session's MOD_FILES.live folder, whose rows show before the transcript has them. */
  constructor(
    file: string | string[],
    opts: AccumulatorOpts = {},
    format: 'claude' | 'codex' = 'claude',
    private readonly sink?: (line: string) => void,
    liveDir?: string,
  ) {
    this.candidates = Array.isArray(file) ? file : [file];
    this.acc = format === 'codex' ? new CodexAccumulator(opts) : new TranscriptAccumulator(opts);
    this.skipUnread = format === 'claude' && !opts.raw;
    this.live = liveDir && format === 'claude' && !opts.raw ? new LiveRows(liveDir, (liveId, apiId) => this.acc.sameMessage(liveId, apiId)) : null;
  }

  /** Read from the transcript's end as it is now: what it already holds is left out (none yet: all of it). */
  async skipExisting(): Promise<void> {
    try {
      this.offset = this.end = (await fs.promises.stat(await this.resolve())).size;
    } catch {
      this.offset = this.end = 0;
    }
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

  /**
   * Reads only the transcript's last `bytes`, from the first line that starts in them, when it's at least `min`
   * long; false when it's shorter, and nothing is read. Then read() goes on from its end.
   */
  async readTail(bytes: number, min: number): Promise<boolean> {
    const size = (await fs.promises.stat(await this.resolve())).size;
    if (size < min) return false;
    this.offset = size - bytes;
    this.torn = true;
    await this.read();
    return true;
  }

  /** Reads one at a time: two overlapping ones would both start at the same offset and add the new lines twice. Resolves with whether the file grew. */
  private queue: Promise<unknown> = Promise.resolve();

  read(): Promise<boolean> {
    const next = this.queue.then(async () => {
      const grew = await this.readNew();
      const all = this.live ? (await this.live.read((rec) => this.acc.addParsed(rec))) || grew : grew;
      if (all) this.rev++;
      return all;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readNew(): Promise<boolean> {
    const file = await this.resolve();
    const st = await fs.promises.stat(file);
    if (st.size < this.end) {
      // The file shrank (should not happen to a transcript): start over.
      this.offset = this.end = 0;
      this.acc.reset();
      this.rev++;
    }
    if (st.size === this.end) return false;
    const fh = await fs.promises.open(file, 'r');
    try {
      // One buffer for the read, a chunk at a time: the line a chunk ends inside moves to the buffer's start and the
      // next chunk goes after it, and a line longer than the buffer doubles it, so no line is copied piece by piece.
      // Copying them (Buffer.from of each piece, then Buffer.concat) left 35-43 MB of garbage reading a 68 MB transcript.
      let buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - this.offset));
      /** Bytes in buf, which holds the file from this.offset; the first `scanned` of them have no line's end past the last line taken. */
      let held = 0;
      let scanned = 0;
      let since = performance.now();
      while (this.offset + held < st.size) {
        if (held === buf.length) {
          const bigger = Buffer.allocUnsafe(Math.min(buf.length * 2, st.size - this.offset));
          buf.copy(bigger, 0, 0, held);
          buf = bigger;
        }
        const { bytesRead } = await fh.read(buf, held, Math.min(buf.length - held, st.size - this.offset - held), this.offset + held);
        if (bytesRead === 0) break;
        held += bytesRead;
        const data = buf.subarray(0, held);
        let from = 0;
        let nl: number;
        while ((nl = data.indexOf(0x0a, scanned)) !== -1) {
          const line = data.subarray(from, nl);
          const at = this.offset + from;
          from = scanned = nl + 1;
          if (this.torn) this.torn = false;
          else this.take(line, at);
          // A whole transcript read at once (a chat shown for the first time) held the main process 520 ms for 72 MB.
          if (performance.now() - since > READ_SLICE_MS) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            since = performance.now();
          }
        }
        scanned = held - from;
        if (from) {
          buf.copyWithin(0, from, held);
          this.offset += from;
          held -= from;
        }
      }
      this.end = this.offset + held;
    } finally {
      await fh.close();
    }
    return true;
  }

  /** One line of the transcript, which starts at `at` in the file. */
  private take(bytes: Buffer, at: number): void {
    if (this.skipUnread && unread(bytes)) return;
    const line = (this.skipUnread && !this.sink && bytes.length > CLIP_LINE ? clipPayloads(bytes) : bytes.toString('utf8')).trim();
    if (!line) return;
    if (this.sink) {
      this.sink(line);
      return;
    }
    this.acc.lineAt = { offset: at, length: bytes.length };
    try {
      if (this.live) this.addTranscriptLine(line, this.live);
      else this.acc.addLine(line);
    } finally {
      this.acc.lineAt = undefined;
    }
  }

  /** The image a row's marker stands for, by its row id: a transcript's is read again from the file. */
  image(rowId: string): Promise<MessageImage | null> {
    return imagePayload(this.acc.images.get(rowId), this.file);
  }

  /** The image a tool call's result carried, by the call's tool_use id. */
  toolImage(toolUseId: string): Promise<MessageImage | null> {
    return imagePayload(this.acc.toolImage(toolUseId), this.file);
  }

  private addTranscriptLine(line: string, live: LiveRows): void {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // torn or foreign line
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return;
    if (live.transcriptRow(rec as Rec)) this.acc.addParsed(rec as Rec);
  }
}

/** A compacted chat's run folder keeps the conversation it was compacted from, as rows, once its first message makes it a run. */
export const COMPACTED_FILE = 'compacted.json';

/**
 * compacted.json: the compacted rows (compactRows, then layered), with every
 * call of the newest session, and in Code Mode the names the new session's
 * REPL got back from the earlier one's (replPrelude), which its own compaction
 * snapshots first.
 */
export interface CompactedFile {
  version: 3;
  rows: MessageRow[];
  replNames?: string[];
}

export const compactedFile = (rows: MessageRow[], replNames?: string[]): CompactedFile => ({ version: 3, rows, ...(replNames?.length ? { replNames } : {}) });

/** compacted.json files read, by path, while their size and modified time stay the same: a reopened chat's history reads its file on every poll. */
const compactedCache = new Map<string, { size: number; mtimeMs: number; ino: number; file: CompactedFile }>();
const MAX_COMPACTED_CACHE = 16;

/** A compacted chat's compacted.json; null for any other run. */
function readCompacted(runDir: string): CompactedFile | null {
  const file = path.join(runDir, COMPACTED_FILE);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null; // not a compacted chat
  }
  const hit = compactedCache.get(file);
  // The inode too: a file rewritten (writeJsonAtomic renames a new one over it) can keep its size and time to the ms.
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.file;
  let read: CompactedFile = { version: 3, rows: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CompactedFile>;
    if (data.version === 3 && Array.isArray(data.rows)) {
      const names = Array.isArray(data.replNames) ? data.replNames.filter((n): n is string => typeof n === 'string') : [];
      read = compactedFile(data.rows, names);
    }
  } catch {
    /* torn file: no rows */
  }
  compactedCache.delete(file);
  compactedCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, file: read });
  if (compactedCache.size > MAX_COMPACTED_CACHE) compactedCache.delete(compactedCache.keys().next().value!);
  return read;
}

/** The rows of a compacted chat's compacted.json; empty for any other run. */
export function readCompactedRows(runDir: string): MessageRow[] {
  return readCompacted(runDir)?.rows ?? [];
}

/** Code Mode: the names a compacted chat's REPL got back from the session it was compacted from; empty for any other run. */
export function readCompactedReplNames(runDir: string): string[] {
  return readCompacted(runDir)?.replNames ?? [];
}

/**
 * The earlier compacted.json files become version 3. The first was an array
 * of the messages alone, whose rows become the oldest session's; version 2
 * has version 3's shape without its REPL names. The file's start tells them
 * apart (its first character, or the version that leads its object), so a run
 * without one costs a failed open. True when it rewrote the file.
 */
export async function migrateCompactedFile(runDir: string): Promise<boolean> {
  const file = path.join(runDir, COMPACTED_FILE);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return false; // not a compacted chat
  }
  const head = Buffer.alloc(32);
  let read = 0;
  try {
    ({ bytesRead: read } = await fh.read(head, 0, head.length, 0));
  } finally {
    await fh.close();
  }
  const start = head.toString('utf8', 0, read);
  if (start.startsWith('[')) {
    const rows = JSON.parse(await fs.promises.readFile(file, 'utf8')) as MessageRow[];
    await writeJsonAtomicAsync(file, compactedFile(rows.map((r) => ({ ...r, layer: 0 }))));
    return true;
  }
  if (!/^\{\s*"version"\s*:\s*2\s*,/.test(start)) return false;
  const v2 = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { rows?: unknown };
  await writeJsonAtomicAsync(file, compactedFile(Array.isArray(v2.rows) ? (v2.rows as MessageRow[]) : []));
  return true;
}

/** Run folders the compacted.json migration opens at once. */
const MIGRATE_BATCH = 32;

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
 * The conversation id a finished run can be resumed under: claude's session id
 * (from the SessionStart/Stop hook payload, falling back to the transcript's
 * filename), or codex's thread id. Null when the run recorded no conversation
 * (custom harness, spawn failure, pruned run dir).
 */
export function readRunSessionId(runDir: string, kind: 'claude-code' | 'codex' | 'custom'): string | null {
  if (kind === 'claude-code') {
    for (const name of ['session.json', 'stop.json']) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8').replace(/^﻿/, ''));
        const sid = (raw as Rec | null)?.session_id;
        if (typeof sid === 'string' && sid.trim()) return sid.trim();
        // Transcripts live at .../<session-id>.jsonl; the filename is the id.
        const t = (raw as Rec | null)?.transcript_path;
        if (typeof t === 'string' && t.trim().endsWith('.jsonl')) {
          const base = t.trim().split(/[\\/]/).pop()!;
          return base.slice(0, -'.jsonl'.length);
        }
      } catch {
        /* absent or torn: try the next */
      }
    }
    return null;
  }
  if (kind === 'codex') {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(runDir, 'codex-session.json'), 'utf8'));
      const tid = (raw as Rec | null)?.thread_id;
      if (typeof tid === 'string' && tid) return tid;
    } catch {
      /* absent or torn */
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

/** Each Codex home's session index as last read, by its path: read again when its size or time changes. */
const threadNames = new Map<string, { size: number; mtimeMs: number; names: Map<string, string> }>();

/**
 * A Codex thread's name: the TUI writes `{"id", "thread_name", "updated_at"}`
 * lines to `<codex home>/session_index.jsonl`, and the last line for a thread
 * counts. Undefined when it has none.
 */
export async function codexThreadName(codexHome: string, threadId: string): Promise<string | undefined> {
  const file = path.join(codexHome, 'session_index.jsonl');
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return undefined;
  let kept = threadNames.get(file);
  if (!kept || kept.size !== st.size || kept.mtimeMs !== st.mtimeMs) {
    const names = new Map<string, string>();
    const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      try {
        const rec = JSON.parse(line) as Rec;
        if (typeof rec.id === 'string' && typeof rec.thread_name === 'string') names.set(rec.id, rec.thread_name.trim());
      } catch {
        /* a blank or torn line */
      }
    }
    kept = { size: st.size, mtimeMs: st.mtimeMs, names };
    threadNames.set(file, kept);
  }
  return kept.names.get(threadId) || undefined;
}

/** The Codex home a rollout is under (`<home>/sessions/YYYY/MM/DD/rollout-….jsonl`); undefined for a file elsewhere. */
export function codexHomeOfRollout(file: string): string | undefined {
  const dayDir = path.dirname(file);
  const sessions = path.dirname(path.dirname(path.dirname(dayDir)));
  return path.basename(sessions) === 'sessions' ? path.dirname(sessions) : undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** What Claude's meta file says about a subagent. */
export interface SubagentMeta {
  agentId: string;
  toolUseId: string;
  type: string;
  description: string;
  model?: string;
}

export interface MessagesDeps {
  getTask(id: string): Task | undefined;
  runDir(taskId: string, runId: string): string;
  /** Looper's copy of a file attached to a message, from the path the agent read it at (attachmentAt). */
  attachment(agentPath: string): Attachment | null;
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
  private readers = new Map<string, { reader: TranscriptReader; used: number }>();
  /** Settles once migrateCompacted has gone through every run: nothing reads a compacted.json before. */
  private compactedReady: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MessagesDeps) {}

  /** Rewrites each first-version compacted.json in `runDirs` as version 2; resolves with how many it rewrote. */
  migrateCompacted(runDirs: Promise<string[]>): Promise<number> {
    const done = (async () => {
      const dirs = await runDirs;
      let migrated = 0;
      for (let at = 0; at < dirs.length; at += MIGRATE_BATCH) {
        const batch = dirs.slice(at, at + MIGRATE_BATCH).map((dir) =>
          migrateCompactedFile(dir).catch((err: unknown) => {
            this.deps.log.error(`${dir}: cannot migrate compacted.json: ${errMsg(err)}`);
            return false;
          }),
        );
        for (const ok of await Promise.all(batch)) if (ok) migrated++;
      }
      return migrated;
    })();
    this.compactedReady = done.catch(() => undefined);
    return done;
  }

  /** `known`: the `version` an earlier read of this subagent's transcript returned; while it's current, no rows are sent. */
  async read(taskId: string, runId: string, agentId?: string, raw = false, known?: string): Promise<MessagesResult> {
    const none = (status: 'no-session' | 'no-transcript'): MessagesResult => ({ status, rows: [] });
    if (agentId !== undefined) {
      const reader = await this.subagentReader(taskId, runId, agentId, raw);
      if (typeof reader === 'string') return none(reader);
      try {
        await reader.read();
      } catch {
        return none('no-transcript'); // not written yet, or cleaned up by the harness
      }
      const version = reader.version;
      return known === version ? { status: 'ok', rows: [], version, unchanged: true } : { status: 'ok', rows: reader.acc.rows, version };
    }
    const pendingGuidance = readPendingGuidance(this.deps.runDir(taskId, runId)) ?? undefined;
    // A compacted chat's run starts with the messages of the conversation it was compacted from.
    if (!raw) await this.compactedReady;
    const rows: MessageRow[] = raw ? [] : proseRows(readCompactedRows(this.deps.runDir(taskId, runId)));
    let refs = 0;
    let readable = 0;
    let commands: SlashCommand[] = [];
    const ended: NonNullable<MessagesResult['ended']> = {};
    // The classifier first, then the agent sessions in the order they ran.
    const sources: ('classifier' | 'agent' | number)[] = [
      'classifier',
      ...endedSessions(this.deps.runDir(taskId, runId)),
      'agent',
    ];
    for (const source of sources) {
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
      for (const [id, status] of reader.acc.ended) ended[id] = status;
      // The classifier's session isn't the one guidance goes to; the newest agent session's list counts.
      if (source !== 'classifier' && reader.acc.commands.length) commands = reader.acc.commands;
    }
    if (refs === 0) return { ...none('no-session'), pendingGuidance };
    if (readable === 0) return { ...none('no-transcript'), pendingGuidance };
    return { status: 'ok', rows, pendingGuidance, ...(commands.length ? { commands } : {}), ...(Object.keys(ended).length ? { ended } : {}) };
  }

  /**
   * The newest rows of a run's conversation, from the end of its agent session's Claude transcript when that's at
   * least NEWEST_MIN long: what a chat shows while all of it is read. Over \\wsl.localhost a 170 MB one took 0.8 s
   * whole and 60 ms for its last 4 MB. Empty for a shorter one, or a Codex one.
   */
  async newest(taskId: string, runId: string): Promise<MessageRow[]> {
    const ref = readTranscriptRef(this.deps.runDir(taskId, runId));
    const hostPath = ref ? await this.toHostPath(ref, taskId) : undefined;
    if (!hostPath) return [];
    const reader = new TranscriptReader(hostPath, { attachment: this.deps.attachment });
    return (await reader.readTail(NEWEST_BYTES, NEWEST_MIN)) ? reader.acc.rows : [];
  }

  /** The run's whole conversation as a compacted one keeps it (compactRows); empty when it recorded none. */
  async compactable(taskId: string, runId: string): Promise<MessageRow[]> {
    const runDir = this.deps.runDir(taskId, runId);
    await this.compactedReady;
    const rows: MessageRow[] = [...readCompactedRows(runDir)];
    for (const source of [...endedSessions(runDir), 'agent' as const]) {
      const reader = await this.mainReader(taskId, runId, source, false);
      if (typeof reader === 'string') continue;
      try {
        await reader.read();
      } catch {
        continue;
      }
      rows.push(...reader.acc.rows);
    }
    return compactRows(rows);
  }

  /**
   * The harness's name for the run's conversation: Claude Code's from the
   * transcript (custom-title, else ai-title), Codex's thread name from its
   * session index. Undefined before it has one.
   */
  async sessionName(taskId: string, runId: string): Promise<string | undefined> {
    const runDir = this.deps.runDir(taskId, runId);
    const codex = readCodexRef(runDir);
    if (codex) {
      const home = await this.toHostPath(codex.codexHome, taskId);
      return home ? codexThreadName(home, codex.threadId) : undefined;
    }
    const reader = await this.mainReader(taskId, runId, 'agent', false);
    if (typeof reader === 'string') return undefined;
    try {
      await reader.read();
    } catch {
      return undefined;
    }
    return reader.acc.sessionName || undefined;
  }

  /**
   * The image payload behind a row's marker, or null when unavailable. `rowId`
   * is the row's id, or toolImageKey(tool_use id) for a tool call's image:
   * that key holds in any list of rows (a chat's own, whose row ids aren't
   * the transcript's), so every conversation of the run is searched for it.
   */
  async readImage(taskId: string, runId: string, rowId: string, agentId?: string): Promise<MessageImage | null> {
    const toolId = toolImageId(rowId);
    const sources: ('classifier' | 'agent' | number)[] = toolId
      ? ['agent', ...endedSessions(this.deps.runDir(taskId, runId)).reverse(), 'classifier']
      : [rowSource(rowId)];
    for (const source of agentId !== undefined ? ['sub' as const] : sources) {
      const reader =
        source === 'sub'
          ? await this.subagentReader(taskId, runId, agentId!, false)
          : await this.mainReader(taskId, runId, source, false);
      if (typeof reader === 'string') continue;
      try {
        await reader.read();
      } catch {
        /* rows already parsed may still hold the image */
      }
      const image = toolId ? await reader.toolImage(toolId) : await reader.image(rowId);
      if (image) return image;
    }
    return null;
  }

  /**
   * `count` of the tool calls a Code Mode script made, the ones before the `before`th (the newest without it),
   * by its REPL call's tool_use id, which holds in any list of rows of the run; null when no conversation has them.
   */
  async readScriptCalls(taskId: string, runId: string, toolUseId: string, before: number | null, count: number, agentId?: string): Promise<ScriptCalls | null> {
    const sources: ('sub' | 'classifier' | 'agent' | number)[] =
      agentId !== undefined ? ['sub'] : ['agent', ...endedSessions(this.deps.runDir(taskId, runId)).reverse(), 'classifier'];
    for (const source of sources) {
      const reader =
        source === 'sub'
          ? await this.subagentReader(taskId, runId, agentId!, false)
          : await this.mainReader(taskId, runId, source, false);
      if (typeof reader === 'string') continue;
      try {
        await reader.read();
      } catch {
        /* rows already parsed may still hold them */
      }
      const calls = reader.acc.scriptCalls.get(toolUseId);
      if (calls) return scriptCallsPage(calls, before, count);
    }
    return null;
  }

  /**
   * The same page from a transcript read by its host path: the conversation
   * from outside Looper that a chat went on with, which the chat's own
   * session hasn't written (its agent hasn't started yet, or never did).
   */
  async transcriptScriptCalls(hostPath: string, format: 'claude' | 'codex', toolUseId: string, before: number | null, count: number): Promise<ScriptCalls | null> {
    const reader = await this.cached(`transcript ${format} ${hostPath}`, async () =>
      (await exists(hostPath)) ? new TranscriptReader(hostPath, { attachment: this.deps.attachment }, format) : null,
    );
    if (typeof reader === 'string') return null;
    try {
      await reader.read();
    } catch {
      /* rows already parsed may still hold them */
    }
    const calls = reader.acc.scriptCalls.get(toolUseId);
    return calls ? scriptCallsPage(calls, before, count) : null;
  }

  /**
   * One main conversation's reader, from its transcript ref (claude hooks, or
   * the codex ref pair): the classifier's, the agent's current session, or an
   * agent session a context restart ended (by its number). The ref is part of
   * the cache key: after a restart the current session's ref names a new
   * transcript.
   */
  private async mainReader(
    taskId: string,
    runId: string,
    source: 'agent' | 'classifier' | number,
    raw: boolean,
  ): Promise<TranscriptReader | 'no-session' | 'no-transcript'> {
    const runDir = this.deps.runDir(taskId, runId);
    const prefix = source === 'classifier' ? 'classify-' : source === 'agent' ? '' : restartPrefix(source);
    const accOpts: AccumulatorOpts = {
      raw,
      source: source === 'classifier' ? 'classifier' : undefined,
      session: typeof source === 'number' ? source : undefined,
      attachment: this.deps.attachment,
    };
    const targetPath = readTranscriptRef(runDir, prefix);
    if (targetPath) {
      return this.cached(`${taskId} ${runId} ${source} ${raw} ${targetPath}`, async () => {
        const hostPath = await this.toHostPath(targetPath, taskId);
        if (!hostPath || !(await exists(hostPath))) return null; // not written yet; retried on the next poll
        // The running session's rows come from its mod first, when it's an interactive one.
        return new TranscriptReader(hostPath, accOpts, 'claude', undefined, source === 'agent' ? path.join(runDir, MOD_FILES.live) : undefined);
      });
    }
    const codexRef = readCodexRef(runDir, prefix);
    if (!codexRef) return 'no-session';
    return this.cached(`${taskId} ${runId} ${source} ${raw} ${codexRef.threadId}`, async () => {
      const hostHome = await this.toHostPath(codexRef.codexHome, taskId);
      if (!hostHome) return null;
      const rollout = await findCodexRollout(path.join(hostHome, 'sessions'), codexRef.threadId);
      if (!rollout) return null; // not written yet; retried on the next poll
      return new TranscriptReader(rollout, accOpts, 'codex');
    });
  }

  /**
   * A subagent's reader. The parent may be either step's session, so both
   * transcript dirs are candidates; the one whose file exists wins. A
   * workflow's agent keeps its transcript under its run's folder.
   */
  private async subagentReader(
    taskId: string,
    runId: string,
    agentId: string,
    raw: boolean,
  ): Promise<TranscriptReader | 'no-session' | 'no-transcript'> {
    if (!/^[\w.-]+$/.test(agentId)) return 'no-transcript';
    const runDir = this.deps.runDir(taskId, runId);
    const prefixes = ['', 'classify-', ...endedSessions(runDir).map(restartPrefix)];
    const refs = prefixes.map((p) => readTranscriptRef(runDir, p)).filter((r): r is string => r !== null);
    if (refs.length === 0) return 'no-session';
    return this.cached(`${taskId} ${runId} sub:${agentId} ${raw}`, async () => {
      const candidates: string[] = [];
      for (const ref of refs) {
        const hostPath = await this.toHostPath(ref, taskId);
        if (!hostPath) continue;
        const candidate = path.join(hostPath.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
        if (await exists(candidate)) candidates.push(candidate);
        else {
          const workflowAgent = await workflowAgentTranscript(hostPath, agentId);
          if (workflowAgent) candidates.push(workflowAgent);
        }
      }
      if (candidates.length === 0) return null; // not written yet; retried on the next poll
      return new TranscriptReader(candidates, { sidechain: true, raw });
    });
  }

  /**
   * Reader cache with LRU eviction; `make` runs only on a miss. `make` must
   * return null until the transcript exists: translating a path that does not
   * exist yet can yield a host path that never opens (wslpath resolves
   * symlinks such as a CLAUDE_CONFIG_DIR's `projects -> ~/.claude/projects`
   * only for existing files, and Windows cannot follow them over
   * \\wsl.localhost), and a cached reader keeps that path for good.
   */
  private async cached(
    key: string,
    make: () => Promise<TranscriptReader | null>,
  ): Promise<TranscriptReader | 'no-transcript'> {
    let reader = this.readers.get(key)?.reader;
    if (!reader) {
      const made = await make();
      if (!made) return 'no-transcript';
      reader = made;
    }
    // Refresh LRU order; evict the oldest beyond the cap that nothing has read for READER_KEEP_MS.
    const now = Date.now();
    this.readers.delete(key);
    this.readers.set(key, { reader, used: now });
    for (const [oldest, { used }] of this.readers) {
      if (this.readers.size <= MAX_READERS || now - used < READER_KEEP_MS) break;
      this.readers.delete(oldest);
    }
    return reader;
  }

  /** Subagent meta files read so far, by host path: they don't change once written. */
  private readonly metas = new Map<string, SubagentMeta>();

  /**
   * The subagents a run's agent session started, from the meta file Claude
   * writes next to each one's transcript (`subagents/agent-<id>.meta.json`).
   */
  async subagents(taskId: string, runId: string): Promise<SubagentMeta[]> {
    const ref = readTranscriptRef(this.deps.runDir(taskId, runId));
    const hostPath = ref ? await this.toHostPath(ref, taskId) : undefined;
    return hostPath ? this.subagentsAt(hostPath) : [];
  }

  /** The subagents of the Claude transcript at a host path (a conversation from outside Looper's runs). */
  async subagentsAt(hostPath: string): Promise<SubagentMeta[]> {
    const dir = path.join(hostPath.replace(/\.jsonl$/i, ''), 'subagents');
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    const out: SubagentMeta[] = [];
    for (const name of names) {
      const m = /^agent-([\w.-]+)\.meta\.json$/.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      let meta = this.metas.get(file);
      if (!meta) {
        try {
          const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Rec;
          if (typeof raw.toolUseId !== 'string') continue;
          meta = {
            agentId: m[1],
            toolUseId: raw.toolUseId,
            type: typeof raw.agentType === 'string' ? raw.agentType : 'agent',
            description: typeof raw.description === 'string' ? raw.description : '',
            ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
          };
          this.metas.set(file, meta);
        } catch {
          continue; // still being written
        }
      }
      out.push(meta);
    }
    return out;
  }

  /** Each session's workflow runs, by transcript host path; the least recently used past MAX_READERS are dropped. */
  private readonly workflowReaders = new Map<string, SessionWorkflows>();

  /** The workflow runs (Claude Code's Workflow tool) a run's agent session started, newest first. */
  async workflows(
    taskId: string,
    runId: string,
    opts: { launches?: WorkflowLaunch[]; detail?: boolean; sessionEnded?: boolean } = {},
  ): Promise<WorkflowRun[]> {
    const ref = readTranscriptRef(this.deps.runDir(taskId, runId));
    const hostPath = ref ? await this.toHostPath(ref, taskId) : undefined;
    if (!hostPath) return [];
    let reader = this.workflowReaders.get(hostPath);
    if (reader) this.workflowReaders.delete(hostPath);
    else reader = new SessionWorkflows(hostPath);
    this.workflowReaders.set(hostPath, reader);
    while (this.workflowReaders.size > MAX_READERS) {
      const oldest = this.workflowReaders.keys().next().value;
      if (oldest === undefined) break;
      this.workflowReaders.delete(oldest);
    }
    return reader.read(opts);
  }

  /** A subagent's model, effort and context, from its transcript's newest response; null before it has one. */
  async subagentStats(taskId: string, runId: string, agentId: string): Promise<SubagentStats | null> {
    if (!/^[\w.-]+$/.test(agentId)) return null;
    const ref = readTranscriptRef(this.deps.runDir(taskId, runId));
    const hostPath = ref ? await this.toHostPath(ref, taskId) : undefined;
    if (!hostPath) return null;
    const file = path.join(hostPath.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
    try {
      return await readSubagentStats(file);
    } catch {
      return null; // not written yet
    }
  }

  /** The end of a file the agent named in its own path form (a background command's output), or null when it can't be read. */
  async readTail(taskId: string, targetPath: string, maxBytes = 65_536): Promise<string | null> {
    const hostPath = await this.toHostPath(targetPath, taskId);
    if (!hostPath) return null;
    try {
      const fh = await fs.promises.open(hostPath, 'r');
      try {
        const { size } = await fh.stat();
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  /** A background command's output from byte `known` on, in the agent's own path form (readOutputFrom); null when it can't be read. */
  async readOutput(taskId: string, targetPath: string, known?: number): Promise<OutputRead | null> {
    const hostPath = await this.toHostPath(targetPath, taskId);
    if (!hostPath) return null;
    try {
      return await readOutputFrom(hostPath, known);
    } catch {
      return null;
    }
  }

  /** The end of a run's Claude transcript; null before it's written. */
  async transcriptTail(taskId: string, runId: string, maxBytes = 262_144): Promise<string | null> {
    const ref = readTranscriptRef(this.deps.runDir(taskId, runId));
    return ref ? this.readTail(taskId, ref, maxBytes) : null;
  }

  /** How many tokens the run's agent session holds, from its transcript; null when unknown. */
  async contextTokens(taskId: string, runId: string): Promise<number | null> {
    const found = await findStepTranscript(this.deps.runDir(taskId, runId), '', (p) => this.toHostPath(p, taskId));
    return found ? readContextTokens(found.file, found.kind) : null;
  }

  /** Codex: when the run's newest response came; null for Claude, or before its first. */
  async codexLastResponse(taskId: string, runId: string): Promise<number | null> {
    const found = await findStepTranscript(this.deps.runDir(taskId, runId), '', (p) => this.toHostPath(p, taskId));
    return found?.kind === 'codex' ? readCodexLastResponse(found.file) : null;
  }

  /** Claude: the model the run's newest response came from; null when it can't tell (codex, no response yet). */
  async contextModel(taskId: string, runId: string): Promise<string | null> {
    const found = await findStepTranscript(this.deps.runDir(taskId, runId), '', (p) => this.toHostPath(p, taskId));
    return found?.kind === 'claude' ? ((await readSubagentStats(found.file).catch(() => null))?.model ?? null) : null;
  }

  /** Translate the transcript path from the run target's form to the engine host's. */
  private async toHostPath(p: string, taskId: string): Promise<string | undefined> {
    const task = this.deps.getTask(taskId);
    const env = task ? this.deps.settings.environments.find((e) => e.id === task.environmentId) : undefined;
    const converted = await transcriptHostPath(p, this.deps.host, env?.kind === 'wsl' ? env.distro : undefined);
    if (!converted) this.deps.log.warn(`${taskId}: cannot map transcript path ${p} to a host path`);
    return converted;
  }
}

/** A transcript path in the run target's form, as the engine host can open it. */
export async function transcriptHostPath(p: string, host: HostKind, distro?: string): Promise<string | undefined> {
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (host === 'windows') return isWindowsPath ? p : convertWslPath(p, 'windows', distro, true);
  if (isWindowsPath) return convertWslPath(p, 'posix', undefined, true);
  return p;
}

/**
 * The host path of a step's own transcript and whose format it is, from the
 * run dir's references (claude's hook payloads, or codex's thread id and
 * home); null until the harness has written it.
 */
export async function findStepTranscript(
  runDir: string,
  prefix: string,
  toHost: (p: string) => Promise<string | undefined>,
): Promise<{ file: string; kind: 'claude' | 'codex' } | null> {
  const ref = readTranscriptRef(runDir, prefix);
  if (ref) {
    const file = await toHost(ref);
    return file && (await exists(file)) ? { file, kind: 'claude' } : null;
  }
  const codexRef = readCodexRef(runDir, prefix);
  if (!codexRef) return null;
  const home = await toHost(codexRef.codexHome);
  const file = home ? await findCodexRollout(path.join(home, 'sessions'), codexRef.threadId) : null;
  return file ? { file, kind: 'codex' } : null;
}
