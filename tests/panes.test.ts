import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { groupProjectsByMenu, paneMenuItems, paneVisibilityItems, projectsPaneMenuItems, singleMenuItems, taskListMenu } from '../src/main/view-menu';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { ALL_FILTERS, PANES, passesFilter, sidebarHasPanes } from '../src/shared/panes';
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

  it('builds the View > Task List Options menu for the current mode', () => {
    const single = ViewSchema.parse({});
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? '-');
    expect(labels(taskListMenu(single, () => undefined))).toContain('Show &Watcher Tasks');

    const multiple = ViewSchema.parse({ sidebar: 'multiple' });
    const menu = taskListMenu(multiple, () => undefined);
    expect(labels(menu)).toEqual(expect.arrayContaining(['&Tasks Pane', '&Goals Pane', '&Watchers Pane']));
    expect(labels(menu)).not.toContain('Show &Pane');
    expect(labels(menu)).not.toContain('Show &Watcher Tasks');
    const goals = menu.find((i) => i.label === '&Goals Pane')!.submenu as MenuItemConstructorOptions[];
    expect(labels(goals)).toEqual([
      ...['Disabled', 'Comp&leted', 'S&cheduled', '&Manual', '&Watcher'].map((k) => expect.stringContaining(k)),
      '-',
      'Show &Folders',
      'Hide &Empty Folders',
    ]);
  });

  it('lists every pane in one View group, in the sidebar order', () => {
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label);
    const addon: MenuItemConstructorOptions[] = [{ label: 'Servers', type: 'checkbox' }];
    expect(labels(paneVisibilityItems(ViewSchema.parse({}), () => undefined, addon))).toEqual(['Ta&sks Pane', 'Servers']);
    const multiple = ViewSchema.parse({ sidebar: 'multiple' });
    expect(labels(paneVisibilityItems(multiple, () => undefined, addon))).toEqual(['Ta&sks Pane', 'Go&als Pane', '&Watchers Pane', 'Servers']);
  });

  it('hides the single task list like any pane, and changes only the pane it names', () => {
    let patch: Partial<View> = {};
    const singleView = ViewSchema.parse({ single: { showDisabled: false } });
    const single = paneVisibilityItems(singleView, (p) => (patch = p));
    expect(single[0]).toMatchObject({ checked: true });
    expect(single[0].enabled).toBeUndefined();
    single[0].click!({ checked: false } as never, undefined as never, undefined as never);
    expect(patch.single).toEqual({ ...singleView.single, visible: false });


    const view = ViewSchema.parse({ sidebar: 'multiple' });
    const items = paneVisibilityItems(view, (p) => (patch = p));
    items[1].click!({ checked: false } as never, undefined as never, undefined as never);
    expect(patch.panes?.goals.visible).toBe(false);
    expect(patch.panes?.tasks).toEqual(view.panes.tasks);
  });

  it('offers Hide Empty Folders only while the list shows folders', () => {
    const hideEmpty = (showFolders: boolean) =>
      singleMenuItems(ViewSchema.parse({ single: { showFolders } }), () => undefined).find((i) => i.label === 'Hide &Empty Folders')!;
    expect(hideEmpty(true).enabled).toBe(true);
    expect(hideEmpty(false).enabled).toBe(false);
  });

  it('changes only its own pane, and lets the last pane showing be hidden too', () => {
    let patch: Partial<View> = {};
    const view = ViewSchema.parse({ sidebar: 'multiple', panes: { tasks: { visible: false }, goals: { visible: false } } });
    const items = paneMenuItems(view, 'watchers', (p) => (patch = p));
    expect(items[0].enabled).toBeUndefined();
    const last = paneVisibilityItems(view, (p) => (patch = p))[2];
    expect(last.enabled).toBeUndefined();
    last.click!({ checked: false } as never, undefined as never, undefined as never);
    expect(patch.panes?.watchers.visible).toBe(false);
    const disabled = items.find((i) => i.label === 'Show &Disabled Tasks')!;
    disabled.click!({ checked: false } as never, undefined as never, undefined as never);
    expect(patch.panes?.watchers.showDisabled).toBe(false);
    expect(patch.panes?.goals).toEqual(view.panes.goals);
  });

  it('offers the Projects list its Group By choices in its header menu and as View > Group Projects By, at most two submenu levels deep', () => {
    let patch: Partial<View> = {};
    const view = ViewSchema.parse({});
    expect(view.projectsPane.groupBy).toBe('none');
    const groupBy = (items: MenuItemConstructorOptions[]) => items.find((i) => i.label === '&Group By')!.submenu as MenuItemConstructorOptions[];
    const header = projectsPaneMenuItems(view, (p) => (patch = p));
    expect(header.map((i) => i.label ?? '-')).toEqual(['&Group By']);
    expect(groupBy(header).map((i) => [i.label, i.checked])).toEqual([['&None', true], ['&Folder', false], ['&Harness', false]]);
    groupBy(header)[2].click!({} as never, undefined as never, undefined as never);
    expect(patch.projectsPane).toEqual({ ...view.projectsPane, groupBy: 'harness' });

    // View's own item: the choices one level down, and Task List Options no longer holds them.
    const viewItem = groupProjectsByMenu(view, (p) => (patch = p));
    expect(viewItem.label).toBe('&Group Projects By');
    expect((viewItem.submenu as MenuItemConstructorOptions[]).map((i) => i.label)).toEqual(['&None', '&Folder', '&Harness']);
    (viewItem.submenu as MenuItemConstructorOptions[])[1].click!({} as never, undefined as never, undefined as never);
    expect(patch.projectsPane).toEqual({ ...view.projectsPane, groupBy: 'folder' });
    for (const sidebar of ['single', 'multiple'] as const) {
      const menu = taskListMenu(ViewSchema.parse({ sidebar }), () => undefined);
      expect(menu.some((i) => i.label === '&Projects Pane')).toBe(false);
      // View > Task List Options > pane > item: no menu in the list opens a third level.
      const depth = (items: MenuItemConstructorOptions[]): number =>
        Math.max(0, ...items.map((i) => (Array.isArray(i.submenu) ? 1 + depth(i.submenu) : 0)));
      expect(depth(menu)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the sidebar out only when no pane shows', () => {
    const none = { single: { visible: false } };
    expect(sidebarHasPanes(ViewSchema.parse({}), [])).toBe(true);
    expect(sidebarHasPanes(ViewSchema.parse(none), [])).toBe(false);
    // Multiple panes: the single list's flag doesn't count, the task panes do.
    expect(sidebarHasPanes(ViewSchema.parse({ ...none, sidebar: 'multiple' }), [])).toBe(true);
    const hidden = { visible: false };
    const noTaskPanes = ViewSchema.parse({ ...none, sidebar: 'multiple', panes: { tasks: hidden, goals: hidden, watchers: hidden } });
    expect(sidebarHasPanes(noTaskPanes, [])).toBe(false);
    // An addon pane shows unless View hides it; a stopped addon's panes don't count.
    const addon = { id: 'srv', enabled: true, panes: [{ id: 'list', title: 'Servers' }] };
    expect(sidebarHasPanes(noTaskPanes, [addon])).toBe(true);
    expect(sidebarHasPanes(noTaskPanes, [{ ...addon, enabled: false }])).toBe(false);
    const addonHidden = ViewSchema.parse({ ...none, addonPanes: { 'srv/list': { visible: false } } });
    expect(sidebarHasPanes(addonHidden, [addon])).toBe(false);
  });

  it('hides completed goals by default and shows every other pane in full', () => {
    const view = ViewSchema.parse({});
    expect(view.sidebar).toBe('single');
    expect(view.panes.goals.showCompleted).toBe(false);
    expect(view.panes.tasks.showCompleted).toBe(true);
    expect(PANES.every((p) => view.panes[p.id].visible)).toBe(true);
    expect(view.single.visible).toBe(true);
  });
});
