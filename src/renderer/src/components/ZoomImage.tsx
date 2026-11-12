import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { isPhone } from '../web/page-nav';

/**
 * An image in a viewer window: on a phone it fits the screen and zooms by touch (ZoomImage); on the desktop
 * it scrolls in a viewport at `width` (the window's zoom), or fits its width until that's known. `missing`
 * shows in its place while there's no image.
 */
export function ImageViewer({
  src,
  alt,
  width,
  onLoad,
  viewportRef,
  missing,
}: {
  src: string | null;
  alt: string;
  width?: number;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  viewportRef?: Ref<HTMLDivElement>;
  missing?: ReactNode;
}) {
  if (isPhone) return <>{src ? <ZoomImage key={src} src={src} alt={alt} /> : missing}</>;
  return (
    <div className="image-viewport" ref={viewportRef}>
      {src ? <img src={src} alt={alt} onLoad={onLoad} style={width !== undefined ? { width } : { maxWidth: '100%' }} /> : missing}
    </div>
  );
}

const MAX_SCALE = 8;
const TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 12;
/** The space between images side by side while swiping. */
const GAP = 20;
/** Faster than this (px/ms) at release, a swipe goes on to the image it's moving toward. */
const FLICK = 0.3;
const SETTLE_MS = 380;

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

/** The images either side, for a swipe: -1 is the previous one, 1 the next. */
export interface ZoomSwipe {
  can: (step: -1 | 1) => boolean;
  /** The image that side, or null while it loads. */
  src: (step: -1 | 1) => string | null;
  go: (step: -1 | 1) => void;
}

/** The strip's offset where a transform leaves it, mid-animation included. */
const offsetOf = (el: HTMLElement): number => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;

/**
 * An image that fits its place and zooms by touch: pinch, drag once zoomed, double-tap to zoom in
 * and back. With `swipe`, the images either side wait beside it, and a sideways drag while it fits
 * moves all of them with the finger, as in Photos. Styled inline because the phone frame and the
 * pages have different stylesheets.
 */
