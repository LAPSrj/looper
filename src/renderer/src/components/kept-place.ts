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

/** What BatchPlace uses of a scroller and its children: the DOM's, as types the unit tests can fake. */
export interface PlaceBox {
  getBoundingClientRect(): { top: number; bottom: number };
}
export interface PlaceChild extends PlaceBox {
  readonly isConnected: boolean;
  /** An HTML or SVG element's; an Element's type doesn't promise one. */
  readonly style?: { marginTop: string };
}
export interface PlaceScroller extends PlaceBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly clientTop: number;
  readonly children: ArrayLike<PlaceChild>;
  readonly style: { overflowAnchor: string };
}

/** How long a scroller holds still for its scroll to have ended: what macro-inc/macro#9232 measured for iOS's flings. */
export const SETTLE_MS = 150;

/** Where `item` is in the scroller's content, from its top. */
const contentTop = (el: PlaceScroller, item: PlaceBox): number =>
  item.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop;

/** The child at the bottom edge of the view: below where older items go, which a title or a command line above them isn't. */
function atBottom(el: PlaceScroller): PlaceChild | null {
  const n = el.children.length;
  if (n === 0) return null;
  const bottom = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
  return el.children[firstBelow(n, (i) => el.children[i].getBoundingClientRect().bottom, bottom)];
}

/**
 * Keeps the reader's place as older items are drawn above what they read: the item at the bottom of the view stays
 * where it was. The browser's own scroll anchoring is off meanwhile, so it doesn't move the scroller too, and the
 * scroller moves by what was added from where it is then, not from where it was when the items were asked for, which a
 * reader still scrolling has left. WebKit on iOS drops a scrollTop written while the reader scrolls (a fling, its
 * bounce, a finger on the screen; macro-inc/macro#9232), which showed the start of the added items instead. There
 * (`shiftWhileScrolling`) a negative margin on the first child keeps the items in place, leaving what was added above
 * the scroller's top, and once the scroller has held still for SETTLE_MS, in bounds with no finger down, the margin
 * goes and the scroller moves by it in the same task.
 */
export class BatchPlace {
  private kept: { item: PlaceChild; at: number } | null = null;
  /** The child whose margin keeps the items in place, and its style. */
  private shifted: { child: PlaceChild; style: { marginTop: string } } | null = null;
  private timer: unknown = null;
  /** Which wait a timer or frame belongs to: one from before a drop doesn't settle a later shift. */
  private waiting = 0;
  private still = 0;
  private moved = false;

  constructor(
    private readonly opts: {
      shiftWhileScrolling: boolean;
      fingers: () => number;
      setTimer: (fn: () => void, ms: number) => unknown;
      clearTimer: (timer: unknown) => void;
      /** The next frame (requestAnimationFrame). */
      frame: (fn: () => void) => void;
    },
  ) {}

  /** Older items are about to be drawn: notes the place to keep. */
  before(el: PlaceScroller): void {
    const item = atBottom(el);
    if (!item) return;
    el.style.overflowAnchor = 'none';
    this.kept = { item, at: contentTop(el, item) };
  }

  /** The scroller's items changed (a layout effect, before the frame is painted): puts the reader back where they were. */
  drawn(el: PlaceScroller): void {
    const k = this.kept;
    this.kept = null;
    if (k?.item.isConnected) {
      if (this.opts.shiftWhileScrolling) this.hold(el, k.item, k.at);
      else el.scrollTop += contentTop(el, k.item) - k.at;
    } else if (this.shifted && (!this.shifted.child.isConnected || el.children[0] !== this.shifted.child)) {
      // Another conversation, or this one drawn again from its end.
      this.drop(el);
    }
    if (!this.shifted) this.release(el);
  }

  /** The scroller scrolled (its scroll event). */
  scrolled(): void {
    this.moved = true;
  }

  /** Forgets the shift without moving the scroller: it goes somewhere else (the top, the end), or away. */
  drop(el: PlaceScroller | null): void {
    if (this.timer !== null) this.opts.clearTimer(this.timer);
    this.timer = null;
    this.waiting++;
    if (this.shifted?.child.isConnected) this.shifted.style.marginTop = '';
    this.shifted = null;
    if (el) this.release(el);
  }

  /** The browser's own scroll anchoring back. */
  private release(el: PlaceScroller): void {
    el.style.overflowAnchor = '';
  }

  /** Keeps `item` at `at` in the content by a margin on the first child. */
  private hold(el: PlaceScroller, item: PlaceChild, at: number): void {
    const first = el.children[0];
    if (this.shifted && this.shifted.child !== first && this.shifted.child.isConnected) this.shifted.style.marginTop = '';
    this.shifted = null;
    const style = first.style;
    if (!style) {
      el.scrollTop += contentTop(el, item) - at;
      return;
    }
    style.marginTop = '0px';
    style.marginTop = `${at - contentTop(el, item)}px`;
    this.shifted = { child: first, style };
    this.wait(el);
  }

  private wait(el: PlaceScroller): void {
    if (this.timer !== null) return;
    this.still = el.scrollTop;
    this.moved = false;
    const waiting = ++this.waiting;
    const done = () => {
      if (waiting !== this.waiting) return;
      this.timer = null;
      this.settle(el);
    };
    // Then two frames more: a page too busy to draw hasn't seen the scroll move either.
    this.timer = this.opts.setTimer(() => this.opts.frame(() => this.opts.frame(done)), SETTLE_MS);
  }

  private settle(el: PlaceScroller): void {
    const s = this.shifted;
    if (!s) return;
    const top = el.scrollTop;
    // A batch on its way is measured with the shift: it goes after that batch.
    if (top !== this.still || this.moved || this.kept || this.opts.fingers() > 0 || top < 0 || top > el.scrollHeight - el.clientHeight) return this.wait(el);
    this.shifted = null;
    const item = atBottom(el);
    const y = item?.getBoundingClientRect().top ?? 0;
    s.style.marginTop = '';
    if (item) el.scrollTop += item.getBoundingClientRect().top - y;
    this.release(el);
  }
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
