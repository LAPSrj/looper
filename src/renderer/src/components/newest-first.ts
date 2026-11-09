import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How many items a conversation draws at first: about a screen's worth, so it shows at once. */
export const FIRST_ITEMS = 15;
/** A dashboard card shows only its newest messages. */
export const CARD_ITEMS = 6;
/** While the page is idle, a conversation goes on drawing older items up to this many, so scrolling up finds them there. */
const READY = 50;
/** How near its top (px) the reader asks for more. */
const OLDER_AT = 600;
/** How many older items are added at a time, so each batch fits in a frame on a phone. */
const BATCH = 20;

const whenIdle = (fn: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(fn, 50);
  return () => clearTimeout(t);
};

/**
 * A long conversation draws its newest items first, and the older ones as the
 * reader scrolls up to them: drawing them all at once holds a phone for seconds.
 * Returns how many items at the start aren't drawn, and the scroll handler that
 * draws more. New items only add at the end, and the reader stays where they
 * are as older ones are added above. `all` draws every item (Find searches the
 * whole conversation) a batch at a time, between which the page keeps answering
 * touches and keys; what it drew stays drawn afterwards. `key` names the
 * conversation: another one starts over. `first`: how many it draws at first;
 * with fewer than FIRST_ITEMS (a card) it doesn't draw more while idle.
 */
export function useNewestFirst(
  scrollRef: RefObject<HTMLElement | null>,
  key: string,
  total: number,
  all: boolean,
  first = FIRST_ITEMS,
): { hidden: number; onScroll: (el: HTMLElement) => void } {
  const [drawn, setDrawn] = useState(() => ({ key, start: Math.max(0, total - first) }));
  if (drawn.key !== key) setDrawn({ key, start: Math.max(0, total - first) });
  const hidden = Math.min(drawn.start, total);
  const card = first < FIRST_ITEMS;
  // Where the reader was as older items were added above, to keep them there.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const older = (count: number) => {
    const el = scrollRef.current;
    if (el && !anchor.current) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setDrawn((d) => ({ ...d, start: Math.max(0, d.start - count) }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.top + el.scrollHeight - a.height;
    // Too few to scroll, so no scroll would ever ask for more: add them now. A card only fills its own height.
    else if (el && hidden > 0 && el.scrollHeight <= el.clientHeight + (card ? 0 : OLDER_AT)) older(card ? CARD_ITEMS : BATCH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);
  // `all`: the next batch once this one is on the screen. Otherwise, more while the page has nothing else to do.
  const prefetch = !card && total - hidden < READY;
  useEffect(() => {
    if (hidden === 0) return;
    if (all) {
      const t = setTimeout(() => older(BATCH), 0);
      return () => clearTimeout(t);
    }
    if (prefetch) return whenIdle(() => older(BATCH));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hidden, prefetch]);
  // `all` is drawing them already, a batch a frame.
  const onScroll = (el: HTMLElement) => {
    if (all || hidden === 0 || el.scrollTop > OLDER_AT || anchor.current) return;
    older(BATCH);
  };
  return { hidden, onScroll };
}
