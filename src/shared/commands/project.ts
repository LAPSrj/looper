// Relative imports only: the main process, the renderer and the unit tests all load the catalogs.
import type { TaskMoreGroup } from './task';
import type { Command } from './types';

/**
 * A project's commands, in one order with one label each: the Project menu
 * and a project's context menu (main/project-menu.ts). Their phone placement
 * is for a task's screen, whose More menu has its project's commands too.
 */
export const PROJECT_COMMANDS = {
  'new-task': {
    label: 'New &Task…',
    icon: 'newTask',
    menu: { id: 'project-new-task', in: 'project', group: 'new' },
    mobile: { hidden: 'A task’s screen doesn’t make tasks: the Tasks tab’s bar has New Task.' },
  },
  'new-chat': {
    label: 'New &Chat',
    icon: 'newChat',
    menu: { id: 'project-new-chat', in: 'project', group: 'new' },
    mobile: { group: 'project' },
  },
  'new-terminal': {
    label: 'New Ter&minal',
    icon: 'terminal',
    menu: { id: 'project-new-terminal', in: 'project', group: 'new' },
    mobile: { group: 'project' },
  },
  edit: {
    label: '&Edit Project…',
    icon: 'edit',
    menu: { id: 'project-edit', in: 'project', group: 'project' },
    mobile: { hidden: 'The project’s own screen has Edit Project.' },
  },
  'open-folder': {
    label: 'Open &Folder',
    menu: { id: 'project-folder', in: 'project', group: 'project' },
    mobile: { hidden: 'Not a command of the task shown: the project’s own screen has it (its toolbar’s Open Folder, in More).' },
  },
  delete: {
    label: '&Delete Project…',
    icon: 'delete',
    destructive: true,
    menu: { id: 'project-delete', in: 'project', group: 'project' },
    mobile: { hidden: 'Not a command of the task shown: the project’s own screen has it (a long press).' },
  },
} as const satisfies Record<string, Command<'project', never, TaskMoreGroup, never>>;

export type ProjectCommand = keyof typeof PROJECT_COMMANDS;
