import { fileAttachments, withCommands } from './bash-mode';
import type { MessageRow } from './messages';

/** The tools that start a subagent: their result is the subagent's final report. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** A background subagent's launch answers with this; its report comes later, as the row's background summary. */
const ASYNC_LAUNCH = 'Async agent launched';

const OPEN = '<compacted-conversation>';
const CLOSE = '</compacted-conversation>';

/** A larger result is listed but never included, so it isn't stored either. */
export const RESULT_MAX_CHARS = 20_000;
/** A call's input as the newest session's rows store it. */
const INPUT_MAX_CHARS = 2_000;
/** A call's input as earlier sessions' rows store it, and as the call list shows it. */
const LIST_INPUT_CHARS = 300;
/** Estimated tokens per character of the compacted text (measured on real compactions). */
const TOKENS_PER_CHAR = 0.45;
/** Room kept for results when the messages and the call list are trimmed to fit. */
const MIN_RESULT_TOKENS = 8_000;
/** The newest turns, whose agent messages are never trimmed. */
const KEEP_TURNS = 3;
/** Files listed per earlier session. */
const MAX_LAYER_FILES = 40;

export interface CompactionBudget {
  /** Tokens for tool results, on top of the messages and the call list. */
  resultTokens: number;
  /** The whole compacted text; past it, older agent messages and then call inputs are shortened. */
  maxTotalTokens: number;
}

export const DEFAULT_COMPACTION: CompactionBudget = { resultTokens: 35_000, maxTotalTokens: 90_000 };

/** The result budgets Settings → Chats offers (chats.compaction.resultTokens). */
export const COMPACTION_RESULT_TOKENS = [20_000, 35_000, 50_000] as const;
export type CompactionResultTokens = (typeof COMPACTION_RESULT_TOKENS)[number];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** A call's input as the call list shows it, at most. */
const listInput = (s: string, chars = LIST_INPUT_CHARS) => s.replace(/\s+/g, ' ').trim().slice(0, chars).trimEnd();

/**
 * One row as a compacted conversation keeps it, or null when it leaves it
 * out: the user's messages, the agent's (not Looper's notes or the
 * classifier's), files the agent sent, each subagent's final report, and
 * every other tool call with its input and (up to RESULT_MAX_CHARS) result.
 * Thinking, errors, raw records and replies a later one superseded go.
 */
export function compactRow(r: MessageRow): MessageRow | null {
  if (r.source === 'classifier' || r.note || r.superseded) return null;
  const base = { id: r.id, ...(r.ts ? { ts: r.ts } : {}), ...(r.layer !== undefined ? { layer: r.layer } : {}) };
  if (r.kind === 'prompt' || r.kind === 'guidance') {
    return { ...base, kind: r.kind, preview: r.preview, text: r.text, ...(r.attachments?.length ? { attachments: r.attachments } : {}) };
  }
  if (r.kind === 'agent' || r.kind === 'events' || r.kind === 'delegate') return { ...base, kind: r.kind, preview: r.preview, text: r.text };
  if (r.kind !== 'tool') return null;
  if (r.sent) return { ...base, kind: 'tool', tool: r.tool, preview: r.preview, text: r.sent.caption ?? '', sent: r.sent };
  if (AGENT_TOOLS.has(r.tool ?? '') && r.resultChars === undefined) {
    const result = r.result?.trim() ?? '';
    const report = result.startsWith(ASYNC_LAUNCH) ? (r.background?.summary?.trim() ?? '') : result;
    if (report) return { ...base, kind: 'tool', tool: r.tool, preview: r.preview, text: r.preview, result: report, ...(r.resultError ? { resultError: true } : {}) };
  }
  const resultChars = r.resultChars ?? r.result?.length ?? 0;
  return {
    ...base,
    kind: 'tool',
    tool: r.tool,
    preview: r.preview,
    text: clip(r.text, INPUT_MAX_CHARS),
    ...(r.file ? { file: r.file } : {}),
    ...(r.result && r.result.length <= RESULT_MAX_CHARS ? { result: r.result } : {}),
    resultChars,
    ...(r.resultError ? { resultError: true } : {}),
  };
}

