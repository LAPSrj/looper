import { describe, expect, it } from 'vitest';
import {
  autoRowHeight,
  CARD_MIN_HEIGHT,
  columnTracks,
  columnWidths,
  gapBars,
  placeCards,
  resetSize,
  rowCount,
  rowHeights,
  sizeColumn,
  sizeRow,
  DASHBOARD_LAYOUTS,
  FOCUS_SIDE_MIN,
  FOCUS_SIDE_WIDTH,
  focusSideWidth,
  layoutDashboard,
  type LayoutInput,
} from '../src/shared/card-grid';
import { ViewSchema } from '../src/shared/types';

describe('columnWidths', () => {
  it('fits as many automatic columns of at least the least width as there is room for, sharing the width', () => {
    expect(columnWidths([], 1000)).toEqual([494, 494]);
    expect(columnWidths([], 1044)).toEqual([340, 340, 340]);
    expect(columnWidths([], 1043)).toHaveLength(2);
    expect(columnWidths([], 300)).toEqual([300]);
  });

  it('keeps the fixed columns and fills the rest with automatic ones', () => {
    expect(columnWidths([500], 1200)).toEqual([500, 688]);
    expect(columnWidths([400, 400], 1500)).toEqual([400, 400, 676]);
  });

  it('stretches the last fixed column when no automatic one fits', () => {
    expect(columnWidths([500], 800)).toEqual([800]);
    expect(columnWidths([400, 400], 1100)).toEqual([400, 688]);
  });

  it('drops a fixed column that does not fit, and every one after it', () => {
    expect(columnWidths([400, 900, 340], 1200)).toEqual([1200]);
    expect(columnWidths([400, 900], 1400)).toEqual([400, 988]);
  });

  it('shrinks a first column wider than the dashboard to it', () => {
    expect(columnWidths([2000], 1200)).toEqual([1200]);
  });

  it('treats a 0 as an automatic column and a fixed one under the least width as the least', () => {
    expect(columnWidths([0, 500], 1200)).toEqual([688, 500]);
    expect(columnWidths([100], 700)).toEqual([340, 348]);
  });

  it('adds up to the width, gaps included', () => {
    for (const [saved, width] of [
      [[], 1371],
      [[420], 1371],
      [[0, 380, 0], 1650],
    ] as [number[], number][]) {
      const w = columnWidths(saved, width);
      expect(w.reduce((a, b) => a + b, 0) + (w.length - 1) * 12).toBeCloseTo(width);
    }
  });
});

describe('columnTracks', () => {
  it('gives the fixed columns in pixels and the ones that take the rest as shares', () => {
    expect(columnTracks([], 1000)).toBe('minmax(0, 1fr) minmax(0, 1fr)');
    expect(columnTracks([500], 1200)).toBe('500px minmax(0, 1fr)');
    expect(columnTracks([400, 400], 1100)).toBe('400px minmax(0, 1fr)');
    expect(columnTracks([2000], 1200)).toBe('minmax(0, 1fr)');
  });
});

describe('rows', () => {
  it('makes an automatic row half the view, at least 320', () => {
    expect(autoRowHeight(812)).toBe(400);
    expect(autoRowHeight(500)).toBe(320);
  });

  it('uses the saved heights, at least the least one, and the automatic one for the rest', () => {
    expect(rowHeights([250, 0, 100], 4, 400)).toEqual([250, 400, CARD_MIN_HEIGHT, 400]);
  });
});

describe('placeCards', () => {
  it('fills the rows in order', () => {
    expect(placeCards([false, false, false], 2)).toEqual([
      { row: 0, col: 0, cols: 1, rows: 1 },
      { row: 0, col: 1, cols: 1, rows: 1 },
      { row: 1, col: 0, cols: 1, rows: 1 },
    ]);
  });

  it('gives a doubled card two columns and two rows, and the cards after it the cells left', () => {
    const p = placeCards([true, false, false, false], 3);
    expect(p).toEqual([
      { row: 0, col: 0, cols: 2, rows: 2 },
      { row: 0, col: 2, cols: 1, rows: 1 },
      { row: 1, col: 2, cols: 1, rows: 1 },
      { row: 2, col: 0, cols: 1, rows: 1 },
    ]);
    expect(rowCount(p)).toBe(3);
  });

  it('moves a doubled card that does not fit at the end of a row to the next, without going back', () => {
    expect(placeCards([false, true, false], 2)).toEqual([
      { row: 0, col: 0, cols: 1, rows: 1 },
      { row: 1, col: 0, cols: 2, rows: 2 },
      { row: 3, col: 0, cols: 1, rows: 1 },
    ]);
  });

  it('makes a doubled card one column wide when there is only one', () => {
    expect(placeCards([true, false], 1)).toEqual([
      { row: 0, col: 0, cols: 1, rows: 2 },
      { row: 2, col: 0, cols: 1, rows: 1 },
    ]);
  });
});

