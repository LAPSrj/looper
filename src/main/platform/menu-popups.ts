/**
 * Menus that reach past the edges of their window, as Windows' own do: each open level of a desktop window's
 * menu (its menu bar's or a context menu) is drawn in a small window of its own (MenuLevelApp), the way Win32
 * gives each menu level a window. The page that opened the menu keeps the keyboard, the screen reader's copy
 * and the state; the level windows only draw it and send back what the pointer does.
 *
 * A level window costs about 5 MB of the shared page process (scripts/perf/popup-cost.mjs), so they're made on
 * a menu's first use and closed after IDLE_MS without one; until the first is ready, the page draws its menu.
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import type { MenuItemSpec } from '../../shared/remote-access';

/** What a page's open menu shows: its levels, the point it opens at in the page (CSS px), and whether access keys are underlined. */
export interface MenuPopupState {
  levels: { items: MenuItemSpec[]; active: number }[];
  at: { x: number; y: number };
  cues: boolean;
}

/** A box in a page, in CSS px. */
export interface MenuMouseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A level as its window measured it: its size and the top of each item by index, in CSS px from the menu's top. */
export interface MenuLevelLayout {
  width: number;
  height: number;
  tops: Record<number, number>;
  /** Sent back once the window is in place for this layout: its page keeps the menu hidden until then. */
  seq: number;
}

/** The room around a menu in its window, for its shadow. MenuLevelApp draws the menu this far in. */
export const MENU_PAD = 8;
/** How far a submenu overlaps its parent menu. */
const OVERLAP = 3;
/** A submenu's first item lines up with the item that opened it (the menu's own padding). */
const SUBMENU_LIFT = 5;
const IDLE_MS = 5 * 60_000;

interface Level {
  win: BrowserWindow;
  ready: boolean;
  layout: MenuLevelLayout | null;
  shown: boolean;
}

const levels: (Level | undefined)[] = [];
let owner: BrowserWindow | null = null;
let state: MenuPopupState | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let page: { preload: string; load: (w: BrowserWindow, hash: string) => void } | null = null;

/** A menu's level window: shown all the time (see park), so lists of open windows leave it out. */
export function isMenuLevelWindow(w: BrowserWindow): boolean {
  return levels.some((l) => l?.win === w);
}

/** The level windows' page: the windows' own preload, and how a window loads a route. */
export function useMenuPopupPage(p: { preload: string; load: (w: BrowserWindow, hash: string) => void }): void {
  page = p;
}

function make(depth: number): Level {
  const win = new BrowserWindow({
    width: 600,
    height: 800,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    // Zoomed as the window whose menu it shows (zoomTo), not as every page of the origin.
    webPreferences: { preload: page!.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, zoomMode: 'isolated' },
  });
  win.removeMenu();
  const level: Level = { win, ready: false, layout: null, shown: false };
  win.on('closed', () => {
    if (levels[depth] === level) levels[depth] = undefined;
  });
  page!.load(win, `menu-level/${depth}`);
  return level;
}

/**
 * The page `from` opened, changed or closed (null) its menu. True when the level windows draw it; false when
 * the page draws it itself (the first window isn't ready yet), which it then does until that menu closes.
 */
export function showMenuPopups(from: unknown, next: MenuPopupState | null): boolean {
  // A desktop window's only: a phone's or a browser's menus are its own.
  if (!page || process.platform === 'darwin' || !(from instanceof BrowserWindow)) return false;
  if (idle) clearTimeout(idle);
  idle = setTimeout(closeAll, IDLE_MS);
  if (!next) {
    if (owner === from) release();
    return false;
  }
  levels[0] ??= make(0);
  if (!levels[0].ready) return false;
  if (owner !== from) {
    if (owner) release();
    owner = from;
    from.once('closed', () => {
      if (owner === from) release();
    });
  }
  state = next;
  for (let d = 0; d < Math.max(levels.length, next.levels.length); d++) {
    const lv = next.levels[d];
    if (!lv) {
      hideFrom(d);
      break;
    }
    const level = (levels[d] ??= make(d));
    zoomTo(level);
    send(level, { ...lv, cues: next.cues });
  }
  return true;
}

