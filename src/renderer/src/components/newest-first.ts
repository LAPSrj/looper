import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { platform } from '../platform';
import { BatchPlace, firstDrawn, nextDrawn, placeKey as keyOf, placeToRestore, type Drawn, type Place } from './kept-place';
import { useTopRequests } from './scroll-top';

/** How many items a conversation draws at first: about a screen's worth, so it shows at once. */
export const FIRST_ITEMS = 15;
/** A dashboard card shows only its newest messages. */
export const CARD_ITEMS = 6;
/**
 * While the page is idle, a conversation goes on drawing older items until READY_SCREENS of its view's height are
 * drawn above what it shows, and at most READY items, so scrolling up finds them there. Drawing READY items whatever
 * their height drew 13 screens of a phone's long chat above the one shown: a third of its page's elements.
 */
const READY = 50;
const READY_SCREENS = 2;
/** How near its top (px) the reader asks for more. */
const OLDER_AT = 600;
/** How many older items are added at a time, so each batch fits in a frame on a phone. */
const BATCH = 20;
/** How long a batch waits for what `prepare` fetches (its thumbnails): past it, it's drawn without them. */
const PREPARE_MS = 1000;

const whenIdle = (fn: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(fn, 50);
  return () => clearTimeout(t);
};

const placeKey = (): string => keyOf(location.search, location.hash);

/** The scroller shows its end, give or take `slack` px. */
export const atEnd = (el: HTMLElement, slack = 40): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < slack;

/** Fingers on the screen, for BatchPlace: on iOS a scroll held under a finger hasn't ended. */
let fingers = 0;
const fingersOn = new WeakSet<Document>();
function countFingers(doc: Document): void {
  if (fingersOn.has(doc)) return;
  fingersOn.add(doc);
  const count = (e: TouchEvent) => {
    fingers = e.touches.length;
  };
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) doc.addEventListener(type, count, { capture: true, passive: true });
}

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
 * Keeps a reader who is at the end of a scroller there: as new content comes (`endKey` changes), and while anything
 * changes size: a reply growing as it streams, an image or a highlighted block drawn late, the keyboard or the message
 * box taking room. What the reader opens themselves stays where they opened it. `stays` is the scroller's own
 * at-the-end flag, which its scroll handler keeps (atEnd). `on`: false while it follows nothing (a table with its Auto
 * Scroll off). The scroller can come and go, as an output shown and hidden does.
 */
export function useStayAtEnd(scrollRef: RefObject<HTMLElement | null>, stays: RefObject<boolean>, endKey: unknown, on = true): void {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (on && el && stays.current) el.scrollTop = el.scrollHeight;
  }, [scrollRef, stays, endKey, on]);
  // The scroller there now, checked after each render.
  const watched = useRef<{ el: HTMLElement; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    const el = on ? scrollRef.current : null;
    if (watched.current?.el === el) return;
    watched.current?.stop();
    watched.current = el ? { el, stop: followSize(el, stays) } : null;
  });
  useLayoutEffect(
    () => () => {
      watched.current?.stop();
      watched.current = null;
    },
    [],
  );
}

