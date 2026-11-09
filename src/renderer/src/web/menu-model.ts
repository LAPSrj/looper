// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { MenuItemSpec } from '../../../shared/remote-access';

// ---------- keyboard navigation ----------

/** One open list of a menu: its items and the highlighted one (-1 = none). */
export interface MenuLevel {
  items: MenuItemSpec[];
  active: number;
}

/** An open menu and its open submenus, outermost first. */
export type MenuNav = MenuLevel[];

export type MenuEffect =
  | { kind: 'pick'; item: MenuItemSpec }
  /** Tab: the menu closes. */
  | { kind: 'close' }
  /** Esc on the outermost list: the menu closes, and a menu bar keeps its item focused. */
  | { kind: 'escape' }
  /** Left/Right past the edge of a menu bar's menu: open the neighbouring one. */
  | { kind: 'prev' }
  | { kind: 'next' }
  | null;

const selectable = (it: MenuItemSpec | undefined): boolean => !!it && it.type !== 'separator';

/** The next selectable index from `from` in direction `dir`, wrapping; -1 when none. */
export function step(items: MenuItemSpec[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (selectable(items[i])) return i;
  }
  return -1;
}

export const firstItem = (items: MenuItemSpec[]): number => step(items, -1, 1);

/** A menu opened by keyboard starts on its first item; by mouse, on none. */
export function openNav(items: MenuItemSpec[], byKeyboard: boolean): MenuNav {
  return [{ items, active: byKeyboard ? firstItem(items) : -1 }];
}

/** The submenu of `item` as a new level, when it has one to open. */
function subLevel(item: MenuItemSpec | undefined, byKeyboard: boolean): MenuLevel | null {
  if (!item || item.type !== 'submenu' || !item.enabled || !item.submenu?.length) return null;
  return { items: item.submenu, active: byKeyboard ? firstItem(item.submenu) : -1 };
}

/** The item's access key, lower case (the letter its label's `&` marked); undefined when it has none. */
export const accessChar = (it: MenuItemSpec): string | undefined => (it.access === undefined ? undefined : it.label?.[it.access]?.toLocaleLowerCase());

/**
 * Typing a letter that is access keys in the list: the one item with it is picked (its submenu opens);
 * with more than one, the next of them is highlighted. Null when no item has it.
 */
function accessKey(nav: MenuNav, level: MenuLevel, ch: string): { nav: MenuNav; effect: MenuEffect } | null {
  const c = ch.toLocaleLowerCase();
  const hits = level.items.flatMap((it, i) => (selectable(it) && it.enabled && accessChar(it) === c ? [i] : []));
  if (!hits.length) return null;
  if (hits.length > 1) return { nav: replaceLast(nav, { ...level, active: hits.find((i) => i > level.active) ?? hits[0] }), effect: null };
  const item = level.items[hits[0]];
  const at = replaceLast(nav, { ...level, active: hits[0] });
  const sub = subLevel(item, true);
  return sub ? { nav: [...at, sub], effect: null } : { nav: at, effect: { kind: 'pick', item } };
}

/** Typing a letter: the next item whose label starts with it. */
function typeahead(level: MenuLevel, ch: string): number {
  const c = ch.toLocaleLowerCase();
  const n = level.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (level.active + k + n) % n;
    const it = level.items[i];
    if (selectable(it) && (it.label ?? '').trimStart().toLocaleLowerCase().startsWith(c)) return i;
  }
  return level.active;
}

const replaceLast = (nav: MenuNav, level: MenuLevel): MenuNav => [...nav.slice(0, -1), level];

/** A key pressed while the menu is open: the new state and what the frame should do. */
export function menuKey(nav: MenuNav, key: string): { nav: MenuNav; effect: MenuEffect } {
  const level = nav[nav.length - 1];
  if (!level) return { nav, effect: null };
  const item = level.items[level.active];
  switch (key) {
    case 'ArrowDown':
      return { nav: replaceLast(nav, { ...level, active: step(level.items, level.active, 1) }), effect: null };
    case 'ArrowUp':
      return { nav: replaceLast(nav, { ...level, active: step(level.items, level.active < 0 ? 0 : level.active, -1) }), effect: null };
    case 'Home':
      return { nav: replaceLast(nav, { ...level, active: firstItem(level.items) }), effect: null };
    case 'End':
      return { nav: replaceLast(nav, { ...level, active: step(level.items, 0, -1) }), effect: null };
    case 'ArrowRight': {
      const sub = subLevel(item, true);
      return sub ? { nav: [...nav, sub], effect: null } : { nav, effect: { kind: 'next' } };
    }
    case 'ArrowLeft':
      return nav.length > 1 ? { nav: nav.slice(0, -1), effect: null } : { nav, effect: { kind: 'prev' } };
    case 'Enter':
    case ' ': {
      const sub = subLevel(item, true);
      if (sub) return { nav: [...nav, sub], effect: null };
      if (item && item.enabled && item.type !== 'submenu' && item.type !== 'separator') return { nav, effect: { kind: 'pick', item } };
      return { nav, effect: null };
    }
    case 'Escape':
      return nav.length > 1 ? { nav: nav.slice(0, -1), effect: null } : { nav, effect: { kind: 'escape' } };
    case 'Tab':
      return { nav, effect: { kind: 'close' } };
    default:
      if (key.length !== 1 || key === ' ') return { nav, effect: null };
      return accessKey(nav, level, key) ?? { nav: replaceLast(nav, { ...level, active: typeahead(level, key) }), effect: null };
  }
}

