// Relative imports only: the main process, the renderer and the unit tests all load the list.
import { addonIconKey, commandEntries, commandMenu, type AddonCommand, type AddonCommandState, type AddonEntry, type AddonEventSource, type AddonInfo, type AddonPlace, type AddonPlacement } from '../addons';
import { addonTabId } from '../main-tabs';
import { keyId } from '../shortcuts';
import { UI_PLATFORMS } from '../ui-platform';
import type { Command, CommandView, Entry, Hide, Where } from './command';
import type { CommandContext } from './context';

/**
 * An addon's commands as the one list's own (Command), so every surface draws
 * them as it draws Looper's. They go into the list's order in three places:
 * with Looper's New items, in Tools before the settings, and the rest before
 * File's Close and Exit (ADDON_SLOTS in list.ts).
 */
export interface AddonCommandSlots {
  new: Command[];
  tools: Command[];
  rest: Command[];
}

/** The view of the one list each of the manifest's places is. */
const VIEW_OF: Record<Exclude<AddonPlace, 'new'>, CommandView> = {
  app: 'app',
  dashboard: 'dashboard',
  projects: 'projects',
  tasks: 'tasks',
  chats: 'chats',
  panes: 'addonPanes',
  item: 'addonItem',
  screen: 'addonScreen',
};

/** The places in Looper's own windows: a command placed there always has something to act on. */
const LOOPER_PLACES: readonly AddonPlace[] = ['new', 'app', 'dashboard', 'projects', 'tasks', 'chats'];

export const addonCommandId = (addonId: string, commandId: string): string => `addon:${addonId}:${commandId}`;

/** How the window's panes, picked item and screen say the command is now; the most specific wins. */
function stateOf(c: CommandContext, addonId: string, id: string): AddonCommandState {
  const own = c.addon;
  if (own?.id !== addonId) return {};
  return { ...own.panes?.state?.[id], ...own.item?.state?.[id], ...own.screen?.state?.[id] };
}

const screenMatches = (cmd: AddonCommand, view: string): boolean => !cmd.in.screen?.views || cmd.in.screen.views.includes(view);

/** What it acts on here: the item picked, the screen showing, the pane, or Looper's window; null when it's placed nowhere that shows. */
function targetOf(c: CommandContext, addonId: string, cmd: AddonCommand): { item?: { pane: string; id: string }; screen?: true; source?: AddonEventSource } | null {
  const own = c.addon?.id === addonId ? c.addon : undefined;
  if (cmd.in.item && own?.item) return { item: own.item };
  if (cmd.in.screen && own?.screen && screenMatches(cmd, own.screen.view)) return { screen: true };
  if (cmd.in.panes && own?.panes) return { source: { pane: own.panes.pane } };
  if (LOOPER_PLACES.some((p) => cmd.in[p])) return { source: { app: true } };
  return null;
}

/** Show the tab it opens here, or from any other window in the tab's own window. */
function openTabOf(c: CommandContext, tab: string): void {
  if (c.openTab) c.openTab(tab);
  else c.host('open-view', tab);
}

/** Do what the command, or one of its submenu's items, does: it acts where the command is placed. */
function run(c: CommandContext, a: AddonInfo, cmd: AddonCommand, action: AddonCommand | AddonEntry): void {
  if (action.opens) {
    const opens = action.opens;
    const open = () => ('tab' in opens ? openTabOf(c, addonTabId(a.id, opens.tab)) : void c.looper.addons.open(a.id, action.id));
    if (action.confirm) void c.looper.confirm(action.confirm).then((ok) => ok && open());
    else open();
    return;
  }
  const target = targetOf(c, a.id, cmd);
  if (!target) return;
  if (target.screen) {
    c.addon!.screen!.run(action.id, action.confirm);
    return;
  }
  const source = target.item ? { pane: target.item.pane } : target.source!;
  void c.looper.addons.event(a.id, { source, kind: 'command', id: action.id, ...(target.item ? { item: target.item.id } : {}) }, action.confirm);
}

const where = (menu: Where['menu'], p: AddonPlacement): Where =>
  ({
    menu,
    ...(p.toolbar ? { toolbar: true as const } : {}),
    ...(p.main ? { main: true as const } : {}),
    ...(p.context === false ? { context: false as const } : {}),
  }) as Where;

/** The command's submenu as it is now: what's left out takes its line with it. */
function entriesOf(c: CommandContext, a: AddonInfo, cmd: AddonCommand, keyOf: KeyOf): Entry[] {
  const out: Entry[] = [];
  for (const e of cmd.entries ?? []) {
    if (!('id' in e)) {
      if (out.length && !('separator' in out[out.length - 1])) out.push({ separator: true });
      continue;
    }
    const state = stateOf(c, a.id, e.id);
    if (state.hidden || (e.opens && 'tab' in e.opens && c.here === 'mobile')) continue;
    const icon = addonIconKey(a, state.icon) ?? addonIconKey(a, e.icon);
    const key = keyOf(e);
    out.push({
      id: e.id,
      label: state.label ?? e.label,
      ...(icon ? { icon } : {}),
      enabled: a.status === 'running' && state.enabled !== false && !!targetOf(c, a.id, cmd),
      ...(e.check ? { checked: !!state.checked, ...(e.check === 'radio' ? { radio: true as const } : {}) } : {}),
      ...(key ? { accelerator: key } : {}),
      ...(e.destructive ? { destructive: true as const } : {}),
      run: () => run(c, a, cmd, e),
    });
  }
  const last = out[out.length - 1];
  if (last && 'separator' in last) out.pop();
  return out;
}

/** The key an action has: none when an addon listed earlier took it. */
type KeyOf = (action: AddonCommand | AddonEntry) => string | undefined;

