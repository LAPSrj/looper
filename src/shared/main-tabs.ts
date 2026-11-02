import type { AddonInfo, AddonTab } from './addons';

/** Looper's own tabs of the main window, in their order. */
export const LOOPER_TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'chats', label: 'Chats', icon: 'chat' },
] as const;

export type LooperTab = (typeof LOOPER_TABS)[number]['id'];

/** A tab of the main window: Looper's own, or an addon's (one of its screens fills it). */
export interface MainTabDef {
  id: string;
  label: string;
  /** An ICONS key (renderer components/icons.tsx). */
  icon: string;
  addon?: { id: string; name: string; tab: AddonTab };
}

/** An addon tab's id among the main window's tabs. */
export const addonTabId = (addonId: string, tabId: string): string => `addon/${addonId}/${tabId}`;

/** The icon of an addon tab that names none. */
export const ADDON_TAB_ICON = 'window';

/** The main window's tabs: Looper's, then each started addon's in the order the addons are listed. */
export function mainTabs(addons: Pick<AddonInfo, 'id' | 'name' | 'enabled' | 'tabs'>[]): MainTabDef[] {
  return [
    ...LOOPER_TABS.map((t) => ({ ...t })),
    ...addons
      .filter((a) => a.enabled)
      .flatMap((a) => a.tabs.map((tab) => ({ id: addonTabId(a.id, tab.id), label: tab.title, icon: tab.icon ?? ADDON_TAB_ICON, addon: { id: a.id, name: a.name, tab } }))),
  ];
}

export const isLooperTab = (id: string): id is LooperTab => LOOPER_TABS.some((t) => t.id === id);
