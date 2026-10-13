import type { MenuItemConstructorOptions } from 'electron';
import { ALL_FILTERS, FILTER_LABELS, PANES, type PaneId } from '../shared/panes';
import type { TaskFilter, View } from '../shared/types';

export type ViewUpdate = (patch: Partial<View>) => void;

function filterItems(
  filter: TaskFilter,
  offered: (keyof TaskFilter)[],
  set: (patch: Partial<TaskFilter>) => void,
): MenuItemConstructorOptions[] {
  return offered.map((k) => ({
    label: FILTER_LABELS[k],
    type: 'checkbox',
    checked: filter[k],
    click: (item) => set({ [k]: item.checked }),
  }));
}

/** One pane's items: whether it shows, then its filters. Used by its View submenu and its header's context menu. */
export function paneMenuItems(view: View, id: PaneId, update: ViewUpdate): MenuItemConstructorOptions[] {
  const def = PANES.find((p) => p.id === id)!;
  const pane = view.panes[id];
  const set = (patch: Partial<View['panes'][PaneId]>) =>
    update({ panes: { ...view.panes, [id]: { ...pane, ...patch } } });
  // The last pane showing can't be hidden: the sidebar would be empty.
  const lastVisible = PANES.filter((p) => view.panes[p.id].visible).length === 1 && pane.visible;
  return [
    { label: 'Show &Pane', type: 'checkbox', checked: pane.visible, enabled: !lastVisible, click: (item) => set({ visible: item.checked }) },
    { type: 'separator' },
    ...filterItems(pane, def.filters, set),
  ];
}

/** The single list's filters. */
export function singleMenuItems(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  return filterItems(view.single, ALL_FILTERS, (patch) => update({ single: { ...view.single, ...patch } }));
}

/** View > Task List. */
export function taskListMenu(view: View, update: ViewUpdate): MenuItemConstructorOptions[] {
  const multiple = view.sidebar === 'multiple';
  return [
    { label: 'S&ingle Pane', type: 'radio', checked: !multiple, click: () => update({ sidebar: 'single' }) },
    { label: 'M&ultiple Panes', type: 'radio', checked: multiple, click: () => update({ sidebar: 'multiple' }) },
    { type: 'separator' },
    { label: '&Standard', type: 'radio', checked: view.taskList !== 'compact', click: () => update({ taskList: 'standard' }) },
    { label: '&Compact', type: 'radio', checked: view.taskList === 'compact', click: () => update({ taskList: 'compact' }) },
    { type: 'separator' },
    ...(multiple
      ? PANES.map((p): MenuItemConstructorOptions => ({ label: p.menuLabel, submenu: paneMenuItems(view, p.id, update) }))
      : singleMenuItems(view, update)),
    { type: 'separator' },
    { label: '&Open Folders Automatically', type: 'checkbox', checked: view.autoOpenFolders, click: (item) => update({ autoOpenFolders: item.checked }) },
  ];
}
