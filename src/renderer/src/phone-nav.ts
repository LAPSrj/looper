// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/** The main window's tabs on a phone or tablet: Looper's own, an addon's (its main-tabs id), and iOS's More for what doesn't fit. */
export type PhoneTab = 'dashboard' | 'projects' | 'tasks' | 'sessions' | 'more' | `addon/${string}`;
export type PhoneTabEntry = readonly [PhoneTab, string];

export const PHONE_TABS: readonly PhoneTabEntry[] = [
  ['dashboard', 'Dashboard'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks'],
  ['sessions', 'Chats'],
];

/** A bottom bar holds five destinations (HIG: Tab bars; Material: Navigation bar). */
export const MAX_BAR_TABS = 5;
/** A collapsed navigation rail holds three to seven (Material: Navigation rail). */
export const MAX_RAIL_TABS = 7;
/** Material's breakpoints, in dp: compact under 600, medium under 840. */
export const MEDIUM_WIDTH = 600;
export const EXPANDED_WIDTH = 840;

const MORE: PhoneTabEntry = ['more', 'More'];

/** iPad's tab bar near the top: a tab's padding and its name's width at 15 pt, and the row's margins and capsule (ios.css). */
const topTabWidth = (label: string) => 40 + label.length * 9.5;
const TOP_BAR_CHROME = 40;

/** How the main window shows its views. */
export interface PhoneTabs {
  /** bar: at the bottom. top: iPad's, in the frame's bar. rail: beside the content. none: behind the menu icon. */
  form: 'bar' | 'top' | 'rail' | 'none';
  /** The tabs that form shows. */
  shown: PhoneTabEntry[];
  /** iOS: the tabs the More tab lists. */
  more: PhoneTabEntry[];
  /** Android: every view, when `shown` doesn't have them all; the top app bar's menu icon opens them in a modal expanded rail. */
  menu: PhoneTabEntry[] | null;
}

/** iOS: as many tabs as the space holds, and "the trailing tab becomes a More tab" when they don't all fit (HIG: Tab bars). */
function iosTabs(all: PhoneTabEntry[], width: number, top: boolean): PhoneTabs {
  const form = top ? 'top' : 'bar';
  const room = width - TOP_BAR_CHROME;
  const fits = (tabs: PhoneTabEntry[]) => (top ? tabs.reduce((sum, [, label]) => sum + topTabWidth(label), 0) <= room : tabs.length <= MAX_BAR_TABS);
  if (fits(all)) return { form, shown: all, more: [], menu: null };
  let count = all.length - 1;
  while (count > PHONE_TABS.length && !fits([...all.slice(0, count), MORE])) count--;
  return { form, shown: [...all.slice(0, count), MORE], more: all.slice(count), menu: null };
}

/**
 * Android, after Material: a bar for up to five views under the expanded width, and a rail from
 * there. With more than five, a bar is out: medium windows take the rail, and compact ones hide
 * the views behind a menu icon. A rail with more than seven keeps the rest behind the same icon.
 */
function androidTabs(all: PhoneTabEntry[], width: number): PhoneTabs {
  const crowded = all.length > MAX_BAR_TABS;
  if (width >= EXPANDED_WIDTH || (width >= MEDIUM_WIDTH && crowded)) {
    return { form: 'rail', shown: all.slice(0, MAX_RAIL_TABS), more: [], menu: all.length > MAX_RAIL_TABS ? all : null };
  }
  return crowded ? { form: 'none', shown: [], more: [], menu: all } : { form: 'bar', shown: all, more: [], menu: null };
}

export function phoneTabs(addonTabs: readonly PhoneTabEntry[], os: 'ios' | 'android', width: number, top: boolean): PhoneTabs {
  const all = [...PHONE_TABS, ...addonTabs];
  return os === 'ios' ? iosTabs(all, width, top) : androidTabs(all, width);
}

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
  stacks: { dashboard: [], projects: [], tasks: [], sessions: [] },
});

/** The screens over a tab's list; a tab that hasn't been opened has none. */
export const stackOf = (nav: PhoneNav, tab: PhoneTab = nav.tab): PhoneScreen[] => nav.stacks[tab] ?? [];

export function topScreen(nav: PhoneNav): PhoneScreen | null {
  const stack = stackOf(nav);
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
  return withStack(nav, [...stackOf(nav), screen]);
}

/** iPad: a row of the list column tapped; its screen replaces what the detail column shows. */
export function rootScreen(nav: PhoneNav, screen: PhoneScreen): PhoneNav {
  const stack = stackOf(nav);
  if (stack.length === 1 && sameScreen(stack[0], screen)) return nav;
  return withStack(nav, [screen]);
}

/** Back: the screen under the current one, or the tab's list. */
export function popScreen(nav: PhoneNav): PhoneNav {
  const stack = stackOf(nav);
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