/** The page zoom of the window whose menu is open: its menu is drawn at that zoom, as the menu bar it opens from. */
function ownerZoom(): number {
  return (owner && !owner.isDestroyed() && owner.webContents.getZoomFactor()) || 1;
}

/** The level's page at its owner's zoom, before it draws the owner's menu. */
function zoomTo(level: Level): void {
  const z = ownerZoom();
  const wc = level.win.webContents;
  if (level.ready && !wc.isDestroyed() && wc.getZoomFactor() !== z) wc.setZoomFactor(z);
}

function release(): void {
  hideFrom(0);
  owner = null;
  state = null;
}

function send(level: Level, content: { items: MenuItemSpec[]; active: number; cues: boolean } | null): void {
  if (level.ready && !level.win.isDestroyed() && !level.win.webContents.isDestroyed()) level.win.webContents.send('ui:event', { type: 'menu-level', level: content });
}

function hideFrom(depth: number): void {
  for (let d = depth; d < levels.length; d++) {
    const level = levels[d];
    if (!level || level.win.isDestroyed()) continue;
    // Shrunk once its page has drawn it empty (menuLevelLayout(null)).
    if (level.shown) conceal(level);
    level.shown = false;
    level.layout = null;
    send(level, null);
  }
}

/**
 * Without a menu, a level window stays shown, empty, see-through, letting the pointer through, and as small as Windows
 * allows (it keeps 32 × 39 px). Chromium doesn't draw a hidden window, so a menu shown in one was drawn only once
 * Windows had begun fading it in, and with the page process busy the fade stopped partway and then jumped. A shown
 * window has its menu drawn as it moves into place.
 */
function park(level: Level): void {
  conceal(level);
  const { x, y } = level.win.getBounds();
  level.win.setBounds({ x, y, width: 1, height: 1 });
}

/**
 * Gone from the screen at once: its page shares the windows' thread, and while that's busy the page can't draw it
 * empty. Shrunk before it had, the window went on showing its menu's corner.
 */
function conceal(level: Level): void {
  level.win.setOpacity(0);
  level.win.setIgnoreMouseEvents(true);
}

function closeAll(): void {
  idle = null;
  if (state) return;
  for (const level of levels.splice(0)) if (level && !level.win.isDestroyed()) level.win.destroy();
}

/** A level window's page is ready or has drawn no menu since its last closed (null), or has laid its menu out, which places the window. */
export function menuLevelLayout(from: unknown, depth: number, layout: MenuLevelLayout | null): void {
  const level = levels[depth];
  if (!level || level.win.webContents !== from) return;
  if (!layout && level.ready) {
    if (!level.shown) park(level);
    return;
  }
  if (!layout) {
    level.ready = true;
    // `transparent` alone leaves it opaque white while its page shares the windows' process (process-per-site).
    level.win.setBackgroundColor('#00000000');
    park(level);
    level.win.showInactive();
    // Topmost rather than owned: setParentWindow takes the focus from the owner, whose page then closes the menu.
    level.win.setAlwaysOnTop(true, 'pop-up-menu');
    // A submenu opened while its window loaded.
    const lv = state?.levels[depth];
    if (lv) {
      zoomTo(level);
      send(level, { ...lv, cues: state!.cues });
    }
    return;
  }
  level.layout = layout;
  place(depth);
}

