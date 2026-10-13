import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { paneMenuItems, singleMenuItems, taskListMenu } from '../src/main/view-menu';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { ALL_FILTERS, PANES, passesFilter } from '../src/shared/panes';
import { TaskFilterSchema, TaskSchema, ViewSchema, type TaskInput, type View } from '../src/shared/types';

const task = (over: Partial<TaskInput>) => TaskSchema.parse({ ...EXAMPLE_TASK, ...over });
const panesOf = (t: ReturnType<typeof task>) => PANES.filter((p) => p.member(t)).map((p) => p.id);

const scheduled = { mode: 'schedule' as const, schedule: { cron: '0 9 * * *' } };
const watcher = { mode: 'watcher' as const, watcher: { command: 'watch' } };

describe('sidebar panes', () => {
  it('puts each task in the pane its trigger and completion option call for', () => {
    expect(panesOf(task({ trigger: scheduled }))).toEqual(['tasks']);
    expect(panesOf(task({ trigger: { mode: 'manual' } }))).toEqual(['tasks']);
    expect(panesOf(task({ trigger: scheduled, completion: { allowed: true } }))).toEqual(['goals']);
    expect(panesOf(task({ trigger: watcher }))).toEqual(['watchers']);
  });

  it('lists a completable watcher in both Goals and Watchers', () => {
    expect(panesOf(task({ trigger: watcher, completion: { allowed: true } }))).toEqual(['goals', 'watchers']);
  });

  it('applies only the filters a list offers', () => {
    const disabledWatcher = task({ trigger: watcher, enabled: false });
    const filter = TaskFilterSchema.parse({ showWatcher: false, showDisabled: false });
    // The single list offers every filter.
    expect(passesFilter(disabledWatcher, filter, ALL_FILTERS)).toBe(false);
    // Watchers offers Show Disabled but not Show Watcher.
    expect(passesFilter(disabledWatcher, filter, ['showDisabled', 'showCompleted'])).toBe(false);
    expect(passesFilter(task({ trigger: watcher }), filter, ['showDisabled', 'showCompleted'])).toBe(true);
  });

  it('builds the View > Task List menu for the current mode', () => {
    const single = ViewSchema.parse({});
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? '-');
    expect(labels(taskListMenu(single, () => undefined))).toContain('Show &Watcher Tasks');

    const multiple = ViewSchema.parse({ sidebar: 'multiple' });
    const menu = taskListMenu(multiple, () => undefined);
    expect(labels(menu)).toEqual(expect.arrayContaining(['&Tasks Pane', '&Goals Pane', '&Watchers Pane']));
    expect(labels(menu)).not.toContain('Show &Watcher Tasks');
    const goals = menu.find((i) => i.label === '&Goals Pane')!.submenu as MenuItemConstructorOptions[];
    expect(labels(goals)).toEqual([
      'Show &Pane',
      '-',
      ...['Disabled', 'Comp&leted', 'S&cheduled', '&Manual', '&Watcher'].map((k) => expect.stringContaining(k)),
      '-',
      'Show &Folders',
      'Hide &Empty Folders',
    ]);
  });

  it('offers Hide Empty Folders only while the list shows folders', () => {
    const hideEmpty = (showFolders: boolean) =>
      singleMenuItems(ViewSchema.parse({ single: { showFolders } }), () => undefined).find((i) => i.label === 'Hide &Empty Folders')!;
    expect(hideEmpty(true).enabled).toBe(true);
    expect(hideEmpty(false).enabled).toBe(false);
  });

  it('changes only its own pane, and never hides the last pane showing', () => {
    let patch: Partial<View> = {};
    const view = ViewSchema.parse({ sidebar: 'multiple', panes: { tasks: { visible: false }, goals: { visible: false } } });
    const items = paneMenuItems(view, 'watchers', (p) => (patch = p));
    expect(items[0].enabled).toBe(false);
    const disabled = items.find((i) => i.label === 'Show &Disabled Tasks')!;
    disabled.click!({ checked: false } as never, undefined as never, undefined as never);
    expect(patch.panes?.watchers.showDisabled).toBe(false);
    expect(patch.panes?.goals).toEqual(view.panes.goals);
  });

  it('hides completed goals by default and shows every other pane in full', () => {
    const view = ViewSchema.parse({});
    expect(view.sidebar).toBe('single');
    expect(view.panes.goals.showCompleted).toBe(false);
    expect(view.panes.tasks.showCompleted).toBe(true);
    expect(PANES.every((p) => view.panes[p.id].visible)).toBe(true);
  });
});