/** A tool call of a compacted conversation (compactRow's form), not a message, report or sent files. */
export function isCall(r: MessageRow): boolean {
  return r.kind === 'tool' && r.resultChars !== undefined;
}

/** A call as earlier sessions keep it: a short input and the result's length, without the result. */
export function slimCall(r: MessageRow): MessageRow {
  if (!isCall(r)) return r;
  const slim = { ...r, text: listInput(r.text) };
  delete slim.result;
  return slim;
}

/** A conversation's rows as compaction keeps them, numbered c0, c1… so they don't share ids with the rows that follow. */
export function compactRows(rows: MessageRow[]): MessageRow[] {
  const out: MessageRow[] = [];
  for (const r of rows) {
    const c = compactRow(r);
    if (c) out.push({ ...c, id: `c${out.length}` });
  }
  return out;
}

/**
 * Compacted rows as a compacted chat keeps them (compacted.json): rows
 * without a layer are the newest session's and get the next one, and every
 * earlier session's calls are slimmed.
 */
export function layered(rows: MessageRow[]): MessageRow[] {
  if (!rows.some((r) => r.layer === undefined)) return rows;
  const next = Math.max(-1, ...rows.map((r) => r.layer ?? -1)) + 1;
  return rows.map((r) => (r.layer === undefined ? { ...r, layer: next } : slimCall(r)));
}

/** A row's session in compactedText: one without a layer is the newest's. */
const layerOf = (r: MessageRow) => r.layer ?? Infinity;

/** The messages, reports and sent files of compacted rows: what a chat shows of the conversation it was compacted from. */
export function proseRows(rows: MessageRow[]): MessageRow[] {
  return rows.filter((r) => !isCall(r));
}

