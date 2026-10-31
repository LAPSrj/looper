/**
 * Where a window opens: the pure part of window placement (window-places.ts
 * binds it to Electron). Each kind of window opens where the last one of its
 * kind was, as long as that spot is still on a connected display.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A kind of window's last place: its normal (unmaximized) bounds, in DIPs. */
export interface Place {
  bounds: Rect;
  maximized: boolean;
}

export interface DisplayLike {
  workArea: Rect;
}

/**
 * What a window of its kind gets back: `bounds` (top-level windows and
 * modeless editors), `size` (resizable modal dialogs, centered on their
 * parent), `position` (fixed-size modeless windows), or nothing (fixed-size
 * modal dialogs).
 */
export type PlaceMode = 'bounds' | 'size' | 'position' | 'none';

export function placeMode(modal: boolean, resizable: boolean): PlaceMode {
  if (modal) return resizable ? 'size' : 'none';
  return resizable ? 'bounds' : 'position';
}

/** The task editor's and the template editor's routes, each opening the same editor. */
const SAME_KIND: Record<string, string> = {
  'editor-in': 'editor',
  'editor-from-template': 'editor',
  'editor-import': 'editor',
  'template-import': 'template-editor',
  'project-new': 'project',
};

/**
 * The kind of window a renderer hash opens, one place per kind: the route,
 * without the item it shows. A single chat's window is `chat` (the Chats
 * window is `sessions`); an addon's window is per addon and screen.
 */
export function placeKey(hash: string): string {
  const parts = hash.split('/');
  const route = parts[0];
  if (!route) return 'main';
  if (route === 'sessions' && parts[2] === 'window') return 'chat';
  if (route === 'addon' || route === 'addon-pane') return parts.slice(0, 3).join('/');
  return SAME_KIND[route] ?? route;
}

/** How much of a window's top edge must show on a display for it to count as there: enough to grab it. */
const GRAB_WIDTH = 64;
const GRAB_HEIGHT = 16;
const TITLE_BAR = 32;
/** How far a window opens from another of its kind already at its spot. */
export const CASCADE = 24;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

function validRect(r: unknown): r is Rect {
  if (!r || typeof r !== 'object') return false;
  const { x, y, width, height } = r as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) && (width as number) > 0 && (height as number) > 0;
}

/**
 * The work area a window is on: of the displays showing enough of its title
 * bar to grab it, the one showing most of the window. Null when none does
 * (the display it was on is gone, or moved).
 */
function workAreaOf(bounds: Rect, displays: DisplayLike[]): Rect | null {
  const title = { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(TITLE_BAR, bounds.height) };
  let best: Rect | null = null;
  let bestArea = -1;
  for (const d of displays) {
    if (!validRect(d.workArea)) continue;
    const t = overlap(title, d.workArea);
    if (t.width < Math.min(GRAB_WIDTH, bounds.width) || t.height < Math.min(GRAB_HEIGHT, title.height)) continue;
    const o = overlap(bounds, d.workArea);
    if (o.width * o.height > bestArea) {
      best = d.workArea;
      bestArea = o.width * o.height;
    }
  }
  return best;
}

function rounded(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** Shrink a window to a work area and move it fully onto it. */
function clampInto(b: Rect, wa: Rect): Rect {
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  return rounded({ x, y, width, height });
}

/**
 * Fit a window's bounds onto the displays: null when no display shows
 * enough of its title bar to grab it. On its display, a window bigger than
 * the work area (a smaller screen, a higher scaling) shrinks to it and moves
 * fully onto it, and a title bar above the work area comes down into it; a
 * window that fits stays where it was, even partly off the screen.
 */
export function fitToDisplays(bounds: Rect, displays: DisplayLike[]): Rect | null {
  if (!validRect(bounds)) return null;
  const wa = workAreaOf(bounds, displays);
  if (!wa) return null;
  if (bounds.width > wa.width || bounds.height > wa.height) return clampInto(bounds, wa);
  return rounded({ ...bounds, y: Math.max(bounds.y, wa.y) });
}

/** Step a window down and right past others of its kind sitting at the same spot. */
export function cascade(bounds: Rect, taken: Rect[]): Rect {
  let { x, y } = bounds;
  for (let i = 0; i < 20 && taken.some((t) => t.x === x && t.y === y); i++) {
    x += CASCADE;
    y += CASCADE;
  }
  return { ...bounds, x, y };
}

/**
 * The bounds a new window opens at, from its kind's saved place: null to
 * leave it where Electron put it (nothing to restore, or the place is no
 * longer on any display). `current` is the new window's own default bounds,
 * `parent` the bounds of the window a modal dialog belongs to, `taken` the
 * open windows of the same kind.
 */
export function restoredBounds(args: {
  saved: Rect;
  mode: PlaceMode;
  current: Rect;
  displays: DisplayLike[];
  parent?: Rect | null;
  taken?: Rect[];
}): Rect | null {
  const { saved, mode, current, displays, parent } = args;
  if (!validRect(saved) || !validRect(current)) return null;
  let want: Rect;
  switch (mode) {
    case 'none':
      return null;
    case 'bounds':
      want = saved;
      break;
    case 'position':
      want = { x: saved.x, y: saved.y, width: current.width, height: current.height };
      break;
    case 'size': {
      // Centered on its parent, and wholly on the parent's display.
      const around = parent && validRect(parent) ? parent : current;
      const wa = workAreaOf(around, displays);
      if (!wa) return null;
      want = {
        x: around.x + (around.width - saved.width) / 2,
        y: around.y + (around.height - saved.height) / 2,
        width: saved.width,
        height: saved.height,
      };
      return clampInto(want, wa);
    }
  }
  return fitToDisplays(cascade(want, args.taken ?? []), displays);
}

/** The saved places file's entries that are well-formed; anything else is dropped. */
export function parsePlaces(data: unknown): Record<string, Place> {
  const out: Record<string, Place> = {};
  const places = data && typeof data === 'object' ? (data as { places?: unknown }).places : undefined;
  if (!places || typeof places !== 'object') return out;
  for (const [key, p] of Object.entries(places as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') continue;
    const { bounds, maximized } = p as Record<string, unknown>;
    if (!validRect(bounds)) continue;
    out[key] = { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: maximized === true };
  }
  return out;
}
