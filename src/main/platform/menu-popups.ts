/**
 * Menus that reach past the edges of their window, as Windows' own do: each open level of a desktop window's
 * menu (its menu bar's or a context menu) is drawn in a small window of its own (MenuLevelApp), the way Win32
 * gives each menu level a window. The page that opened the menu keeps the keyboard, the screen reader's copy
 * and the state; the level windows only draw it and send back what the pointer does.
 *
 * A level window costs about 5 MB of the shared page process (scripts/perf/popup-cost.mjs), so they're made on
 * a menu's first use and closed after IDLE_MS without one; until the first is ready, the page draws its menu.
 */
import { BrowserWindow, screen } from 'electron';
import type { MenuItemSpec } from '../../shared/remote-access';

/** What a page's open menu shows: its levels, the point it opens at in the page (CSS px), and whether access keys are underlined. */
export interface MenuPopupState {
  levels: { items: MenuItemSpec[]; active: number }[];
  at: { x: number; y: number };
  cues: boolean;
}

/** A level as its window measured it: its size and the top of each item by index, in CSS px from the menu's top. */
export interface MenuLevelLayout {
  width: number;
  height: number;
  tops: Record<number, number>;
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
    webPreferences: { preload: page!.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
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
    send(level, { ...lv, cues: next.cues });
  }
  return true;
}

function release(): void {
  hideFrom(0);
  owner = null;
  state = null;
}

function send(level: Level, content: { items: MenuItemSpec[]; active: number; cues: boolean } | null): void {
  if (level.ready && !level.win.isDestroyed()) level.win.webContents.send('ui:event', { type: 'menu-level', level: content });
}

function hideFrom(depth: number): void {
  for (let d = depth; d < levels.length; d++) {
    const level = levels[d];
    if (!level || level.win.isDestroyed()) continue;
    if (level.shown) level.win.hide();
    level.shown = false;
    level.layout = null;
    send(level, null);
  }
}

function closeAll(): void {
  idle = null;
  if (state) return;
  for (const level of levels.splice(0)) if (level && !level.win.isDestroyed()) level.win.destroy();
}

/** A level window's page is ready (null), or has laid its menu out, which places the window. */
export function menuLevelLayout(from: unknown, depth: number, layout: MenuLevelLayout | null): void {
  const level = levels[depth];
  if (!level || level.win.webContents !== from) return;
  if (!layout) {
    level.ready = true;
    // A submenu opened while its window loaded.
    const lv = state?.levels[depth];
    if (lv) send(level, { ...lv, cues: state!.cues });
    return;
  }
  level.layout = layout;
  place(depth);
}

/** The window of level `depth` where it belongs: the first at the menu's point, a submenu beside its item, both kept on the screen. */
function place(depth: number): void {
  const level = levels[depth];
  if (!owner || owner.isDestroyed() || !state || !level?.layout || !state.levels[depth]) return;
  const { width, height } = level.layout;
  // The menu's own top-left on the screen; its window is MENU_PAD larger on every side.
  let x: number;
  let y: number;
  if (depth === 0) {
    const content = owner.getContentBounds();
    const zoom = owner.webContents.getZoomFactor() || 1;
    x = Math.round(content.x + state.at.x * zoom);
    y = Math.round(content.y + state.at.y * zoom);
    const work = screen.getDisplayNearestPoint({ x, y }).workArea;
    if (x + width > work.x + work.width) x = Math.max(work.x, work.x + work.width - width);
    // No room below: above the point, as a context menu opens near the bottom of the screen.
    if (y + height > work.y + work.height) y = Math.max(work.y, y - height);
  } else {
    const parent = levels[depth - 1];
    const active = state.levels[depth - 1]?.active ?? -1;
    if (!parent?.shown || !parent.layout || active < 0) return;
    const p = parent.win.getBounds();
    const left = p.x + MENU_PAD;
    const right = p.x + p.width - MENU_PAD;
    const work = screen.getDisplayNearestPoint({ x: left, y: p.y }).workArea;
    x = right - OVERLAP;
    if (x + width > work.x + work.width) x = Math.max(work.x, left + OVERLAP - width);
    y = p.y + MENU_PAD + (parent.layout.tops[active] ?? 0) - SUBMENU_LIFT;
    if (y + height > work.y + work.height) y = Math.max(work.y, work.y + work.height - height);
  }
  level.win.setBounds({ x: x - MENU_PAD, y: y - MENU_PAD, width: width + 2 * MENU_PAD, height: height + 2 * MENU_PAD });
  if (!level.shown) {
    if (level.win.getParentWindow() !== owner) level.win.setParentWindow(owner);
    level.win.showInactive();
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
