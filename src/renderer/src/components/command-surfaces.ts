// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import { commandSpec, commandsOf, entriesMenu, isEnabled, placed, runCommand } from '../../../shared/commands/build';
import { iconOf, labelOf, noMnemonic, plainLabel, type Command, type CommandView, type Entry, type LabelOf } from '../../../shared/commands/command';
import type { CommandContext } from '../../../shared/commands/context';
import type { MenuItemSpec } from '../../../shared/remote-access';
import { hint } from '../../../shared/shortcuts';
import type { PageNavAction, PageNavMenuEntry } from '../web/nav-bar-model';
import type { ToolbarGroup, ToolbarItem } from './toolbar-model';

const textOf = (label: LabelOf | undefined, c: CommandContext): string | undefined => (typeof label === 'function' ? label(c) : label);
/** What a toolbar or a phone's bar calls it. */
const shortLabel = (cmd: Command, c: CommandContext): string => plainLabel(cmd.alt?.when(c) ? cmd.alt.label : (textOf(cmd.toolbarLabel, c) ?? labelOf(cmd, c)));

/** Show a list's choices in a popup, at a point in the window or at the finger. */
export function popupEntries(c: CommandContext, prefix: string, entries: Entry[], at?: { x: number; y: number }): void {
  const { items, pick } = entriesMenu(prefix, entries);
  void c.looper.commands.popup(items, at).then((id) => id && pick(id));
}

/** Show a menu built from commands (a right-click), and do what's picked with the same state. */
export function popupCommands(c: CommandContext, items: MenuItemSpec[], at?: { x: number; y: number }): void {
  if (items.length) void c.looper.commands.popup(items, at).then((id) => id && runCommand(id, c));
}

function toolbarItem(cmd: Command, c: CommandContext): ToolbarItem {
  const accelerator = typeof cmd.accelerator === 'function' ? cmd.accelerator(c) : cmd.accelerator;
  const icon = iconOf(cmd, c);
  const entries = cmd.entries?.(c);
  const canRun = isEnabled(cmd, c);
  const item: ToolbarItem = { id: cmd.id, label: shortLabel(cmd, c), enabled: canRun, run: entries && !hasPrimary(cmd, c) ? null : () => runCommand(cmd.id, c) };
  if (accelerator) item.shortcut = hint(accelerator);
  if (icon) item.icon = icon;
  if (cmd.labeled || !icon) item.labeled = true;
  if (cmd.checked) item.pressed = cmd.checked(c);
  if (cmd.destructive) item.destructive = true;
  if (entries) {
    item.menu = { label: plainLabel(textOf(cmd.dropdown, c) ?? labelOf(cmd, c)), open: (x, y) => popupEntries(c, cmd.id, entries, { x, y }) };
  } else if (cmd.openDropdown) {
    item.menu = { label: plainLabel(textOf(cmd.dropdown, c) ?? labelOf(cmd, c)), open: (x, y) => cmd.openDropdown!(c, x, y) };
  }
  return item;
}

const hasPrimary = (cmd: Command, c: CommandContext): boolean => !!cmd.run && (cmd.runnable?.(c) ?? true);

/** The toolbar of a window showing these views, a separator between groups. */
export function commandToolbar(views: readonly CommandView[], c: CommandContext): ToolbarGroup[] {
  const groups: ToolbarGroup[] = [];
  const atEnd = new Set<string>();
  for (const cmd of commandsOf(c)) {
    if (!placed(cmd, views, c, (w) => !!w.toolbar, 'toolbar')) continue;
    if (cmd.toolbarLast) atEnd.add(cmd.id);
    const id = cmd.toolbarGroup ?? cmd.group;
    const last = groups.find((g) => g.id === id);
    if (last) last.items.push(toolbarItem(cmd, c));
    else groups.push({ id, items: [toolbarItem(cmd, c)] });
  }
  if (atEnd.size) for (const g of groups) g.items.sort((a, b) => Number(atEnd.has(a.id)) - Number(atEnd.has(b.id)));
  return groups;
}

const actionEntry = (e: Entry, at: number): PageNavMenuEntry => {
  if ('separator' in e) return { id: `-${at}`, label: '', separator: true, run: () => undefined };
  return {
    id: e.id,
    label: noMnemonic(e.label),
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.enabled === false ? { enabled: false } : {}),
    ...(e.destructive ? { destructive: true as const } : {}),
    ...(e.checked !== undefined ? { checked: e.checked, type: e.radio ? ('radio' as const) : ('checkbox' as const) } : {}),
    ...(e.entries ? { submenu: e.entries.map(actionEntry) } : {}),
    run: () => e.run?.(),
  };
};

