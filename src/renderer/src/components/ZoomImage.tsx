import { useRef, useState } from 'react';

const MAX_SCALE = 8;
const TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 12;

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * An image that fits its place and zooms by touch: pinch, drag once zoomed, double-tap to zoom in
 * and back. Styled inline because the phone frame and the pages have different stylesheets.
 */
export function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const [view, setView] = useState(FIT);
  const box = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ from: View; x: number; y: number; dist: number; moved: boolean } | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });

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
  const start = () => {
    const [a, b] = [...points.current.values()];
    if (!a) return (gesture.current = null);
    const moved = points.current.size > 1 || !!gesture.current?.moved;
    gesture.current = b
      ? { from: view, ...fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2), dist: Math.hypot(a.x - b.x, a.y - b.y), moved }
      : { from: view, x: a.x, y: a.y, dist: 0, moved };
  };

  return (
    <div
      ref={box}
      style={{ flex: 1, alignSelf: 'stretch', minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}
      onPointerDown={(e) => {
        points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start();
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
        } else {
          if (Math.hypot(a.x - g.x, a.y - g.y) > TAP_SLOP) g.moved = true;
          setView(kept({ ...g.from, x: g.from.x + a.x - g.x, y: g.from.y + a.y - g.y }));
        }
      }}
      onPointerUp={(e) => {
        const wasTap = points.current.size === 1 && !gesture.current?.moved;
        points.current.delete(e.pointerId);
        start();
        if (!wasTap) return;
        const last = lastTap.current;
        const twice = e.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TAP_SLOP * 2;
        lastTap.current = twice ? { t: 0, x: 0, y: 0 } : { t: e.timeStamp, x: e.clientX, y: e.clientY };
        if (twice) setView(view.scale > 1 ? FIT : zoomed(view, TAP_SCALE, fromCenter(e.clientX, e.clientY)));
      }}
      onPointerCancel={(e) => {
        points.current.delete(e.pointerId);
        start();
      }}
    >
      <img
        ref={image}
        src={src}
        alt={alt}
        draggable={false}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, willChange: 'transform' }}
      />
    </div>
  );
}