describe('gapBars', () => {
  it('has a bar between each two columns and under each row', () => {
    const bars = gapBars(placeCards([false, false, false, false], 2), [400, 400], [300, 300]);
    expect(bars).toEqual([
      { axis: 'x', index: 0, at: 400, from: 0, length: 612 },
      { axis: 'y', index: 0, at: 300, from: 0, length: 812 },
      { axis: 'y', index: 1, at: 612, from: 0, length: 812 },
    ]);
  });

  it('leaves out where a doubled card covers the gap', () => {
    // A doubled card in the first two of three columns, then two cards down the third.
    const bars = gapBars(placeCards([true, false, false], 3), [300, 300, 300], [200, 200]);
    expect(bars.filter((b) => b.axis === 'x')).toEqual([{ axis: 'x', index: 1, at: 612, from: 0, length: 412 }]);
    expect(bars.filter((b) => b.axis === 'y' && b.index === 0)).toEqual([{ axis: 'y', index: 0, at: 200, from: 624, length: 300 }]);
  });

  it('has none without cards', () => {
    expect(gapBars([], [500], [])).toEqual([]);
  });
});

describe('sizing a track', () => {
  it('sets a column, keeping the shown widths of the ones before it and the saved ones after it', () => {
    expect(sizeColumn([], [392, 392, 392], 1, 492.4)).toEqual([392, 492]);
    expect(sizeColumn([400, 0, 500], [400, 380, 500], 0, 450)).toEqual([450, 0, 500]);
  });

  it('keeps a column at least the least width', () => {
    expect(sizeColumn([], [600, 600], 0, 100)).toEqual([340]);
  });

  it('sets a row, at least the least height, leaving the others', () => {
    expect(sizeRow([], 2, 260)).toEqual([0, 0, 260]);
    expect(sizeRow([300], 0, 50)).toEqual([CARD_MIN_HEIGHT]);
  });

  it('makes a column or row automatic again, dropping the automatic ones at the end', () => {
    expect(resetSize([400, 500], 1)).toEqual([400]);
    expect(resetSize([400, 500], 0)).toEqual([0, 500]);
    expect(resetSize([0, 0, 260], 2)).toEqual([]);
  });
});

describe('the dashboard layouts', () => {
  const input = (n: number, over: Partial<LayoutInput> = {}): LayoutInput => ({
    cards: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, big: false })),
    width: 1200,
    height: 900,
    columns: [],
    rows: [],
    side: 0,
    ...over,
  });

  it("are View's layout values, Grid first (the default)", () => {
    for (const l of DASHBOARD_LAYOUTS) expect(ViewSchema.parse({ sessions: { layout: l.id } }).sessions.layout).toBe(l.id);
    expect(ViewSchema.safeParse({ sessions: { layout: 'nope' } }).success).toBe(false);
    expect(ViewSchema.parse({}).sessions.layout).toBe(DASHBOARD_LAYOUTS[0].id);
  });

  it("lays Grid out as before: every card with its message box, in the columns that fit, the gaps' bars", () => {
    const g = layoutDashboard('grid', input(4, { cards: [{ id: 'a', big: true }, { id: 'b', big: false }, { id: 'c', big: false }, { id: 'd', big: false }] }));
    expect(g.widths).toEqual(columnWidths([], 1200));
    expect(g.columns).toBe(columnTracks([], 1200));
    expect(g.cards.map((c) => [c.id, c.box, c.place])).toEqual(placeCards([true, false, false, false], 3).map((p, i) => [['a', 'b', 'c', 'd'][i], true, p]));
    expect(g.gap).toBe(12);
    expect(g.bars.length).toBeGreaterThan(0);
    // An unknown layout is Grid.
    expect(layoutDashboard('nope', input(2))).toEqual(layoutDashboard('grid', input(2)));
  });

  it('lays Focus out as one large conversation with its message box, which stays in view, and the others in a column beside it', () => {
    const f = layoutDashboard('focus', input(3, { focus: 'c1' }));
    expect(f.gap).toBe(0);
    expect(f.columns).toBe(`minmax(0, 1fr) ${FOCUS_SIDE_WIDTH}px`);
    expect(f.rows).toBe('repeat(2, minmax(300px, 1fr))');
    expect(f.cards).toEqual([
      { id: 'c1', place: { row: 0, col: 0, rows: 2, cols: 1 }, box: true, stays: 900 },
      { id: 'c0', place: { row: 0, col: 1, rows: 1, cols: 1 }, box: false },
      { id: 'c2', place: { row: 1, col: 1, rows: 1, cols: 1 }, box: false },
    ]);
    expect(f.split).toEqual({ at: 1200 - FOCUS_SIDE_WIDTH, width: FOCUS_SIDE_WIDTH, min: FOCUS_SIDE_MIN, max: 1200 - 340 - 1 });
    // A large conversation that closed: the first card.
    expect(layoutDashboard('focus', input(2, { focus: 'gone' })).cards[0]).toMatchObject({ id: 'c0', box: true });
    // One card fills the dashboard, with no side column.
    expect(layoutDashboard('focus', input(1))).toMatchObject({ columns: 'minmax(0, 1fr)', cards: [{ id: 'c0', box: true }] });
    expect(layoutDashboard('focus', input(1)).split).toBeUndefined();
  });

  it("keeps Focus's side column within what both columns keep", () => {
    expect(focusSideWidth(0, 1200)).toBe(FOCUS_SIDE_WIDTH);
    expect(focusSideWidth(100, 1200)).toBe(FOCUS_SIDE_MIN);
    expect(focusSideWidth(5000, 1200)).toBe(1200 - 340 - 1);
    expect(focusSideWidth(500, 400)).toBe(FOCUS_SIDE_MIN);
  });
});
