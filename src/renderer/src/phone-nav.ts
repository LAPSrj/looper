// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/** The main window's bottom tabs on a phone. */
export type PhoneTab = 'dashboard' | 'projects' | 'tasks' | 'sessions';

export const PHONE_TABS: readonly (readonly [PhoneTab, string])[] = [
  ['dashboard', 'Dashboard'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks'],
  ['sessions', 'Chats'],
];

/** A screen pushed over a tab's list: what the desktop shows in the main pane. */
export type PhoneScreen =
  | { kind: 'task'; id: string }
  | { kind: 'project'; id: string }
  /** The Tasks tab inside a folder: its subfolders and tasks. Not a selection: the main window selects nothing while it shows. */
  | { kind: 'folder'; id: string }
  | { kind: 'addon'; addonId: string; pane: string; item: string };

/** Each tab keeps its own stack, as iOS's tab bar and Material's navigation bar do. */
export interface PhoneNav {
  tab: PhoneTab;
  stacks: Record<PhoneTab, PhoneScreen[]>;
}

/** The main window's selection: the task, project or addon item its main pane shows. */
export interface MainSelection {
  task: string | null;
  project: string | null;
  addon: { addonId: string; pane: string; item: string } | null;
}

export const initialPhoneNav = (tab: PhoneTab = 'dashboard'): PhoneNav => ({
  tab,
  stacks: { dashboard: [], projects: [], tasks: [], sessions: [] },
});

export function topScreen(nav: PhoneNav): PhoneScreen | null {
  const stack = nav.stacks[nav.tab];
  return stack.length ? stack[stack.length - 1] : null;
}

export function sameScreen(a: PhoneScreen | null, b: PhoneScreen | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'addon' && b.kind === 'addon') return a.addonId === b.addonId && a.pane === b.pane && a.item === b.item;
  if (a.kind === 'addon' || b.kind === 'addon') return false;
  return a.kind === b.kind && a.id === b.id;
}

const withStack = (nav: PhoneNav, stack: PhoneScreen[]): PhoneNav => ({ ...nav, stacks: { ...nav.stacks, [nav.tab]: stack } });

/** Show a screen over the current one (nothing changes when it's already on top). */
export function pushScreen(nav: PhoneNav, screen: PhoneScreen): PhoneNav {
  if (sameScreen(topScreen(nav), screen)) return nav;
  return withStack(nav, [...nav.stacks[nav.tab], screen]);
}

/** iPad: a row of the list column tapped; its screen replaces what the detail column shows. */
export function rootScreen(nav: PhoneNav, screen: PhoneScreen): PhoneNav {
  const stack = nav.stacks[nav.tab];
  if (stack.length === 1 && sameScreen(stack[0], screen)) return nav;
  return withStack(nav, [screen]);
}

/** Back: the screen under the current one, or the tab's list. */
export function popScreen(nav: PhoneNav): PhoneNav {
  const stack = nav.stacks[nav.tab];
  return stack.length ? withStack(nav, stack.slice(0, -1)) : nav;
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
  if (!screen || screen.kind === 'folder') return { task: null, project: null, addon: null };
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
 * (a folder's screen selects nothing, so it stays). `replace`: the selection
 * came from an iPad's list column, so its screen replaces the detail column's
 * stack instead of going over it.
 */
export function followSelection(nav: PhoneNav, sel: MainSelection, replace = false): PhoneNav {
  const screen = screenOf(sel);
  const top = topScreen(nav);
  if (!screen && top?.kind === 'folder') return nav;
  if (screen && replace) return rootScreen(nav, screen);
  if (sameScreen(screen, top)) return nav;
  return screen ? pushScreen(nav, screen) : popScreen(nav);
}
