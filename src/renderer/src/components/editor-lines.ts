import type { MessageRow, PatchHunk } from '../../../shared/messages';

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const inputOf = (row: MessageRow): Rec =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Rec) : {};

/** A line on the Now tab's editor: its number (the new file's, or the old one's for a removed line), and whether it was added or removed. */
export type EditorLine = { n: string; kind: 'add' | 'del' | 'ctx' | 'gap'; text: string };

/** A recorded patch as editor lines, numbered from each hunk's start; a gap line between hunks. */
export function patchLines(hunks: PatchHunk[]): EditorLine[] {
  const out: EditorLine[] = [];
  hunks.forEach((h, i) => {
    if (i > 0) out.push({ n: '', kind: 'gap', text: '' });
    let oldN = h.oldStart;
    let newN = h.newStart;
    for (const line of h.lines) {
      const text = line.slice(1);
      if (line.startsWith('+')) out.push({ n: String(newN++), kind: 'add', text });
      else if (line.startsWith('-')) out.push({ n: String(oldN++), kind: 'del', text });
      // "\ No newline at end of file" isn't a line of the file.
      else if (!line.startsWith('\\')) {
        out.push({ n: String(newN++), kind: 'ctx', text });
        oldN++;
      }
    }
  });
  return out;
}

const textLines = (text: string): string[] => text.replace(/\n$/, '').split('\n');

/** Before the harness records the patch: the replaced text, then its replacement (their line numbers aren't known yet). */
const replacedLines = (oldText: string, newText: string): EditorLine[] => [
  ...(oldText ? textLines(oldText).map((text) => ({ n: '', kind: 'del' as const, text })) : []),
  ...(newText ? textLines(newText).map((text) => ({ n: '', kind: 'add' as const, text })) : []),
];

/**
 * A file change as the editor shows it: the patch when the harness recorded
 * one, else what the call's input says (a Write's whole file, numbered from 1).
 * Null when neither says anything.
 */
export function changeLines(row: MessageRow): EditorLine[] | null {
  if (row.patch) return patchLines(row.patch);
  const input = inputOf(row);
  let lines: EditorLine[] = [];
  if (row.tool === 'Write') {
    const content = str(input.content);
    if (content !== undefined) lines = textLines(content).map((text, i) => ({ n: String(i + 1), kind: 'ctx', text }));
  } else if (row.tool === 'Edit') {
    lines = replacedLines(str(input.old_string) ?? '', str(input.new_string) ?? '');
  } else if (row.tool === 'MultiEdit' && Array.isArray(input.edits)) {
    lines = (input.edits as Rec[]).flatMap((e, i) => [
      ...(i > 0 ? [{ n: '', kind: 'gap' as const, text: '' }] : []),
      ...replacedLines(str(e?.old_string) ?? '', str(e?.new_string) ?? ''),
    ]);
  } else if (row.tool === 'NotebookEdit') {
    lines = replacedLines('', str(input.new_source) ?? '');
  }
  return lines.length > 0 ? lines : null;
}
