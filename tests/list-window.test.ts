import { describe, expect, it } from 'vitest';
import { groupHeight, rowDrawn, rowOffset, scrollToShow, windowGroups, type ListMetrics } from '../src/renderer/src/components/list-window';

/** Rows 50 high, headers 30, 6 above the first group, 2 rows of overscan. */
const m: ListMetrics = { base: 6, headH: 30, rowH: 50, overscan: 2 };

describe('windowGroups', () => {
  it('draws the groups and rows in view with the overscan, and nothing of a group far below', () => {
    // Group 0 holds 100 rows (6..5036), group 1 holds 3 (5036..5216).
    const r = windowGroups([100, 3], 0, 500, m);
    // The view and 2 rows below end at 600; rows start at 36: ceil((600 - 36) / 50) = 12.
    expect(r[0]).toEqual({ from: 0, to: 12 });
    expect(r[1]).toBeNull();
  });

  it('starts at the first row the overscan reaches when scrolled', () => {
    const r = windowGroups([100], 2536, 500, m);
    // lo = 2436, items start at 36: floor(2400 / 50) = 48.
    expect(r[0]?.from).toBe(48);
    expect(r[0]?.to).toBe(Math.ceil((2536 + 500 + 100 - 36) / 50));
  });

  it('draws a group whose header shows but whose rows are below the view, with none of them', () => {
    const r = windowGroups([0, 5], 0, 40, { ...m, overscan: 0 });
    expect(r[0]).toEqual({ from: 0, to: 0 });
    expect(r[1]).toEqual({ from: 0, to: 0 });
  });

  it('draws a closed group as its header alone', () => {
    expect(windowGroups([0], 0, 300, m)).toEqual([{ from: 0, to: 0 }]);
  });

  it('draws every row when the view holds them all', () => {
    expect(windowGroups([3, 4], 0, 2000, m)).toEqual([
      { from: 0, to: 3 },
      { from: 0, to: 4 },
    ]);
  });

  it('draws the rows that fill what the view shows even for a top the scroll rounded down by the overscan', () => {
    const sizes = [200];
    for (const scrollTop of [1000, 1049, 1099]) {
      const top = 1000; // rounded down by up to two rows (100 px)
      const [r] = windowGroups(sizes, top, 500, m);
      const firstSeen = Math.floor((scrollTop - 36) / 50);
      const lastSeen = Math.ceil((scrollTop + 500 - 36) / 50);
      expect(r!.from).toBeLessThanOrEqual(firstSeen);
      expect(r!.to).toBeGreaterThanOrEqual(lastSeen);
    }
  });

  it('keeps the scroll height: spacers and drawn rows add up to the whole list', () => {
    const sizes = [100, 30, 0, 12];
    const total = sizes.reduce((y, n) => y + groupHeight(n, m), 0);
    const ranges = windowGroups(sizes, 1500, 600, m);
    let y = 0;
    ranges.forEach((r, g) => {
      y += r ? m.headH + r.from * m.rowH + (r.to - r.from) * m.rowH + (sizes[g] - r.to) * m.rowH : groupHeight(sizes[g], m);
    });
    expect(y).toBe(total);
  });
});

describe('rowOffset', () => {
  it('counts each group header, then its items', () => {
    const sizes = [2, 0, 3];
    expect(rowOffset(sizes, 0, m)).toEqual({ top: 6, height: 30 });
    expect(rowOffset(sizes, 1, m)).toEqual({ top: 36, height: 50 });
    expect(rowOffset(sizes, 2, m)).toEqual({ top: 86, height: 50 });
    // Group 1 (closed) starts at 6 + 30 + 100 = 136, group 2 at 166.
    expect(rowOffset(sizes, 3, m)).toEqual({ top: 136, height: 30 });
    expect(rowOffset(sizes, 4, m)).toEqual({ top: 166, height: 30 });
    expect(rowOffset(sizes, 5, m)).toEqual({ top: 196, height: 50 });
    expect(rowOffset(sizes, 7, m)).toEqual({ top: 296, height: 50 });
    expect(rowOffset(sizes, 8, m)).toBeNull();
  });
});

describe('rowDrawn', () => {
  it('is true for everything when nothing is left out', () => {
    expect(rowDrawn([5], null, 3)).toBe(true);
  });

  it('is true for a header of a drawn group and a row in its range only', () => {
    const sizes = [10, 10];
    const ranges = [{ from: 2, to: 5 }, null];
    expect(rowDrawn(sizes, ranges, 0)).toBe(true);
    expect(rowDrawn(sizes, ranges, 1)).toBe(false);
    expect(rowDrawn(sizes, ranges, 3)).toBe(true);
    expect(rowDrawn(sizes, ranges, 5)).toBe(true);
    expect(rowDrawn(sizes, ranges, 6)).toBe(false);
    expect(rowDrawn(sizes, ranges, 11)).toBe(false);
    expect(rowDrawn(sizes, ranges, 12)).toBe(false);
  });
});

describe('scrollToShow', () => {
  it('leaves a row in view alone and moves a row out of view the least it can', () => {
    expect(scrollToShow({ top: 300, height: 50 }, 200, 400)).toBeNull();
    expect(scrollToShow({ top: 100, height: 50 }, 200, 400)).toBe(100);
    expect(scrollToShow({ top: 700, height: 50 }, 200, 400)).toBe(350);
  });
});
