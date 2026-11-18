import { useEffect, useRef, useState, type ReactNode } from 'react';
import { platform } from '../../platform';
import { useSheetDrag } from '../../web/sheet-drag';
import { BarHostContext, NavBar, type BarHost } from '../NavBar';
import { DETENT_HEIGHT, draggedHeight, settleSheet, type Detent } from './sheet-detents';

/**
 * A sheet from the bottom of a phone page (the Activity and Usage panels): a
 * grabber that drags it between its medium and large heights, or down to close,
 * a scrim that closes it, and its bar (NavBar: on iOS an xmark at the leading
 * edge). It's drawn in the page, so the frame's bar stays above it.
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

  const page = () => card.current?.parentElement?.clientHeight ?? 800;
  // Up and down: between the detents, or down to close.
  const drag = useSheetDrag({
    twoWay: true,
    skip: 'button',
    onMove: (dy) => {
      const el = card.current;
      if (!el) return;
      el.style.transition = dy === null ? '' : 'none';
      el.style.height = dy === null ? '' : `${draggedHeight(detent, dy, page())}px`;
    },
    onEnd: (r) => {
      if (!r) return;
      const to = settleSheet(detent, r.offset, r.speed, page());
      if (to === 'dismiss') close();
      else setDetent(to);
    },
  });

  return (
    <div className="pg-sheet-scrim" onClick={close}>
      <div
        ref={card}
        className={`pg-sheet detent-${detent}${closing ? ' closing' : ''}`}
        style={{ '--detent': DETENT_HEIGHT[detent] } as React.CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pg-sheet-handle" {...drag}>
          <div className="pg-sheet-grabber" aria-hidden="true" />
          <BarHostContext.Provider value={host}>
            <NavBar title={title} />
          </BarHostContext.Provider>
        </div>
        <div className="pg-sheet-body">{children}</div>
      </div>
    </div>
  );
}
