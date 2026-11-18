// No React, no DOM: the unit tests load this file.

/** Several selected rows: the keys selected, the row the keyboard is on, and the row a Shift range runs from. */
export interface MultiSelection {
  keys: string[];
  lead: string | null;
  anchor: string | null;
}

/** The keys from `a` to `b` (either way), in the rows' order. */
function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * A click on row `key`, as a Windows list view takes it: alone it selects only
 * that row; Ctrl adds it or takes it out; Shift selects the range from the
 * anchor (the last row clicked without Shift), Ctrl+Shift adds that range.
 */
export function clickSelect(order: readonly string[], cur: MultiSelection, key: string, mods: { ctrl?: boolean; shift?: boolean }): MultiSelection {
  if (mods.shift && cur.anchor !== null && order.includes(cur.anchor)) {
    const span = range(order, cur.anchor, key);
    const keys = mods.ctrl ? order.filter((k) => cur.keys.includes(k) || span.includes(k)) : span;
    return { keys, lead: key, anchor: cur.anchor };
  }
  if (mods.ctrl) {
    const keys = cur.keys.includes(key) ? cur.keys.filter((k) => k !== key) : order.filter((k) => cur.keys.includes(k) || k === key);
    return { keys, lead: key, anchor: key };
  }
  return { keys: [key], lead: key, anchor: key };
}

/**
 * The keyboard moved to row `key` (an arrow, Home or End): without Shift only
 * that row is selected and it's the new anchor; with Shift the selection is
 * the range from the anchor to it.
 */
export function moveSelect(order: readonly string[], cur: MultiSelection, key: string, shift: boolean): MultiSelection {
  return clickSelect(order, cur, key, { shift });
}

/** Where Up, Down, Home and End take the keyboard from row `index` of `count`; null for another key. */
export function stepIndex(key: string, index: number, count: number): number | null {
  if (!count) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(count - 1, index + 1);
    case 'ArrowUp':
      return index < 0 ? 0 : Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
