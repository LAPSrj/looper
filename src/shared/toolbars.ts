// Relative imports only: the main process, the renderer and the unit tests all load it.

/**
 * The main window's own toolbars, in their first order: each one's id (its
 * key in View settings' `toolbars`) and its name in View → Toolbars and the
 * toolbar's right-click menu. An addon's buttons are a toolbar of their own
 * (`addonToolbarId`), turned off in View settings' `hiddenAddonToolbars`.
 */
export const MAIN_TOOLBARS = [
  { id: 'new', label: '&New Toolbar' },
  { id: 'projects', label: '&Projects Toolbar' },
  { id: 'tasks', label: '&Tasks Toolbar' },
  { id: 'chats', label: '&Chats Toolbar' },
] as const;
export type MainToolbarId = (typeof MAIN_TOOLBARS)[number]['id'];

/** An addon's toolbar, as a toolbar row lists it. */
export const addonToolbarId = (addonId: string): string => `addon:${addonId}`;

/** The toolbar of a main window tab's own buttons; none for the Dashboard's and an addon's tab, whose buttons are the addons'. */
export function tabToolbar(tab: string | undefined): MainToolbarId | null {
  return tab === 'projects' || tab === 'tasks' || tab === 'chats' ? tab : null;
}

/**
 * The main window's toolbars a window can show: all four in the main window,
 * New and its tab's in a view window, and its tab's alone in a task's or
 * project's own window.
 */
export function windowToolbars(tab: string | undefined, fixed: boolean, item: boolean): MainToolbarId[] {
  const own = tabToolbar(tab);
  if (item) return own ? [own] : [];
  // A Dashboard window makes nothing; an addon's tab's window has the addon's New items.
  if (fixed) return own ? ['new', own] : tab?.startsWith('addon/') ? ['new'] : [];
  return MAIN_TOOLBARS.map((t) => t.id);
}

/** A toolbar's place in a row: its id and the width its edge was dragged to (0: its buttons' width). */
export interface ToolbarPlace {
  id: string;
  width: number;
}
export type ToolbarRows = ToolbarPlace[][];

/** Where a dragged toolbar goes: into a row, before a toolbar (null: at its end), or into a new row at that index. */
export type ToolbarDrop = { row: number; before: string | null } | { newRow: number };

/** The saved rows with every toolbar of `ids` in them once: one no row lists goes at the end of the first, in `ids`' order. */
export function toolbarRows(saved: ToolbarRows, ids: readonly string[]): ToolbarRows {
  const listed = new Set(saved.flat().map((p) => p.id));
  const missing = [...new Set(ids)].filter((id) => !listed.has(id)).map((id) => ({ id, width: 0 }));
  const rows = saved.filter((r) => r.length).map((r) => [...r]);
  if (!missing.length) return rows;
  if (!rows.length) return [missing];
  rows[0] = [...rows[0], ...missing];
  return rows;
}

/** The rows after the toolbar's grip dropped it at `drop` (row indexes are `rows`'), keeping its width; rows left empty go. */
export function moveToolbar(rows: ToolbarRows, id: string, drop: ToolbarDrop): ToolbarRows {
  const place = rows.flat().find((p) => p.id === id) ?? { id, width: 0 };
  const without = rows.map((r) => r.filter((p) => p.id !== id));
  let out: ToolbarRows;
  if ('newRow' in drop) {
    const at = Math.max(0, Math.min(drop.newRow, without.length));
    out = [...without.slice(0, at), [place], ...without.slice(at)];
  } else {
    out = without.map((r, i) => {
      if (i !== drop.row) return r;
      const before = drop.before === null ? -1 : r.findIndex((p) => p.id === drop.before);
      const at = before < 0 ? r.length : before;
      return [...r.slice(0, at), place, ...r.slice(at)];
    });
  }
  return out.filter((r) => r.length);
}

/** The rows with the toolbar's width set (0: its buttons' width). */
export function resizeToolbar(rows: ToolbarRows, id: string, width: number): ToolbarRows {
  return rows.map((r) => r.map((p) => (p.id === id ? { ...p, width: Math.max(0, Math.round(width)) } : p)));
}
