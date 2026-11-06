import type { MenuItemConstructorOptions } from 'electron';
import { ALL_FILTERS, FILTER_LABELS, PANES, type PaneId } from '../shared/panes';
import type { ProjectGroupBy } from '../shared/projects';
import type { TaskFilter, TaskListOptions, View } from '../shared/types';
import { NOT_MOBILE } from '../shared/ui-platform';

export type ViewUpdate = (patch: Partial<View>) => void;

/** A list's filters, then its folder options. */
function listItems(
  options: TaskListOptions,
  offered: (keyof TaskFilter)[],
  set: (patch: Partial<TaskListOptions>) => void,
): MenuItemConstructorOptions[] {
  return [
    ...offered.map((k): MenuItemConstructorOptions => ({
      label: FILTER_LABELS[k],
      type: 'checkbox',
      checked: options[k],
      click: (item) => set({ [k]: item.checked }),
    })),
    { type: 'separator' },
    { label: 'Show &Folders', type: 'checkbox', checked: options.showFolders, click: (item) => set({ showFolders: item.checked }) },
    {
      label: 'Hide &Empty Folders',
      type: 'checkbox',
      checked: options.hideEmptyFolders,
      enabled: options.showFolders,
      click: (item) => set({ hideEmptyFolders: item.checked }),
    },
  ];
}

/** The label of a task pane's Show check box in View. */
const SHOW_LABELS: Record<PaneId, string> = { tasks: 'Ta&sks Pane', goals: 'Go&als Pane', watchers: '&Watchers Pane' };

/** A task pane's Show check box. */
function showPaneItem(view: View, id: PaneId, update: ViewUpdate, label: string): MenuItemConstructorOptions {
  const pane = view.panes[id];
  return {
    label,
    type: 'checkbox',
    checked: pane.visible,
    click: (item) => update({ panes: { ...view.panes, [id]: { ...pane, visible: item.checked } } }),
  };
}

/**
 * View's pane group: a check box for every pane of the Tasks tab's sidebar in
 * the order it shows them (the task panes or the single task list, then
 * `addonPanes`). With none showing, the tab has no sidebar. A phone has one
 * task list, so only the addons' panes (on its Tasks tab) stay there.
 */
export function paneVisibilityItems(
  view: View,
  update: ViewUpdate,
  addonPanes: MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions[] {
  return [
    ...(view.sidebar === 'multiple'
      ? PANES.map((p) => ({ ...showPaneItem(view, p.id, update, SHOW_LABELS[p.id]), platforms: NOT_MOBILE }))
      : [
          {
            label: SHOW_LABELS.tasks,
            platforms: NOT_MOBILE,
            type: 'checkbox',
            checked: view.single.visible,
            click: (item) => update({ single: { ...view.single, visible: item.checked } }),
          } as MenuItemConstructorOptions,
        ]),
    ...addonPanes,
  ];
}

/** One pane's items: whether it shows, then its filters. Used by its header's context menu; `withShow: false` leaves the Show check box to View's pane group. */
export function paneMenuItems(view: View, id: PaneId, update: ViewUpdate, withShow = true): MenuItemConstructorOptions[] {
  const def = PANES.find((p) => p.id === id)!;
  const pane = view.panes[id];
  const set = (patch: Partial<View['panes'][PaneId]>) =>
    update({ panes: { ...view.panes, [id]: { ...pane, ...patch } } });
  return [
    ...(withShow ? [showPaneItem(view, id, update, 'Show &Pane'), { type: 'separator' } as MenuItemConstructorOptions] : []),
    ...listItems(pane, def.filters, set),
  ];
}

// "Parent Folder": the folder the projects' folders are in, not the folders the user makes in the list.
const GROUP_LABELS: Record<ProjectGroupBy, string> = { none: '&None', folder: '&Parent Folder', harness: '&Harness' };

/** The Projects list's Group By choices as a submenu named `label`. */
function groupByMenu(view: View, update: ViewUpdate, label: string): MenuItemConstructorOptions {
  const pane = view.projectsPane;
  return {
    label,
    submenu: (Object.keys(GROUP_LABELS) as ProjectGroupBy[]).map((k): MenuItemConstructorOptions => ({
      label: GROUP_LABELS[k],
      type: 'radio',
      checked: pane.groupBy === k,
      click: () => update({ projectsPane: { ...pane, groupBy: k } }),
    })),
  };
}

/** View > Group Projects By, on the Projects tab; not on a phone, whose Projects tab shows the groups picked here. */
export function groupProjectsByMenu(view: View, update: ViewUpdate): MenuItemConstructorOptions {
  return { ...groupByMenu(view, update, '&Group Projects By'), platforms: NOT_MOBILE };
}

/** The Projects list header's context menu: its Group By choices. */
export function projectsPaneMenuItems(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  return [groupByMenu(view, update, '&Group By')];
}

/** The single list's filters and folder options. */
export function singleMenuItems(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  return listItems(view.single, ALL_FILTERS, (patch) => update({ single: { ...view.single, ...patch } }));
}

/**
 * View > Task List Options: how the task list looks and what it lists. Which panes show is in View itself.
 * The phone's Tasks tab is one standard list with the single list's options, so the pane layout,
 * the Compact look and the separate panes' options stay off it.
 */
export function taskListMenu(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  const multiple = view.sidebar === 'multiple';
  return [
    { label: 'S&ingle Pane', platforms: NOT_MOBILE, type: 'radio', checked: !multiple, click: () => update({ sidebar: 'single' }) },
    { label: 'M&ultiple Panes', platforms: NOT_MOBILE, type: 'radio', checked: multiple, click: () => update({ sidebar: 'multiple' }) },
    { type: 'separator' },
    { label: '&Standard', platforms: NOT_MOBILE, type: 'radio', checked: view.taskList !== 'compact', click: () => update({ taskList: 'standard' }) },
    { label: '&Compact', platforms: NOT_MOBILE, type: 'radio', checked: view.taskList === 'compact', click: () => update({ taskList: 'compact' }) },
    { type: 'separator' },
    // The single list's folder options end its items, so Open Folders Automatically joins them.
    ...(multiple
      ? [
          ...PANES.map((p): MenuItemConstructorOptions => ({ label: p.menuLabel, platforms: NOT_MOBILE, submenu: paneMenuItems(view, p.id, update, false) })),
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : singleMenuItems(view, update)),
    { label: '&Open Folders Automatically', type: 'checkbox', checked: view.autoOpenFolders, click: (item) => update({ autoOpenFolders: item.checked }) },
  ];
}
