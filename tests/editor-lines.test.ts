import { describe, expect, it } from 'vitest';
import { changeLines, patchLines } from '../src/renderer/src/components/editor-lines';
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

describe('patchLines', () => {
  it('numbers added and kept lines by the new file, removed ones by the old, with a gap between hunks', () => {
    const lines = patchLines([
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [' x', '+y', '\\ No newline at end of file'] },
    ]);
    expect(lines.map((l) => [l.n, l.kind, l.text])).toEqual([
      ['10', 'ctx', 'a'],
      ['11', 'del', 'b'],
      ['11', 'add', 'B'],
      ['12', 'ctx', 'c'],
      ['', 'gap', ''],
      ['40', 'ctx', 'x'],
      ['41', 'add', 'y'],
    ]);
  });
});

describe('changeLines', () => {
  it("shows a Write's file numbered from 1", () => {
    expect(changeLines(row('Write', { file_path: '/a.txt', content: 'one\ntwo\n' }))?.map((l) => [l.n, l.text])).toEqual([
      ['1', 'one'],
      ['2', 'two'],
    ]);
  });

  it("shows an Edit's replaced and new text until the patch is recorded, then the patch", () => {
    const edit = row('Edit', { file_path: '/a.ts', old_string: 'x = 1', new_string: 'x = 2\ny = 3' });
    expect(changeLines(edit)?.map((l) => [l.kind, l.text])).toEqual([
      ['del', 'x = 1'],
      ['add', 'x = 2'],
      ['add', 'y = 3'],
    ]);
    const patched = { ...edit, patch: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-x = 1', '+x = 2'] }] };
    expect(changeLines(patched)?.map((l) => l.n)).toEqual(['5', '5']);
  });

  it("has nothing for a change its input doesn't describe (Codex's live file changes)", () => {
    expect(changeLines(row('Edit', { kind: 'update' }))).toBeNull();
  });
});
