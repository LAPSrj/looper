// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/** The main window's tabs on a phone or tablet: Looper's own and More, which lists the addons' tabs. */
export type PhoneTab = 'dashboard' | 'projects' | 'tasks' | 'sessions' | 'more';

/** An addon's tab (its main-tabs id): not one of the bar's, a screen the More tab pushes. */
export type AddonTabId = `addon/${string}`;
export type PhoneTabEntry = readonly [PhoneTab, string];

export const PHONE_TABS: readonly PhoneTabEntry[] = [
  ['dashboard', 'Dashboard'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks'],
  ['sessions', 'Chats'],
  ['more', 'More'],
];

/** Material's expanded width, in dp, from which a window takes a rail instead of a bar. */
export const EXPANDED_WIDTH = 840;

/** How the main window shows its tabs: a bar at the bottom, iPad's in the frame's bar, or Android's rail beside the content. */
export type PhoneTabForm = 'bar' | 'top' | 'rail';

export function phoneTabForm(os: 'ios' | 'android', width: number, top: boolean): PhoneTabForm {
  if (os === 'ios') return top ? 'top' : 'bar';
  return width >= EXPANDED_WIDTH ? 'rail' : 'bar';
}

/** A screen pushed over a tab's list: what the desktop shows in the main pane. */
export type PhoneScreen =
  | { kind: 'task'; id: string }
  | { kind: 'project'; id: string }
  /** The Tasks or Projects tab inside a folder: its subfolders and items. Not a selection: the main window selects nothing while it shows. */
  | { kind: 'folder'; id: string }
  /** The More tab's list of a menu (Advanced): its rows. Not a selection either. */
  | { kind: 'list'; id: string }
  /** An addon's tab, opened from the More tab's list. Not a selection either. */
  | { kind: 'addonTab'; tab: AddonTabId }
  | { kind: 'addon'; addonId: string; pane: string; item: string };

/** Each tab keeps its own stack, as iOS's tab bar and Material's navigation bar do. */
export interface PhoneNav {
  tab: PhoneTab;
  stacks: Partial<Record<PhoneTab, PhoneScreen[]>>;
}

/** The main window's selection: the task, project or addon item its main pane shows. */
export interface MainSelection {
  task: string | null;
  project: string | null;
  addon: { addonId: string; pane: string; item: string } | null;
}

export const initialPhoneNav = (tab: PhoneTab = 'dashboard'): PhoneNav => ({
  tab,
  stacks: { dashboard: [], projects: [], tasks: [], sessions: [], more: [] },
});

const SCREEN_KINDS = new Set(['task', 'project', 'folder', 'list', 'addonTab', 'addon']);

/** A kept PhoneNav read back (the page loading again, the app relaunched); null unless it has the shape this build writes. */
export function keptNav(v: unknown): PhoneNav | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as { tab?: unknown; stacks?: unknown };
  const tabOk = PHONE_TABS.some(([id]) => id === n.tab);
  if (!tabOk || !n.stacks || typeof n.stacks !== 'object') return null;
  for (const stack of Object.values(n.stacks)) {
    if (!Array.isArray(stack) || stack.some((s) => !s || typeof s !== 'object' || !SCREEN_KINDS.has((s as { kind?: string }).kind ?? ''))) return null;
  }
  return n as PhoneNav;
}

/** `nav` without the screens whose item is gone, nor any screen above one. */
export function pruneNav(nav: PhoneNav, exists: (s: PhoneScreen) => boolean): PhoneNav {
  const stacks: PhoneNav['stacks'] = {};
  for (const [tab, stack = []] of Object.entries(nav.stacks)) {
    const gone = stack.findIndex((s) => !exists(s));
    stacks[tab as PhoneTab] = gone < 0 ? stack : stack.slice(0, gone);
  }
  return { ...nav, stacks };
}

/** The screens over a tab's list; a tab that hasn't been opened has none. */
export const stackOf = (nav: PhoneNav, tab: PhoneTab = nav.tab): PhoneScreen[] => nav.stacks[tab] ?? [];

export function topScreen(nav: PhoneNav): PhoneScreen | null {
  const stack = stackOf(nav);
  return stack.length ? stack[stack.length - 1] : null;
}

export function sameScreen(a: PhoneScreen | null, b: PhoneScreen | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'addon' && b.kind === 'addon') return a.addonId === b.addonId && a.pane === b.pane && a.item === b.item;
  if (a.kind === 'addonTab' && b.kind === 'addonTab') return a.tab === b.tab;
  if (a.kind === 'addon' || b.kind === 'addon' || a.kind === 'addonTab' || b.kind === 'addonTab') return false;
  return a.kind === b.kind && a.id === b.id;
}

