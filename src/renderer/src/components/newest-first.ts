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

/** Where the reader was in a conversation: the first item drawn, the scroll offset from it, and whether at the end. */
export interface Place {
  chat: string;
  start: number;
  top: number;
  atEnd: boolean;
}

/** A conversation shown as its page loads, this soon, is the page coming back (a phone reconnecting, the app relaunched), not one the reader opened. */
const RESTORE_WITHIN_MS = 10_000;
const placeKey = (): string => `looper.place.${new URLSearchParams(location.search).get('w') ?? location.hash}`;

/** Where the reader left `chat` in this window, when its page is coming back; null for a conversation opened anew. */
export function readPlace(chat: string): Place | null {
  if (performance.now() > RESTORE_WITHIN_MS) return null;
  try {
    const p = JSON.parse(localStorage.getItem(placeKey()) ?? 'null') as Place | null;
    return p && p.chat === chat && Number.isFinite(p.start) && Number.isFinite(p.top) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Keeps where the reader is in `chat`, so the page loading again (a phone back from another app) puts them there,
 * and forgets it when they leave the conversation, so opening it again starts at its end. Items are only ever added
 * after the first one drawn, so that item and the offset from it find the same place.
 */
export function useKeepPlace(scrollRef: RefObject<HTMLElement | null>, chat: string, start: number, atEnd: RefObject<boolean>, off: boolean): (el: HTMLElement) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useRef({ chat, start });
  now.current = { chat, start };
  const save = () => {
    const el = scrollRef.current;
    if (off || !el) return;
    try {
      localStorage.setItem(placeKey(), JSON.stringify({ ...now.current, top: Math.round(el.scrollTop), atEnd: !!atEnd.current } satisfies Place));
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
    ro.observe(el);
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
 * `startAt`: the first item to draw instead, where a reader's place was kept.
 */
export function useNewestFirst(
  scrollRef: RefObject<HTMLElement | null>,
  key: string,
  total: number,
  all: boolean,
  first = FIRST_ITEMS,
  startAt?: number,
): { hidden: number; onScroll: (el: HTMLElement) => void } {
  const [drawn, setDrawn] = useState(() => ({ key, start: startAt !== undefined ? Math.max(0, Math.min(startAt, total)) : Math.max(0, total - first) }));
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