/** The labels compactedText starts its blocks with. */
const LABEL_RE = /^(\s*)(\[(?:User|Agent|Subagent report|Trigger events|From the agents|Tool call #|Result\]|Earlier session|Compaction))/gm;

/** Text inside a block, with each line that would read as one of the block labels escaped, so a message can't pass for another speaker. */
function escapeLabels(text: string): string {
  return text.replace(LABEL_RE, '$1\\$2');
}

const tok = (s: string) => Math.ceil(s.length * TOKENS_PER_CHAR);
const COUNT = new Intl.NumberFormat('en-US');

type Block =
  | { kind: 'prose'; row: MessageRow; label: string; body: string; turn: number }
  | { kind: 'call'; row: MessageRow; n: number }
  | { kind: 'layer'; layer: number; calls: number; files: string[] };

/** First paragraph, at most 300 chars, marked when anything was cut. */
function shorten(s: string): string {
  const t = s.trim();
  const first = t.split(/\n\s*\n/)[0].slice(0, 300);
  return first.length < t.length ? `${first} […shortened by compaction]` : t;
}

export interface CompactedTextOptions extends Partial<CompactionBudget> {
  /** Turns a file's host path into the agent's. */
  path?: (hostPath: string) => string;
}

/**
 * The compacted conversation as the agent receives it, ahead of the user's
 * first message in the new conversation: the messages in order, every tool
 * call of the newest session listed where it ran, and the results that fit
 * the budget, newest and smallest first. Earlier sessions' calls are one line
 * per session. When the messages and list don't fit, older agent progress
 * updates go first, then older reports are shortened, then call inputs.
 */
export function compactedText(rows: MessageRow[], opts: CompactedTextOptions = {}): string {
  const path = opts.path ?? ((p: string) => p);
  const resultTokens = opts.resultTokens ?? DEFAULT_COMPACTION.resultTokens;
  const maxTotal = opts.maxTotalTokens ?? DEFAULT_COMPACTION.maxTotalTokens;
  const newest = Math.max(-1, ...rows.map(layerOf));

  // The newest session's calls: identical ones (same tool and input, as far as the list shows it) are listed once, where the last ran.
  const calls = rows.filter((r) => isCall(r) && layerOf(r) === newest);
  const key = (r: MessageRow) => `${r.tool}\0${listInput(r.text)}`;
  const times = new Map<string, number>();
  const lastAt = new Map<string, MessageRow>();
  for (const c of calls) {
    times.set(key(c), (times.get(key(c)) ?? 0) + 1);
    lastAt.set(key(c), c);
  }

  const blocks: Block[] = [];
  let turn = 0;
  let n = 0;
  let older: Extract<Block, { kind: 'layer' }> | null = null;
  for (const r of rows) {
    const layer = layerOf(r);
    if (older && older.layer !== layer) older = null;
    if (isCall(r)) {
      if (layer === newest) {
        n++;
        if (lastAt.get(key(r)) === r) blocks.push({ kind: 'call', row: r, n });
        continue;
      }
      if (!older) {
        older = { kind: 'layer', layer, calls: 0, files: [] };
        blocks.push(older);
      }
      older.calls++;
      if (r.file && !older.files.includes(r.file)) older.files.push(r.file);
      continue;
    }
    if (r.kind === 'prompt' || r.kind === 'guidance') turn++;
    blocks.push({ kind: 'prose', row: r, turn, ...proseBlock(r, path) });
  }

  let inputChars = LIST_INPUT_CHARS;
  const callLine = (r: MessageRow, num: number) => {
    // The file says what a call on one did (a Codex edit's text is its diff), at a fraction of an edit's input.
    const input = listInput(r.file ?? r.text, inputChars);
    const k = times.get(key(r)) ?? 1;
    return `[Tool call #${num}${r.resultError ? ', failed' : ''}] ${r.tool ?? 'tool'}(${input})${k > 1 ? ` ×${k}` : ''}`;
  };
  const layerLine = (b: Extract<Block, { kind: 'layer' }>) => {
    const files = b.files.slice(-MAX_LAYER_FILES);
    const more = b.files.length - files.length;
    const list = files.length ? `; files it worked on: ${files.join(', ')}${more ? ` and ${more} more` : ''}` : '';
    return `[Earlier session ${b.layer + 1}: ${b.calls} tool call${b.calls === 1 ? '' : 's'}, not listed${list}]`;
  };
  const proseText = new Map<Block, string>();
  for (const b of blocks) if (b.kind === 'prose') proseText.set(b, `${b.label}\n${b.body}`);
  const fixedTokens = () => {
    let t = 0;
    for (const b of blocks) {
      if (b.kind === 'prose') t += tok(proseText.get(b)!);
      // The line, its " → result left out (N chars)" and the blank line after it.
      else if (b.kind === 'call') t += tok(callLine(b.row, b.n)) + 16;
      else t += tok(layerLine(b));
    }
    return t;
  };

  // Trimming, only when the messages and the list leave too little room for results.
  const limit = maxTotal - MIN_RESULT_TOKENS;
  let fixed = fixedTokens();
  let removed = 0;
  let shortened = 0;
  if (fixed > limit) {
    const prose = blocks.filter((b): b is Extract<Block, { kind: 'prose' }> => b.kind === 'prose');
    const kept = new Set(Array.from({ length: KEEP_TURNS }, (_, i) => turn - i));
    const lastInTurn = new Map<number, Block>();
    for (const b of prose) if (b.row.kind === 'agent') lastInTurn.set(b.turn, b);
    const agents = prose.filter((b) => b.row.kind === 'agent' && !kept.has(b.turn));
    const removedIn = new Map<number, number>();
    for (const b of agents) {
      if (fixed <= limit) break;
      if (lastInTurn.get(b.turn) === b) continue;
      fixed -= tok(proseText.get(b)!);
      proseText.set(b, '');
      removed++;
      removedIn.set(b.turn, (removedIn.get(b.turn) ?? 0) + 1);
    }
    for (const [t, k] of removedIn) {
      const report = lastInTurn.get(t);
      if (report && report.kind === 'prose') {
        report.label = `[Agent] (${k} progress update${k > 1 ? 's' : ''} before this removed by compaction)`;
        proseText.set(report, `${report.label}\n${report.body}`);
      }
    }
    fixed = fixedTokens();
    for (const b of agents) {
      if (fixed <= limit) break;
      if (lastInTurn.get(b.turn) !== b || b.kind !== 'prose') continue;
      const cur = proseText.get(b)!;
      const next = `${b.label}\n${escapeLabels(shorten(b.row.text))}`;
      if (next.length >= cur.length) continue;
      fixed += tok(next) - tok(cur);
      proseText.set(b, next);
      shortened++;
    }
    for (const chars of [120, 60]) {
      if (fixed <= limit) break;
      inputChars = chars;
      fixed = fixedTokens();
    }
  }

  // Results: newest and smallest first, while they fit.
  let room = Math.min(resultTokens, maxTotal - fixed);
  const listed = blocks.filter((b): b is Extract<Block, { kind: 'call' }> => b.kind === 'call');
  const score = (b: Extract<Block, { kind: 'call' }>) => Math.pow(0.98, n - b.n) / Math.sqrt(Math.max(b.row.result!.length, 200));
  const withResult = new Set<Block>();
  for (const b of listed.filter((x) => x.row.result).sort((a, z) => score(z) - score(a))) {
    const t = tok(b.row.result!) + 4;
    if (t > room) continue;
    withResult.add(b);
    room -= t;
  }

  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'prose') {
      const t = proseText.get(b)!;
      if (t) parts.push(t);
    } else if (b.kind === 'layer') parts.push(layerLine(b));
    else {
      const head = callLine(b.row, b.n);
      const chars = b.row.resultChars ?? 0;
      parts.push(
        withResult.has(b)
          ? `${head}\n[Result]\n${escapeLabels(b.row.result!)}`
          : `${head} → ${chars ? `result left out (${COUNT.format(chars)} chars)` : 'no output'}`,
      );
    }
  }
  const trimmed =
    removed || shortened
      ? ` To fit, ${[removed ? `${removed} older progress update${removed > 1 ? 's were' : ' was'} removed` : '', shortened ? `${shortened} older report${shortened > 1 ? 's were' : ' was'} shortened` : ''].filter(Boolean).join(' and ')}, each marked where it happened.`
      : '';
  const intro =
    'The conversation so far, continued in a new session. Every user message is kept, and so is every agent message unless marked. ' +
    'Each tool call is listed where it ran, once (×N when it ran N times with the same input), and only some keep their results: run a call again when you need a result that was left out. ' +
    'Calls from earlier sessions are counted, not listed. A line starting with \\[ inside a message or result is text, not a new block.' +
    trimmed;
  // A message quoting the closing tag would end the block early for withoutCompacted.
  const body = parts.join('\n\n').split(CLOSE).join('</compacted conversation>');
  return `${OPEN}\n${intro}\n\n${body}\n${CLOSE}`;
}

function proseBlock(r: MessageRow, path: (p: string) => string): { label: string; body: string } {
  if (r.sent) {
    const files = r.sent.files.map((f) => `- ${f.path}`);
    return { label: '[Agent sent files]', body: escapeLabels([...(r.sent.caption ? [r.sent.caption] : []), ...files].join('\n')) };
  }
  if (r.kind === 'tool') return { label: `[Subagent report: ${r.text.replace(/\s+/g, ' ').trim()}]`, body: escapeLabels(r.result ?? '') };
  if (r.kind === 'agent') return { label: '[Agent]', body: escapeLabels(r.text) };
  if (r.kind === 'events') return { label: '[Trigger events, while the agent worked]', body: escapeLabels(r.text) };
  if (r.kind === 'delegate') return { label: '[From the agents it started]', body: escapeLabels(r.text) };
  const attached = fileAttachments(r.attachments ?? []);
  const files = attached.length ? `\n\nAttached files:\n${attached.map((a) => `- ${path(a.path)}`).join('\n')}` : '';
  // The commands the user ran go ahead of the text, as they went to the agent.
  return {
    label: r.kind === 'guidance' ? '[User, while the agent worked]' : '[User]',
    body: escapeLabels(withCommands(r.text, r.attachments ?? [])) + files,
  };
}

/** A user message without the compacted conversation it starts with (the first message of a compacted chat). */
export function withoutCompacted(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith(OPEN)) return text;
  const end = t.indexOf(CLOSE);
  return end === -1 ? '' : t.slice(end + CLOSE.length).trim();
}
