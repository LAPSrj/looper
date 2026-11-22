import { contextMenu, entriesMenu, runCommand, viewOptions } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { listOptionEntries } from '@shared/commands/list';
import type { Entry } from '@shared/commands/command';
import { ALL_FILTERS, PANES, type PaneId } from '@shared/panes';
import type { Project, Task, TaskRuntime } from '@shared/types';
import { popupCommands, popupEntries } from './command-surfaces';

/** The state a window's commands read now: what a row's menu starts from. */
let current: CommandContext | null = null;
export const setRowMenuContext = (c: CommandContext): void => {
  current = c;
};

const forTask = (c: CommandContext, t: Task, rt: TaskRuntime | undefined): CommandContext => ({
  ...c,
  task: t,
  runtime: rt,
  pickedRun: null,
  clearAttention: undefined,
  project: c.projects.find((p) => p.id === t.projectId) ?? null,
  projectSelected: false,
});

/** A task row's menu: its commands act on that row, whatever is selected. A Needs attention row passes how to take it off. */
export function showTaskMenu(t: Task, rt: TaskRuntime | undefined, clearAttention?: () => void): void {
  if (!current) return;
  const c = { ...forTask(current, t, rt), clearAttention };
  popupCommands(c, contextMenu('task', c));
}

/** The task list's Delete key. */
export function deleteTask(t: Task, rt: TaskRuntime | undefined): void {
  if (current) runCommand('deleteTask', forTask(current, t, rt));
}

/** A Claude Code login's row in Needs attention: Log In, or take the row off. */
export function showLoginMenu(logIn: () => void, clear: () => void): void {
  if (current) popupEntries(current, 'login', [{ id: 'log-in', label: '&Log In', run: logIn }, { separator: true }, { id: 'remove', label: 'Remove from &Needs Attention', run: clear }]);
}

/** A project row's menu. */
export function showProjectMenu(p: Project): void {
  if (!current) return;
  const c: CommandContext = { ...current, task: null, runtime: undefined, project: p, projectSelected: true };
  popupCommands(c, contextMenu('project', c));
}

/** The Projects list's own menu: Group By, New Project, New Folder. */
export function showProjectsListMenu(): void {
  if (current) popupCommands({ ...current, tab: 'projects' }, contextMenu('projects', { ...current, tab: 'projects' }));
}

/** A task list's own menu (a right-click on its empty space): that pane's options, or the single list's, then the Tasks tab's commands. */
export function showTasksListMenu(pane?: PaneId): void {
  const c = current;
  if (!c) return;
  const tc: CommandContext = { ...c, tab: 'tasks' };
  const options = paneOptions(c, pane);
  const own = options.length ? entriesMenu('pane', options) : null;
  const rest = contextMenu('tasks', tc);
  const items = own ? [...own.items, ...(rest.length ? [{ id: '-pane', type: 'separator' as const, enabled: true }] : []), ...rest] : rest;
  if (items.length) void c.looper.commands.popup(items).then((id) => id && (own && id.startsWith('pane/') ? own.pick(id) : runCommand(id, tc)));
}

/** The Dashboard's Recent runs and a task's Runs list: View → Task Runs (what they leave out), in a popup. */
export function showRunListMenu(): void {
  if (current) popupCommands(current, viewOptions('dashboard', ['task-list'], current));
}

/** A pane's options, or the single list's: Show Pane (a pane's), then what the list shows. */
function paneOptions(c: CommandContext, pane?: PaneId): Entry[] {
  const view = c.settings?.view;
  if (!view) return [];
  const def = PANES.find((p) => p.id === pane);
  return def
    ? [
        { id: 'show', label: 'Show &Pane', checked: view.panes[def.id].visible, run: () => c.setView({ panes: { ...view.panes, [def.id]: { ...view.panes[def.id], visible: !view.panes[def.id].visible } } }) },
        { separator: true },
        ...listOptionEntries(view.panes[def.id], def.filters, (patch) => c.setView({ panes: { ...view.panes, [def.id]: { ...view.panes[def.id], ...patch } } })),
      ]
    : listOptionEntries(view.single, ALL_FILTERS, (patch) => c.setView({ single: { ...view.single, ...patch } }));
}

/** A task list's header: that pane's options, or the single list's, then New Folder. */
export function showPaneMenu(pane?: PaneId): void {
  const c = current;
  if (!c?.settings?.view) return;
  popupEntries(c, 'pane', [...paneOptions(c, pane), { separator: true }, { id: 'new-folder', label: 'New Folder…', run: () => c.host('new-folder', 'task') }]);
}
