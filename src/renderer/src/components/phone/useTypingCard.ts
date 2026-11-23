import { useLayoutEffect } from 'react';
import { atEnd } from '../newest-first';
import { typingCardFit } from './typing-card';

/** What a card's conversation showed before the keyboard came: its end, or a place in it. */
type Place = { end: true } | { end: false; scrollTop: number };

/**
 * A phone's Overview (`overview`, inside the page's scroller `scroller`): while the on-screen keyboard is up
 * (html.keyboard-up, from the visual viewport: components/phone/keyboard.ts) and the focus is in a card, the card fits
 * what shows above the keyboard (typingCardFit), its newest messages in view. When the keyboard goes, or the focus
 * leaves the card, the card takes its own height again and the page and the conversation go back to where they were.
 * The bar stays: the frame draws it, outside this page.
 */
export function useTypingCard(overview: HTMLElement | null, scroller: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!overview || !scroller) return;
    const doc = overview.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    // The keyboard shrinks the top frame's visual viewport, not this iframe's (keyboard.ts).
    let top: Window = win;
    try {
      top = win.top ?? win;
      void top.document;
    } catch {
      top = win;
    }
    const vv = top.visualViewport;
    const visibleBottom = (): number => {
      const own = scroller.getBoundingClientRect().bottom;
      if (!vv) return own;
      const frame = win.frameElement as HTMLElement | null;
      const offset = frame ? frame.getBoundingClientRect().top : 0;
      return Math.min(own, vv.offsetTop + vv.height - offset);
    };
    const conversation = (card: HTMLElement) => card.querySelector<HTMLElement>('.chat-scroll, .overview-messages');
    const placeOf = (el: HTMLElement | null): Place | null => (el ? (atEnd(el) ? { end: true } : { end: false, scrollTop: el.scrollTop }) : null);
    const putBack = (el: HTMLElement | null, place: Place | null) => {
      if (el && place) el.scrollTop = place.end ? el.scrollHeight : place.scrollTop;
    };
    // Where the page and the card's conversation were when the focus came into a card, before WebKit scrolls to show the field.
    let before: { card: HTMLElement; scrollTop: number; place: Place | null } | null = null;
    let typing: { card: HTMLElement; scrollTop: number; place: Place | null } | null = null;
    // After the keyboard goes, the page grows back over a few frames: the place is put back as it does.
    let restore: { card: HTMLElement; scrollTop: number; place: Place | null; until: number } | null = null;
    const leave = () => {
      if (!typing) return;
      const t = typing;
      typing = null;
      t.card.style.height = '';
      t.card.style.marginBottom = '';
      restore = { ...t, until: performance.now() + 1000 };
      scroller.scrollTop = t.scrollTop;
      putBack(conversation(t.card), t.place);
    };
    const update = () => {
      const active = doc.activeElement as HTMLElement | null;
      const up = doc.documentElement.classList.contains('keyboard-up');
      const card = up && active && active !== doc.body && overview.contains(active) ? active.closest<HTMLElement>('.overview-card') : null;
      if (typing && typing.card !== card) leave();
      if (!card) {
        if (restore && performance.now() < restore.until && restore.card.isConnected) {
          scroller.scrollTop = restore.scrollTop;
          putBack(conversation(restore.card), restore.place);
        } else restore = null;
        return;
      }
      const entering = !typing;
      if (!typing) {
        const was = before?.card === card ? before : { card, scrollTop: scroller.scrollTop, place: placeOf(conversation(card)) };
        typing = { card, scrollTop: was.scrollTop, place: was.place };
        restore = null;
      }
      const s = scroller.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      // On iOS the scroller runs under the frame's bar, which its scroll-padding-top keeps clear (phone.css).
      const underBar = parseFloat(win.getComputedStyle(scroller).scrollPaddingTop) || 0;
      const fit = typingCardFit({ top: s.top + underBar, bottom: visibleBottom(), cardTop: r.top, cardHeight: r.height, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight });
      card.style.height = `${fit.height}px`;
      card.style.marginBottom = fit.extra ? `${fit.extra}px` : '';
      scroller.scrollTop = fit.scrollTop;
      // The newest messages show above the message box; from then on the conversation keeps its end as it does (useStayAtEnd).
      if (entering) {
        const c = conversation(card);
        if (c) c.scrollTop = c.scrollHeight;
      }
    };
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const focusIn = (e: FocusEvent) => {
      const card = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.overview-card');
      if (card && overview.contains(card) && !typing) before = { card, scrollTop: scroller.scrollTop, place: placeOf(conversation(card)) };
      schedule();
    };
    doc.addEventListener('focusin', focusIn, true);
    doc.addEventListener('focusout', schedule, true);
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    win.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    return () => {
      doc.removeEventListener('focusin', focusIn, true);
      doc.removeEventListener('focusout', schedule, true);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      win.removeEventListener('resize', schedule);
      ro.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      if (typing) {
        typing.card.style.height = '';
        typing.card.style.marginBottom = '';
      }
    };
  }, [overview, scroller]);
}
