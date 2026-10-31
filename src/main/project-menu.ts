import { DESKTOP_ONLY } from '../shared/ui-platform';

export type ProjectCommand = 'new-task' | 'new-chat' | 'new-terminal' | 'edit' | 'open-folder' | 'delete';

interface Command {
  command: ProjectCommand;
  /** The id the Project menu's item has (the phone's More menu and toolbar refer to it). */
  id: string;
  label: string;
  glyph?: string;
  desktopOnly?: boolean;
  /** Ends a group: a separator follows. */
  group?: boolean;
}

/** One list of a project's commands, in one order with one label each, for the Project menu and a project's context menu. */
const COMMANDS: Command[] = [
  { command: 'new-task', id: 'project-new-task', label: 'New &Task…', glyph: 'newTask' },
  { command: 'new-chat', id: 'project-new-chat', label: 'New &Chat', glyph: 'newChat' },
  { command: 'new-terminal', id: 'project-new-terminal', label: 'New Ter&minal', glyph: 'terminal', group: true },
  { command: 'edit', id: 'project-edit', label: '&Edit Project…', glyph: 'edit' },
  { command: 'open-folder', id: 'project-folder', label: 'Open &Folder', desktopOnly: true },
  { command: 'delete', id: 'project-delete', label: '&Delete Project…', glyph: 'delete' },
];

export const PROJECT_COMMANDS: ProjectCommand[] = COMMANDS.map((c) => c.command);

/**
 * A project's commands as menu items. `run` does the picked one; `extra` adds
 * to a command's item (an accelerator, whether it's enabled).
 */
export function projectMenuItems(
  run: (command: ProjectCommand) => void,
  extra: Partial<Record<ProjectCommand, Partial<Electron.MenuItemConstructorOptions>>> = {},
): Electron.MenuItemConstructorOptions[] {
  return COMMANDS.flatMap((c): Electron.MenuItemConstructorOptions[] => {
    const item: Electron.MenuItemConstructorOptions = {
      id: c.id,
      label: c.label,
      ...(c.glyph ? { glyph: c.glyph } : {}),
      ...(c.desktopOnly ? { platforms: DESKTOP_ONLY } : {}),
      ...extra[c.command],
      click: () => run(c.command),
    };
    return c.group ? [item, { type: 'separator' }] : [item];
  });
}
