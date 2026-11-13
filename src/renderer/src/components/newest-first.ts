import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { firstDrawn, placeKey as keyOf, placeToRestore, type Place } from './kept-place';

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

const placeKey = (): string => keyOf(location.search, location.hash);

/** The page put its kept place back already: a later conversation is one the reader opened. */
let placeRead = false;

/** Where the reader left `chat` in this window, as its page loads again (placeToRestore); null for a conversation opened anew. */
export function readPlace(chat: string): Place | null {
  if (placeRead) return null;
  placeRead = true;
  try {
    return placeToRestore(chat, location.hash, localStorage.getItem(placeKey()));
  } catch {
    return null;
  }
}

/**
 * Keeps where the reader is in `chat`, so the page loading again (a phone back from another app) puts them there,
 * and forgets it when they leave the conversation, so opening it again starts at its end. `where` gives the item at
 * the top of the view and how far into it the view starts, so the page draws only from that item to come back.
 */
export function useKeepPlace(chat: string, where: () => Pick<Place, 'item' | 'offset'> | null, atEnd: RefObject<boolean>, off: boolean): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useRef({ chat, where });
  now.current = { chat, where };
  const save = () => {
    const at = off ? null : now.current.where();
    if (!at) return;
    try {
      localStorage.setItem(placeKey(), JSON.stringify({ chat: now.current.chat, ...at, atEnd: !!atEnd.current } satisfies Place));
    } catch {
      // Storage full or off: the page comes back at the end.
    }
  };
  useEffect(() => {
    if (off) return;
    const hidden = () => document.visibilityState === 'hidden' && save();
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      if (timer.current) clearTimeout(timer.current);
      try {
        if ((JSON.parse(localStorage.getItem(placeKey()) ?? 'null') as Place | null)?.chat === chat) localStorage.removeItem(placeKey());
      } catch {
        // Nothing kept.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, off]);
  return () => {
    if (off || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      save();
    }, 250);
  };
}

/** How long after a tap or key in the conversation a change of size is the reader's own (a tool call opened). */
const OWN_CHANGE_MS = 500;

/**
 * Keeps a reader who is at the end there while anything changes size: a reply growing as it streams, an image or
 * a highlighted block drawn late, the keyboard or the message box taking room. What the reader opens themselves
 * stays where they opened it. `atEnd` is the conversation's own flag, which its scroll handler keeps.
 */
export function useStayAtEnd(scrollRef: RefObject<HTMLElement | null>, atEnd: RefObject<boolean>): void {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let input = -Infinity;
    const own = () => {
      input = performance.now();
    };
    const ro = new ResizeObserver(() => {
      if (performance.now() - input < OWN_CHANGE_MS) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      else if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    // The border box: on iOS the message box sets the scroller's padding from a ResizeObserver of its own, which
    // keeps the reader at the end itself, and a content box seen here would be a loop the browser reports as an error.
    ro.observe(el, { box: 'border-box' });
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof Element) ro.observe(n);
        for (const n of r.removedNodes) if (n instanceof Element) ro.unobserve(n);
      }
    });
    mo.observe(el, { childList: true });
    el.addEventListener('pointerdown', own);
    el.addEventListener('keydown', own);
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('pointerdown', own);
      el.removeEventListener('keydown', own);
    };
  }, [scrollRef, atEnd]);
}

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
 * `startAt`: the item to draw from instead, where a reader's place was kept. Only `first` items are drawn from it,
 * and the newer ones below are added as the reader scrolls down to them; `newer` counts those not drawn yet.
 */
export function useNewestFirst(
  scrollRef: RefObject<HTMLElement | null>,
  key: string,
  total: number,
  all: boolean,
  first = FIRST_ITEMS,
  startAt?: number,
): { hidden: number; newer: number; onScroll: (el: HTMLElement) => void; toEnd: () => void } {
  const [drawn, setDrawn] = useState(() => ({ key, ...firstDrawn(total, first, startAt) }));
  if (drawn.key !== key) setDrawn({ key, ...firstDrawn(total, first) });
  // Once the newest item is drawn, what arrives after it is drawn too.
  else if (drawn.end !== null && drawn.end >= total) setDrawn({ ...drawn, end: null });
  const hidden = Math.min(drawn.start, total);
  const newer = drawn.end === null ? 0 : Math.max(0, total - drawn.end);
  const card = first < FIRST_ITEMS;
  // Where the reader was as older items were added above, to keep them there.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // Newer items are being added: older ones wait, or the anchor would count their height too.
  const addingNewer = useRef(false);
  const older = (count: number) => {
    const el = scrollRef.current;
    if (anchor.current || addingNewer.current) return;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setDrawn((d) => ({ ...d, start: Math.max(0, d.start - count) }));
  };
  const drawNewer = (count: number) => {
    if (anchor.current || addingNewer.current) return;
    addingNewer.current = true;
    setDrawn((d) => ({ ...d, end: d.end === null ? null : d.end + count }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    anchor.current = null;
    addingNewer.current = false;
    if (el && a) el.scrollTop = a.top + el.scrollHeight - a.height;
    // Too few to scroll, so no scroll would ever ask for more: add them now. A card only fills its own height.
    else if (el && el.scrollHeight <= el.clientHeight + (card ? 0 : OLDER_AT)) {
      if (newer > 0) drawNewer(BATCH);
      else if (hidden > 0) older(card ? CARD_ITEMS : BATCH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, drawn.end]);
  // `all`: the next batch once this one is on the screen. Otherwise, older ones while the page has nothing else to do.
  const prefetch = !card && total - newer - hidden < READY;
  useEffect(() => {
    if (all) {
      if (hidden === 0 && newer === 0) return;
      const t = setTimeout(() => (hidden > 0 ? older(BATCH) : drawNewer(BATCH)), 0);
      return () => clearTimeout(t);
    }
    if (hidden > 0 && prefetch) return whenIdle(() => older(BATCH));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hidden, newer, prefetch]);
  // `all` is drawing them already, a batch a frame.
  const onScroll = (el: HTMLElement) => {
    if (all) return;
    if (hidden > 0 && el.scrollTop <= OLDER_AT) older(BATCH);
    else if (newer > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= OLDER_AT) drawNewer(BATCH);
  };
  // Draws the newest items as a conversation opened anew does, without drawing everything between.
  const toEnd = () => setDrawn((d) => ({ ...d, ...firstDrawn(total, first) }));
  return { hidden, newer, onScroll, toEnd };
}