/** The bar buttons that fit, by view: a title takes the rest of the row. */
const BAR_SLOTS: Partial<Record<CommandView, number>> = { conversation: 3, chats: 3, task: 2, project: 2, tasks: 2, addonPanes: 2, addonItem: 2, addonScreen: 2 };

/** The commands on a phone's bar right now: the view's main ones that can run, in the list's order, as many as fit. */
export function phoneBarCommands(views: readonly CommandView[], c: CommandContext, extraSlots = 0): Command[] {
  const hasBox = c.chats?.summary?.kind === 'chat';
  const slots = (BAR_SLOTS[views[0]] ?? 1) + extraSlots;
  return commandsOf(c).filter((cmd) => {
    const w = placed(cmd, views, c, (x) => !!x.main);
    return !!w && !(hasBox && w.box) && isEnabled(cmd, c);
  }).slice(0, slots);
}

/** A phone's bar buttons. */
export function phoneActions(views: readonly CommandView[], c: CommandContext, extraSlots = 0): PageNavAction[] {
  return phoneBarCommands(views, c, extraSlots).map((cmd) => {
    const icon = iconOf(cmd, c);
    const entries = cmd.entries?.(c);
    return {
      id: cmd.id,
      label: shortLabel(cmd, c),
      ...(icon ? { icon } : {}),
      ...(cmd.ring ? { ring: cmd.ring(c) } : {}),
      ...(cmd.on?.(c) ? { on: true } : {}),
      ...(entries ? { menu: entries.map(actionEntry) } : {}),
      run: () => runCommand(cmd.id, c),
    };
  });
}

/** A phone's More menu of these views: everything else they have, what's in the message box and on the bar left out. */
export function phoneMore(views: readonly CommandView[], c: CommandContext, extraSlots = 0): MenuItemSpec[] {
  const bar = new Set(phoneBarCommands(views, c, extraSlots));
  const hasBox = c.chats?.summary?.kind === 'chat';
  const list = commandsOf(c).filter((cmd) => {
    const w = placed(cmd, views, c);
    return !!w && !bar.has(cmd) && !(hasBox && w.box) && (!!w.menu || !!w.toolbar || !!w.main);
  });
  const out: MenuItemSpec[] = [];
  let group: string | undefined;
  for (const cmd of list) {
    const items = commandSpec(cmd, c);
    if (!items.length) continue;
    if (group !== undefined && cmd.group !== group) out.push({ id: `-${out.length}`, type: 'separator', enabled: true });
    group = cmd.group;
    out.push(...items);
  }
  return out;
}

/**
 * The More menu's commands that are buttons on the desktop's toolbar and can
 * stand as one in a phone's menu: a plain action with an icon, as the toolbar
 * labels it. Each id is also one of phoneMore's items.
 */
export function phoneMoreToolbar(views: readonly CommandView[], c: CommandContext, extraSlots = 0): MenuItemSpec[] {
  const bar = new Set(phoneBarCommands(views, c, extraSlots));
  const hasBox = c.chats?.summary?.kind === 'chat';
  return commandsOf(c).flatMap((cmd): MenuItemSpec[] => {
    const w = placed(cmd, views, c, (x) => !!x.toolbar);
    const icon = iconOf(cmd, c);
    if (!w || !icon || bar.has(cmd) || (hasBox && w.box) || !isEnabled(cmd, c)) return [];
    if (cmd.entries || cmd.checked || cmd.destructive || cmd.ring || cmd.provided || cmd.role) return [];
    return [{ id: cmd.id, type: 'normal', label: shortLabel(cmd, c), enabled: true, icon }];
  });
}

/** A screen's bar and More menu, as NavBar takes them. */
export function phoneNav(
  views: readonly CommandView[],
  c: CommandContext,
  extraSlots = 0,
): { actions: PageNavAction[]; more: { items: MenuItemSpec[]; toolbar: MenuItemSpec[]; run: (id: string) => void } } {
  return {
    actions: phoneActions(views, c, extraSlots),
    more: { items: phoneMore(views, c, extraSlots), toolbar: phoneMoreToolbar(views, c, extraSlots), run: (id) => runCommand(id, c) },
  };
}
