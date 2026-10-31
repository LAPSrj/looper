// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { MenuItemSpec } from '../../../shared/remote-access';
import { menuForPlatform } from '../../../shared/ui-platform';
import { isEnabled, toolbarFor, type ToolbarGroup, type ToolbarItem } from '../components/toolbar-model';

/**
 * The phone's More (…) menu. By default: the screen's toolbar (PageNav
 * `toolbar`), then the window's menu bar as one submenu row per menu, then
 * This Device on the main window. A page can design it instead (PageNav
 * `more`): groups of its own commands and of references to its toolbar and
 * menu bar, flattened, so the menu shows only what applies to the screen.
 */

/** One entry of a designed More menu. */
export type MoreRef =
  /** A command of the page's own. */
  | { action: MoreAction }
  /** A toolbar item, by id (a split button shows as a submenu). */
  | { toolbar: string }
  /** A menu-bar menu, by its key (the template's id) or label: its items show in its place, its separators as group breaks. */
  | { menu: string }
  /** A menu-bar item anywhere in the menu bar, by its key. */
  | { item: string };

/** A group of entries, set off from the next by a gap. */
export type MoreGroup = MoreRef[];

export interface MoreAction {
  id: string;
  label: string;
  /** An ICONS key. */
  icon?: string;
  /** Hidden while true: a phone's menus show only what can be done now. */
  disabled?: boolean;
  run: () => void;
}

/** The synthetic item the root screen's More menu ends with. */
export const THIS_DEVICE_ITEM = '__looper-this-device';
/** Items the page carries out itself start with this; the rest go to the computer's menu. */
const PAGE = '__page:';

/**
 * Items that destroy or cut something off, as their labels start: red, and
 * last in a menu (HIG: Context menus); a red button in an alert.
 */
export const DESTRUCTIVE = /^(delete|remove|discard|don.t save|unpair|end|stop|clear|overwrite|replace|move to recycle bin)\b/i;
export const isDestructive = (label: string | undefined): boolean => DESTRUCTIVE.test(plain(label));

const plain = (label: string | undefined): string => (label ?? '').replace(/&(&?)/g, (_m, amp: string) => amp);
const sameLabel = (a: string | undefined, b: string): boolean => plain(a).trim().toLowerCase() === plain(b).trim().toLowerCase();

let sepSeq = 0;
const separator = (): MenuItemSpec => ({ id: `__sep${sepSeq++}`, type: 'separator', enabled: true });

