// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { MenuItemSpec } from '../../../shared/remote-access';
import { isEnabled, toolbarFor, type ToolbarGroup, type ToolbarItem } from '../components/toolbar-model';

/**
 * The phone's More (…) menu: the toolbar a page reports (an addon's buttons, a
 * terminal's text size), then the screen's commands from the one list.
 */

/** A screen's commands for its More menu: the items as data, and what picking one does. */
export interface MoreMenuInput {
  items: MenuItemSpec[];
  run: (id: string) => void;
}

/** Items the page carries out itself start with this. */
const PAGE = '__page:';

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
 * hidden, not dimmed; the items marked destructive go last, in a group of
 * their own; submenus left with nothing go too.
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
    (it.destructive ? red : keep).push(it);
  }
  const body = tidy(keep);
  return red.length ? [...body, ...(body.length ? [separator()] : []), ...red] : body;
}

export interface MoreInput {
  /** A toolbar the page reports (all platforms; filtered here). */
  toolbar?: ToolbarGroup[];
  /** The screen's commands. */
  more?: MoreMenuInput;
}

export interface MoreMenu {
  items: MenuItemSpec[];
  /** What each item does, by its id. */
  run: Map<string, () => void>;
}

/** The More menu of a screen. */
export function composeMore(input: MoreInput): MoreMenu {
  const run = new Map<string, () => void>();

  const page = (id: string, label: string, icon: string | undefined, fn: () => void): MenuItemSpec => {
    const item: MenuItemSpec = { id: PAGE + id, type: 'normal', label, enabled: true };
    if (icon) item.icon = icon;
    run.set(item.id, fn);
    return item;
  };

  /** A toolbar item's rows: a submenu for a split button's entries, else the command and the row that opens its list. */
  const toolbarRows = (it: ToolbarItem): MenuItemSpec[] => {
    if (!isEnabled(it)) return [];
    const primary = it.run ? page(`tb:${it.id}`, it.label, it.icon, it.run) : null;
    if (primary && it.pressed !== undefined) Object.assign(primary, { type: 'checkbox', checked: it.pressed });
    if (primary && it.destructive) primary.destructive = true;
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

  /** A command's rows carry its id with the page mark, so a pick runs in the page. */
  const commandRows = (items: MenuItemSpec[]): MenuItemSpec[] =>
    items.map((it) => {
      if (it.type === 'separator') return it;
      if (it.submenu) return { ...it, id: PAGE + `cmd:${it.id}`, submenu: commandRows(it.submenu) };
      const id = PAGE + `cmd:${it.id}`;
      run.set(id, () => input.more?.run(it.id));
      return { ...it, id };
    });

  const groups = toolbarFor(input.toolbar ?? [], 'mobile').map((g) => g.items.flatMap(toolbarRows));
  return { items: phoneMenu(joinGroups([...groups, commandRows(input.more?.items ?? [])])), run };
}
