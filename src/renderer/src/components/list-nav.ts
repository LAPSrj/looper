/**
 * The keyboard model of a list (no React, no DOM, so it runs in a test): which key
 * moves the selection, opens, deletes or renames the row, opens or closes a
 * folder, or asks for the row's context menu. `useListNav` (hooks.ts) is the hook
 * that applies it to a list's `onKeyDown`.
 */

/** What a list needs to answer the keys. Rows are indexed top to bottom, as they show. */
export interface ListNavModel {
  count: number;
  /** The active row, -1 when none is. */
  index: number;
  onIndex: (i: number) => void;
  /** Enter on the active row (preventDefault + stopPropagation). */
  onActivate?: (i: number) => void;
  /** Delete on the active row: the row's own Delete command, which asks first when it needs to. */
  onDelete?: (i: number) => void;
  /** F2 on the active row. */
  onRename?: (i: number) => void;
  /** Shift+F10 or the Menu key: open the row's context menu. */
  onMenu?: (i: number) => void;
  /** A tree: rows that open and close (a folder or group header). */
  tree?: {
    /** Whether row i is open, false when closed, undefined for a row that holds nothing. */
    expanded: (i: number) => boolean | undefined;
    set: (i: number, open: boolean) => void;
    /** The row that holds row i, -1 at the top level. */
    parent: (i: number) => number;
  };
}

/** The part of a keyboard event the model reads. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

/** When the keyboard last asked for a row's menu, so the `contextmenu` event that follows isn't answered twice. */
let keyMenuAt = 0;
const KEY_MENU_MS = 500;

/** Shift+F10 and the Menu key. */
export const isMenuKey = (e: Pick<KeyLike, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey'>) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && !!e.shiftKey && !e.ctrlKey && !e.altKey);

/** Row `i`'s parent in a flat tree given each row's depth: the nearest row above it that is shallower. -1 at the top. */
export function parentIndex(depths: readonly number[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (depths[j] < depths[i]) return j;
  return -1;
}

/** Applies the key to the list; true when the list handled it (the caller has nothing left to do). */
export function listNavKey(e: KeyLike, m: ListNavModel, now: () => number = Date.now): boolean {
  const { count, index: i } = m;
  if (!count) return false;
  const done = () => {
    e.preventDefault();
    return true;
  };
  if (isMenuKey(e)) {
    if (!m.onMenu || i < 0) return false;
    keyMenuAt = now();
    m.onMenu(i);
    return done();
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  switch (e.key) {
    case 'ArrowDown':
      m.onIndex(i < 0 ? 0 : Math.min(count - 1, i + 1));
      return done();
    case 'ArrowUp':
      m.onIndex(i < 0 ? 0 : Math.max(0, i - 1));
      return done();
    case 'Home':
      m.onIndex(0);
      return done();
    case 'End':
      m.onIndex(count - 1);
      return done();
    case 'Enter':
      if (!m.onActivate) return false;
      e.stopPropagation?.();
      if (i >= 0) m.onActivate(i);
      return done();
    case 'Delete':
      if (!m.onDelete || i < 0) return false;
      m.onDelete(i);
      return done();
    case 'F2':
      if (!m.onRename || i < 0) return false;
      m.onRename(i);
      return done();
    case 'ArrowLeft': {
      if (!m.tree || i < 0) return false;
      if (m.tree.expanded(i) === true) {
        m.tree.set(i, false);
        return done();
      }
      const up = m.tree.parent(i);
      if (up < 0) return false;
      m.onIndex(up);
      return done();
    }
    case 'ArrowRight': {
      if (!m.tree || i < 0) return false;
      const open = m.tree.expanded(i);
      if (open === false) {
        m.tree.set(i, true);
        return done();
      }
      if (open === true && i + 1 < count) {
        m.onIndex(i + 1);
        return done();
      }
      return false;
    }
    case ' ': {
      if (!m.tree || i < 0) return false;
      const open = m.tree.expanded(i);
      if (open === undefined) return false;
      m.tree.set(i, !open);
      return done();
    }
    default:
      return false;
  }
}

/**
 * A list's own `contextmenu` event (its target is the list, not a row): the
 * keyboard's request opens the active row's menu, a right click on the empty
 * space opens the list's own. The keyboard's request is the one the Menu key or
 * Shift+F10 already answered (a `contextmenu` event follows within a moment of
 * the key), or a `contextmenu` event with button 0, which no mouse click has.
 */
export function listContextMenu(
  e: { target: unknown; currentTarget: unknown; button: number; preventDefault: () => void },
  index: number,
  onRow: (i: number) => void,
  onEmpty?: () => void,
  now: () => number = Date.now,
): void {
  if (e.target !== e.currentTarget) return;
  e.preventDefault();
  if (now() - keyMenuAt < KEY_MENU_MS) return;
  if (index >= 0 && e.button === 0) onRow(index);
  else onEmpty?.();
}

/**
 * Enter presses a dialog's default button wherever focus is, except where Enter
 * means something else: a multi-line box (a new line), a button or link (it
 * clicks), a drop-down (it opens) and a disclosure.
 */
export function enterPressesDefault(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return true;
  if (el.isContentEditable) return false;
  return !['TEXTAREA', 'BUTTON', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName);
}

/** Enter or Space on an element that acts as a button (role="button"), not on a control inside it: runs `run`. */
export const pressKeys =
  (run: () => void) =>
  (e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    run();
  };