export function ZoomImage({ src, alt, swipe }: { src: string; alt: string; swipe?: ZoomSwipe }) {
  const [view, setView] = useState(FIT);
  const box = useRef<HTMLDivElement>(null);
  /** The images side by side; moved by hand, so a drag doesn't render. */
  const strip = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ from: View; x: number; y: number; dist: number; moved: boolean; swiping: boolean; base: number; lastX: number; lastT: number; speed: number } | null>(null);
  const settling = useRef<(() => void) | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });

  // A new image (swiped to, or Previous and Next) is already in the middle slot: the strip goes back under it.
  useLayoutEffect(() => {
    const el = strip.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = 'translate3d(0, 0, 0)';
    }
    setView(FIT);
  }, [src]);

  /** The image's edges don't come inside the box's while it's bigger than the box. */
  const kept = (v: View): View => {
    const b = box.current;
    const i = image.current;
    if (!b || !i) return v;
    const scale = Math.max(1, Math.min(MAX_SCALE, v.scale));
    const maxX = Math.max(0, (i.offsetWidth * scale - b.clientWidth) / 2);
    const maxY = Math.max(0, (i.offsetHeight * scale - b.clientHeight) / 2);
    return { scale, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
  };
  /** From the box's center, where the image's transform starts. */
  const fromCenter = (x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  /** `from` scaled to `scale`, with what was under `at` still under `to`. */
  const zoomed = (from: View, scale: number, at: { x: number; y: number }, to = at): View => {
    const s = Math.max(1, Math.min(MAX_SCALE, scale)) / from.scale;
    return kept({ scale: from.scale * s, x: to.x - (at.x - from.x) * s, y: to.y - (at.y - from.y) * s });
  };
  const page = () => (box.current?.clientWidth ?? 1) + GAP;
  /** Held back past an end, where there's no image that side. */
  const shown = (offset: number) => (swipe && ((offset > 0 && !swipe.can(-1)) || (offset < 0 && !swipe.can(1))) ? offset / 3 : offset);
  const moveStrip = (offset: number) => {
    if (strip.current) strip.current.style.transform = `translate3d(${offset}px, 0, 0)`;
  };
  const start = (t: number) => {
    const [a, b] = [...points.current.values()];
    if (!a) return (gesture.current = null);
    const moved = points.current.size > 1 || !!gesture.current?.moved;
    // A finger down while the strip settles catches it where it is.
    let base = 0;
    if (settling.current && strip.current) {
      base = offsetOf(strip.current);
      settling.current = null;
      strip.current.style.transition = 'none';
      moveStrip(base);
    }
    gesture.current = b
      ? { from: view, ...fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2), dist: Math.hypot(a.x - b.x, a.y - b.y), moved, swiping: false, base, lastX: 0, lastT: t, speed: 0 }
      : { from: view, x: a.x, y: a.y, dist: 0, moved, swiping: base !== 0, base, lastX: a.x, lastT: t, speed: 0 };
  };
  /**
   * The strip let go at `offset`, moving at `speed` (px/ms): it settles on the nearest image, or the
   * next one the way a flick goes, starting at the finger's speed and slowing to a stop.
   */
  const settle = (offset: number, speed: number) => {
    const el = strip.current;
    if (!el || !swipe) return;
    const w = page();
    const f = -offset / w;
    const lo = swipe.can(-1) ? -1 : 0;
    const hi = swipe.can(1) ? 1 : 0;
    const target = Math.max(lo, Math.min(hi, Math.abs(speed) > FLICK ? (speed < 0 ? Math.ceil(f) : Math.floor(f)) : Math.round(f))) as -1 | 0 | 1;
    const to = -target * w;
    const distance = to - offset;
    const done = () => {
      if (settling.current !== done) return;
      settling.current = null;
      if (target !== 0) swipe.go(target);
    };
    settling.current = done;
    if (Math.abs(distance) < 0.5) {
      moveStrip(to);
      return done();
    }
    // The curve's first slope is the finger's speed over the distance left, so the strip carries on from the flick.
    const along = speed * distance > 0 ? Math.abs((speed * SETTLE_MS) / distance) : 0;
    const x1 = 0.2;
    const y1 = Math.min(1, Math.max(1.6, Math.min(along, 5)) * x1);
    el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(${x1}, ${y1}, 0.3, 1)`;
    moveStrip(to);
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, SETTLE_MS + 60);
  };

  const sides: { at: -1 | 0 | 1; src: string | null }[] = [{ at: 0, src }];
  if (swipe) {
    if (swipe.can(-1)) sides.unshift({ at: -1, src: swipe.src(-1) });
    if (swipe.can(1)) sides.push({ at: 1, src: swipe.src(1) });
  }
  // Keyed by image, so the one swiped to stays the same element as it moves into the middle.
  const keys = new Set<string>();
  const slots = sides.map((s) => {
    let key = s.src ?? `empty ${s.at}`;
    if (keys.has(key)) key = `${key} ${s.at}`;
    keys.add(key);
    return { ...s, key };
  });

  return (
    <div
      ref={box}
      style={{ position: 'relative', flex: 1, alignSelf: 'stretch', minWidth: 0, minHeight: 0, overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}
      onPointerDown={(e) => {
        // Keeps the drag when the finger leaves the box; throws for a pointer that isn't down.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // The gesture works without it.
        }
        points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start(e.timeStamp);
      }}
      onPointerMove={(e) => {
        if (!points.current.has(e.pointerId)) return;
        points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (!g) return;
        const [a, b] = [...points.current.values()];
        if (b) {
          const mid = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
          setView(zoomed(g.from, (g.from.scale * Math.hypot(a.x - b.x, a.y - b.y)) / (g.dist || 1), { x: g.x, y: g.y }, mid));
          return;
        }
        if (Math.hypot(a.x - g.x, a.y - g.y) > TAP_SLOP) g.moved = true;
        // Fit to the box, a sideways drag moves the strip with the finger.
        if (swipe && g.from.scale === 1 && (g.swiping || (g.moved && Math.abs(a.x - g.x) > Math.abs(a.y - g.y)))) {
          g.swiping = true;
          moveStrip(shown(g.base + a.x - g.x));
          if (e.timeStamp > g.lastT) g.speed = 0.7 * ((a.x - g.lastX) / (e.timeStamp - g.lastT)) + 0.3 * g.speed;
          g.lastX = a.x;
          g.lastT = e.timeStamp;
          return;
        }
        setView(kept({ ...g.from, x: g.from.x + a.x - g.x, y: g.from.y + a.y - g.y }));
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        const wasTap = points.current.size === 1 && !g?.moved;
        // A finger that stopped before lifting isn't a flick.
        if (g?.swiping && points.current.size === 1) settle(shown(g.base + e.clientX - g.x), e.timeStamp - g.lastT < 100 ? g.speed : 0);
        points.current.delete(e.pointerId);
        start(e.timeStamp);
        if (!wasTap) return;
        const last = lastTap.current;
        const twice = e.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TAP_SLOP * 2;
        lastTap.current = twice ? { t: 0, x: 0, y: 0 } : { t: e.timeStamp, x: e.clientX, y: e.clientY };
        if (twice) setView(view.scale > 1 ? FIT : zoomed(view, TAP_SCALE, fromCenter(e.clientX, e.clientY)));
      }}
      onPointerCancel={(e) => {
        const g = gesture.current;
        if (g?.swiping && strip.current) settle(offsetOf(strip.current), 0);
        points.current.delete(e.pointerId);
        start(e.timeStamp);
      }}
    >
      <div ref={strip} style={{ position: 'absolute', inset: 0, willChange: swipe ? 'transform' : undefined }}>
        {slots.map((s) => (
          <div
            key={s.key}
            style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: s.at ? `translateX(calc(${s.at} * (100% + ${GAP}px)))` : undefined }}
          >
            {s.src && (
              <img
                ref={s.at === 0 ? image : undefined}
                src={s.src}
                alt={s.at === 0 ? alt : ''}
                draggable={false}
                decoding="async"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: s.at === 0 ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