const withStack = (nav: PhoneNav, stack: PhoneScreen[]): PhoneNav => ({ ...nav, stacks: { ...nav.stacks, [nav.tab]: stack } });

/** Show a screen over the current one (nothing changes when it's already on top). */
export function pushScreen(nav: PhoneNav, screen: PhoneScreen): PhoneNav {
  if (sameScreen(topScreen(nav), screen)) return nav;
  return withStack(nav, [...stackOf(nav), screen]);
}

/** iPad: a row of the list column tapped; its screen replaces what the detail column shows. */
export function rootScreen(nav: PhoneNav, screen: PhoneScreen): PhoneNav {
  const stack = stackOf(nav);
  if (stack.length === 1 && sameScreen(stack[0], screen)) return nav;
  return withStack(nav, [screen]);
}

/**
 * How the screen a tab shows changes from one stack to the next: pushed over it, popped off it, or neither (the same
 * depth, or another tab). On a tablet (`split`) a row of the list column replaces the detail column's stack, which
 * UIKit's split view installs in place (showDetailViewController: "installs vc as the secondary view controller"), so
 * only a stack that keeps its first screen pushes or pops.
 */
export function stackMove(from: readonly PhoneScreen[], to: readonly PhoneScreen[], split: boolean): 'push' | 'pop' | null {
  if (from.length === to.length) return null;
  if (split && !sameScreen(from[0] ?? null, to[0] ?? null)) return null;
  return to.length > from.length ? 'push' : 'pop';
}

/** Back: the screen under the current one, or the tab's list. */
export function popScreen(nav: PhoneNav): PhoneNav {
  const stack = stackOf(nav);
  return stack.length ? withStack(nav, stack.slice(0, -1)) : nav;
}

/** An addon's tab, opened from the More tab's list: a screen pushed over it, as a folder is over Tasks. */
export function openAddonTab(nav: PhoneNav, tab: AddonTabId): PhoneNav {
  return pushScreen({ ...nav, tab: 'more' }, { kind: 'addonTab', tab });
}

/** The addon tab the current tab shows (its screen is the bottom of the stack, under any item it opened), or null. */
export function addonTabOf(nav: PhoneNav): AddonTabId | null {
  const first = stackOf(nav)[0];
  return first?.kind === 'addonTab' ? first.tab : null;
}

/** A tab tapped: its own stack shows; the tab already showing goes back to its list. */
export function selectTab(nav: PhoneNav, tab: PhoneTab): PhoneNav {
  if (tab === nav.tab) return withStack(nav, []);
  return { ...nav, tab };
}

/** The tab's list shows, its stack emptied (View → Dashboard). */
export function showTabRoot(nav: PhoneNav, tab: PhoneTab): PhoneNav {
  return { tab, stacks: { ...nav.stacks, [tab]: [] } };
}

/** What the main window selects to show a screen; null shows the tab's list. */
export function selectionOf(screen: PhoneScreen | null): MainSelection {
  if (!screen || screen.kind === 'folder' || screen.kind === 'list' || screen.kind === 'addonTab') return { task: null, project: null, addon: null };
  if (screen.kind === 'task') return { task: screen.id, project: null, addon: null };
  if (screen.kind === 'project') return { task: null, project: screen.id, addon: null };
  return { task: null, project: null, addon: { addonId: screen.addonId, pane: screen.pane, item: screen.item } };
}

/** The screen a selection shows: the task, else the project, else the addon item (the desktop's order). */
export function screenOf(sel: MainSelection): PhoneScreen | null {
  if (sel.task) return { kind: 'task', id: sel.task };
  if (sel.project) return { kind: 'project', id: sel.project };
  if (sel.addon) return { kind: 'addon', ...sel.addon };
  return null;
}

/**
 * The window's selection changed on its own (a notification opened a task, a
 * list row was tapped, an addon picked an item, the shown task was deleted):
 * a new selection pushes its screen, and a cleared one takes the shown screen away
 * (a folder's, a list's or an addon tab's screen selects nothing, so it stays). `replace`: the selection
 * came from an iPad's list column, so its screen replaces the detail column's
 * stack instead of going over it.
 */
export function followSelection(nav: PhoneNav, sel: MainSelection, replace = false): PhoneNav {
  const screen = screenOf(sel);
  const top = topScreen(nav);
  if (!screen && (top?.kind === 'folder' || top?.kind === 'list' || top?.kind === 'addonTab')) return nav;
  if (screen && replace) return rootScreen(nav, screen);
  if (sameScreen(screen, top)) return nav;
  return screen ? pushScreen(nav, screen) : popScreen(nav);
}
