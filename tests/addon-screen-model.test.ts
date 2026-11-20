import { describe, expect, it } from 'vitest';
import type { AddonField, AddonListRow, AddonNode } from '../src/shared/addons';
import {
  emptyValue,
  fieldRuns,
  fieldsOf,
  fillsScreen,
  isMissing,
  listSelection,
  mergeValues,
  nearEnd,
  redrawnProblems,
  refreshes,
  rowsKey,
  toggleChecked,
} from '../src/renderer/src/components/addon-screen-model';

const checklist = (o: Partial<AddonField> = {}): AddonField => ({
  type: 'field',
  id: 'files',
  label: 'Files',
  input: 'checklist',
  options: [
    { value: 'a.ts', label: 'a.ts' },
    { value: 'b.ts', label: 'b.ts', description: 'Modified' },
    { value: 'c.ts', label: 'c.ts' },
  ],
  ...o,
});
const text = (o: Partial<AddonField> = {}): AddonField => ({ type: 'field', id: 'message', label: 'Message', input: 'text', ...o });
const rows: AddonListRow[] = [
  { id: 'r1', title: 'One', detail: { view: 'diff', params: { path: 'one' } } },
  { id: 'r2', title: 'Two', detail: { view: 'diff', params: { path: 'two' } } },
  { id: 'r3', title: 'Three' },
];

describe('an addon screen’s checklist values', () => {
  it('starts with nothing checked, or the addon’s values still among the options', () => {
    expect(emptyValue(checklist())).toEqual([]);
    expect(mergeValues({}, [checklist()])).toEqual({ files: [] });
    expect(mergeValues({}, [checklist({ value: ['b.ts', 'gone.ts'] })])).toEqual({ files: ['b.ts'] });
  });

  it('keeps what the user checked across redraws, less the options that went', () => {
    const prev = { files: ['a.ts', 'c.ts'], message: 'typed' };
    const next = mergeValues(prev, [checklist({ value: ['b.ts'], options: [{ value: 'a.ts', label: 'a.ts' }, { value: 'b.ts', label: 'b.ts' }] }), text({ value: 'addon' })]);
    expect(next).toEqual({ files: ['a.ts'], message: 'typed' });
  });

  it('checks and unchecks in the options’ order', () => {
    const f = checklist();
    expect(toggleChecked(f, ['c.ts'], 'a.ts', true)).toEqual(['a.ts', 'c.ts']);
    expect(toggleChecked(f, ['a.ts', 'c.ts'], 'a.ts', false)).toEqual(['c.ts']);
    expect(toggleChecked(f, undefined, 'b.ts', true)).toEqual(['b.ts']);
  });

  it('needs one checked when required, and text that isn’t blank', () => {
    expect(isMissing(checklist({ required: true }), [])).toBe(true);
    expect(isMissing(checklist({ required: true }), ['a.ts'])).toBe(false);
    expect(isMissing(checklist(), [])).toBe(false);
    expect(isMissing(text({ required: true }), '  ')).toBe(true);
    expect(isMissing(text({ required: true }), undefined)).toBe(true);
    expect(isMissing(text({ required: true }), 'fix')).toBe(false);
  });

  it('finds checklists inside tabs and keeps them out of a group of fields', () => {
    const body: AddonNode[] = [text(), checklist(), text({ id: 'b' }), { type: 'tabs', id: 't', items: [{ id: 'x', title: 'X', body: [checklist({ id: 'inner' })] }] }];
    expect(fieldsOf(body).map((f) => f.id)).toEqual(['message', 'files', 'b', 'inner']);
    expect(fieldRuns(body).map((r) => [r.at, r.fields])).toEqual([
      [0, true],
      [1, false],
      [2, true],
      [3, false],
    ]);
  });
});

describe('a listDetail’s selection', () => {
  it('starts on the node’s selected row, else the first on the desktop and none on a phone', () => {
    expect(listSelection(rows, 'r2', undefined, true)?.id).toBe('r2');
    expect(listSelection(rows, 'r2', undefined, false)?.id).toBe('r2');
    expect(listSelection(rows, undefined, undefined, true)?.id).toBe('r1');
    expect(listSelection(rows, undefined, undefined, false)).toBeUndefined();
    expect(listSelection(rows, 'gone', undefined, true)?.id).toBe('r1');
  });

  it('keeps the row picked by its id across redraws, and gives way when it’s gone', () => {
    expect(listSelection([rows[2], rows[0], rows[1]], 'r1', 'r2', true)?.id).toBe('r2');
    expect(listSelection(rows, 'r1', 'gone', true)?.id).toBe('r1');
    expect(listSelection(rows, 'r1', 'gone', false)).toBeUndefined();
    // A phone's Back: nothing selected, whatever the node says.
    expect(listSelection(rows, 'r1', null, false)).toBeUndefined();
  });

  it('asks for more rows near the end, once for each set of rows', () => {
    expect(nearEnd({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 300 })).toBe(true);
    expect(nearEnd({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 300 })).toBe(false);
    expect(rowsKey(rows)).not.toBe(rowsKey(rows.slice(0, 2)));
    expect(rowsKey(rows)).toBe(rowsKey([...rows]));
  });

  it('fills its place, as a diff does', () => {
    expect(fillsScreen({ type: 'listDetail', id: 'l', label: 'Changes', items: rows })).toBe(true);
    expect(fillsScreen({ type: 'diff', hunks: [] })).toBe(true);
    expect(fillsScreen({ type: 'text', text: 'x' })).toBe(false);
  });
});

describe('an addon’s refresh', () => {
  it('draws everything again without only, or with none of its parts', () => {
    for (const only of [undefined, {}]) {
      expect(refreshes(only, { view: 'changes' })).toBe(true);
      expect(refreshes(only, { pane: 'servers' })).toBe(true);
      expect(refreshes(only, { projectTabs: true })).toBe(true);
    }
  });

  it('draws only the screens, panes and project tab titles it names', () => {
    const only = { views: ['changes'], panes: ['servers'] };
    expect(refreshes(only, { view: 'changes' })).toBe(true);
    expect(refreshes(only, { view: 'history' })).toBe(false);
    expect(refreshes(only, { pane: 'servers' })).toBe(true);
    expect(refreshes(only, { pane: 'keys' })).toBe(false);
    expect(refreshes(only, { projectTabs: true })).toBe(false);
    expect(refreshes({ projectTabs: true }, { projectTabs: true })).toBe(true);
    expect(refreshes({ projectTabs: true }, { view: 'changes' })).toBe(false);
    expect(refreshes({ projectTabs: false }, { projectTabs: true })).toBe(false);
  });
});

describe('redrawnProblems', () => {
  const text = (id: string, error?: string): AddonField => ({ type: 'field', id, label: id, input: 'text', ...(error ? { error } : {}) });
  it('keeps the problems of fields the redrawn screen still has, and adds its own', () => {
    expect(redrawnProblems({ name: 'A branch named "master" already exists', gone: 'x' }, [text('name'), text('url', "The URL can't be read")])).toEqual({
      name: 'A branch named "master" already exists',
      url: "The URL can't be read",
    });
  });
});