function toCommand(a: AddonInfo, cmd: AddonCommand, keyOf: KeyOf): Command {
  const views = cmd.in.screen?.views;
  const own = (c: CommandContext) => (c.addon?.id === a.id ? c.addon : undefined);
  const hide: Hide[] = [
    { if: (c) => !!stateOf(c, a.id, cmd.id).hidden, why: 'Its addon leaves it out here.' },
    { surface: 'toolbar', if: (c) => !!c.settings?.view.hiddenAddonToolbars.includes(a.id), why: 'View → its toolbar is turned off.' },
    { view: 'new', if: (c) => !!c.fixed && !(c.tab ?? '').startsWith(addonTabId(a.id, '')), why: 'A view window has only what its view creates.' },
    { view: 'new', surface: 'toolbar', if: (c) => !!c.chats && !c.chats.tab, why: 'The Chats window’s toolbar makes conversations; its File menu has this.' },
    { view: 'addonPanes', if: (c) => !own(c)?.panes, why: 'Only its own panes tab has it.' },
    { view: 'addonItem', if: (c) => own(c)?.item === undefined, why: 'Only its own pane items have it.' },
    { view: 'addonScreen', if: (c) => !own(c)?.screen || (!!views && !views.includes(own(c)!.screen!.view)), why: 'Only the addon’s screens it names have it.' },
  ];
  const elsewhere = cmd.platforms ? UI_PLATFORMS.filter((p) => !cmd.platforms!.includes(p)) : [];
  if (elsewhere.length) hide.push({ on: elsewhere, why: 'Its addon offers it only on some devices.' });
  if (cmd.opens && 'tab' in cmd.opens) hide.push({ on: ['mobile'], why: 'The More view lists the tab it opens.' });
  const menu = commandMenu(cmd);
  const placed: Partial<Record<CommandView, Where>> = {};
  for (const [place, p] of Object.entries(cmd.in) as [AddonPlace, AddonCommand['in'][AddonPlace]][]) {
    if (!p) continue;
    if (place === 'new') placed.new = where('file', p as AddonPlacement);
    else placed[VIEW_OF[place]] = where(menu, p as AddonPlacement);
  }
  const key = keyOf(cmd);
  return {
    id: addonCommandId(a.id, cmd.id),
    label: (c) => stateOf(c, a.id, cmd.id).label ?? cmd.label,
    // With Looper's New items, a New item is one of them; the others are the addon's own groups.
    group: cmd.in.new ? 'new' : `addon:${a.id}${cmd.group ? `:${cmd.group}` : ''}`,
    icon: (c) => addonIconKey(a, stateOf(c, a.id, cmd.id).icon) ?? addonIconKey(a, cmd.icon),
    ...(cmd.labeled ? { labeled: true as const } : {}),
    ...(key ? { accelerator: key } : {}),
    ...(cmd.destructive ? { destructive: true as const } : {}),
    enabled: (c) => a.status === 'running' && stateOf(c, a.id, cmd.id).enabled !== false && !!targetOf(c, a.id, cmd),
    ...(cmd.check ? { checked: (c: CommandContext) => !!stateOf(c, a.id, cmd.id).checked, ...(cmd.check === 'radio' ? { radio: true as const } : {}) } : {}),
    ...(cmd.entries ? { entries: (c: CommandContext) => entriesOf(c, a, cmd, keyOf) } : {}),
    hide,
    ...(!cmd.entries || cmd.primary || cmd.opens ? { run: (c: CommandContext) => run(c, a, cmd, cmd) } : {}),
    in: placed,
  };
}

const slotsCache = new WeakMap<readonly AddonInfo[], AddonCommandSlots | null>();

/** The started addons' commands, by where they go in the order; null when there are none. */
export function addonCommandSlots(addons: readonly AddonInfo[]): AddonCommandSlots | null {
  const cached = slotsCache.get(addons);
  if (cached !== undefined) return cached;
  const slots: AddonCommandSlots = { new: [], tools: [], rest: [] };
  // A key has one meaning: of two addons that chose the same one, the first listed keeps it.
  const taken = new Set<string>();
  const kept = new Set<AddonCommand | AddonEntry>();
  for (const a of addons) {
    if (!a.enabled) continue;
    for (const cmd of a.commands) {
      for (const action of [cmd, ...commandEntries(cmd)]) {
        if (!action.accelerator || taken.has(keyId(action.accelerator))) continue;
        taken.add(keyId(action.accelerator));
        kept.add(action);
      }
    }
  }
  const keyOf: KeyOf = (action) => (kept.has(action) ? action.accelerator : undefined);
  for (const a of addons) {
    if (!a.enabled) continue;
    for (const cmd of a.commands) {
      const command = toCommand(a, cmd, keyOf);
      if (cmd.in.new) slots.new.push(command);
      else if (commandMenu(cmd) === 'tools') slots.tools.push(command);
      else slots.rest.push(command);
    }
  }
  const result = slots.new.length + slots.tools.length + slots.rest.length ? slots : null;
  slotsCache.set(addons, result);
  return result;
}

/** Whether an addon's command shows a toolbar button in a window of `tab` (unset: the main window, on any tab). */
export function hasToolbarIn(a: AddonInfo, tab: string | undefined): boolean {
  return a.commands.some((cmd) =>
    (Object.entries(cmd.in) as [AddonPlace, { toolbar?: boolean } | undefined][]).some(([place, p]) => {
      if (!p?.toolbar) return false;
      if (tab === undefined) return true;
      if (tab.startsWith(addonTabId(a.id, ''))) return place === 'new' || place === 'panes' || place === 'item' || place === 'screen';
      return place === tab;
    }),
  );
}
