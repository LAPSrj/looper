import { describe, expect, it } from 'vitest';
import { listOptionEntries } from '../src/shared/commands/list';
import type { Entry } from '../src/shared/commands/command';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { ALL_FILTERS, PANES, passesFilter, sidebarHasPanes } from '../src/shared/panes';
import { TaskFilterSchema, TaskSchema, ViewSchema, type TaskInput } from '../src/shared/types';

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

  const labelsOf = (entries: Entry[]) => entries.map((e) => ('separator' in e ? '-' : e.label));
  const options = (over: object = {}) => ViewSchema.parse({ single: over }).single;

  it('builds a list’s options from the filters it offers, then its folder choices', () => {
    const single = listOptionEntries(options(), ALL_FILTERS, () => undefined);
    expect(labelsOf(single)).toContain('Show &Watcher Tasks');

    const goals = PANES.find((p) => p.id === 'goals')!;
    const entries = listOptionEntries(options(), goals.filters, () => undefined);
    expect(labelsOf(entries)).toEqual([
      ...['Disabled', 'Comp&leted', 'S&cheduled', '&Manual', '&Watcher'].map((k) => expect.stringContaining(k)),
      '-',
      'Show &Folders',
      'Hide &Empty Folders',
    ]);
    const watchers = PANES.find((p) => p.id === 'watchers')!;
    expect(labelsOf(listOptionEntries(options(), watchers.filters, () => undefined))).not.toContain('Show &Watcher Tasks');
  });

  it('changes only the option an entry names, and shows its current value', () => {
    let patch: object = {};
    const entries = listOptionEntries(options({ showDisabled: false }), ['showDisabled', 'showCompleted'], (p) => (patch = p));
    const disabled = entries.find((e) => 'label' in e && e.label === 'Show &Disabled Tasks') as Extract<Entry, { id: string }>;
    expect(disabled.checked).toBe(false);
    disabled.run?.();
    expect(patch).toEqual({ showDisabled: true });
  });

  it('offers Hide Empty Folders only while the list shows folders', () => {
    const hideEmpty = (showFolders: boolean) =>
      listOptionEntries(options({ showFolders }), [], () => undefined).find((e) => 'label' in e && e.label === 'Hide &Empty Folders') as Extract<Entry, { id: string }>;
    expect(hideEmpty(true).enabled).toBe(true);
    expect(hideEmpty(false).enabled).toBe(false);
  });

  it('leaves the sidebar out only when no pane shows', () => {
    const none = { single: { visible: false } };
    expect(sidebarHasPanes(ViewSchema.parse({}))).toBe(true);
    expect(sidebarHasPanes(ViewSchema.parse(none))).toBe(false);
    // Multiple panes: the single list's flag doesn't count, the task panes do.
    expect(sidebarHasPanes(ViewSchema.parse({ ...none, sidebar: 'multiple' }))).toBe(true);
    const hidden = { visible: false };
    const noTaskPanes = ViewSchema.parse({ ...none, sidebar: 'multiple', panes: { tasks: hidden, goals: hidden, watchers: hidden } });
    expect(sidebarHasPanes(noTaskPanes)).toBe(false);
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
