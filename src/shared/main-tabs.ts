import { addonIconKey, type AddonInfo, type AddonTab } from './addons';

/** Looper's own tabs of the main window, in their order. */
export const LOOPER_TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboardTab' },
  { id: 'projects', label: 'Projects', icon: 'projectsTab' },
  { id: 'tasks', label: 'Tasks', icon: 'tasksTab' },
  { id: 'chats', label: 'Chats', icon: 'chatsTab' },
] as const;

export type LooperTab = (typeof LOOPER_TABS)[number]['id'];

/** A tab of the main window: Looper's own, or an addon's (one of its screens fills it). */
export interface MainTabDef {
  id: string;
  label: string;
  /** What iconNode draws (renderer components/icons.tsx). */
  icon: string;
  /** With no `tab`: the addon's panes fill it. */
  addon?: { id: string; name: string; tab?: AddonTab };
}

/** An addon tab's id among the main window's tabs. */
export const addonTabId = (addonId: string, tabId: string): string => `addon/${addonId}/${tabId}`;

/** The icon of an addon tab that names none. */
export const ADDON_TAB_ICON = 'window';

/** An addon's panes tab: its one pane's title, or else the addon's name, told apart from a screen's tab of that title. */
function panesTabLabel(a: Pick<AddonInfo, 'name' | 'tabs' | 'panes'>): string {
  const label = a.panes.length === 1 ? a.panes[0].title : a.name;
  return a.tabs.some((t) => t.title === label) ? `${label} List` : label;
}

/** The main window's tabs: Looper's, then each started addon's in the order the addons are listed. */
export function mainTabs(addons: Pick<AddonInfo, 'id' | 'name' | 'enabled' | 'tabs' | 'panes' | 'panesIcon' | 'icons'>[]): MainTabDef[] {
  return [
    ...LOOPER_TABS.map((t) => ({ ...t })),
    ...addons
      .filter((a) => a.enabled)
      .flatMap((a): MainTabDef[] => [
        ...a.tabs.map((tab) => ({ id: addonTabId(a.id, tab.id), label: tab.title, icon: addonIconKey(a, tab.icon) ?? ADDON_TAB_ICON, addon: { id: a.id, name: a.name, tab } })),
        ...(a.panes.length > 0 ? [{ id: addonTabId(a.id, 'panes'), label: panesTabLabel(a), icon: addonIconKey(a, a.panesIcon) ?? ADDON_TAB_ICON, addon: { id: a.id, name: a.name } }] : []),
      ]),
  ];
}

export const isLooperTab = (id: string): id is LooperTab => LOOPER_TABS.some((t) => t.id === id);
