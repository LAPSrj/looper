import fs from 'node:fs';

/**
 * How full an agent's conversation is, read from the end of its transcript.
 *
 * Claude Code writes the usage of every API response on its assistant
 * records: the context the response was given is input + cache read + cache
 * creation. A compaction writes a `compact_boundary` system record whose
 * compactMetadata.postTokens is the size after it.
 *
 * Codex writes an `event_msg` of type `token_count` after every response;
 * info.last_token_usage.input_tokens is the context that response was given,
 * cached tokens included. Right after a compaction it writes a `compacted`
 * record and a token_count of 0, so the size is unknown until the next
 * response (read from rollouts of codex-cli in 2026-09 and 2026-10).
 *
 * Only the newest response or compaction counts, so the file is read from the
 * end, a chunk at a time, until one turns up.
 */

export type TranscriptKind = 'claude' | 'codex';

/** The first chunk read from the end; it grows 4x until it holds an answer or is the whole file. */
const FIRST_CHUNK = 256 * 1024;

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * What one transcript line says about the context: a token count, `unknown`
 * (a compaction with no size yet), or null when the line doesn't say.
 */
export function contextOfLine(line: string, kind: TranscriptKind): number | 'unknown' | null {
  // Most lines say nothing about the context; skip them without parsing.
  if (kind === 'claude' ? !line.includes('"usage"') && !line.includes('compact_boundary') : !line.includes('token_count') && !line.includes('"compacted"')) {
    return null;
  }
  let rec: Rec | null;
  try {
    rec = obj(JSON.parse(line));
  } catch {
    return null; // torn or cut
  }
  if (!rec) return null;
  if (kind === 'claude') {
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      const post = obj(rec.compactMetadata)?.postTokens;
      return typeof post === 'number' && post > 0 ? post : 'unknown';
    }
    // A subagent's records belong to its own conversation.
    if (rec.type !== 'assistant' || rec.isSidechain === true) return null;
    const msg = obj(rec.message);
    const usage = obj(msg?.usage);
    if (!usage || msg?.model === '<synthetic>') return null;
    return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  }
  if (rec.type === 'compacted') return 'unknown';
  const payload = obj(rec.payload);
  if (rec.type !== 'event_msg' || payload?.type !== 'token_count') return null;
  const tokens = num(obj(obj(payload.info)?.last_token_usage)?.input_tokens);
  return tokens > 0 ? tokens : 'unknown';
}

/** The newest line `pick` has an answer for (non-null), reading the file from the end. */
async function newestFromEnd<T>(file: string, pick: (line: string) => T | null): Promise<T | null> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    for (let chunk = FIRST_CHUNK; ; chunk *= 4) {
      const len = Math.min(size, chunk);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // The first line of a partial chunk may be cut.
      for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
        const found = pick(lines[i]);
        if (found !== null) return found;
      }
      if (len >= size) return null;
    }
  } finally {
    await fh.close();
  }
}

/** The conversation's context now, in tokens; null when the transcript doesn't tell (yet). */
export async function readContextTokens(file: string, kind: TranscriptKind): Promise<number | null> {
  const found = await newestFromEnd(file, (line) => contextOfLine(line, kind));
  return found === 'unknown' ? null : found;
}

/** Codex's context window, which each token_count names as info.model_context_window. */
export function codexWindowOfLine(line: string): number | null {
  if (!line.includes('model_context_window')) return null;
  try {
    const info = obj(obj(obj(JSON.parse(line))?.payload)?.info);
    const w = info?.model_context_window;
    return typeof w === 'number' && w > 0 ? w : null;
  } catch {
    return null;
  }
}

/** The model's context window as the newest token_count of a codex rollout names it. */
export function readCodexContextWindow(file: string): Promise<number | null> {
  return newestFromEnd(file, codexWindowOfLine);
}
