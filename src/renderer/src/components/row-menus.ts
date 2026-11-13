import { contextMenu, runCommand } from '@shared/commands/build';
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
  project: c.projects.find((p) => p.id === t.projectId) ?? null,
  projectSelected: false,
});

/** A task row's menu: its commands act on that row, whatever is selected. */
export function showTaskMenu(t: Task, rt: TaskRuntime | undefined): void {
  if (!current) return;
  const c = forTask(current, t, rt);
  popupCommands(c, contextMenu('task', c));
}

/** The task list's Delete key. */
export function deleteTask(t: Task, rt: TaskRuntime | undefined): void {
  if (current) runCommand('deleteTask', forTask(current, t, rt));
}

/** A Claude Code login's row: Log In. */
export function showLoginMenu(logIn: () => void): void {
  if (current) popupEntries(current, 'login', [{ id: 'log-in', label: '&Log In', run: logIn }]);
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

/** The task list's own menu. */
export function showTasksListMenu(): void {
  if (current) popupCommands({ ...current, tab: 'tasks' }, contextMenu('tasks', { ...current, tab: 'tasks' }));
}

/** A task list's header: that pane's options, or the single list's, then New Folder. */
export function showPaneMenu(pane?: PaneId): void {
  const c = current;
  const view = c?.settings?.view;
  if (!c || !view) return;
  const def = PANES.find((p) => p.id === pane);
  const options: Entry[] = def
    ? [
        { id: 'show', label: 'Show &Pane', checked: view.panes[def.id].visible, run: () => c.setView({ panes: { ...view.panes, [def.id]: { ...view.panes[def.id], visible: !view.panes[def.id].visible } } }) },
        { separator: true },
        ...listOptionEntries(view.panes[def.id], def.filters, (patch) => c.setView({ panes: { ...view.panes, [def.id]: { ...view.panes[def.id], ...patch } } })),
      ]
    : listOptionEntries(view.single, ALL_FILTERS, (patch) => c.setView({ single: { ...view.single, ...patch } }));
  popupEntries(c, 'pane', [...options, { separator: true }, { id: 'new-folder', label: 'New Folder…', run: () => c.host('new-folder', 'task') }]);
}
