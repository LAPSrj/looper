import fs from 'node:fs';
import path from 'node:path';
import {
  SENT_IMAGE_RE,
  guidanceText,
  toolImageId,
  type MessageImage,
  type MessageRow,
  type MessagesResult,
  type PatchHunk,
  type SentFiles,
} from '../shared/messages';
import { commandAttachment, parseCommands, parseOutputOnly, withOutput } from '../shared/bash-mode';
import { parseTaskNotification } from '../shared/sessions';
import { compactRow, compactRows, withoutCompacted } from '../shared/compact';
import { readCodexLastResponse, readContextTokens, readSubagentStats, type SubagentStats } from './context';
import { readPendingGuidance } from './guidance';
import type { Settings, Task } from '../shared/types';
import type { HostKind } from './host';
import { convertWslPath } from './host';
import type { Logger } from './log';
import type { WorkflowRun } from '../shared/workflows';
import { SessionWorkflows, workflowAgentTranscript, type WorkflowLaunch } from './workflows';

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
 * Folds transcript records into display rows. Only `user`/`assistant` records
 * count; sidechain and meta records, and the transcript's bookkeeping types
 * (attachment, queue-operation, ai-title…) are skipped, except where they carry
 * the user's guidance. Tool results attach to their tool_use row instead of
 * appearing as user messages.
 */
export class TranscriptAccumulator {
  rows: MessageRow[] = [];
  dropped = 0;
  /** The dropped rows a compacted conversation keeps (compactRow), oldest first: compaction gets the whole conversation. */
  evicted: MessageRow[] = [];
  /** Image payloads by row id; the rows only carry a marker. */
  readonly images = new Map<string, MessageImage>();
  private nextId = 0;
  private byToolId = new Map<string, MessageRow>();
  /** Rows that started background work, by Claude's background task id (a subagent's is its agent id). */
  private byBackgroundId = new Map<string, MessageRow>();
  /** The agent rows StructuredOutput calls became, by the call's tool_use id, until their results arrive. */
  private structuredAnswers = new Map<string, MessageRow>();
  /** The id of the record addLine is folding: its rows get it. */
  private recordUuid: string | undefined;
  /** Claude's own name for the session (its ai-title records), the latest. */
  aiTitle = '';
  /** The name the user gave it in Claude Code (/rename, or a host's rename_session), the latest; '' takes it away. */
  customTitle = '';

  constructor(protected readonly opts: AccumulatorOpts = {}) {}

  /** The session's name in Claude Code: the user's, else Claude's own; '' before it has one. */
  get sessionName(): string {
    return this.customTitle || this.aiTitle;
  }

  reset(): void {
    this.rows = [];
    this.dropped = 0;
    this.aiTitle = '';
    this.customTitle = '';
    this.evicted = [];
    this.nextId = 0;
    this.byToolId.clear();
    this.structuredAnswers.clear();
    this.byBackgroundId.clear();
    this.images.clear();
  }

  /**
   * A Bash call run in the background (its result names the task id and the
   * file its output goes to), an Agent call launched in the background, or a
   * Workflow call (its result's toolUseResult is `{status:'async_launched',
   * taskId, taskType:'local_workflow', runId, …}`, claude 2.1.314).
   */
  private takeBackground(row: MessageRow, tur: Rec | undefined, result: string | undefined): void {
    let id: string | undefined;
    if (typeof tur?.backgroundTaskId === 'string' && tur.backgroundTaskId) id = tur.backgroundTaskId;
    else if (tur?.isAsync === true && typeof tur.agentId === 'string' && tur.agentId) id = tur.agentId;
    else if (tur?.taskType === 'local_workflow' && typeof tur.taskId === 'string' && tur.taskId) id = tur.taskId;
    if (!id) return;
    const outputFile =
      (typeof tur?.outputFile === 'string' && tur.outputFile ? tur.outputFile : undefined) ??
      /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(result ?? '')?.[1];
    row.background = { id, status: 'running', ...(outputFile ? { outputFile } : {}) };
    this.byBackgroundId.set(id, row);
  }

