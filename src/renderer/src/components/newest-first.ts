import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How many items a conversation draws at first, and how near its top (px) the reader asks for more. */
const PAGE = 50;
const OLDER_AT = 600;
/** How many older items are added at a time, so each batch fits in a frame on a phone. */
const BATCH = 20;

/**
 * A long conversation draws its newest items first, and the older ones as the
 * reader scrolls up to them: drawing them all at once holds a phone for seconds.
 * Returns how many items at the start aren't drawn, and the scroll handler that
 * draws more. New items only add at the end, and the reader stays where they
 * are as older ones are added above. `all` draws every item (Find searches the
 * whole conversation) a batch at a time, between which the page keeps answering
 * touches and keys; what it drew stays drawn afterwards. `key` names the
 * conversation: another one starts over.
 */
export function useNewestFirst(scrollRef: RefObject<HTMLElement | null>, key: string, total: number, all: boolean): { hidden: number; onScroll: (el: HTMLElement) => void } {
  const [drawn, setDrawn] = useState(() => ({ key, start: Math.max(0, total - PAGE) }));
  if (drawn.key !== key) setDrawn({ key, start: Math.max(0, total - PAGE) });
  const hidden = Math.min(drawn.start, total);
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
    // Too few to scroll, so no scroll would ever ask for more: add them now.
    else if (el && hidden > 0 && el.scrollHeight <= el.clientHeight + OLDER_AT) older(BATCH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);
  // The next batch once this one is on the screen.
  useEffect(() => {
    if (!all || hidden === 0) return;
    const t = setTimeout(() => older(BATCH), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hidden]);
  // `all` is drawing them already, a batch a frame.
  const onScroll = (el: HTMLElement) => {
    if (all || hidden === 0 || el.scrollTop > OLDER_AT || anchor.current) return;
    older(BATCH);
  };
  return { hidden, onScroll };
}
