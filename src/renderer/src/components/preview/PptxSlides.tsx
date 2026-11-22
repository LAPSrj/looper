import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PptxPresentation } from '@silurus/ooxml/pptx';
import { FILL, NOTE } from './note';

const GAP = 12;

/**
 * WebKit handed each slide's canvas a later slide's bitmap from the worker (iOS: the canvases showed slides
 * 1, 3, 4, …), so there the deck is read and drawn on the page, straight into each canvas.
 */
const ON_PAGE = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent);

/** Each deck's slides are drawn one at a time, in the order they were asked for. */
const turns = new WeakMap<PptxPresentation, Promise<unknown>>();
function inTurn<T>(deck: PptxPresentation, job: () => Promise<T>): Promise<T> {
  const next = (turns.get(deck) ?? Promise.resolve()).then(job, job);
  turns.set(deck, next.catch(() => undefined));
  return next;
}

/**
 * A PowerPoint deck's slides one under another, fit to the width, as @silurus/ooxml draws them. The deck is
 * read and each slide drawn in a worker (`mode: 'worker'`), so a big deck doesn't hold the thread every
 * window shares; a slide is drawn while it's near the screen and gives its pixels back when it's far.
 */
export default function PptxSlides({ data, name }: { data: ArrayBuffer; name: string }) {
  const [deck, setDeck] = useState<PptxPresentation | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let opened: PptxPresentation | null = null;
    setDeck(null);
    setError('');
    PptxPresentation.load(data.slice(0), { mode: ON_PAGE ? 'main' : 'worker' }).then(
      (d) => {
        opened = d;
        if (live) setDeck(d);
        else d.destroy();
      },
      (err: unknown) => live && setError(`${name} can’t be shown. ${err instanceof Error ? err.message : ''}`.trim()),
    );
    return () => {
      live = false;
      opened?.destroy();
    };
  }, [data, name]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [deck]);

  if (error) return <div style={NOTE}>{error}</div>;
  if (!deck) return <div style={NOTE}>Loading…</div>;
  const slideWidth = Math.max(0, width - GAP * 2);
  const aspect = deck.slideHeight / deck.slideWidth;
  return (
    <div ref={scroller} className="preview-slides" role="document" aria-label={name} style={{ ...FILL, overflow: 'auto', alignItems: 'center', gap: GAP, padding: `${GAP}px ${GAP}px calc(${GAP}px + var(--viewer-end, 0px))`, boxSizing: 'border-box', background: 'rgba(118, 118, 128, 0.12)' }}>
      {slideWidth > 0 && Array.from({ length: deck.slideCount }, (_, i) => <Slide key={i} deck={deck} index={i} width={slideWidth} height={Math.round(slideWidth * aspect)} root={scroller} />)}
    </div>
  );
}

function Slide({ deck, index, width, height, root }: { deck: PptxPresentation; index: number; width: number; height: number; root: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !root.current) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: '100% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    if (!near) {
      el.width = el.height = 0;
      return;
    }
    let live = true;
    // Drawn once the size has settled, so dragging the window's edge doesn't draw every step.
    const timer = setTimeout(() => {
      if (ON_PAGE) {
        void inTurn(deck, () => (live ? deck.renderSlide(el, index, { width, dpr: window.devicePixelRatio || 1 }) : Promise.resolve())).catch(() => undefined);
        return;
      }
      inTurn(deck, () => (live ? deck.renderSlideToBitmap(index, { width, dpr: window.devicePixelRatio || 1 }) : Promise.resolve(null))).then(
        (bmp) => {
          if (!bmp) return;
          if (!live) return bmp.close();
          el.width = bmp.width;
          el.height = bmp.height;
          // A 2D context, not 'bitmaprenderer': WebKit showed one slide's bitmap on another's canvas with it.
          el.getContext('2d')?.drawImage(bmp, 0, 0);
          bmp.close();
        },
        () => undefined,
      );
    }, 60);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deck, index, width, near]);
  return <canvas ref={canvas} className="preview-slide" aria-label={`Slide ${index + 1}`} style={{ width, height, flex: 'none', display: 'block', background: '#fff', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)' }} />;
}
