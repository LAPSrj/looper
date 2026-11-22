/** What a column with no width keeps (px) before the columns with one give way: the details column's least. */
export const FLEX_MIN = 120;

interface Labelled {
  label: string;
  width?: number;
  min?: number;
}

/** The width a column has: the one stored for its label, else its starting width; none for the flex column. */
export function shownWidth(c: Labelled, stored: Record<string, unknown>): number | undefined {
  if (c.width === undefined) return undefined;
  const w = stored[c.label];
  return typeof w === 'number' && Number.isFinite(w) ? Math.max(c.min ?? 40, Math.round(w)) : c.width;
}

/**
 * The stored widths after the shown columns were sized `w` (by position): a column at its starting width loses its
 * entry, and a column the pane left out keeps the one it had.
 */
export function mergeStoredWidths(stored: Record<string, unknown>, cols: readonly Labelled[], w: readonly (number | undefined)[]): Record<string, unknown> {
  const next = { ...stored };
  cols.forEach((c, i) => {
    if (c.width === undefined) return;
    if (typeof w[i] === 'number' && w[i] !== c.width) next[c.label] = w[i];
    else delete next[c.label];
  });
  return next;
}

interface Sized {
  width?: number;
  percent?: number;
}

/**
 * The columns of a table that fit in `room` px (null: not measured yet, all of them). The window or the pane is
 * too narrow for them all when their widths, with the flexible column's least, add up to more: the columns with
 * a width go from the right until the rest fit. The first column names the row, so it stays, and so does the
 * flexible one, so a table has no horizontal scroll bar.
 */
export function fitColumns<T extends Sized>(cols: readonly T[], room: number | null): T[] {
  const kept = [...cols];
  if (room === null) return kept;
  const need = () => kept.reduce((sum, c) => sum + (c.width ?? (c.percent !== undefined ? (room * c.percent) / 100 : FLEX_MIN)), 0);
  while (kept.length > 1 && need() > room) {
    let drop = -1;
    for (let i = kept.length - 1; i > 0; i--) {
      if (kept[i].width !== undefined) {
        drop = i;
        break;
      }
    }
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return kept;
}
