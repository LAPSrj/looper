/**
 * iOS: a tap on the status bar scrolls the screen's list to its top, as in every iOS app.
 *
 * WebKit leaves the tap to UIKit's scroll-to-top, which only moves WKWebView's own scroll view: the top document's
 * (WKWebViewIOS.mm implements scrollViewDidScrollToTop: and not scrollViewShouldScrollToTop:), and every overflow and
 * frame scroller has it turned off (ScrollingTreeScrollingNodeDelegateIOS.mm: `scrollsToTop = NO`). The shell's
 * document doesn't scroll, so it keeps 1 px to scroll (web/phone.css, html.ph-status-tap), parked 1 px down. The tap
 * scrolls it back to 0; a scroll there with no finger on the screen is the tap, and the shell scrolls the screen's
 * main scroller. A smooth scrollTo on an overflow scroller is UIKit's own animation
 * (ScrollingTreeScrollingNodeDelegateIOS::startAnimatedScrollToPosition: `setContentOffset:animated:YES`).
 *
 * A list that draws its items in parts (a conversation's older messages) is taken to its real top by scrollToTop
 * (components/scroll-top.ts), not stopped partway where the older items it loaded put the reader back.
 */
import { scrollToTop } from '../components/scroll-top';
import { AFTER_TOUCH_MS, PARKED, statusBarTapped } from './status-tap';

/** The scroller a status bar tap moves in `doc`: the one that scrolls up and down and shows the most of itself. */
export function mainScroller(doc: Document): HTMLElement | null {
  const win = doc.defaultView;
  if (!win) return null;
  let best: { el: HTMLElement; area: number } | null = null;
  for (const el of doc.querySelectorAll<HTMLElement>('*')) {
    if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(win.getComputedStyle(el).overflowY)) continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
    // One already at its top wins only when nothing else has moved.
    const score = area * (el.scrollTop > 0 ? 2 : 1);
    if (area > 0 && (!best || score > best.area)) best = { el, area: score };
  }
  return best?.el ?? null;
}

/** Watches for the status bar's tap in the top document `doc`; `target` gives the document whose list it scrolls. */
export function installStatusBarTap(doc: Document, target: () => Document | null | undefined): () => void {
  const win = doc.defaultView!;
  doc.documentElement.classList.add('ph-status-tap');
  let fingers = 0;
  let touchedAt = -Infinity;
  const touched = (e: TouchEvent) => {
    fingers = e.touches.length;
    touchedAt = performance.now();
  };
  // The windows' pages get their own touches: each one's document is watched as it loads.
  const watched = new WeakSet<Document>();
  const watch = (d: Document | null | undefined) => {
    if (!d || watched.has(d)) return;
    watched.add(d);
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) d.addEventListener(type, touched, { capture: true, passive: true });
  };
  watch(doc);
  // A sandboxed frame (a page Preview shows) has an origin of its own: reading its document only gets null and an error in the console.
  const docOf = (f: HTMLIFrameElement) => (f.hasAttribute('sandbox') ? null : f.contentDocument);
  const watchFrames = () => doc.querySelectorAll('iframe').forEach((f) => watch(docOf(f)));
  watchFrames();
  const onLoad = (e: Event) => e.target instanceof HTMLIFrameElement && watch(docOf(e.target));
  doc.addEventListener('load', onLoad, true);
  let scrolling = false;
  let parkTimer: ReturnType<typeof setTimeout> | undefined;
  const park = () => {
    if (win.scrollY !== PARKED) win.scrollTo(0, PARKED);
  };
  const parkSoon = (ms: number) => {
    clearTimeout(parkTimer);
    parkTimer = setTimeout(park, ms);
  };
  let resizedAt = -Infinity;
  const onScroll = () => {
    if (win.scrollY >= PARKED) return;
    watchFrames();
    const now = performance.now();
    if (!statusBarTapped({ scrollY: win.scrollY, fingers, sinceTouch: now - touchedAt, sinceResize: now - resizedAt })) return parkSoon(AFTER_TOUCH_MS);
    const d = target();
    const el = d ? mainScroller(d) : null;
    if (el && !scrolling) {
      // A finger on the screen after the tap takes over from it.
      const tappedAt = performance.now();
      scrolling = true;
      void scrollToTop(el, () => touchedAt > tappedAt).finally(() => (scrolling = false));
    }
    // After UIKit's own scroll of the 1 px has ended.
    parkSoon(400);
  };
  park();
  win.addEventListener('scroll', onScroll, { passive: true });
  // Rotating or the keyboard can scroll the document back: parked again, and not taken for a tap.
  const resized = () => {
    resizedAt = performance.now();
    parkSoon(300);
  };
  win.addEventListener('resize', resized);
  win.visualViewport?.addEventListener('resize', resized);
  return () => {
    clearTimeout(parkTimer);
    win.removeEventListener('scroll', onScroll);
    win.removeEventListener('resize', resized);
    win.visualViewport?.removeEventListener('resize', resized);
    doc.removeEventListener('load', onLoad, true);
    doc.documentElement.classList.remove('ph-status-tap');
  };
}
