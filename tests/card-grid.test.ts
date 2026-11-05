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
} from '../src/shared/card-grid';

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
