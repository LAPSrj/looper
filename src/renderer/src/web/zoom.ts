// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/*
 * The zoom the image viewer (ZoomImage) and the PDF viewer (PdfPages) share:
 * the same double-tap, pinch and limits, worked out here; useZoomLayer
 * (components/zoom-layer.ts) moves what they show while the fingers move.
 */

/** A double-tap zooms in to this, from fit. */
export const TAP_SCALE = 2.5;
/** Two taps within this long, and near each other, are a double-tap. */
export const DOUBLE_TAP_MS = 300;
/** A finger that moves less than this is still a tap. */
export const TAP_SLOP = 12;
/** How far in an image zooms: the bitmap holds detail that far. */
export const IMAGE_MAX_SCALE = 8;
/** How far in a PDF zooms: each step in is drawn again, and 4× a phone's width is already a large canvas. */
export const PDF_MAX_SCALE = 4;
/** How long a double-tap's zoom, or the settle after a pinch let go past an edge, glides. */
export const GLIDE_MS = 220;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A transform: translate(x, y) then scale, from the box's center (an image) or the content's corner (a PDF). */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const FIT: View = { scale: 1, x: 0, y: 0 };

/** A scale kept between fit (1) and `max`. */
export const clampScale = (scale: number, max: number): number => Math.max(1, Math.min(max, Number.isFinite(scale) ? scale : 1));

/** `from` zoomed to `scale` (kept between 1 and `max`), with what was under `at` now under `to`; points from the transform's origin. */
export function zoomAround(from: View, scale: number, max: number, at: Point, to: Point = at): View {
  const s = clampScale(scale, max) / from.scale;
  return { scale: from.scale * s, x: to.x - (at.x - from.x) * s, y: to.y - (at.y - from.y) * s };
}

/**
 * A view whose content (`content` at scale 1, centered in `box`) doesn't
 * show the box's background inside its edges while it's bigger than the box.
 */
export function keepInside(v: View, content: Size, box: Size, max: number): View {
  const scale = clampScale(v.scale, max);
  const maxX = Math.max(0, (content.width * scale - box.width) / 2);
  const maxY = Math.max(0, (content.height * scale - box.height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
}

/** A pinch: how much the two fingers spread since they came down, and where their midpoint started and is now. */
export function pinch(start: readonly [Point, Point], now: readonly [Point, Point]): { spread: number; at: Point; to: Point } {
  const dist = (p: readonly [Point, Point]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  const mid = (p: readonly [Point, Point]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  return { spread: dist(now) / (dist(start) || 1), at: mid(start), to: mid(now) };
}

/** A tap that ended at time `t` (ms) at (x, y). */
export interface Tap extends Point {
  t: number;
}

/** Whether `tap` is the second of a double-tap after `last`. */
export const isDoubleTap = (last: Tap | null, tap: Tap): boolean =>
  !!last && tap.t - last.t < DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < TAP_SLOP * 2;

/** The double-tap's next scale: back to fit when zoomed in, else in to TAP_SCALE (or `max` when that's less). */
export const tapScale = (scale: number, max: number): number => (scale > 1 ? 1 : Math.min(TAP_SCALE, max));

// ---------- a scrolled PDF ----------

/**
 * The scroll position after the pages' scale changed by `k`, keeping what
 * was under `at` (from the scroller's corner) now under `to`, and kept in
 * the scroller's range: `content` is the pages' size before the change.
 */
export function scrollAfterZoom(scroll: Point, k: number, at: Point, to: Point, content: Size, view: Size): Point {
  const x = (scroll.x + at.x) * k - to.x;
  const y = (scroll.y + at.y) * k - to.y;
  return {
    x: Math.max(0, Math.min(Math.max(0, content.width * k - view.width), x)),
    y: Math.max(0, Math.min(Math.max(0, content.height * k - view.height), y)),
  };
}

/**
 * The pages' transform (origin at their corner) that shows them as they will
 * be once laid out at `k` times their size and scrolled to `next`: what a
 * pinch's last frame or a double-tap's glide ends on.
 */
export const pagesTransform = (scroll: Point, k: number, next: Point): View => ({ scale: k, x: scroll.x - next.x, y: scroll.y - next.y });

/** What a PDF page does with its canvas. */
export type PageDraw = 'draw' | 'keep' | 'free';

/**
 * A page near the screen without a drawing is drawn; a zoom draws again only
 * the pages in view, at their new size, and the others keep their old drawing
 * stretched until they come into view; one far away gives its pixels back.
 * `drawnAt`: the width its canvas was drawn for, null without one.
 */
export function pageDraw(p: { near: boolean; visible: boolean; drawnAt: number | null; width: number }): PageDraw {
  if (!p.near || p.width <= 0) return 'free';
  if (p.drawnAt === p.width) return 'keep';
  return p.drawnAt === null || p.visible ? 'draw' : 'keep';
}
