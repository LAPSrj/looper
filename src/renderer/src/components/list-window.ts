/**
 * Which rows of a list in groups to draw (no React, no DOM, so it runs in a test). The list's rows
 * all have one height and a group's header another, so where a row sits is known from counts alone:
 * a group takes its header's height (`headH`, its margin too) and `rowH` for each item it shows.
 * The rows out of view, with `overscan` rows on each side, are left out and stand as spacers of the
 * height they would take, so the scroll height and scrollbar stay the same.
 */

export interface ListMetrics {
  /** Where the first group starts in the scroller's content (its padding above). */
  base: number;
  /** A group header's height with its margin. */
  headH: number;
  /** An item row's height. */
  rowH: number;
  /** Rows drawn beyond the view's edge, above and below. */
  overscan: number;
}

/** The items of a group that are drawn: `from` up to, not including, `to`. */
export interface ItemRange {
  from: number;
  to: number;
}

/** What a group takes: its header, then `n` item rows. */
export const groupHeight = (n: number, m: ListMetrics): number => m.headH + n * m.rowH;

/**
 * The part of each group to draw for a view `height` tall that starts `top` down the content. `sizes`: how many
 * items each group shows (a closed group's are 0). null for a group that's out of view altogether, header and all.
 * `top` may be rounded down by up to `overscan` rows, which the overscan covers.
 */
export function windowGroups(sizes: readonly number[], top: number, height: number, m: ListMetrics): (ItemRange | null)[] {
  const lo = top - m.overscan * m.rowH;
  const hi = top + height + m.overscan * m.rowH;
  let y = m.base;
  return sizes.map((n) => {
    const start = y;
    y += groupHeight(n, m);
    if (y <= lo || start >= hi) return null;
    const items = start + m.headH;
    const from = Math.min(n, Math.max(0, Math.floor((lo - items) / m.rowH)));
    const to = Math.min(n, Math.max(from, Math.ceil((hi - items) / m.rowH)));
    return { from, to };
  });
}

/**
 * Where row `flat` sits, counting rows as a list's keys do: each group's header, then its items (`sizes`).
 * null for an index past the last row.
 */
export function rowOffset(sizes: readonly number[], flat: number, m: ListMetrics): { top: number; height: number } | null {
  let y = m.base;
  let i = flat;
  for (const n of sizes) {
    if (i === 0) return { top: y, height: m.headH };
    if (i <= n) return { top: y + m.headH + (i - 1) * m.rowH, height: m.rowH };
    i -= n + 1;
    y += groupHeight(n, m);
  }
  return null;
}

/** Whether row `flat` is among the drawn ones (`ranges`, from windowGroups); true when nothing is left out (null). */
export function rowDrawn(sizes: readonly number[], ranges: readonly (ItemRange | null)[] | null, flat: number): boolean {
  if (!ranges) return true;
  let i = flat;
  for (let g = 0; g < sizes.length; g++) {
    const r = ranges[g];
    if (i === 0) return r !== null;
    if (i <= sizes[g]) return r !== null && i - 1 >= r.from && i - 1 < r.to;
    i -= sizes[g] + 1;
  }
  return false;
}

/** The scroll position that brings a row into a view `viewH` tall, moving it as little as it can; null when it's in view. */
export function scrollToShow(row: { top: number; height: number }, scrollTop: number, viewH: number): number | null {
  if (row.top < scrollTop) return row.top;
  if (row.top + row.height > scrollTop + viewH) return row.top + row.height - viewH;
  return null;
}
