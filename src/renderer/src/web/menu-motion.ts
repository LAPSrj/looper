// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/** A CSS easing and how long it runs. */
export interface Motion {
  easing: string;
  ms: number;
}

/**
 * SwiftUI's Spring(duration:bounce:) as a CSS linear() easing: a unit mass
 * with ω0 = 2π / duration and a damping ratio of 1 − bounce, run until it
 * stays within 0.1% of its end.
 */
export function springEasing(duration: number, bounce: number, points = 48): Motion {
  const w0 = (2 * Math.PI) / duration;
  const zeta = 1 - Math.min(Math.max(bounce, 0), 0.95);
  const at = (t: number): number => {
    if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  };
  // The envelope bounds every later swing, so once it's under 0.1% the spring has settled.
  const envelope = (t: number): number => Math.exp(-zeta * w0 * t) * (zeta >= 1 ? 1 + w0 * t : 1 / Math.sqrt(1 - zeta * zeta));
  let end = 0;
  while (envelope(end) > 0.001) end += 0.005;
  const values: string[] = [];
  for (let i = 0; i <= points; i++) values.push(i === points ? '1' : String(Math.round(at((end * i) / points) * 10000) / 10000));
  return { easing: `linear(${values.join(', ')})`, ms: Math.round(end * 1000) };
}

/** Animation.snappy: "a small amount of bounce", 0.5 s with a bounce of 0.15 (SwiftUI's defaults). */
export const SNAPPY = springEasing(0.5, 0.15);
/** Animation.smooth: no bounce. A menu goes back into its button at a shorter pace than it came out. */
export const SMOOTH = springEasing(0.35, 0);

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a submenu's card goes: its header over the row that opened it, moved
 * up to fit above the screen's bottom, but never above `floor` (just under
 * the menu's top, so the menu behind shows as a stacked edge); past that it
 * scrolls.
 */
export function placeSubmenu(row: Box, height: number, floor: number, bottom: number, pad = 6): { top: number; maxHeight: number } {
  const top = Math.max(floor, Math.min(row.top - pad, bottom - height));
  return { top, maxHeight: bottom - top };
}
