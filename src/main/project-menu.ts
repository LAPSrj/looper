import { PROJECT_COMMANDS, type ProjectCommand } from '../shared/commands/project';
import { commandMenuItem } from './command-menu';

export type { ProjectCommand };

/** The project's commands, in the catalog's order. */
export const PROJECT_COMMAND_NAMES = Object.keys(PROJECT_COMMANDS) as ProjectCommand[];

/**
 * A project's commands as menu items (the Project menu and a project's
 * context menu). `run` does the picked one; `extra` adds to a command's item
 * (an accelerator, whether it's enabled).
 */
export function projectMenuItems(
  run: (command: ProjectCommand) => void,
  extra: Partial<Record<ProjectCommand, Partial<Electron.MenuItemConstructorOptions>>> = {},
): Electron.MenuItemConstructorOptions[] {
  const out: Electron.MenuItemConstructorOptions[] = [];
  let group: string | undefined;
  for (const command of PROJECT_COMMAND_NAMES) {
    const c = PROJECT_COMMANDS[command];
    if (group !== undefined && c.menu.group !== group) out.push({ type: 'separator' });
    group = c.menu.group;
    out.push({ ...commandMenuItem(c, {}), ...extra[command], click: () => run(command) });
  }
  return out;
}
