import { useEffect, useRef, useState, type ReactNode } from 'react';
import { platform } from '../../platform';
import { useSheetDrag } from '../../web/sheet-drag';
import { BarHostContext, NavBar, PanelNavContext, PanelPushedContext, usePanelNav, type BarHost } from '../NavBar';
import { draggedHeight, nextDetent, settleSheet, type Detent } from './sheet-detents';

/** Above this order, the sheet's part of the page's report wins over the page's own (its Back closes the sheet). */
const SHEET_ORDER = 90;

/**
 * A sheet from the bottom of a phone page (the Activity and Usage panels): a
 * grabber that drags it between its medium and large heights, or down to close,
 * and that a tap, or VoiceOver's and TalkBack's activation, moves to the other
 * height (HIG Sheets: "they can also tap it to cycle through the detents"), a
 * scrim that closes it, and its bar (NavBar: on iOS an xmark at the leading
 * edge). The NavBars of what it shows fill its bar: a pushed detail's Back
 * (which takes the xmark's place, HIG Sheets), title and subtitle. It's drawn in
 * the page; while it's up the frame lifts the page over its bar (PageNav's
 * `modal`), so the large detent reaches the status bar and the scrim dims the
 * frame's bar too.
 */
export function PhoneSheet({
  title,
  detent: initial = 'large',
  onClose,
  children,
}: {
  title: string;
  /** The height it opens at. */
  detent?: Detent;
  onClose: () => void;
  children: ReactNode;
}) {
  const [detent, setDetent] = useState<Detent>(initial);
  const [closing, setClosing] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const inner = usePanelNav();

  const close = () => {
    setClosing(true);
    // iOS's leaving spring (phone.css) is within a few pixels of its end by then.
    setTimeout(onClose, 300);
  };
  const host: BarHost = { presentation: platform === 'android' ? 'bottom-sheet' : 'page-sheet', close };
  // Esc, from a hardware keyboard.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    // The card is still below the screen as it rises: WebKit would scroll the page to show it.
    card.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The grabber cycles the heights. A tap on it ends the handle's drag as a tap; the click that may follow (the handle
  // holds the pointer, so where it lands differs by engine) is skipped, and a click alone is a keyboard's or a screen
  // reader's activation.
  const pressedGrabber = useRef(false);
  const cycledAt = useRef(0);
  const cycle = () => {
    cycledAt.current = Date.now();
    setDetent(nextDetent);
  };

  const page = () => card.current?.parentElement?.clientHeight ?? 800;
  // The room the large detent leaves above the sheet (phone.css, per platform and size).
  const gap = () => (card.current ? parseFloat(getComputedStyle(card.current).getPropertyValue('--sheet-gap')) || 0 : 0);
  // Up and down: between the detents, or down to close.
  const drag = useSheetDrag({
    twoWay: true,
    skip: 'button:not(.pg-sheet-grabber)',
    onMove: (dy) => {
      const el = card.current;
      if (!el) return;
      el.style.transition = dy === null ? '' : 'none';
      el.style.height = dy === null ? '' : `${draggedHeight(detent, dy, page(), gap())}px`;
    },
    onEnd: (r) => {
      if (!r) {
        if (pressedGrabber.current) cycle();
        return;
      }
      const to = settleSheet(detent, r.offset, r.speed, page());
      if (to === 'dismiss') close();
      else setDetent(to);
    },
  });

  const back = inner.nav?.back;
  return (
    <div className="pg-sheet-scrim" onClick={close}>
      {/* The frame: the page is lifted over its bar, and the system's Back (Android's, Safari's) leaves a pushed detail first. */}
      <NavBar modal back={back} order={SHEET_ORDER} />
      <div
        ref={card}
        className={`pg-sheet detent-${detent}${closing ? ' closing' : ''}`}
        data-detents="medium large"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="pg-sheet-handle"
          {...drag}
          onPointerDown={(e) => {
            pressedGrabber.current = !!(e.target as Element).closest('.pg-sheet-grabber');
            drag.onPointerDown(e);
          }}
        >
          <button
            type="button"
            className="pg-sheet-grabber"
            aria-label={platform === 'android' ? 'Drag handle' : 'Sheet Grabber'}
            aria-expanded={detent === 'large'}
            onClick={() => {
              if (Date.now() - cycledAt.current > 500) cycle();
            }}
          />
          <BarHostContext.Provider value={host}>
            <NavBar title={inner.nav?.title ?? title} subtitle={inner.nav?.subtitle} back={back} />
          </BarHostContext.Provider>
        </div>
        <div className="pg-sheet-body">
          <PanelNavContext.Provider value={inner.target}>
            <PanelPushedContext.Provider value={!!back}>{children}</PanelPushedContext.Provider>
          </PanelNavContext.Provider>
        </div>
      </div>
    </div>
  );
}
