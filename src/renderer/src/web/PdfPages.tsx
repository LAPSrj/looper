import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useZoomLayer } from '../components/zoom-layer';
import { clampScale, DOUBLE_TAP_MS, isDoubleTap, pageDraw, pagesTransform, PDF_MAX_SCALE, pinch, scrollAfterZoom, TAP_SLOP, tapScale, type Point, type Tap } from './zoom';

GlobalWorkerOptions.workerSrc = workerUrl;

const GAP = 12;
/** iOS refuses a canvas bigger than about 16.7 million pixels and draws nothing. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** What the pages share: whether each is near the screen or in view, and whether a gesture holds back their drawing. */
interface Pages {
  watch: (el: Element, on: (seen: { near: boolean; visible: boolean }) => void) => () => void;
  /** Resolves once no gesture is going on: a page isn't drawn under the fingers. */
  idle: () => Promise<void>;
}

const PagesContext = createContext<Pages | null>(null);

/** One observer for every page's nearness and one for what's in view, rather than one per page. */
function usePages(root: React.RefObject<HTMLDivElement | null>, ready: boolean): Pages & { hold: (on: boolean) => void } {
  const [pages] = useState(() => {
    const seen = new Map<Element, { near: boolean; visible: boolean; on: (s: { near: boolean; visible: boolean }) => void }>();
    let near: IntersectionObserver | null = null;
    let visible: IntersectionObserver | null = null;
    let held = false;
    let waiting: (() => void)[] = [];
    const update = (kind: 'near' | 'visible') => (entries: IntersectionObserverEntry[]) => {
      for (const e of entries) {
        const s = seen.get(e.target);
        if (!s || s[kind] === e.isIntersecting) continue;
        s[kind] = e.isIntersecting;
        s.on({ near: s.near, visible: s.visible });
      }
    };
    return {
      start: (el: HTMLElement) => {
        near = new IntersectionObserver(update('near'), { root: el, rootMargin: '150% 50%' });
        visible = new IntersectionObserver(update('visible'), { root: el });
        for (const t of seen.keys()) {
          near.observe(t);
          visible.observe(t);
        }
      },
      stop: () => {
        near?.disconnect();
        visible?.disconnect();
        near = visible = null;
      },
      watch: (el: Element, on: (s: { near: boolean; visible: boolean }) => void) => {
        seen.set(el, { near: false, visible: false, on });
        near?.observe(el);
        visible?.observe(el);
        return () => {
          seen.delete(el);
          near?.unobserve(el);
          visible?.unobserve(el);
        };
      },
      idle: () => (held ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve()),
      hold: (on: boolean) => {
        held = on;
        if (on) return;
        const go = waiting;
        waiting = [];
        for (const resolve of go) resolve();
      },
    };
  });
  useLayoutEffect(() => {
    const el = root.current;
    if (!ready || !el) return;
    pages.start(el);
    return pages.stop;
  }, [pages, root, ready]);
  return pages;
}

/**
 * A PDF's pages one under another, fit to the width, scrolled natively, and
 * drawn by pdf.js only while near the screen (a page far away gives its pixels
 * back). Pinch and double-tap zoom (web/zoom.ts, the image viewer's zoom too):
 * while the fingers move, the pages follow as one transform on the GPU and
 * nothing is drawn; once they lift (or the double-tap's glide ends), the pages
 * take their new size and the ones in view are drawn again sharp at it. The
 * others keep their old drawing until they come into view. Styled inline
 * because the phone frames and the desktop shell have different stylesheets.
 */
