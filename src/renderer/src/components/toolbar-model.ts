// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import { showsOn, type UiPlatform } from '../../../shared/ui-platform';

/**
 * A toolbar as data: the desktop draws it as a row of buttons (Toolbar.tsx),
 * a phone puts it in its More menu (PageNav `toolbar`). Groups are split by
 * separators on the desktop and by gaps in a menu.
 */
export interface ToolbarGroup {
  id: string;
  items: ToolbarItem[];
  /** Where the group shows; unset: everywhere. */
  platforms?: UiPlatform[];
}

export interface ToolbarItem {
  id: string;
  /** The command's name: the tooltip and accessible name, the label beside the icon or in a menu. */
  label: string;
  /** Its keyboard shortcut, shown in the desktop tooltip ("F5", "Ctrl+P"). */
  shortcut?: string;
  /** An ICONS key (components/icons.tsx). */
  icon?: string;
  /** Show the label beside the icon on the desktop (an addon's buttons). */
  labeled?: boolean;
  /** Default true. */
  enabled?: boolean;
  /** A toggle that's on (the dashboard showing). */
  pressed?: boolean;
  platforms?: UiPlatform[];
  /** It destroys or cuts something off (Delete, Stop, Close): a phone's menu row for it carries the mark. */
  destructive?: true;
  /** The command; null with a `menu`: there's no current place, so the button opens the menu. */
  run?: (() => void) | null;
  /** A split button's list of places. */
  menu?: ToolbarMenu;
}

/** A split button's list: entries the phone shows as a submenu, or a menu the computer opens at a point (`open`). */
export interface ToolbarMenu {
  /** The arrow's tooltip, and the phone's row that opens the computer's menu ("New Chat in Project"). */
  label: string;
  open?: (x: number, y: number) => void;
  items?: ToolbarMenuEntry[];
}

export interface ToolbarMenuEntry {
  id: string;
  label: string;
  icon?: string;
  enabled?: boolean;
  platforms?: UiPlatform[];
  run: () => void;
}

export const isEnabled = (it: { enabled?: boolean }): boolean => it.enabled !== false;

/** The groups and items that show on `here`, without groups left empty. */
export function toolbarFor(groups: ToolbarGroup[], here: UiPlatform): ToolbarGroup[] {
  return groups.flatMap((g) => {
    if (!showsOn(g.platforms, here)) return [];
    const items = g.items
      .filter((it) => showsOn(it.platforms, here))
      .map((it) => (it.menu?.items ? { ...it, menu: { ...it.menu, items: it.menu.items.filter((e) => showsOn(e.platforms, here)) } } : it));
    return items.length ? [{ ...g, items }] : [];
  });
}

/**
 * Where a bottom toolbar's items sit on a phone, around its status in the middle: the groups at the leading edge and
 * the groups at the trailing edge, each a list of item ids that share one background (iOS: one glass capsule, groups
 * split by a fixed space; HIG Toolbars, UIToolbar "Split the toolbar's shared background").
 */
export interface BottomBarPlaces {
  leading: string[][];
  trailing: string[][];
}

/** Items that share a background: a run of symbols; a text item is always alone ("be sure to not group symbols with text", WWDC25 356). */
function sharedRuns(items: ToolbarItem[]): ToolbarItem[][] {
  const runs: ToolbarItem[][] = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    if (it.icon && last?.[0].icon) last.push(it);
    else runs.push([it]);
  }
  return runs;
}

/**
 * A bottom toolbar's groups on a phone, from the same toolbar data the desktop draws and the places it's given: the
 * items that show on `here`, grouped as `places` says and cut where text meets a symbol, and the items `places`
 * doesn't name after the trailing groups, so nothing the desktop shows is left out.
 */
export function bottomBarGroups(groups: ToolbarGroup[], places: BottomBarPlaces, here: UiPlatform): { leading: ToolbarItem[][]; trailing: ToolbarItem[][] } {
  const items = new Map(toolbarFor(groups, here).flatMap((g) => g.items.map((it) => [it.id, it] as const)));
  const named = new Set([...places.leading, ...places.trailing].flat());
  const side = (list: string[][]) => list.flatMap((ids) => sharedRuns(ids.flatMap((id) => items.get(id) ?? [])));
  const rest = [...items.values()].filter((it) => !named.has(it.id));
  return { leading: side(places.leading), trailing: [...side(places.trailing), ...sharedRuns(rest)] };
}

/** A toolbar item by id, and a split button's entry by "<item>/<entry>". */
export function findToolbarItem(groups: ToolbarGroup[] | undefined, id: string): ToolbarItem | ToolbarMenuEntry | undefined {
  const slash = id.indexOf('/');
  const itemId = slash < 0 ? id : id.slice(0, slash);
  const item = groups?.flatMap((g) => g.items).find((it) => it.id === itemId);
  return slash < 0 ? item : item?.menu?.items?.find((e) => e.id === id.slice(slash + 1));
}

/** Groups split at a list's separators ({ separator: true }), as an addon's toolbar gives them. */
export function groupsAtSeparators<T>(items: (T | { separator: true })[], toItem: (it: T) => ToolbarItem, prefix: string): ToolbarGroup[] {
  const groups: ToolbarGroup[] = [{ id: `${prefix}0`, items: [] }];
  for (const it of items) {
    if (typeof it === 'object' && it !== null && 'separator' in it) groups.push({ id: `${prefix}${groups.length}`, items: [] });
    else groups[groups.length - 1].items.push(toItem(it as T));
  }
  return groups.filter((g) => g.items.length);
}

/** What a toolbar's JSON key holds: everything but the callbacks, for knowing when it changed. */
export function toolbarKey(groups: ToolbarGroup[] | undefined): string {
  return JSON.stringify(groups ?? null, (_k, v) => (typeof v === 'function' ? true : v));
}