  /**
   * A background command's or subagent's task notification: its row gets how it ended.
   * A subagent that stopped with background work of its own still running is reported
   * as completed ("… is waiting on its own background work", with a note that it may
   * resume and notify again, claude 2.1.316), but it's still running.
   */
  private takeNotification(text: string): void {
    const n = parseTaskNotification(text);
    const row = n ? this.byBackgroundId.get(n.id) : undefined;
    if (!n || !row?.background) return;
    if (n.status === 'completed' && WAITING_ON_OWN_WORK.test(text)) {
      row.background = { ...row.background, status: 'running' };
      delete row.background.summary;
      return;
    }
    row.background = { ...row.background, status: n.status, ...(n.summary ? { summary: n.summary } : {}) };
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
      if (att?.type === 'hook_additional_context' && Array.isArray(att.content)) {
        for (const c of att.content) if (typeof c === 'string') this.pushGuidance(c, ts);
      }
      // A background command or subagent ended: Claude queues its notification for the agent.
      if (att?.type === 'queued_command' && att.commandMode === 'task-notification' && typeof att.prompt === 'string') {
        this.takeNotification(att.prompt);
      }
      return;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    const msg = rec.message;
    if (msg === null || typeof msg !== 'object') return;
    const content = (msg as Rec).content;
    if (rec.isMeta === true) {
      if (rec.type !== 'user') return;
      if (this.takeSkill(rec, content)) return;
      const text = textOf(content);
      // A background job's end can come as a meta record too (a stream's isSynthetic).
      if (text.trimStart().startsWith('<task-notification>')) this.takeNotification(text);
      else if (text) this.pushGuidance(text, ts);
      return;
    }

    if (rec.type === 'user') {
      // In -p mode a background job's end comes as a user message of its own: no prompt of the user's.
      const only = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 ? (content[0] as Rec)?.text : undefined;
      if (typeof only === 'string' && only.trimStart().startsWith('<task-notification>')) {
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
        if (block?.type === 'tool_result') {
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
          if (block.is_error === true) row.resultError = true;
          this.takeImage(row, block.content);
          const patch = takePatch(rec.toolUseResult);
          if (patch) row.patch = patch;
          // The record-level toolUseResult carries the subagent id of a Task call.
          const tur = rec.toolUseResult as Rec | undefined;
          const agentId = tur?.agentId;
          if (typeof agentId === 'string' && agentId) row.agentId = agentId;
          this.takeBackground(row, tur, row.result);
          // SendUserFile: the result confirms delivery, so the call becomes the agent's message with its files.
          if (row.tool === 'SendUserFile' && block.is_error !== true) {
            const sent = sentFilesOf(row.input, tur);
            if (sent) {
              row.sent = sent;
              row.preview = sent.caption ? previewOf(sent.caption) : sent.files.map((f) => f.name).join(', ').slice(0, MAX_PREVIEW);
            }
          }
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!this.pushGuidance(block.text, ts)) this.pushPrompt(block.text, ts);
        } else if (block?.type === 'image') {
          const row = this.push({ kind: 'prompt', ts, text: '(image)' });
          this.takeImage(row, [block]);
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
    for (const block of content as Rec[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.push({ kind: 'agent', ts, text: block.text });
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        this.push({ kind: 'thinking', ts, text: block.thinking });
      } else if (block?.type === 'tool_use' && block.name === 'StructuredOutput' && structuredOutputText(block.input)) {
        // A workflow agent's answer: the script reads this call, and the conversation shows it as the agent's reply.
        const row = this.push({ kind: 'agent', ts, text: structuredOutputText(block.input) });
        if (typeof block.id === 'string' && block.id) this.structuredAnswers.set(block.id, row);
      } else if (block?.type === 'tool_use') {
        const row = this.push({
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
      !text.trimStart().startsWith('<task-notification>')
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
    // The commands the user ran from the message box (or Claude Code's bash mode) show as the message's attachments.
    const { commands, text } = parseCommands(full, `cmd${this.nextId}`);
    const task = commands.length ? null : workflowTaskText(text);
    if (task !== null) this.push({ kind: 'task', ts, text: task });
    else {
      const row = this.push({ kind: 'prompt', ts, text, preview: text || !commands.length ? undefined : previewOf(commands.map((c) => `! ${c.input}`).join(', ')) });
      if (commands.length) row.attachments = commands.map(commandAttachment);
    }
  }

  /** The image a tool call's result carried, by the call's tool_use id. */
  toolImage(toolUseId: string): MessageImage | null {
    const row = this.byToolId.get(toolUseId);
    return (row && this.images.get(row.id)) ?? null;
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

  /** A Guidance row when `text` is a guidance message (see GUIDANCE_PREFIX); false when it is not one. */
  protected pushGuidance(text: string, ts?: string): boolean {
    const g = guidanceText(text);
    if (g === null) return false;
    this.push({ kind: 'guidance', ts, text: g });
    return true;
  }

  protected push(r: { kind: MessageRow['kind']; ts?: string; text: string; tool?: string; preview?: string }): MessageRow {
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
    this.rows.push(row);
    if (this.rows.length > MAX_ROWS) {
      const old = compactRow(this.rows.shift()!);
      if (old) this.evicted.push(old);
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
        if (p.role === 'developer') continue;
        if (block.type === 'input_text' && p.role === 'user') {
          // Injected context is one <tag>…</tag> block, after a heading line for the AGENTS.md
          // instructions ("# AGENTS.md instructions", seen live in codex-cli 0.163.0).
          if (/^(?:#[^\n]*\n+)?<([\w-]+)>[\s\S]*<\/\1>\s*$/.test(text.trim())) continue;
          this.pushPrompt(text, ts);
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

  /** Reads one at a time: two overlapping ones would both start at the same offset and add the new lines twice. */
  private queue: Promise<void> = Promise.resolve();

  read(): Promise<void> {
    const next = this.queue.then(() => this.readNew());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readNew(): Promise<void> {
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

/** A compacted chat's run folder keeps the conversation it was compacted from, as rows, once its first message makes it a run. */
export const COMPACTED_FILE = 'compacted.json';

function readCompactedRows(runDir: string): MessageRow[] {
  try {
    const rows: unknown = JSON.parse(fs.readFileSync(path.join(runDir, COMPACTED_FILE), 'utf8'));
    return Array.isArray(rows) ? (rows as MessageRow[]) : [];
  } catch {
    return []; // not a compacted chat
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
    const pendingGuidance = readPendingGuidance(this.deps.runDir(taskId, runId)) ?? undefined;
    // A compacted chat's run starts with the conversation it was compacted from.
    const rows: MessageRow[] = raw ? [] : readCompactedRows(this.deps.runDir(taskId, runId));
    let dropped = 0;
    let refs = 0;
    let readable = 0;
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
      dropped += reader.acc.dropped;
    }
    if (refs === 0) return { ...none('no-session'), pendingGuidance };
    if (readable === 0) return { ...none('no-transcript'), pendingGuidance };
    return { status: 'ok', rows, dropped, pendingGuidance };
  }

  /**
   * The run's whole conversation as a compacted one keeps it (compactRows),
   * the rows its readers dropped included; empty when it recorded none.
   */
  async compactable(taskId: string, runId: string): Promise<MessageRow[]> {
    const runDir = this.deps.runDir(taskId, runId);
    const rows: MessageRow[] = readCompactedRows(runDir);
    for (const source of [...endedSessions(runDir), 'agent' as const]) {
      const reader = await this.mainReader(taskId, runId, source, false);
      if (typeof reader === 'string') continue;
      try {
        await reader.read();
      } catch {
        continue;
      }
      rows.push(...reader.acc.evicted, ...reader.acc.rows);
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
      const image = toolId ? reader.acc.toolImage(toolId) : (reader.acc.images.get(rowId) ?? null);
      if (image) return image;
    }
    return null;
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
    };
    const targetPath = readTranscriptRef(runDir, prefix);
    if (targetPath) {
      return this.cached(`${taskId} ${runId} ${source} ${raw} ${targetPath}`, async () => {
        const hostPath = await this.toHostPath(targetPath, taskId);
        if (!hostPath || !(await exists(hostPath))) return null; // not written yet; retried on the next poll
        return new TranscriptReader(hostPath, accOpts);
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