/** Without separators doubled or at an edge. */
function tidy(items: MenuItemSpec[]): MenuItemSpec[] {
  const out: MenuItemSpec[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

const joinGroups = (groups: MenuItemSpec[][]): MenuItemSpec[] => tidy(groups.flatMap((g) => (g.length ? [...g, separator()] : [])));

/**
 * A menu as a phone shows it (HIG: Context menus): what can't be done now is
 * hidden, not dimmed; destructive items go last, in a group of their own;
 * submenus left with nothing go too.
 */
export function phoneMenu(items: MenuItemSpec[]): MenuItemSpec[] {
  const keep: MenuItemSpec[] = [];
  const red: MenuItemSpec[] = [];
  for (const it of items) {
    if (it.type === 'separator') {
      keep.push(it);
      continue;
    }
    if (!it.enabled) continue;
    if (it.type === 'submenu') {
      const sub = phoneMenu(it.submenu ?? []);
      if (sub.length) keep.push({ ...it, submenu: sub });
      continue;
    }
    (isDestructive(it.label) ? red : keep).push(it);
  }
  const body = tidy(keep);
  return red.length ? [...body, ...(body.length ? [separator()] : []), ...red] : body;
}

export interface MoreInput {
  /** The screen's toolbar (all platforms; filtered here). */
  toolbar?: ToolbarGroup[];
  /** The ids of the bar's buttons: toolbar items with these ids are already on screen. */
  barIds?: string[];
  /** The window's menu bar, as the computer sent it. */
  menu: MenuItemSpec[] | null;
  /** A designed menu, in place of the default. */
  more?: MoreGroup[];
  /** The label of This Device, on the main window's screen. */
  device?: string;
}

export interface MoreMenu {
  items: MenuItemSpec[];
  /** What the page's own items do, by item id; any other item is the computer's to carry out. */
  run: Map<string, () => void>;
}

/** The More menu of a screen: the designed one when the page gives one, else the default. */
export function composeMore(input: MoreInput): MoreMenu {
  const run = new Map<string, () => void>();
  const toolbar = toolbarFor(input.toolbar ?? [], 'mobile');
  const menu = menuForPlatform(input.menu ?? [], 'mobile');
  const bar = new Set(input.barIds ?? []);

  const page = (id: string, label: string, icon: string | undefined, fn: () => void): MenuItemSpec => {
    const item: MenuItemSpec = { id: PAGE + id, type: 'normal', label, enabled: true };
    if (icon) item.icon = icon;
    run.set(item.id, fn);
    return item;
  };

  /** A toolbar item's rows: a submenu for a split button's entries, else the command and the row that opens the computer's list. */
  const toolbarRows = (it: ToolbarItem): MenuItemSpec[] => {
    if (!isEnabled(it)) return [];
    const primary = it.run ? page(`tb:${it.id}`, it.label, it.icon, it.run) : null;
    if (primary && it.pressed !== undefined) Object.assign(primary, { type: 'checkbox', checked: it.pressed });
    const m = it.menu;
    const entries = m?.items?.filter(isEnabled) ?? [];
    if (m && entries.length) {
      const sub = entries.map((e) => page(`tb:${it.id}/${e.id}`, e.label, e.icon, e.run));
      const row: MenuItemSpec = { id: PAGE + `tbmenu:${it.id}`, type: 'submenu', label: it.label, enabled: true, submenu: primary ? [primary, separator(), ...sub] : sub };
      if (it.icon) row.icon = it.icon;
      return [row];
    }
    if (m?.open) {
      const open = m.open;
      const opener = page(`tbopen:${it.id}`, primary ? m.label : it.label, it.icon, () => open(0, 0));
      return primary ? [primary, opener] : [opener];
    }
    return primary ? [primary] : [];
  };

  const findMenu = (name: string): MenuItemSpec | undefined => menu.find((m) => m.type === 'submenu' && (m.key === name || sameLabel(m.label, name)));
  const findItem = (items: MenuItemSpec[], key: string): MenuItemSpec | undefined => {
    for (const it of items) {
      if (it.key === key) return it;
      const deeper = it.submenu ? findItem(it.submenu, key) : undefined;
      if (deeper) return deeper;
    }
    return undefined;
  };

  let body: MenuItemSpec[];
  if (input.more) {
    body = joinGroups(
      input.more.map((group) =>
        group.flatMap((ref): MenuItemSpec[] => {
          if ('action' in ref) return ref.action.disabled ? [] : [page(`act:${ref.action.id}`, ref.action.label, ref.action.icon, ref.action.run)];
          if ('toolbar' in ref) {
            const it = toolbar.flatMap((g) => g.items).find((x) => x.id === ref.toolbar);
            return it ? toolbarRows(it) : [];
          }
          if ('menu' in ref) return findMenu(ref.menu)?.submenu ?? [];
          const it = findItem(menu, ref.item);
          return it ? [it] : [];
        }),
      ),
    );
  } else {
    const groups = toolbar.map((g) => g.items.filter((it) => !bar.has(it.id)).flatMap(toolbarRows));
    body = joinGroups([...groups, menu]);
  }
  const items = phoneMenu(body);
  if (input.device) {
    if (items.length) items.push(separator());
    items.push({ id: THIS_DEVICE_ITEM, type: 'normal', label: input.device, enabled: true });
  }
  return { items, run };
}

/** A designed menu's own command, by id. */
export function findMoreAction(more: MoreGroup[] | undefined, id: string): MoreAction | undefined {
  for (const g of more ?? []) for (const r of g) if ('action' in r && r.action.id === id) return r.action;
  return undefined;
}
