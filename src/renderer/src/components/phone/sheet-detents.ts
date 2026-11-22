// No imports and no DOM types: the unit tests (node tsconfig) load this file.

/** A phone sheet rests at one of two heights: half the page, or all of it but a gap at its top. */
export type Detent = 'medium' | 'large';

/**
 * The sheet's height (px) at `d` on a page `page` high: medium is half of it, large all of it but `gap` above
 * the sheet (none on an iPhone, under the status bar; ios.md: Sheets; Material 3's bottom sheet top margin).
 */
export function detentHeight(d: Detent, page: number, gap: number): number {
  return d === 'large' ? Math.max(0, page - gap) : page / 2;
}

/** The height a tap on the grabber moves the sheet to: the other one (HIG Sheets: a tap cycles through the detents). */
export function nextDetent(d: Detent): Detent {
  return d === 'large' ? 'medium' : 'large';
}

/** A drag of the sheet's handle this far (px), or a flick this fast (px/ms), moves it one step. */
const DRAG_STEP = 70;
const FLICK = 0.6;

/**
 * Where a sheet goes when the handle is let go: `dy` is how far it was dragged
 * (down is positive), `velocity` how fast it was moving (px/ms), `page` the page's
 * height. Up opens it to large; down closes large to medium and medium to
 * nothing, and a drag that went more than half the page closes either.
 */
export function settleSheet(from: Detent, dy: number, velocity: number, page: number): Detent | 'dismiss' {
  if (dy < -DRAG_STEP || velocity < -FLICK) return 'large';
  if (dy > DRAG_STEP || velocity > FLICK) return from === 'large' && dy < page / 2 && velocity < 2 ? 'medium' : 'dismiss';
  return from;
}

/** The sheet's height (px) while the handle is dragged `dy` from its detent. */
export function draggedHeight(from: Detent, dy: number, page: number, gap: number): number {
  return Math.max(0, Math.min(detentHeight('large', page, gap), detentHeight(from, page, gap) - dy));
}