/** The pointer moved over item `index` of level `depth`: deeper lists close, a submenu opens. */
export function menuHover(nav: MenuNav, depth: number, index: number): MenuNav {
  const level = nav[depth];
  if (!level) return nav;
  const next = [...nav.slice(0, depth), { ...level, active: index }];
  const sub = subLevel(level.items[index], false);
  return sub ? [...next, sub] : next;
}

/** What a pick sends: a checkbox reports the state it turns to; others nothing. */
export const pickChecked = (item: MenuItemSpec): boolean | undefined => (item.type === 'checkbox' ? !item.checked : undefined);

// ---------- accelerators ----------

export interface Accelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Lowercase: a character ("n", ",") or a key name ("f5", "escape", "arrowup"). */
  key: string;
}

/** The KeyboardEvent fields matching reads. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const KEY_NAMES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  space: ' ',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  plus: '+',
};

/** KeyboardEvent.code of the keys whose character Shift or Alt can change. */
const PUNCTUATION_CODES: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
};

/** "CmdOrCtrl+Shift+N" → its parts; null when it can't be read. CmdOrCtrl is Cmd on a Mac. */
export function parseAccelerator(acc: string, isMac: boolean): Accelerator | null {
  const parts = acc.split('+');
  // "Ctrl++" splits into a trailing empty pair: the key is "+".
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  const a: Accelerator = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const [i, raw] of parts.entries()) {
    const p = raw.trim().toLowerCase();
    if (i < parts.length - 1) {
      if (p === 'cmdorctrl' || p === 'commandorcontrol') isMac ? (a.meta = true) : (a.ctrl = true);
      else if (p === 'ctrl' || p === 'control') a.ctrl = true;
      else if (p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') a.meta = true;
      else if (p === 'alt' || p === 'option' || p === 'altgr') a.alt = true;
      else if (p === 'shift') a.shift = true;
      else return null;
      continue;
    }
    if (!p) return null;
    a.key = KEY_NAMES[p] ?? (/^f([1-9]|1\d|2[0-4])$/.test(p) || p.length === 1 ? p : '');
    if (!a.key) return null;
  }
  return a.key ? a : null;
}

function keyMatches(key: string, e: KeyLike): boolean {
  const k = e.key.toLowerCase();
  if (k === key) return true;
  if (key.length !== 1) return false;
  // Shift or Alt changed the character ("<" for ",", "N" for "n" on some layouts): compare the physical key.
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`;
  return PUNCTUATION_CODES[key] !== undefined && e.code === PUNCTUATION_CODES[key];
}

export function eventMatches(a: Accelerator, e: KeyLike): boolean {
  return a.ctrl === e.ctrlKey && a.alt === e.altKey && a.shift === e.shiftKey && a.meta === e.metaKey && keyMatches(a.key, e);
}

/** Electron's own accelerators for the edit roles, shown next to them (the page handles the keys). */
const ROLE_ACCELERATORS: Record<string, string> = {
  undo: 'CmdOrCtrl+Z',
  redo: 'CmdOrCtrl+Y',
  cut: 'CmdOrCtrl+X',
  copy: 'CmdOrCtrl+C',
  paste: 'CmdOrCtrl+V',
  selectAll: 'CmdOrCtrl+A',
};

/** The shortcut text on the right of an item: "Ctrl+Shift+N" ("Cmd+Shift+N" on a Mac). */
export function shortcutText(item: MenuItemSpec, isMac: boolean): string {
  const acc = item.accelerator ?? (item.role ? ROLE_ACCELERATORS[item.role] : undefined);
  if (!acc) return '';
  const a = parseAccelerator(acc, isMac);
  if (!a) return '';
  const mods = [a.ctrl && 'Ctrl', a.meta && (isMac ? 'Cmd' : 'Win'), a.alt && (isMac ? 'Option' : 'Alt'), a.shift && 'Shift'].filter(Boolean);
  return [...mods, KEY_LABELS[a.key] ?? a.key.toUpperCase()].join('+');
}

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  ' ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
};

/**
 * The item a key press is the accelerator of, enabled or not (a disabled one
 * still keeps the key from the browser); items with registerAccelerator:false
 * are left to the page.
 */
export function findAccelerator(items: MenuItemSpec[], e: KeyLike, isMac: boolean): MenuItemSpec | null {
  for (const it of items) {
    if (it.type === 'submenu') {
      const found = it.submenu ? findAccelerator(it.submenu, e, isMac) : null;
      if (found) return found;
      continue;
    }
    if (it.type === 'separator' || !it.accelerator || it.registerAccelerator === false || it.role) continue;
    const a = parseAccelerator(it.accelerator, isMac);
    if (a && eventMatches(a, e)) return it;
  }
  return null;
}
