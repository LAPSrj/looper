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

/** What a conversation draws: its items [start, end) (a null end follows the newest) for `key`, with `lead` items ahead of its last part; `empty`: it had none when this was worked out. */
export interface Drawn {
  key: string;
  start: number;
  end: number | null;
  lead: number;
  empty: boolean;
}

/**
 * What a conversation draws after it changed (`drawn` itself when that stays). Another conversation starts over. One
 * that had no items yet (a chat whose history was still being read) draws as it would have opened with the items
 * that came. Items added or taken ahead of its last part (the history read in whole after its newest rows) move the
 * drawn ones with them, so the same items stay drawn instead of all those that came. Once the newest item is drawn,
 * what arrives after it is drawn too.
 */
export function nextDrawn(drawn: Drawn, key: string, total: number, lead: number, first: number, startAt?: number): Drawn {
  if (drawn.key !== key) return { key, lead, empty: total === 0, ...firstDrawn(total, first) };
  if (drawn.empty && total > 0) return { key, lead, empty: false, ...firstDrawn(total, first, startAt) };
  if (drawn.lead !== lead) {
    const by = lead - drawn.lead;
    return { ...drawn, lead, start: Math.max(0, drawn.start + by), end: drawn.end === null ? null : Math.max(0, drawn.end + by) };
  }
  if (drawn.end !== null && drawn.end >= total) return { ...drawn, end: null };
  return drawn;
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