/** The window of level `depth` where it belongs: the first at the menu's point, a submenu beside its item, both kept on the screen. */
function place(depth: number): void {
  const level = levels[depth];
  if (!owner || owner.isDestroyed() || !state || !level?.layout || !state.levels[depth]) return;
  // The level's page is at its owner's zoom (zoomTo), so its CSS px are `z` screen px.
  const z = ownerZoom();
  const width = Math.ceil(level.layout.width * z);
  const height = Math.ceil(level.layout.height * z);
  const pad = Math.round(MENU_PAD * z);
  // The menu's own top-left on the screen; its window is MENU_PAD larger on every side.
  let x: number;
  let y: number;
  if (depth === 0) {
    const content = owner.getContentBounds();
    x = Math.round(content.x + state.at.x * z);
    y = Math.round(content.y + state.at.y * z);
    const work = screen.getDisplayNearestPoint({ x, y }).workArea;
    if (x + width > work.x + work.width) x = Math.max(work.x, work.x + work.width - width);
    // No room below: above the point, as a context menu opens near the bottom of the screen.
    if (y + height > work.y + work.height) y = Math.max(work.y, y - height);
  } else {
    const parent = levels[depth - 1];
    const active = state.levels[depth - 1]?.active ?? -1;
    if (!parent?.shown || !parent.layout || active < 0) return;
    const p = parent.win.getBounds();
    const left = p.x + pad;
    const right = p.x + p.width - pad;
    const work = screen.getDisplayNearestPoint({ x: left, y: p.y }).workArea;
    const overlap = Math.round(OVERLAP * z);
    x = right - overlap;
    if (x + width > work.x + work.width) x = Math.max(work.x, left + overlap - width);
    y = Math.round(p.y + pad + ((parent.layout.tops[active] ?? 0) - SUBMENU_LIFT) * z);
    if (y + height > work.y + work.height) y = Math.max(work.y, work.y + work.height - height);
  }
  level.win.setBounds({ x: x - pad, y: y - pad, width: width + 2 * pad, height: height + 2 * pad });
  if (!level.win.webContents.isDestroyed()) level.win.webContents.send('ui:event', { type: 'menu-level-placed', seq: level.layout.seq });
  if (!level.shown) {
    level.win.setIgnoreMouseEvents(false);
    level.win.setOpacity(1);
    level.shown = true;
  }
  if (levels[depth + 1]?.layout) place(depth + 1);
}

/** The pointer on a level window: the page that owns the menu carries it out. */
export function menuLevelInput(from: unknown, depth: number, index: number, kind: 'hover' | 'choose'): void {
  const level = levels[depth];
  if (!level || level.win.webContents !== from || !owner || owner.isDestroyed()) return;
  owner.webContents.send('ui:event', { type: 'menu-popup-input', depth, index, kind });
}

/** Where each window's page with an open menu still takes the mouse: what it draws of the menu, its menu bar. */
const mouseHolds = new WeakMap<BrowserWindow, MenuMouseRect[]>();
const holding = new WeakSet<WebContents>();

/**
 * The page `from` opened its menu (the boxes that still take the mouse) or closed it (null). Meanwhile, as under
 * Win32's menus, the rest of its window gets no moves, so nothing there hovers, while a press still reaches it (and
 * closes the menu). The page holds the wheel itself: before-mouse-event doesn't see it.
 */
export function holdMenuMouse(from: unknown, live: MenuMouseRect[] | null): void {
  if (!(from instanceof BrowserWindow) || from.isDestroyed() || process.platform === 'darwin') return;
  const wc = from.webContents;
  if (!live) {
    mouseHolds.delete(from);
    return;
  }
  const started = !mouseHolds.has(from);
  mouseHolds.set(from, live);
  if (!holding.has(wc)) {
    holding.add(wc);
    wc.on('before-mouse-event', (event, mouse) => {
      const boxes = mouseHolds.get(from);
      if (!boxes || mouse.type === 'mouseUp' || mouse.type === 'contextMenu' || mouse.type === 'mouseLeave') return;
      const zoom = wc.getZoomFactor() || 1;
      const x = mouse.x / zoom;
      const y = mouse.y / zoom;
      if (boxes.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) return;
      // A press outside closes the menu: the moves of its drag are the page's again.
      if (mouse.type === 'mouseDown') mouseHolds.delete(from);
      else event.preventDefault();
    });
  }
  // What the pointer rests on (a right-clicked row) stops hovering, so its tooltip doesn't show beside the menu.
  if (started) wc.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 });
}
