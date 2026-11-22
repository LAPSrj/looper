import { useEffect, useRef, type RefObject } from 'react';

/**
 * A status bar tap scrolls a screen's list to its real top (web/status-bar-tap.ts). A scroller that draws its items in
 * parts, the older ones as the reader scrolls up to them (useNewestFirst), can't be taken there by moving it: each
 * batch of older items added above puts the reader back where they were, which ends the scroll, and a conversation
 * of a thousand rows is too long to draw to get to its first. So the scroll goes through what is drawn, and the
 * scroller then draws its first items itself. The shell and the page are separate documents, each with a copy of this
 * file, so they talk through events on the scroller.
 */

/** While a tap scrolls: `detail` true, the scroller adds no older items; false, it may again. */
const TOP_HOLD = 'looper-top-hold';
/** The scroll has reached the top of what is drawn: the scroller draws its first items, at its top, and cancels the event (preventDefault) when it does. */
const TOP_ARRIVED = 'looper-top-arrived';

/** How long a scroller must hold still (position and height) to have stopped. */
const STILL_MS = 250;
const POLL_MS = 40;
/** A scroll that goes on longer than this stops, so a scroller that never gets there doesn't hold the page. */
const MAX_MS = 10_000;

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Resolves once `el` has held still, in position and height, for STILL_MS, or (`atTop`) has reached its top. */
async function still(el: HTMLElement, cancelled: () => boolean, until: number, atTop: boolean): Promise<void> {
  let at = '';
  let since = performance.now();
  while (!cancelled() && performance.now() < until) {
    await wait(POLL_MS);
    if (atTop && el.scrollTop <= 1) return;
    const now = `${el.scrollTop}:${el.scrollHeight}`;
    if (now !== at) {
      at = now;
      since = performance.now();
    } else if (performance.now() - since >= STILL_MS) return;
  }
}

/**
 * Scrolls `el` to its real top with the system's own animation: through what is drawn, once more if something moved
 * it back (a scroller that loads older items while it scrolls), then the scroller draws its first items. `cancelled`
 * stops it, as a finger on the screen does. In `el`'s document the scroller must listen with useTopRequests.
 */
export async function scrollToTop(el: HTMLElement, cancelled: () => boolean = () => false): Promise<void> {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  const say = (type: string, detail?: boolean) => el.dispatchEvent(new win.CustomEvent(type, { detail, cancelable: true }));
  say(TOP_HOLD, true);
  try {
    const until = performance.now() + MAX_MS;
    while (!cancelled() && performance.now() < until) {
      if (el.scrollTop > 1) el.scrollTo({ top: 0, behavior: 'smooth' });
      await still(el, cancelled, until, true);
      if (cancelled() || el.scrollTop > 1) continue;
      // At the top of what is drawn: a scroller with more draws it now. Any other may still add items above, and moves the reader.
      if (!say(TOP_ARRIVED)) break;
      await still(el, cancelled, until, false);
      if (el.scrollTop <= 1) break;
    }
  } finally {
    say(TOP_HOLD, false);
  }
}

/**
 * For a scroller that draws its items in parts: `hold` says whether a status bar tap is scrolling it (add no older
 * items then), `arrived` that it has reached the top of what is drawn (draw the first items and put it at 0; true when it did).
 * The scroller can come and go, so it's checked after each render.
 */
export function useTopRequests(scrollRef: RefObject<HTMLElement | null>, requests: { hold: (on: boolean) => void; arrived: () => boolean }): void {
  const now = useRef(requests);
  now.current = requests;
  const watched = useRef<{ el: HTMLElement; stop: () => void } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (watched.current?.el === el) return;
    watched.current?.stop();
    watched.current = null;
    if (!el) return;
    const hold = (e: Event) => now.current.hold((e as CustomEvent<boolean>).detail);
    const arrived = (e: Event) => {
      if (now.current.arrived()) e.preventDefault();
    };
    el.addEventListener(TOP_HOLD, hold);
    el.addEventListener(TOP_ARRIVED, arrived);
    watched.current = {
      el,
      stop: () => {
        el.removeEventListener(TOP_HOLD, hold);
        el.removeEventListener(TOP_ARRIVED, arrived);
      },
    };
  });
  useEffect(
    () => () => {
      watched.current?.stop();
      watched.current = null;
    },
    [],
  );
}
