// Relative imports only: the main process, the renderer and the unit tests all load the catalogs.
import { SHORTCUTS } from '../shortcuts';
import type { Command } from './types';

/** The menus these commands are in: the Task menu, and File (Export Task). */
export type TaskMenu = 'task' | 'file';
/** The Tasks tab's toolbar groups. */
export type TaskToolbarGroup = 'task' | 'edit';
/** A task screen's More menu, in this order (the project's commands are PROJECT_COMMANDS'). */
export const TASK_MORE_GROUPS = ['state', 'edit', 'organize', 'project', 'delete'] as const;
export type TaskMoreGroup = (typeof TASK_MORE_GROUPS)[number];

type TaskCommand = Command<TaskMenu, TaskToolbarGroup, TaskMoreGroup, never>;

/**
 * The selected task's commands (the main window's Task menu and the Tasks
 * tab's toolbar). The phone's More menu on a task's screen lists them in this
 * order, by group.
 */
export const TASK_COMMANDS = {
  runNow: {
    label: '&Run Now',
    icon: 'run',
    accelerator: 'F5',
    menu: { id: 'task-run-now', in: 'task', group: 'task' },
    toolbar: { id: 'run-now', group: 'task' },
    mobile: { group: 'state' },
  },
  stop: {
    label: '&Stop Task',
    icon: 'stop',
    accelerator: 'Shift+F5',
    destructive: true,
    menu: { id: 'task-stop', in: 'task', group: 'task' },
    toolbar: { id: 'stop-task', group: 'task' },
    mobile: { group: 'state' },
  },
  pauseResume: {
    label: '&Pause',
    icon: 'pause',
    alt: { label: '&Resume', icon: 'resume' },
    accelerator: SHORTCUTS.pauseResume,
    menu: { id: 'task-pause-resume', in: 'task', group: 'task' },
    toolbar: { id: 'pause-resume', group: 'task' },
    mobile: { group: 'state' },
  },
  enableDisable: {
    label: '&Disable',
    icon: 'power',
    alt: { label: 'E&nable' },
    menu: { id: 'task-enable-disable', in: 'task', group: 'task' },
    toolbar: { id: 'enable-disable', group: 'task' },
    mobile: { group: 'state' },
  },
  complete: {
    label: 'C&omplete',
    icon: 'complete',
    alt: { label: 'Re&open' },
    menu: { id: 'task-complete', in: 'task', group: 'task' },
    toolbar: { id: 'complete-reopen', group: 'task' },
    mobile: { group: 'state' },
  },
  edit: {
    label: '&Edit Task…',
    icon: 'edit',
    accelerator: 'CmdOrCtrl+E',
    menu: { id: 'task-edit', in: 'task', group: 'task' },
    toolbar: { id: 'edit-task', group: 'edit' },
    mobile: { group: 'edit' },
  },
  editAgent: {
    label: 'Edit with &Agent…',
    menu: { id: 'task-edit-agent', in: 'task', group: 'task' },
    mobile: { group: 'edit' },
  },
  note: {
    label: 'Add &Guidance for Next Run…',
    icon: 'guidance',
    alt: { label: 'Edit &Guidance for Next Run…' },
    menu: { id: 'task-note', in: 'task', group: 'guidance' },
    toolbar: { id: 'edit-note', group: 'task' },
    mobile: { group: 'edit' },
  },
  noteClear: {
    label: 'Clear Guidance',
    destructive: true,
    menu: { id: 'task-note-clear', in: 'task', group: 'guidance' },
    mobile: { group: 'edit' },
  },
  moveFolder: {
    label: 'Move to &Folder…',
    icon: 'folder',
    menu: { id: 'task-move-folder', in: 'task', group: 'organize' },
    mobile: { group: 'organize' },
  },
  versions: {
    label: '&Version History',
    menu: { id: 'task-versions', in: 'task', group: 'task' },
    mobile: { group: 'organize' },
  },
  export: {
    label: 'Ex&port Task…',
    menu: { id: 'task-export', in: 'file', group: 'export' },
    mobile: { group: 'organize' },
  },
  clearRuns: {
    label: 'Clear Run &History…',
    destructive: true,
    menu: { id: 'task-clear-runs', in: 'task', group: 'organize' },
    mobile: { group: 'organize' },
  },
  delete: {
    label: 'De&lete Task',
    icon: 'delete',
    destructive: true,
    menu: { id: 'task-delete', in: 'task', group: 'task' },
    mobile: { group: 'delete' },
  },
  workFolder: {
    label: 'Open &Working Directory',
    icon: 'openFolder',
    menu: { id: 'task-work-folder', in: 'task', group: 'folder', glyph: false },
    toolbar: { id: 'open-work-folder', group: 'edit' },
    mobile: { group: 'organize' },
  },
} as const satisfies Record<string, TaskCommand>;

export type TaskCommandName = keyof typeof TASK_COMMANDS;
