/**
 * The Chats window's desktop dashboard as a grid: column widths and row heights
 * the user set by dragging the gaps between the cards (0: automatic), the
 * columns and rows they come to at the dashboard's size, where each card goes,
 * and the gaps that can be dragged. Sizes are in CSS pixels.
 */

/** A column narrower than this drops; room for one this wide brings another in. */
export const CARD_MIN_WIDTH = 340;
/** The least height a row can be dragged to. */
export const CARD_MIN_HEIGHT = 200;
/** The space between two cards. */
export const CARD_GAP = 12;
/** An automatic row's least height. */
const AUTO_ROW_MIN = 320;

/** Saved sizes: `0` (or none) is automatic. Trailing automatic entries go. */
const trim = (sizes: number[]): number[] => {
  const out = [...sizes];
  while (out.length && !(out[out.length - 1] > 0)) out.pop();
  return out;
};

/**
 * The columns' widths in a dashboard `width` wide: the saved ones from the
 * first column (`saved`, 0 for an automatic one), then as many automatic
 * columns as fit. Automatic columns share what the fixed ones leave, each at
 * least `min`; a column that doesn't fit drops with every one after it, and
 * with no automatic column the last one stretches to the edge. A first column
 * wider than the dashboard shrinks to it.
 */
export function columnWidths(saved: number[], width: number, gap = CARD_GAP, min = CARD_MIN_WIDTH): number[] {
  return fitColumns(saved, width, gap, min).map((c) => c.width);
}

/**
 * The columns as CSS grid tracks: a fixed one in pixels, the ones that take
 * what's left (the automatic ones, or the last) as shares of it, so their
 * widths add up to the dashboard's exactly.
 */
export function columnTracks(saved: number[], width: number, gap = CARD_GAP, min = CARD_MIN_WIDTH): string {
  return fitColumns(saved, width, gap, min)
    .map((c) => (c.stretch ? 'minmax(0, 1fr)' : `${c.width}px`))
    .join(' ');
}

function fitColumns(saved: number[], width: number, gap: number, min: number): { width: number; stretch: boolean }[] {
  const fixed = saved.map((w) => (w > 0 ? Math.max(min, w) : 0));
  let n = 0;
  let fixedSum = 0;
  let autos = 0;
  // Each column needs at least min + gap more, so this ends.
  for (;;) {
    const w = fixed[n] ?? 0;
    if (fixedSum + w + n * gap + (autos + (w ? 0 : 1)) * min > width) break;
    fixedSum += w;
    if (!w) autos++;
    n++;
  }
  if (n === 0) return [{ width: Math.max(0, width), stretch: true }];
  const left = width - fixedSum - (n - 1) * gap;
  const cols = Array.from({ length: n }, (_, i) => fixed[i] ?? 0);
  if (autos === 0) return cols.map((w, i) => (i === n - 1 ? { width: w + left, stretch: true } : { width: w, stretch: false }));
  return cols.map((w) => (w ? { width: w, stretch: false } : { width: left / autos, stretch: true }));
}

/** An automatic row's height in a dashboard `height` tall: two rows to the view, at least 320. */
export const autoRowHeight = (height: number, gap = CARD_GAP): number => Math.max(AUTO_ROW_MIN, (height - gap) / 2);

/** The rows' heights: the saved ones (`saved`, 0 for automatic), `auto` for the rest. */
export const rowHeights = (saved: number[], count: number, auto: number): number[] =>
  Array.from({ length: count }, (_, i) => (saved[i] > 0 ? Math.max(CARD_MIN_HEIGHT, saved[i]) : auto));

/** Where a card goes: its first row and column (from 0) and how many it spans. */
export interface CardPlace {
  row: number;
  col: number;
  cols: number;
  rows: number;
}

/**
 * Where each card goes in `columns` columns, in order, as CSS grid's
 * auto-placement puts them: a doubled card (`big`) covers two columns and two
 * rows (one column when there's only one), and a card goes after the cards
 * before it in their row, or to the next row where it fits.
 */