export default function PdfPages({ data, name }: { data: ArrayBuffer; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [aspects, setAspects] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const layer = useZoomLayer(inner);
  const pages = usePages(scroller, !!doc);
  /** The scroll position to set once the pages have their new size. */
  const pendingScroll = useRef<Point | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

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

  // The pages have their new size: the transform that showed it goes, in the same frame, and the scroll keeps the place.
  useLayoutEffect(() => {
    const s = pendingScroll.current;
    const el = scroller.current;
    if (!s || !el) return;
    pendingScroll.current = null;
    layer.rest(null);
    el.scrollLeft = s.x;
    el.scrollTop = s.y;
    pages.hold(false);
  }, [zoom, layer, pages]);

  // Pinch and double-tap by touch events: touch-action leaves scrolling to the browser and pinching to this.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    /** The two fingers' start, and the scroll then. */
    let start: { points: [Point, Point]; scroll: Point } | null = null;
    let k = 1;
    let to: Point = { x: 0, y: 0 };
    let at: Point = { x: 0, y: 0 };
    let tap: { t: number; x: number; y: number; moved: boolean } | null = null;
    let lastTap: Tap | null = null;
    /** A zoom being carried out (a glide, then the new layout): no new gesture until it lands. */
    let busy = false;
    const local = (t: Touch): Point => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const scrollNow = (): Point => ({ x: el.scrollLeft, y: el.scrollTop });
    const content = () => ({ width: inner.current?.offsetWidth ?? 0, height: inner.current?.offsetHeight ?? 0 });
    const view = () => ({ width: el.clientWidth, height: el.clientHeight });
    /** Lays the pages out at `zoom × k`, scrolled to `next`, once the transform shows just that. */
    const commit = (kk: number, next: Point) => {
      const z = zoomRef.current;
      const nz = clampScale(z * kk, PDF_MAX_SCALE);
      if (Math.abs(nz - z) < 0.001) {
        layer.rest(null);
        el.scrollLeft = next.x;
        el.scrollTop = next.y;
        pages.hold(false);
        busy = false;
        return;
      }
      pendingScroll.current = next;
      busy = false;
      setZoom(nz);
    };
    /** Glides from where the transform is to how the pages will be laid out, then lays them out. */
    const land = (scroll: Point, kk: number, from: Point, onto: Point) => {
      busy = true;
      const next = scrollAfterZoom(scroll, kk, from, onto, content(), view());
      void layer.glide(pagesTransform(scroll, kk, next)).then(() => commit(kk, next));
    };
    const onStart = (e: TouchEvent) => {
      if (busy) return;
      if (e.touches.length === 2) {
        const points: [Point, Point] = [local(e.touches[0]), local(e.touches[1])];
        start = { points, scroll: scrollNow() };
        k = 1;
        at = to = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        if (inner.current) inner.current.style.transformOrigin = '0 0';
        pages.hold(true);
        tap = null;
      } else if (e.touches.length === 1) {
        tap = { t: e.timeStamp, ...local(e.touches[0]), moved: false };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (start && e.touches.length === 2) {
        e.preventDefault();
        const p = pinch(start.points, [local(e.touches[0]), local(e.touches[1])]);
        const z = zoomRef.current;
        k = clampScale(z * p.spread, PDF_MAX_SCALE) / z;
        at = p.at;
        to = p.to;
        // What was under the fingers' first midpoint follows their midpoint now.
        const s = start.scroll;
        layer.move({ scale: k, x: to.x + s.x - k * (s.x + at.x), y: to.y + s.y - k * (s.y + at.y) });
      } else if (tap && e.touches.length === 1) {
        const p = local(e.touches[0]);
        if (Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (start && e.touches.length < 2) {
        const s = start.scroll;
        start = null;
        // Let go past an edge, it glides back in before the pages are laid out again.
        land(s, k, at, to);
        return;
      }
      if (!tap || tap.moved || e.touches.length > 0 || e.timeStamp - tap.t > DOUBLE_TAP_MS || busy) return;
      const now: Tap = { t: tap.t, x: tap.x, y: tap.y };
      const twice = isDoubleTap(lastTap, now);
      lastTap = twice ? null : now;
      tap = null;
      if (!twice) return;
      e.preventDefault();
      const z = zoomRef.current;
      if (inner.current) inner.current.style.transformOrigin = '0 0';
      pages.hold(true);
      land(scrollNow(), tapScale(z, PDF_MAX_SCALE) / z, now, now);
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
  }, [doc, layer, pages]);

  const shared = useMemo<Pages>(() => ({ watch: pages.watch, idle: pages.idle }), [pages]);
  if (error) return <div style={{ margin: 'auto', padding: 24, textAlign: 'center', opacity: 0.6 }}>{error}</div>;
  if (!doc) return <div style={{ margin: 'auto', padding: 24, opacity: 0.6 }}>Loading…</div>;
  const pageWidth = Math.max(0, width * zoom - GAP * 2);
  return (
    <div
      ref={scroller}
      className="pdf-pages"
      role="document"
      aria-label={name}
      style={{ flex: 1, alignSelf: 'stretch', minHeight: 0, overflow: 'auto', touchAction: 'pan-x pan-y', background: 'rgba(118, 118, 128, 0.12)', paddingBottom: 'var(--viewer-end, 0px)', boxSizing: 'border-box' }}
    >
      {/* Holds the pages' laid-out size, so a pinch out (a smaller transform) doesn't shorten the scroll under the fingers. */}
      <div style={{ width: width * zoom }}>
        <div ref={inner} style={{ width: width * zoom, padding: GAP, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: GAP }}>
          <PagesContext.Provider value={shared}>
            {width > 0 &&
              aspects.map((aspect, i) => (
                <PdfPage
                  key={i}
                  doc={doc}
                  number={i + 1}
                  width={pageWidth}
                  aspect={aspect}
                  onAspect={(a) => setAspects((list) => (list[i] === a ? list : list.map((x, j) => (j === i ? a : x))))}
                />
              ))}
          </PagesContext.Provider>
        </div>
      </div>
    </div>
  );
}

function PdfPage({ doc, number, width, aspect, onAspect }: { doc: PDFDocumentProxy; number: number; width: number; aspect: number; onAspect: (aspect: number) => void }) {
  const pages = useContext(PagesContext)!;
  const holder = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState({ near: false, visible: false });
  /** The width its canvas was drawn for; null without one. */
  const drawnAt = useRef<number | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    return pages.watch(el, setSeen);
  }, [pages]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const what = pageDraw({ ...seen, drawnAt: drawnAt.current, width });
    if (what === 'free') {
      for (const c of el.querySelectorAll('canvas')) c.width = c.height = 0;
      el.replaceChildren();
      drawnAt.current = null;
      return;
    }
    if (what === 'keep') return;
    let live = true;
    let task: RenderTask | null = null;
    void (async () => {
      // Never under the fingers: a pinch or a double-tap's glide is drawn when it lands.
      await pages.idle();
      if (!live) return;
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
      drawnAt.current = width;
    })();
    return () => {
      live = false;
      task?.cancel();
    };
    // onAspect changes every render; the page's size and where it is are what matter.
  }, [doc, number, width, seen, pages]);

  return (
    <div
      ref={holder}
      aria-label={`Page ${number}`}
      style={{ width, height: width * aspect, flex: 'none', background: '#fff', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)' }}
    />
  );
}
