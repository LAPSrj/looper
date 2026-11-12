import type { MessageRow, PatchHunk } from '../../../shared/messages';

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const inputOf = (row: MessageRow): Rec =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Rec) : {};

/** A file's line on the Now tab's editor. */
export type EditorLine = { n: string; text: string };

/** Characters of a line, as [start, end) ranges. */
export type TextRange = [number, number];

/** One row of a diff: an `@@` header, or a line with its number in the old and the new file (blank where it has none). */
export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; oldN: string; newN: string; text: string; words?: TextRange[] };

const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Longer lines than this (in tokens, once their common ends are off) aren't compared word by word. */
const MAX_TOKENS = 400;
/** Lines sharing less than this share of their text are different lines, with nothing worth marking. */
const MIN_COMMON = 0.4;

/** The parts of two lines that differ, by whole words; null when the lines have too little in common. */
export function wordChanges(a: string, b: string): { a: TextRange[]; b: TextRange[] } | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  let start = 0;
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++;
  let end = 0;
  while (end < ta.length - start && end < tb.length - start && ta[ta.length - 1 - end] === tb[tb.length - 1 - end]) end++;
  const n = ta.length - start - end;
  const m = tb.length - start - end;
  if (n > MAX_TOKENS || m > MAX_TOKENS) return null;
  // The longest common run of tokens between the two middles.
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ta[start + i] === tb[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const keepA = new Set<number>();
  const keepB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[start + i] === tb[start + j]) {
      keepA.add(start + i++);
      keepB.add(start + j++);
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  const ranges = (tokens: string[], keep: Set<number>, from: number, count: number) => {
    const out: TextRange[] = [];
    let at = tokens.slice(0, from).join('').length;
    for (let k = from; k < from + count; k++) {
      const next = at + tokens[k].length;
      if (!keep.has(k)) {
        const last = out[out.length - 1];
        if (last && last[1] === at) last[1] = next;
        else out.push([at, next]);
      }
      at = next;
    }
    return out;
  };
  const changedA = ranges(ta, keepA, start, n);
  const changedB = ranges(tb, keepB, start, m);
  const changed = (r: TextRange[]) => r.reduce((sum, [x, y]) => sum + y - x, 0);
  const longest = Math.max(a.length, b.length);
  if (longest === 0 || longest - Math.max(changed(changedA), changed(changedB)) < longest * MIN_COMMON) return null;
  return { a: changedA, b: changedB };
}

/** A line diff of two whole texts (`lineDiff`'s) as numbered rows with the changed words marked. */
export function lineDiffRows(lines: { op: ' ' | '-' | '+'; text: string }[]): DiffRow[] {
  let oldN = 0;
  let newN = 0;
  return withWords(
    lines.map(({ op, text }) =>
      op === '+'
        ? { kind: 'add' as const, oldN: '', newN: String(++newN), text }
        : op === '-'
          ? { kind: 'del' as const, oldN: String(++oldN), newN: '', text }
          : { kind: 'ctx' as const, oldN: String(++oldN), newN: String(++newN), text },
    ),
  );
}

/** Marks the changed words: each run of removed lines is compared, line by line, with the added lines after it. */
function withWords(rows: DiffRow[]): DiffRow[] {
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'del') continue;
    let d = i;
    while (d < out.length && out[d].kind === 'del') d++;
    let a = d;
    while (a < out.length && out[a].kind === 'add') a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const del = out[i + k];
      const add = out[d + k];
      if (del.kind !== 'del' || add.kind !== 'add') continue;
      const words = wordChanges(del.text, add.text);
      if (!words) continue;
      del.words = words.a;
      add.words = words.b;
    }
    i = a - 1;
  }
  return out;
}

/** A recorded patch as a diff, each hunk under its `@@` header. */
export function hunkRows(hunks: PatchHunk[]): DiffRow[] {
  const out: DiffRow[] = [];
  for (const h of hunks) {
    out.push({ kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let oldN = h.oldStart;
    let newN = h.newStart;
    for (const line of h.lines) {
      const text = line.slice(1);
      if (line.startsWith('+')) out.push({ kind: 'add', oldN: '', newN: String(newN++), text });
      else if (line.startsWith('-')) out.push({ kind: 'del', oldN: String(oldN++), newN: '', text });
      // "\ No newline at end of file" isn't a line of the file.
      else if (!line.startsWith('\\')) out.push({ kind: 'ctx', oldN: String(oldN++), newN: String(newN++), text });
    }
  }
  return withWords(out);
}

const textLines = (text: string): string[] => text.replace(/\n$/, '').split('\n');

/** Before the harness records the patch: the replaced text, then its replacement (their line numbers aren't known yet). */
export function replacedRows(oldText: string, newText: string): DiffRow[] {
  return withWords([
    ...(oldText ? textLines(oldText).map((text) => ({ kind: 'del' as const, oldN: '', newN: '', text })) : []),
    ...(newText ? textLines(newText).map((text) => ({ kind: 'add' as const, oldN: '', newN: '', text })) : []),
  ]);
}

/**
 * A file change as a diff: the patch when the harness recorded one, else what
 * the call's input says. Null when neither does, and for a Write, whose file
 * shows whole until it has a patch (writtenLines).
 */
export function changeRows(row: MessageRow): DiffRow[] | null {
  if (row.patch) return hunkRows(row.patch);
  const input = inputOf(row);
  let rows: DiffRow[] = [];
  if (row.tool === 'Edit') {
    rows = replacedRows(str(input.old_string) ?? '', str(input.new_string) ?? '');
  } else if (row.tool === 'MultiEdit' && Array.isArray(input.edits)) {
    rows = (input.edits as Rec[]).flatMap((e, i) => [
      ...(i > 0 ? [{ kind: 'hunk' as const, text: '⋯' }] : []),
      ...replacedRows(str(e?.old_string) ?? '', str(e?.new_string) ?? ''),
    ]);
  } else if (row.tool === 'NotebookEdit') {
    rows = replacedRows('', str(input.new_source) ?? '');
  }
  return rows.length > 0 ? rows : null;
}

/** A Write's whole file, numbered from 1; null when the call's input has none. */
export function writtenLines(row: MessageRow): EditorLine[] | null {
  const content = row.tool === 'Write' ? str(inputOf(row).content) : undefined;
  return content === undefined ? null : textLines(content).map((text, i) => ({ n: String(i + 1), text }));
}

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Highlighted HTML (or escaped text) with these character ranges of its text
 * marked. A mark closes around each tag inside it, so tags stay balanced.
 */
export function markRanges(html: string, ranges: TextRange[]): string {
  const OPEN = '<mark class="diff-word">';
  let out = '';
  let at = 0;
  let inMark = false;
  const re = /<[^>]*>|&[^;]+;|[\s\S]/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].length > 1 && m[0][0] === '<') {
      out += inMark ? `</mark>${m[0]}${OPEN}` : m[0];
      continue;
    }
    const marked = ranges.some(([x, y]) => at >= x && at < y);
    if (marked !== inMark) {
      out += marked ? OPEN : '</mark>';
      inMark = marked;
    }
    out += m[0];
    at++;
  }
  return inMark ? `${out}</mark>` : out;
}
