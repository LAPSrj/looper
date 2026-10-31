/** The pure part of page zoom (zoom.ts binds it to Electron's windows). */

export type ZoomDirection = 'in' | 'out' | 'reset';

/** The levels Ctrl+= and Ctrl+- step through (Chromium's own). */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The zoom after one step: the next level above or below `current`, or 100%. */
export function zoomStep(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 1;
  const at = Number.isFinite(current) && current > 0 ? current : 1;
  // A factor between two levels (one set some other way) moves to the next level in that direction.
  if (direction === 'in') return ZOOM_STEPS.find((z) => z > at + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < at - 1e-6) ?? ZOOM_STEPS[0];
}

/** The direction a Ctrl (or Cmd) + key press asks for, or null when it isn't a zoom key. */
export function zoomKey(input: { key: string; code?: string }): ZoomDirection | null {
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Numpad0') return 'reset';
  return null;
}

/** The saved zoom factors of the places file's `zooms` object (by window kind); anything not a sensible factor is dropped. */
export function parseZooms(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const zooms = data && typeof data === 'object' ? (data as { zooms?: unknown }).zooms : undefined;
  if (!zooms || typeof zooms !== 'object') return out;
  for (const [key, z] of Object.entries(zooms as Record<string, unknown>)) {
    if (typeof z === 'number' && Number.isFinite(z) && z >= ZOOM_STEPS[0] && z <= ZOOM_STEPS[ZOOM_STEPS.length - 1] && z !== 1) out[key] = z;
  }
  return out;
}