/** Scrolls `el` to its end while `stays` as anything in it changes size; returns what stops it. */
function followSize(el: HTMLElement, stays: RefObject<boolean>): () => void {
  let input = -Infinity;
  const own = () => {
    input = performance.now();
  };
  const ro = new ResizeObserver(() => {
    if (performance.now() - input < OWN_CHANGE_MS) stays.current = atEnd(el);
    else if (stays.current) el.scrollTop = el.scrollHeight;
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
 * `lead`: how many items come ahead of the conversation's last part (a chat's history, read in after it opened):
 * items added there don't draw, and the drawn ones stay drawn (nextDrawn).
 * A status bar tap (scroll-top.ts) scrolls through what's drawn without adding older items, then draws the first
 * ones, at the top, and the newer ones as the reader scrolls down.
 * `prepare(from, to)`: what older items [from, to) need before they're drawn (their thumbnails, so they're drawn at
 * their size and don't grow above the reader); null when nothing.
 */
export function useNewestFirst(
  scrollRef: RefObject<HTMLElement | null>,
  key: string,
  total: number,
  all: boolean,
  first = FIRST_ITEMS,
  startAt?: number,
  lead = 0,
  prepare?: (from: number, to: number) => Promise<void> | null,
): { hidden: number; newer: number; onScroll: (el: HTMLElement) => void; toEnd: () => void } {
  const [drawn, setDrawn] = useState<Drawn>(() => ({ key, lead, empty: total === 0, ...firstDrawn(total, first, startAt) }));
  const next = nextDrawn(drawn, key, total, lead, first, startAt);
  if (next !== drawn) setDrawn(next);
  const hidden = Math.min(drawn.start, total);
  const newer = drawn.end === null ? 0 : Math.max(0, total - drawn.end);
  const card = first < FIRST_ITEMS;
  // Older items are being added: the reader's place is kept while they are (BatchPlace).
  const asking = useRef(false);
  const place = useRef<BatchPlace | null>(null);
  place.current ??= new BatchPlace({
    shiftWhileScrolling: platform === 'ios',
    fingers: () => fingers,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    frame: (fn) => requestAnimationFrame(fn),
  });
  const keeper = place.current;
  // Newer items are being added: older ones wait, so one batch is drawn at a time.
  const addingNewer = useRef(false);
  // A status bar tap is scrolling to the top (older items wait), or has asked for the first items and the scroller is to go to 0 with them.
  const toTop = useRef(false);
  const jump = useRef(false);
  const latest = useRef({ key, hidden });
  latest.current = { key, hidden };
  const older = (count: number) => {
    if (asking.current || addingNewer.current || toTop.current || jump.current) return;
    asking.current = true;
    const draw = () => {
      const el = scrollRef.current;
      if (el) {
        if (platform === 'ios') countFingers(el.ownerDocument);
        keeper.before(el);
      }
      setDrawn((d) => ({ ...d, start: Math.max(0, d.start - count) }));
    };
    const wait = prepare?.(Math.max(0, hidden - count), hidden);
    if (!wait) return draw();
    void Promise.race([wait, new Promise((done) => setTimeout(done, PREPARE_MS))]).then(() => {
      // Another conversation, or this one drawn otherwise meanwhile (from its end, a status bar tap): not this batch.
      if (latest.current.key !== key || latest.current.hidden !== hidden || toTop.current || jump.current) {
        if (latest.current.hidden === hidden) asking.current = false;
        return;
      }
      draw();
    });
  };
  const drawNewer = (count: number) => {
    if (asking.current || addingNewer.current) return;
    addingNewer.current = true;
    setDrawn((d) => ({ ...d, end: d.end === null ? null : d.end + count }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const asked = asking.current;
    asking.current = false;
    addingNewer.current = false;
    const jumped = jump.current;
    jump.current = false;
    if (el && jumped) {
      keeper.drop(el);
      el.scrollTop = 0;
    } else if (el) keeper.drawn(el);
    // Too few to scroll, so no scroll would ever ask for more: add them now. A card only fills its own height.
    if (el && (!asked || jumped) && el.scrollHeight <= el.clientHeight + (card ? 0 : OLDER_AT)) {
      if (newer > 0) drawNewer(BATCH);
      else if (hidden > 0) older(card ? CARD_ITEMS : BATCH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, drawn.end]);
  useEffect(() => () => keeper.drop(null), [keeper]);
  useTopRequests(scrollRef, {
    hold: (on) => {
      toTop.current = on;
    },
    arrived: () => {
      if (hidden === 0) return false;
      jump.current = true;
      setDrawn((d) => ({ ...d, ...firstDrawn(total, first, 0) }));
      return true;
    },
  });
  // `all`: the next batch once this one is on the screen. Otherwise, older ones while the page has nothing else to do.
  const prefetch = !card && total - newer - hidden < READY;
  // The next idle batch, while one waits: older items until READY_SCREENS of them are above the view.
  const idle = useRef<(() => void) | null>(null);
  const topUp = () => {
    if (idle.current) return;
    idle.current = whenIdle(() => {
      idle.current = null;
      const el = scrollRef.current;
      if (el && el.scrollTop < READY_SCREENS * el.clientHeight) older(BATCH);
    });
  };
  useEffect(() => {
    if (all) {
      if (hidden === 0 && newer === 0) return;
      const t = setTimeout(() => (hidden > 0 ? older(BATCH) : drawNewer(BATCH)), 0);
      return () => clearTimeout(t);
    }
    if (hidden > 0 && prefetch) topUp();
    return () => {
      idle.current?.();
      idle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, hidden, newer, prefetch]);
  // `all` is drawing them already, a batch a frame. A reader scrolling up into what's drawn above gets more while idle.
  const onScroll = (el: HTMLElement) => {
    keeper.scrolled();
    if (all) return;
    if (hidden > 0 && el.scrollTop <= OLDER_AT) older(BATCH);
    else if (newer > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= OLDER_AT) drawNewer(BATCH);
    else if (hidden > 0 && prefetch && el.scrollTop < READY_SCREENS * el.clientHeight) topUp();
  };
  // Draws the newest items as a conversation opened anew does, without drawing everything between.
  const toEnd = () => setDrawn((d) => ({ ...d, ...firstDrawn(total, first) }));
  return { hidden, newer, onScroll, toEnd };
}
