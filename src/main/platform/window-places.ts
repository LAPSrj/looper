/**
 * Desktop windows open where the last window of their kind was: its size,
 * position, display and maximized state (see placement.ts for which of those
 * each kind gets back). The places live in the data dir's windows.json,
 * saved as windows move and resize, and when they close.
 */
import { BrowserWindow, screen } from 'electron';
import { readJson, writeJsonAtomic } from '../../engine/store/fsutil';
import { parsePlaces, placeKey, placeMode, restoredBounds, type Place, type PlaceMode, type Rect } from './placement';
import { perfQuiet } from './perf-quiet';
import { attachZoom } from './zoom';
import { parseZooms } from './zoom-steps';

const SAVE_DELAY_MS = 500;

let file: string | null = null;
let places: Record<string, Place> = {};
/** The page zoom of each kind of window (View → Zoom), where it isn't 100%. */
let zooms: Record<string, number> = {};
let writeTimer: NodeJS.Timeout | null = null;

/** A window's kind, and what of its place it gets back. */
const tracked = new WeakMap<BrowserWindow, { key: string; mode: PlaceMode }>();

/** Read the saved places; windows opened from here on remember theirs in `path`. */
export function useWindowPlaces(path: string): void {
  file = path;
  try {
    const data = readJson<unknown>(path, {});
    places = parsePlaces(data);
    zooms = parseZooms(data);
  } catch {
    // A torn or hand-edited file: every window opens at its default place.
    places = {};
    zooms = {};
  }
}

function flush(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (!file) return;
  try {
    writeJsonAtomic(file, { version: 1, places, zooms });
  } catch {
    /* window places are advisory */
  }
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function displays(): { workArea: Rect }[] {
  return screen.getAllDisplays();
}

/** setBounds, twice when the first lands at another size: moving onto a display with another scaling can size it by the old one. */
function setBoundsOnce(w: BrowserWindow, b: Rect): void {
  w.setBounds(b);
  const got = w.getBounds();
  if (got.width !== b.width || got.height !== b.height) w.setBounds(b);
}

function openOfKind(key: string, except: BrowserWindow): Rect[] {
  return BrowserWindow.getAllWindows()
    .filter((o) => o !== except && !o.isDestroyed() && o.isVisible() && tracked.get(o)?.key === key)
    .map((o) => o.getNormalBounds());
}

/** Put a window at its kind's saved place: that place, or null when it has none that still fits a display. */
function restore(w: BrowserWindow, key: string, mode: PlaceMode): Place | null {
  const saved = places[key];
  if (!saved) return null;
  const parent = w.getParentWindow();
  const bounds = restoredBounds({
    saved: saved.bounds,
    mode,
    current: w.getBounds(),
    displays: displays(),
    parent: parent && !parent.isDestroyed() ? parent.getBounds() : null,
    taken: openOfKind(key, w),
  });
  if (!bounds) return null;
  setBoundsOnce(w, bounds);
  return saved;
}

/** Record where a window is, now and as it moves, resizes and closes. */
function track(w: BrowserWindow, key: string, mode: PlaceMode): void {
  tracked.set(w, { key, mode });
  let timer: NodeJS.Timeout | null = null;
  const record = (): void => {
    timer = null;
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    const t = tracked.get(w);
    if (!t || t.mode === 'none') return;
    places[t.key] = { bounds: w.getNormalBounds(), maximized: w.isMaximized() };
    scheduleWrite();
  };
  const later = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(record, SAVE_DELAY_MS);
  };
  w.on('move', later);
  w.on('resize', later);
  w.on('maximize', later);
  w.on('unmaximize', later);
  w.on('close', () => {
    if (timer) clearTimeout(timer);
    record();
    flush();
  });
  w.on('closed', () => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * new BrowserWindow(options) for the renderer page at `hash`, opened at the
 * place the last window of its kind had. A window with a saved place starts
 * hidden and moves to it and shows once the caller's synchronous setup is
 * done: a menu bar the caller adds grows the window by its height (Electron
 * keeps the page's size), and a window made maximizable after construction
 * still comes back maximized.
 */
export function createPlacedWindow(options: Electron.BrowserWindowConstructorOptions, hash: string): BrowserWindow {
  const key = placeKey(hash);
  const mode = placeMode(!!options.modal && !!options.parent, options.resizable ?? true);
  const restoring = !!file && mode !== 'none' && !!places[key];
  const show = options.show ?? true;
  // Quiet mode (perf-quiet.ts) shows it here, inactive: shown by the constructor, it would take the focus.
  const deferred = restoring || (show && perfQuiet());
  const w = new BrowserWindow(deferred ? { ...options, show: false } : options);
  if (deferred) {
    process.nextTick(() => {
      if (w.isDestroyed()) return;
      const saved = restore(w, key, mode);
      if (saved?.maximized && mode === 'bounds' && w.isMaximizable()) w.maximize();
      if (show) w.show();
    });
  }
  track(w, key, mode);
  attachZoom(w, zooms[key], (factor) => {
    if (factor === 1) delete zooms[key];
    else zooms[key] = factor;
    scheduleWrite();
  });
  return w;
}

/**
 * A window that turns into another kind (the New Task with Agent setup
 * window becoming its builder) takes that kind's place, and saves there from
 * now on. False when it has no saved place to take, leaving it where it is.
 */
export function placeAs(w: BrowserWindow, hash: string): boolean {
  const key = placeKey(hash);
  const mode = placeMode(w.isModal(), w.isResizable());
  const t = tracked.get(w);
  if (!t) return false;
  tracked.set(w, { key, mode });
  if (mode === 'none') return false;
  const saved = restore(w, key, mode);
  if (!saved) return false;
  if (saved.maximized && mode === 'bounds' && w.isMaximizable()) w.maximize();
  return true;
}
