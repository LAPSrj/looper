import { describe, expect, it } from 'vitest';
import { changeRows, escapeHtml, hunkRows, markRanges, wordChanges, writtenLines, type DiffRow } from '../src/renderer/src/components/editor-lines';
import type { MessageRow } from '../src/shared/messages';

const row = (tool: string, input: unknown, extra: Partial<MessageRow> = {}): MessageRow => ({
  id: '1',
  kind: 'tool',
  tool,
  input,
  text: '',
  preview: '',
  ...extra,
});

const cells = (rows: DiffRow[]) => rows.map((r) => (r.kind === 'hunk' ? [r.kind, r.text] : [r.kind, r.oldN, r.newN, r.text]));

describe('hunkRows', () => {
  it('numbers each line in both files, under a header per hunk', () => {
    const rows = hunkRows([
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 2, lines: [' x', '+y', '\\ No newline at end of file'] },
    ]);
    expect(cells(rows)).toEqual([
      ['hunk', '@@ -10,3 +10,3 @@'],
      ['ctx', '10', '10', 'a'],
      ['del', '11', '', 'b'],
      ['add', '', '11', 'B'],
      ['ctx', '12', '12', 'c'],
      ['hunk', '@@ -40,1 +41,2 @@'],
      ['ctx', '40', '41', 'x'],
      ['add', '', '42', 'y'],
    ]);
  });

  it('marks the changed words of a replaced line', () => {
    const rows = hunkRows([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const x = 1;', '+const x = 22;'] }]);
    expect(rows[1]).toMatchObject({ kind: 'del', words: [[10, 11]] });
    expect(rows[2]).toMatchObject({ kind: 'add', words: [[10, 12]] });
  });
});

describe('wordChanges', () => {
  it('finds a change in the middle of a line, by whole words', () => {
    expect(wordChanges('return foo(bar);', 'return foo(baz);')).toEqual({ a: [[11, 14]], b: [[11, 14]] });
  });

  it('marks nothing on lines with too little in common', () => {
    expect(wordChanges('alpha beta gamma', 'one two three four five')).toBeNull();
  });

  it('gives an insertion only on the side that has it', () => {
    expect(wordChanges('a b', 'a x b')).toEqual({ a: [], b: [[2, 4]] });
  });
});

describe('markRanges', () => {
  it('counts the text only, closing the mark around tags', () => {
    const html = '<span class="k">const</span> x';
    expect(markRanges(html, [[3, 7]])).toBe('<span class="k">con<mark class="diff-word">st</mark></span><mark class="diff-word"> x</mark>');
  });

  it('counts an entity as one character', () => {
    expect(markRanges(escapeHtml('a<b'), [[1, 2]])).toBe('a<mark class="diff-word">&lt;</mark>b');
  });
});

describe('changeRows', () => {
  it("shows an Edit's replaced and new text until the patch is recorded, then the patch", () => {
    const edit = row('Edit', { file_path: '/a.ts', old_string: 'x = 1', new_string: 'x = 2\ny = 3' });
    expect(cells(changeRows(edit)!)).toEqual([
      ['del', '', '', 'x = 1'],
      ['add', '', '', 'x = 2'],
      ['add', '', '', 'y = 3'],
    ]);
    const patched = { ...edit, patch: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-x = 1', '+x = 2'] }] };
    expect(cells(changeRows(patched)!)).toEqual([
      ['hunk', '@@ -5,1 +5,1 @@'],
      ['del', '5', '', 'x = 1'],
      ['add', '', '5', 'x = 2'],
    ]);
  });

  it("has nothing for a change its input doesn't describe (Codex's live file changes)", () => {
    expect(changeRows(row('Edit', { kind: 'update' }))).toBeNull();
  });

  it('leaves a Write without a patch to writtenLines', () => {
    const write = row('Write', { file_path: '/a.txt', content: 'one\ntwo\n' });
    expect(changeRows(write)).toBeNull();
    expect(writtenLines(write)).toEqual([
      { n: '1', text: 'one' },
      { n: '2', text: 'two' },
    ]);
  });
});
