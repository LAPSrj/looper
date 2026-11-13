// No DOM types: the unit tests (node tsconfig) load this file.

/** Where the reader was in a conversation: the item at the top of the view, how far into it the view starts (px), and whether at the end. */
export interface Place {
  chat: string;
  item: number;
  offset: number;
  atEnd: boolean;
}

/** Where a page keeps its place: a phone's screen by its window, any other page by its address. */
export const placeKey = (search: string, hash: string): string => `looper.place.${new URLSearchParams(search).get('w') ?? hash}`;

/**
 * The kept place `chat` opens at: only the conversation the page's address names (a phone's chat screen, a chat's
 * window) comes back where the reader left it. One opened from a list opens at its end, even right after Looper starts.
 */
export function placeToRestore(chat: string, hash: string, kept: string | null): Place | null {
  const shown = /#sessions\/([^/]+)/.exec(hash)?.[1];
  if (!shown || decodeURIComponent(shown) !== chat) return null;
  try {
    const p = JSON.parse(kept ?? 'null') as Place | null;
    return p && p.chat === chat && Number.isFinite(p.item) && Number.isFinite(p.offset) ? p : null;
  } catch {
    return null;
  }
}

/** The items a conversation draws first, [start, end): `first` from the kept item, or the newest `first`. A null end follows the newest. */
export function firstDrawn(total: number, first: number, startAt?: number): { start: number; end: number | null } {
  if (startAt === undefined) return { start: Math.max(0, total - first), end: null };
  const start = Math.max(0, Math.min(startAt, total));
  return { start, end: start + first < total ? start + first : null };
}

/** The first of `count` items in order whose bottom is below `y`, or the last one. */
export function firstBelow(count: number, bottomOf: (i: number) => number, y: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
