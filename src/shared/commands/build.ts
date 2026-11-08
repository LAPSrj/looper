// Relative imports only: the main process, the renderer and the unit tests all load the list.
import { PANES_TAB } from '../addons';
import type { MenuItemSpec } from '../remote-access';
import { addonCommandSlots } from './addon-commands';
import { DESKTOP_VIEWS, MENU_BAR, iconOf, labelOf, noMnemonic, type Command, type CommandView, type Entry, type MenuName, type Where } from './command';
import type { CommandContext } from './context';
import { ADDON_SLOTS, COMMANDS } from './list';

const mergedCache = new WeakMap<object, readonly Command[]>();

/** The one list with the started addons' commands in their places (ADDON_SLOTS): what every surface is built from. */
export function commandsOf(c: Pick<CommandContext, 'addons'>): readonly Command[] {
  const slots = addonCommandSlots(c.addons);
  if (!slots) return COMMANDS;
  const cached = mergedCache.get(slots);
  if (cached) return cached;
  const out: Command[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.id === ADDON_SLOTS.rest) out.push(...slots.rest);
    out.push(cmd);
    if (cmd.id === ADDON_SLOTS.new) out.push(...slots.new);
    if (cmd.id === ADDON_SLOTS.tools) out.push(...slots.tools);
  }
  mergedCache.set(slots, out);
  return out;
}

/** An addon's tab of the main window: its panes tab, or one its screen fills. */
function addonTabViews(tab: string): CommandView[] {
  return tab.endsWith(`/${PANES_TAB}`) ? ['addonPanes', 'addonItem', 'addonScreen'] : ['addonScreen'];
}

/**
 * The views a main window shows: with `fixed` a view window of that tab alone,
 * with `item` a task's or project's own window. No tab: before its page says.
 */
export function mainWindowViews(tab?: string, fixed = false, item = false): CommandView[] {
  if (item) return ['frame', tab === 'projects' ? 'project' : 'task'];
  const own: CommandView[] =
    tab === 'dashboard'
      ? ['dashboard', 'task', ...(fixed ? [] : (['project'] as const))]
      : tab === 'tasks'
        ? ['tasks', 'task', ...(fixed ? [] : (['project'] as const))]
        : tab === 'projects'
          ? ['projects', 'project']
          : tab === 'chats'
            ? ['chats', 'conversation', 'chatWindow']
            : tab?.startsWith('addon/')
              ? addonTabViews(tab)
              : [];
  return fixed ? ['new', 'frame', ...own] : ['new', 'frame', 'app', ...own];
}
/** What a main window's toolbar shows: the tab's own, then (the main window's) the buttons placed on every tab, not the other commands its menus keep. */
export function mainToolbarViews(tab?: string, fixed = false, item = false): CommandView[] {
  if (item) return [tab === 'projects' ? 'project' : 'task'];
  const own: CommandView[] =
    tab === 'dashboard'
      ? ['dashboard']
      : tab === 'tasks'
        ? ['tasks', 'task']
        : tab === 'projects'
          ? ['projects', 'project']
          : tab === 'chats'
            ? ['chats', 'conversation']
            : tab?.startsWith('addon/')
              ? addonTabViews(tab)
              : [];
  return fixed ? ['new', ...own] : ['new', ...own, 'app'];
}
export const CHATS_WINDOW_VIEWS: readonly CommandView[] = ['new', 'frame', 'chats', 'conversation', 'chatWindow'];
export const CHAT_WINDOW_VIEWS: readonly CommandView[] = ['frame', 'conversation', 'chatWindow'];
export const HISTORY_VIEWS: readonly CommandView[] = ['history', 'historyItem'];
export const RUN_VIEWS: readonly CommandView[] = ['run'];
export const ENGINE_LOG_VIEWS: readonly CommandView[] = ['engineLog'];
/** A window an addon's screen fills (its openWindow action, or a command that opens one). */
export const ADDON_WINDOW_VIEWS: readonly CommandView[] = ['addonScreen'];

/** Whether the command shows in this view, here and now. */
export function shows(cmd: Command, view: CommandView, c: CommandContext, surface?: 'menu' | 'toolbar'): boolean {
  if (!cmd.in[view]) return false;
  return !cmd.hide?.some((h) => (!h.view || h.view === view) && (!h.surface || h.surface === surface) && (!h.on || h.on.includes(c.here)) && (!h.if || h.if(c)));
}

export const isEnabled = (cmd: Command, c: CommandContext): boolean => cmd.enabled?.(c) ?? true;

/** The first of `views` the command shows in, and its placement there. */
export function placed(cmd: Command, views: readonly CommandView[], c: CommandContext, test: (w: Where) => boolean = () => true, surface?: 'menu' | 'toolbar'): Where | undefined {
  for (const v of views) {
    const w = cmd.in[v];
    if (w && test(w) && shows(cmd, v, c, surface)) return w;
  }
  return undefined;
}

const entrySpec = (prefix: string, e: Entry, at: number): MenuItemSpec => {
  if ('separator' in e) return { id: `${prefix}/-${at}`, type: 'separator', enabled: true };
  const id = `${prefix}/${e.id}`;
  return {
    id,
    type: e.entries ? 'submenu' : e.checked !== undefined ? (e.radio ? 'radio' : 'checkbox') : 'normal',
    label: e.label,
    enabled: e.enabled ?? true,
    ...(e.checked !== undefined ? { checked: e.checked } : {}),
    ...(e.accelerator ? { accelerator: e.accelerator } : {}),
    ...(e.accelerator && e.pageKey ? { registerAccelerator: false as const } : {}),
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.destructive ? { destructive: true as const } : {}),
    ...(e.entries ? { submenu: e.entries.map((x, i) => entrySpec(prefix, x, i)) } : {}),
  };
};

