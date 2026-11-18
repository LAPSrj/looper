import { describe, expect, it } from 'vitest';
import {
  clampScale,
  FIT,
  IMAGE_MAX_SCALE,
  isDoubleTap,
  keepInside,
  pageDraw,
  pagesTransform,
  PDF_MAX_SCALE,
  pinch,
  scrollAfterZoom,
  TAP_SCALE,
  tapScale,
  zoomAround,
} from '../src/renderer/src/web/zoom';

describe('the zoom the image and PDF viewers share', () => {
  it('keeps a scale between fit and each viewer\'s most', () => {
    expect(clampScale(0.3, IMAGE_MAX_SCALE)).toBe(1);
    expect(clampScale(3, IMAGE_MAX_SCALE)).toBe(3);
    expect(clampScale(20, IMAGE_MAX_SCALE)).toBe(8);
    expect(clampScale(20, PDF_MAX_SCALE)).toBe(4);
    expect(clampScale(Number.NaN, PDF_MAX_SCALE)).toBe(1);
  });

  it('zooms around a point: what was under it stays under it, or follows the fingers', () => {
    const v = zoomAround(FIT, 2, IMAGE_MAX_SCALE, { x: 50, y: 20 });
    expect(v).toEqual({ scale: 2, x: -50, y: -20 });
    // The point (50, 20) of the image is at 50 + 2 * (50 - 50)… back where it was: x + scale * p = p.
    expect(v.x + v.scale * 50).toBe(50);
    const moved = zoomAround(FIT, 2, IMAGE_MAX_SCALE, { x: 50, y: 20 }, { x: 60, y: 30 });
    expect(moved.x + moved.scale * 50).toBe(60);
    expect(zoomAround(FIT, 99, PDF_MAX_SCALE, { x: 0, y: 0 }).scale).toBe(4);
  });

  it('keeps a zoomed image\'s edges outside the box', () => {
    const content = { width: 400, height: 300 };
    const box = { width: 400, height: 600 };
    expect(keepInside({ scale: 2, x: 999, y: 999 }, content, box, IMAGE_MAX_SCALE)).toEqual({ scale: 2, x: 200, y: 0 });
    expect(keepInside({ scale: 0.5, x: 30, y: 30 }, content, box, IMAGE_MAX_SCALE)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('reads a pinch from where the two fingers started', () => {
    const p = pinch(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      [
        { x: 0, y: 50 },
        { x: 200, y: 50 },
      ],
    );
    expect(p).toEqual({ spread: 2, at: { x: 50, y: 0 }, to: { x: 100, y: 50 } });
  });

  it('tells a double-tap by its time and place', () => {
    const first = { t: 1000, x: 10, y: 10 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { t: 1200, x: 20, y: 15 })).toBe(true);
    expect(isDoubleTap(first, { t: 1400, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap(first, { t: 1100, x: 80, y: 10 })).toBe(false);
  });

  it('double-taps in from fit and back out from any zoom', () => {
    expect(tapScale(1, IMAGE_MAX_SCALE)).toBe(TAP_SCALE);
    expect(tapScale(3.2, IMAGE_MAX_SCALE)).toBe(1);
    expect(tapScale(1, 2)).toBe(2);
  });
});

describe('a PDF\'s zoom', () => {
  const content = { width: 400, height: 4000 };
  const view = { width: 400, height: 800 };

  it('keeps what was under the fingers there once the pages are laid out again', () => {
    // 2× around (100, 200) of the view, scrolled 1000 down: that point of the pages, 1200, goes to 2400, shown at 200.
    expect(scrollAfterZoom({ x: 0, y: 1000 }, 2, { x: 100, y: 200 }, { x: 100, y: 200 }, content, view)).toEqual({ x: 100, y: 2200 });
    // And with the fingers moved 50 px right and down meanwhile.
    expect(scrollAfterZoom({ x: 0, y: 1000 }, 2, { x: 100, y: 200 }, { x: 150, y: 250 }, content, view)).toEqual({ x: 50, y: 2150 });
  });

  it('keeps the scroll in the pages\' new range', () => {
    expect(scrollAfterZoom({ x: 0, y: 0 }, 2, { x: 0, y: 0 }, { x: 300, y: 300 }, content, view)).toEqual({ x: 0, y: 0 });
    // Out to half at the bottom: the pages are 2000 tall then, so the scroll stops at 1200, not 1600.
    expect(scrollAfterZoom({ x: 0, y: 3200 }, 0.5, { x: 0, y: 0 }, { x: 0, y: 0 }, content, view)).toEqual({ x: 0, y: 1200 });
    expect(scrollAfterZoom({ x: 400, y: 3200 }, 0.25, { x: 400, y: 800 }, { x: 400, y: 800 }, { width: 1600, height: 16000 }, view)).toEqual({ x: 0, y: 200 });
  });

  it('ends a glide on just what the new layout shows', () => {
    const scroll = { x: 0, y: 1000 };
    const next = scrollAfterZoom(scroll, 2, { x: 100, y: 200 }, { x: 100, y: 200 }, content, view);
    const t = pagesTransform(scroll, 2, next);
    // A point p of the pages shows at t + scale·p − scroll now, and at 2·p − next once laid out.
    for (const p of [{ x: 0, y: 0 }, { x: 123, y: 1700 }]) {
      expect(t.x + t.scale * p.x - scroll.x).toBe(2 * p.x - next.x);
      expect(t.y + t.scale * p.y - scroll.y).toBe(2 * p.y - next.y);
    }
  });

  it('draws again only the pages in view after a zoom; the others keep their drawing until they come into view', () => {
    // Near the screen without a drawing: drawn.
    expect(pageDraw({ near: true, visible: false, drawnAt: null, width: 380 })).toBe('draw');
    // Drawn at this width: nothing to do.
    expect(pageDraw({ near: true, visible: true, drawnAt: 380, width: 380 })).toBe('keep');
    // Zoomed: in view, drawn again sharp; near but out of view, its old drawing stretched.
    expect(pageDraw({ near: true, visible: true, drawnAt: 380, width: 760 })).toBe('draw');
    expect(pageDraw({ near: true, visible: false, drawnAt: 380, width: 760 })).toBe('keep');
    // Far away: its pixels go back.
    expect(pageDraw({ near: false, visible: false, drawnAt: 380, width: 760 })).toBe('free');
    expect(pageDraw({ near: true, visible: true, drawnAt: 380, width: 0 })).toBe('free');
  });
});