export function placeCards(big: boolean[], columns: number): CardPlace[] {
  const n = Math.max(1, columns);
  const taken: boolean[][] = [];
  const free = (r: number, c: number, w: number, h: number) => {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (taken[y]?.[x]) return false;
    return true;
  };
  let row = 0;
  let col = 0;
  return big.map((b) => {
    const cols = b ? Math.min(2, n) : 1;
    const rows = b ? 2 : 1;
    for (;;) {
      if (col + cols > n) {
        row++;
        col = 0;
      } else if (free(row, col, cols, rows)) break;
      else col++;
    }
    for (let y = row; y < row + rows; y++) for (let x = col; x < col + cols; x++) (taken[y] ??= [])[x] = true;
    const place = { row, col, cols, rows };
    col += cols;
    return place;
  });
}

/** How many rows the cards fill. */
export const rowCount = (places: CardPlace[]): number => places.reduce((n, p) => Math.max(n, p.row + p.rows), 0);

/** Where each track starts: 0 for the first, then after each one and a gap. */
const starts = (sizes: number[], gap: number): number[] => {
  const out: number[] = [];
  let at = 0;
  for (const s of sizes) {
    out.push(at);
    at += s + gap;
  }
  return out;
};

/**
 * A gap that can be dragged, from the grid's top left corner: after column
 * `index` (`axis` 'x', a vertical bar), or under row `index` ('y', a
 * horizontal bar). `at` is where the gap starts across it, `from` and `length`
 * where the bar runs along it.
 */
export interface GapBar {
  axis: 'x' | 'y';
  index: number;
  at: number;
  from: number;
  length: number;
}

/**
 * The gaps between the cards that can be dragged: between each two columns and
 * under each row (the last one too, to size it), leaving out where a doubled
 * card covers the gap. A gap runs on across the gaps it crosses.
 */
export function gapBars(places: CardPlace[], widths: number[], heights: number[], gap = CARD_GAP): GapBar[] {
  const xs = starts(widths, gap);
  const ys = starts(heights, gap);
  const covers = (p: CardPlace, row: number, col: number) => p.row <= row && row < p.row + p.rows && p.col <= col && col < p.col + p.cols;
  /** The bars of a gap along `count` tracks, leaving out the ones `covered`. */
  const runs = (count: number, trackStarts: number[], sizes: number[], covered: (k: number) => boolean) => {
    const out: { from: number; length: number }[] = [];
    let first = -1;
    for (let k = 0; k <= count; k++) {
      const open = k < count && !covered(k);
      if (open && first === -1) first = k;
      if (!open && first !== -1) {
        out.push({ from: trackStarts[first], length: trackStarts[k - 1] + sizes[k - 1] - trackStarts[first] });
        first = -1;
      }
    }
    return out;
  };
  const bars: GapBar[] = [];
  if (heights.length === 0) return bars;
  for (let i = 0; i + 1 < widths.length; i++) {
    const at = xs[i] + widths[i];
    for (const r of runs(heights.length, ys, heights, (row) => places.some((p) => covers(p, row, i) && covers(p, row, i + 1))))
      bars.push({ axis: 'x', index: i, at, ...r });
  }
  for (let j = 0; j < heights.length; j++) {
    const at = ys[j] + heights[j];
    for (const r of runs(widths.length, xs, widths, (col) => places.some((p) => covers(p, j, col) && covers(p, j + 1, col))))
      bars.push({ axis: 'y', index: j, at, ...r });
  }
  return bars;
}

/**
 * The saved column widths with column `i` set to `width` (at least `min`): the
 * columns before it keep the widths they show (`shown`), the ones after it
 * theirs.
 */
export function sizeColumn(saved: number[], shown: number[], i: number, width: number, min = CARD_MIN_WIDTH): number[] {
  const next = Array.from({ length: Math.max(saved.length, i + 1) }, (_, k) => (k < i ? (shown[k] ?? saved[k] ?? 0) : (saved[k] ?? 0)));
  next[i] = Math.max(min, Math.round(width));
  return trim(next.map((w) => Math.round(w)));
}

/** The saved row heights with row `i` set to `height` (at least the least height). */
export function sizeRow(saved: number[], i: number, height: number): number[] {
  const next = Array.from({ length: Math.max(saved.length, i + 1) }, (_, k) => saved[k] ?? 0);
  next[i] = Math.max(CARD_MIN_HEIGHT, Math.round(height));
  return trim(next);
}

/** The saved sizes (columns' or rows') with track `i` back to automatic. */
export function resetSize(saved: number[], i: number): number[] {
  return trim(saved.map((s, k) => (k === i ? 0 : s)));
}