/** A command as a menu's item (several, for one that shows its choices in place). */
export function commandSpec(cmd: Command, c: CommandContext): MenuItemSpec[] {
  const entries = cmd.entries?.(c);
  if (cmd.inline) return (entries ?? []).map((e, i) => entrySpec(cmd.id, e, i));
  // The main process fills it in: it stays a marker with the command's id.
  if (cmd.provided) return [{ id: cmd.id, key: cmd.provided, type: 'normal', label: labelOf(cmd, c), enabled: true }];
  const accelerator = typeof cmd.accelerator === 'function' ? cmd.accelerator(c) : cmd.accelerator;
  const icon = cmd.menuGlyph === false ? undefined : iconOf(cmd, c);
  const checked = cmd.checked?.(c);
  return [
    {
      id: cmd.id,
      key: cmd.id,
      type: entries ? 'submenu' : checked !== undefined ? (cmd.radio ? 'radio' : 'checkbox') : 'normal',
      label: labelOf(cmd, c),
      enabled: isEnabled(cmd, c),
      ...(checked !== undefined ? { checked } : {}),
      ...(accelerator ? { accelerator } : {}),
      ...((typeof cmd.pageKey === 'function' ? cmd.pageKey(c) : cmd.pageKey) ? { registerAccelerator: false as const } : {}),
      ...(icon ? { icon } : {}),
      ...(cmd.role ? { role: cmd.role } : {}),
      ...(cmd.destructive ? { destructive: true as const } : {}),
      ...(entries ? { submenu: entries.map((e, i) => entrySpec(cmd.id, e, i)) } : {}),
    },
  ];
}

/** Items with a separator wherever the group changes. */
function grouped(list: readonly Command[], c: CommandContext): MenuItemSpec[] {
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

/** The views' commands placed in menu `name`, in the list's order. */
function inMenu(views: readonly CommandView[], name: MenuName, c: CommandContext): Command[] {
  return commandsOf(c).filter((cmd) => placed(cmd, views, c, (w) => w.menu === name, 'menu'));
}

/** The menu bar of a window showing these views: the main process draws it, and a click comes back as the item's id. */
export function menuBar(views: readonly CommandView[], c: CommandContext): MenuItemSpec[] {
  return MENU_BAR.flatMap(({ name, label }): MenuItemSpec[] => {
    const submenu = grouped(inMenu(views, name, c), c);
    return submenu.length ? [{ id: `menu-${name}`, key: name, type: 'submenu', label, enabled: true, submenu }] : [];
  });
}

/** A right-click on one of the view's rows or on its screen: the view's menu commands, unless one opts out. */
export function contextMenu(view: CommandView, c: CommandContext): MenuItemSpec[] {
  return grouped(
    commandsOf(c).filter((cmd) => {
      const w = cmd.in[view];
      return !!w?.menu && w.context !== false && shows(cmd, view, c, 'menu');
    }),
    c,
  );
}

/** The commands no phone screen shows: the menu items the More view lists, after the addons' rows. */
export function moreViewCommands(c: CommandContext): Command[] {
  return commandsOf(c).filter((cmd) => {
    const views = Object.keys(cmd.in) as CommandView[];
    if (!views.some((v) => cmd.in[v]?.menu && shows(cmd, v, c))) return false;
    return views.every((v) => DESKTOP_VIEWS.includes(v));
  });
}

const findEntry = (entries: Entry[], prefix: string, id: string): Exclude<Entry, { separator: true }> | undefined => {
  for (const e of entries) {
    if ('separator' in e) continue;
    if (`${prefix}/${e.id}` === id) return e;
    const deeper = e.entries ? findEntry(e.entries, prefix, id) : undefined;
    if (deeper) return deeper;
  }
  return undefined;
};

/** Do what the item with this id does: a command, or a choice of one (`<command>/<entry>`). */
export function runCommand(id: string, c: CommandContext): void {
  const slash = id.indexOf('/');
  const cmd = commandsOf(c).find((x) => x.id === (slash < 0 ? id : id.slice(0, slash)));
  if (!cmd) return;
  if (slash < 0) {
    if (isEnabled(cmd, c)) cmd.run?.(c);
    return;
  }
  findEntry(cmd.entries?.(c) ?? [], cmd.id, id)?.run?.();
}

/** A list's own choices as a popup's items, and what picking each does. */
export function entriesMenu(prefix: string, entries: Entry[]): { items: MenuItemSpec[]; pick: (id: string) => void } {
  return { items: entries.map((e, i) => entrySpec(prefix, e, i)), pick: (id) => findEntry(entries, prefix, id)?.run?.() };
}

/** Why each command stays off a platform: the app's whole list of exceptions, for a test to read. */
export function hiddenReasons(): { id: string; label: string; why: string }[] {
  return COMMANDS.flatMap((cmd) => (cmd.hide ?? []).map((h) => ({ id: cmd.id, label: noMnemonic(typeof cmd.label === 'string' ? cmd.label : cmd.id), why: h.why })));
}
