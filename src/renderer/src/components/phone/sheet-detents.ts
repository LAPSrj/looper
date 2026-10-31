// No imports and no DOM types: the unit tests (node tsconfig) load this file.

/** A phone sheet rests at one of two heights: half the page, or nearly all of it. */
export type Detent = 'medium' | 'large';

/** The sheet's height at each detent, as a fraction of the page. */
export const DETENT_HEIGHT: Record<Detent, number> = { medium: 0.5, large: 0.92 };

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
export function draggedHeight(from: Detent, dy: number, page: number): number {
  return Math.max(0, Math.min(DETENT_HEIGHT.large * page, DETENT_HEIGHT[from] * page - dy));
}
