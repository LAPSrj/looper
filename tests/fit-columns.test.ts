import { describe, expect, it } from 'vitest';
import { fitColumns, mergeStoredWidths, shownWidth } from '../src/renderer/src/components/fit-columns';

const label = (cols: { label: string }[]) => cols.map((c) => c.label);

describe('fitColumns', () => {
  const runs = [{ label: 'Task', width: 240 }, { label: 'Result', width: 110 }, { label: 'Details' }, { label: 'Started', width: 128 }, { label: 'Duration', width: 100 }];

  it('keeps every column while they fit, or before the table is measured', () => {
    expect(label(fitColumns(runs, 700))).toEqual(['Task', 'Result', 'Details', 'Started', 'Duration']);
    expect(label(fitColumns(runs, null))).toEqual(label(runs));
  });

  it('drops the columns with a width from the right until the rest fit, keeping the first and the flexible one', () => {
    expect(label(fitColumns(runs, 600))).toEqual(['Task', 'Result', 'Details', 'Started']);
    expect(label(fitColumns(runs, 480))).toEqual(['Task', 'Result', 'Details']);
    expect(label(fitColumns(runs, 378))).toEqual(['Task', 'Details']);
  });

  it('stops at the first column and the flexible one, however narrow the room', () => {
    expect(label(fitColumns(runs, 100))).toEqual(['Task', 'Details']);
    expect(label(fitColumns([{ label: 'A', width: 300 }, { label: 'B', width: 300 }], 100))).toEqual(['A']);
  });

  it('counts a percent column as that share of the room', () => {
    expect(label(fitColumns([{ label: 'A', width: 100 }, { label: 'B', percent: 50 }, { label: 'C', width: 100 }], 200))).toEqual(['A', 'B']);
  });
});

describe('stored column widths', () => {
  const cols = [{ label: 'Task', width: 240 }, { label: 'Result', width: 110 }, { label: 'Details' }, { label: 'Started', width: 128 }];

  it('keeps the width of a column the pane left out when another column is dragged', () => {
    // Started was dragged wider while the pane was wide; now the pane is narrow and Started is hidden.
    const stored = { Started: 200 };
    const shown = cols.slice(0, 3);
    const after = mergeStoredWidths(stored, shown, [300, 110, undefined]);
    expect(after).toEqual({ Started: 200, Task: 300 });
  });

  it('forgets a column dragged back to its starting width', () => {
    expect(mergeStoredWidths({ Task: 300, Started: 200 }, cols, [240, 110, undefined, 200])).toEqual({ Started: 200 });
  });

  it('shows the stored width, clamped to the column least, and none for the flexible column', () => {
    expect(shownWidth(cols[0], { Task: 320 })).toBe(320);
    expect(shownWidth(cols[0], { Task: 5 })).toBe(40);
    expect(shownWidth(cols[0], { Task: 'x' })).toBe(240);
    expect(shownWidth(cols[2], { Details: 400 })).toBeUndefined();
  });

  it('fits by the widths shown: a dragged-wider column takes the room that makes the last one go', () => {
    const sized = (stored: Record<string, unknown>) => cols.map((c) => ({ ...c, width: shownWidth(c, stored) }));
    expect(label(fitColumns(sized({}), 600))).toEqual(['Task', 'Result', 'Details', 'Started']);
    expect(label(fitColumns(sized({ Task: 400 }), 600))).toEqual(['Task', 'Details']);
  });
});
