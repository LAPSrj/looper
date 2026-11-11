import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_ZOOM = 4;
const TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 12;
const GAP = 12;
/** iOS refuses a canvas bigger than about 16.7 million pixels and draws nothing. */
const MAX_CANVAS_PIXELS = 16_000_000;

const clampZoom = (z: number): number => Math.max(1, Math.min(MAX_ZOOM, z));

/**
 * A PDF's pages one under another, fit to the width, drawn by pdf.js only
 * while near the screen (a page far away gives its pixels back). Pinch and
 * double-tap zoom; the pages are drawn again sharp at the new size. Styled
 * inline because the phone frames and the desktop shell have different stylesheets.
 */
export default function PdfPages({ data, name }: { data: ArrayBuffer; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [aspects, setAspects] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** The scroll position to set once the pages have their new size. */
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let live = true;
    // pdf.js moves the bytes it's given to its worker; the viewer keeps its own copy for a second look.
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise
      .then(async (d) => {
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!live) return;
        setAspects(Array.from({ length: d.numPages }, () => first.height / first.width));
        setDoc(d);
      })
      .catch((err: unknown) => live && setError(`${name} can’t be shown. ${err instanceof Error ? err.message : ''}`.trim()));
    return () => {
      live = false;
      void task.destroy();
    };
  }, [data, name]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  useLayoutEffect(() => {
    const s = pendingScroll.current;
    const el = scroller.current;
    if (!s || !el) return;
    pendingScroll.current = null;
    el.scrollLeft = s.left;
    el.scrollTop = s.top;
  }, [zoom]);

  /** Zoom to `to`, keeping what's under (x, y) (relative to the scroller's box) where it is. */
  const zoomAt = (to: number, x: number, y: number) => {
    const el = scroller.current;
    if (!el) return;
    const next = clampZoom(to);
    const k = next / zoom;
    pendingScroll.current = { left: (el.scrollLeft + x) * k - x, top: (el.scrollTop + y) * k - y };
    setZoom(next);
  };

  // Pinch and double-tap by touch events: touch-action leaves scrolling to the browser and pinching to this.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let pinch: { dist: number; x: number; y: number; scale: number } | null = null;
    let tap: { t: number; x: number; y: number; moved: boolean } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    const local = (t: Touch) => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [local(e.touches[0]), local(e.touches[1])];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: 1 };
        if (inner.current) inner.current.style.transformOrigin = `${el.scrollLeft + pinch.x}px ${el.scrollTop + pinch.y}px`;
        tap = null;
      } else if (e.touches.length === 1) {
        const p = local(e.touches[0]);
        tap = { t: e.timeStamp, ...p, moved: false };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = [local(e.touches[0]), local(e.touches[1])];
        pinch.scale = clampZoom((zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist) / zoom;
        if (inner.current) inner.current.style.transform = `scale(${pinch.scale})`;
      } else if (tap && e.touches.length === 1) {
        const p = local(e.touches[0]);
        if (Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        const { scale, x, y } = pinch;
        pinch = null;
        if (inner.current) inner.current.style.transform = '';
        if (scale !== 1) zoomAt(zoom * scale, x, y);
        return;
      }
      if (!tap || tap.moved || e.touches.length > 0 || e.timeStamp - tap.t > DOUBLE_TAP_MS) return;
      const twice = tap.t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < TAP_SLOP * 2;
      lastTap = twice ? { t: 0, x: 0, y: 0 } : { t: tap.t, x: tap.x, y: tap.y };
      if (twice) {
        e.preventDefault();
        zoomAt(zoom > 1 ? 1 : TAP_ZOOM, tap.x, tap.y);
      }
      tap = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // zoomAt reads the current zoom; the listeners are set again with it.
  }, [zoom, doc]);

  if (error) return <div style={{ margin: 'auto', padding: 24, textAlign: 'center', opacity: 0.6 }}>{error}</div>;
  if (!doc) return <div style={{ margin: 'auto', padding: 24, opacity: 0.6 }}>Loading…</div>;
  const pageWidth = Math.max(0, width * zoom - GAP * 2);
  return (
    <div
      ref={scroller}
      className="pdf-pages"
      role="document"
      aria-label={name}
      style={{ flex: 1, alignSelf: 'stretch', minHeight: 0, overflow: 'auto', touchAction: 'pan-x pan-y', background: 'rgba(118, 118, 128, 0.12)' }}
    >
      <div ref={inner} style={{ width: width * zoom, padding: GAP, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: GAP }}>
        {width > 0 &&
          aspects.map((aspect, i) => (
            <PdfPage
              key={i}
              doc={doc}
              number={i + 1}
              width={pageWidth}
              aspect={aspect}
              root={scroller}
              onAspect={(a) => setAspects((list) => (list[i] === a ? list : list.map((x, j) => (j === i ? a : x))))}
            />
          ))}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  number,
  width,
  aspect,
  root,
  onAspect,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  aspect: number;
  root: RefObject<HTMLDivElement | null>;
  onAspect: (aspect: number) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: root.current, rootMargin: '150% 50%' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    if (!near || width <= 0) {
      for (const c of el.querySelectorAll('canvas')) c.width = c.height = 0;
      el.replaceChildren();
      return;
    }
    let live = true;
    let task: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      if (!live) return;
      const base = page.getViewport({ scale: 1 });
      onAspect(base.height / base.width);
      let ratio = (window.devicePixelRatio || 1) * (width / base.width);
      const area = base.width * base.height * ratio * ratio;
      if (area > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / area);
      const viewport = page.getViewport({ scale: ratio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.cssText = 'display:block;width:100%;height:100%';
      task = page.render({ canvas, viewport });
      try {
        await task.promise;
      } catch {
        canvas.width = canvas.height = 0;
        return;
      }
      if (!live) return void (canvas.width = canvas.height = 0);
      // The old drawing stays until the new one is ready, so a zoom doesn't blank the page.
      for (const c of el.querySelectorAll('canvas')) c.width = c.height = 0;
      el.replaceChildren(canvas);
    })();
    return () => {
      live = false;
      task?.cancel();
    };
    // onAspect changes every render; the page's size is what matters.
  }, [doc, number, width, near]);

  return (
    <div
      ref={holder}
      aria-label={`Page ${number}`}
      style={{ width, height: width * aspect, flex: 'none', background: '#fff', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)' }}
    />
  );
}
