import type { MenuItemConstructorOptions } from 'electron';
import { ALL_FILTERS, FILTER_LABELS, PANES, type PaneId } from '../shared/panes';
import type { ProjectGroupBy } from '../shared/projects';
import type { TaskFilter, TaskListOptions, View } from '../shared/types';

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
const SHOW_LABELS: Record<PaneId, string> = { tasks: 'Ta&sks', goals: 'Go&als', watchers: '&Watchers' };

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
 * View's pane group: a check box for every pane in the order the sidebar shows
 * them (Projects, the task panes or the single task list, then `addonPanes`).
 * With none showing, the main window has no sidebar.
 */
export function paneVisibilityItems(
  view: View,
  update: ViewUpdate,
  addonPanes: MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions[] {
  return [
    {
      label: '&Projects',
      type: 'checkbox',
      checked: view.projectsPane.visible,
      click: (item) => update({ projectsPane: { ...view.projectsPane, visible: item.checked } }),
    },
    ...(view.sidebar === 'multiple'
      ? PANES.map((p) => showPaneItem(view, p.id, update, SHOW_LABELS[p.id]))
      : [
          {
            label: SHOW_LABELS.tasks,
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

const GROUP_LABELS: Record<ProjectGroupBy, string> = { none: '&None', folder: '&Folder', harness: '&Harness' };

/** The Projects pane's items: whether it shows (unless `withShow` is off), then its Group By choices. Used by its header's context menu and View > Task List Options. */
export function projectsPaneMenuItems(view: View, update: ViewUpdate, withShow = true): MenuItemConstructorOptions[] {
  const pane = view.projectsPane;
  const set = (patch: Partial<View['projectsPane']>) => update({ projectsPane: { ...pane, ...patch } });
  return [
    ...(withShow
      ? [
          { label: 'Show &Pane', type: 'checkbox', checked: pane.visible, click: (item) => set({ visible: item.checked }) } as MenuItemConstructorOptions,
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: '&Group By',
      submenu: (Object.keys(GROUP_LABELS) as ProjectGroupBy[]).map((k): MenuItemConstructorOptions => ({
        label: GROUP_LABELS[k],
        type: 'radio',
        checked: pane.groupBy === k,
        click: () => set({ groupBy: k }),
      })),
    },
  ];
}

/** The single list's filters and folder options. */
export function singleMenuItems(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  return listItems(view.single, ALL_FILTERS, (patch) => update({ single: { ...view.single, ...patch } }));
}

/** View > Task List Options: how the task list looks and what it lists. Which panes show is in View itself. */
export function taskListMenu(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  const multiple = view.sidebar === 'multiple';
  const projects: MenuItemConstructorOptions = { label: '&Projects Pane', submenu: projectsPaneMenuItems(view, update, false) };
  return [
    { label: 'S&ingle Pane', type: 'radio', checked: !multiple, click: () => update({ sidebar: 'single' }) },
    { label: 'M&ultiple Panes', type: 'radio', checked: multiple, click: () => update({ sidebar: 'multiple' }) },
    { type: 'separator' },
    { label: '&Standard', type: 'radio', checked: view.taskList !== 'compact', click: () => update({ taskList: 'standard' }) },
    { label: '&Compact', type: 'radio', checked: view.taskList === 'compact', click: () => update({ taskList: 'compact' }) },
    { type: 'separator' },
    // The single list's folder options end its items, so Open Folders Automatically joins them.
    ...(multiple
      ? [
          projects,
          ...PANES.map((p): MenuItemConstructorOptions => ({ label: p.menuLabel, submenu: paneMenuItems(view, p.id, update, false) })),
          { type: 'separator' } as MenuItemConstructorOptions,
        ]
      : [projects, { type: 'separator' } as MenuItemConstructorOptions, ...singleMenuItems(view, update)]),
    { label: '&Open Folders Automatically', type: 'checkbox', checked: view.autoOpenFolders, click: (item) => update({ autoOpenFolders: item.checked }) },
  ];
}
