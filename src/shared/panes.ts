import type { Task, TaskFilter } from './types';

/**
 * The panes of the multiple-pane sidebar. Membership comes from the task
 * itself: a task that may be completed is a goal, a watcher-trigger task is a
 * watcher (a completable watcher is in both), and everything else is a task.
 */
export type PaneId = 'tasks' | 'goals' | 'watchers';

export interface PaneDef {
  id: PaneId;
  title: string;
  /** Its submenu label in View > Task List, `&` before the access key. */
  menuLabel: string;
  member: (t: Task) => boolean;
  /** The filters that can change what this pane shows, in menu order. */
  filters: (keyof TaskFilter)[];
}

export const PANES: PaneDef[] = [
  {
    id: 'tasks',
    title: 'Tasks',
    menuLabel: '&Tasks Pane',
    member: (t) => !t.completion.allowed && t.trigger.mode !== 'watcher',
    filters: ['showDisabled', 'showCompleted', 'showScheduled', 'showManual'],
  },
  {
    id: 'goals',
    title: 'Goals',
    menuLabel: '&Goals Pane',
    member: (t) => t.completion.allowed,
    filters: ['showDisabled', 'showCompleted', 'showScheduled', 'showManual', 'showWatcher'],
  },
  {
    id: 'watchers',
    title: 'Watchers',
    menuLabel: '&Watchers Pane',
    member: (t) => t.trigger.mode === 'watcher',
    filters: ['showDisabled', 'showCompleted'],
  },
];

export const FILTER_LABELS: Record<keyof TaskFilter, string> = {
  showDisabled: 'Show &Disabled Tasks',
  showCompleted: 'Show Comp&leted Tasks',
  showScheduled: 'Show S&cheduled Tasks',
  showManual: 'Show &Manual Tasks',
  showWatcher: 'Show &Watcher Tasks',
};

/** The task passes the filters; a filter the list doesn't offer never hides anything. */
export function passesFilter(t: Task, filter: TaskFilter, offered: (keyof TaskFilter)[]): boolean {
  const on = (k: keyof TaskFilter) => !offered.includes(k) || filter[k];
  const mode = t.trigger.mode;
  return (
    (t.completedAt ? on('showCompleted') : t.enabled || on('showDisabled')) &&
    (mode === 'schedule' ? on('showScheduled') : mode === 'watcher' ? on('showWatcher') : on('showManual'))
  );
}

/** Every filter: what the single-pane list offers. */
export const ALL_FILTERS = Object.keys(FILTER_LABELS) as (keyof TaskFilter)[];
