import { useEffect, useRef, useState, type ReactNode } from 'react';
import { platform } from '../../platform';
import { DETENT_HEIGHT, draggedHeight, settleSheet, type Detent } from './sheet-detents';

const XMARK = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 10 10M14 4 4 14" />
  </svg>
);

/**
 * A sheet from the bottom of a phone page (the Activity and Usage panels): a
 * grabber that drags it between its medium and large heights, or down to close,
 * a scrim that closes it, and on iOS an xmark at the leading edge. It's drawn in
 * the page, so the frame's bar stays above it.
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
  const drag = useRef<{ y0: number; y: number; t: number; v: number } | null>(null);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 180);
  };
  // Esc, from a hardware keyboard.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const page = () => card.current?.parentElement?.clientHeight ?? 800;
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return;
    drag.current = { y0: e.clientY, y: e.clientY, t: e.timeStamp, v: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = card.current;
    if (!d || !el) return;
    const dt = e.timeStamp - d.t;
    if (dt > 0) d.v = (e.clientY - d.y) / dt;
    d.y = e.clientY;
    d.t = e.timeStamp;
    el.style.transition = 'none';
    el.style.height = `${draggedHeight(detent, e.clientY - d.y0, page())}px`;
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const el = card.current;
    if (!d || !el) return;
    el.style.transition = '';
    el.style.height = '';
    const to = settleSheet(detent, e.clientY - d.y0, d.v, page());
    if (to === 'dismiss') close();
    else setDetent(to);
  };

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
        <div
          className="pg-sheet-handle"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            drag.current = null;
            if (card.current) {
              card.current.style.transition = '';
              card.current.style.height = '';
            }
          }}
        >
          <div className="pg-sheet-grabber" aria-hidden="true" />
          <div className="pg-sheet-head">
            {platform === 'ios' && (
              <button className="pg-sheet-close" aria-label="Close" onClick={close}>
                {XMARK}
              </button>
            )}
            <span className="pg-sheet-title">{title}</span>
            {platform === 'ios' && <span className="pg-sheet-close pg-sheet-spacer" aria-hidden="true" />}
          </div>
        </div>
        <div className="pg-sheet-body">{children}</div>
      </div>
    </div>
  );
}
