import { describe, expect, it, vi } from 'vitest';
import { contextMenu, mainToolbarViews, mainWindowViews, menuBar, runCommand } from '../src/shared/commands/build';
import { addonCommandId, hasToolbarIn } from '../src/shared/commands/addon-commands';
import { EMPTY_CONTEXT, type CommandContext } from '../src/shared/commands/context';
import type { AddonCommand, AddonInfo } from '../src/shared/addons';
import type { MenuItemSpec } from '../src/shared/remote-access';
import type { Project } from '../src/shared/types';
import { commandToolbar } from '../src/renderer/src/components/command-surfaces';

const project = { id: 'p1', name: 'Web app', cwd: '/w/app' } as Project;
const addon = (commands: Partial<AddonCommand>[]) =>
  ({ id: 'git', name: 'Git', enabled: true, status: 'running', commands, tabs: [], projectTabs: [], panes: [], icons: {}, toolCalls: [] }) as unknown as AddonInfo;
const pull: Partial<AddonCommand> = { id: 'pull', label: 'Pull', menu: 'tools', in: { project: { toolbar: true } } };
const clone: Partial<AddonCommand> = { id: 'clone', label: 'Clone…', menu: 'file', in: { projects: { toolbar: true } } };

function context(over: Partial<CommandContext>): CommandContext & { event: ReturnType<typeof vi.fn> } {
  const event = vi.fn(() => Promise.resolve({}));
  return { ...EMPTY_CONTEXT, looper: { addons: { event } } as never, projects: [project], addons: [addon([pull, clone])], event, ...over };
}
const labels = (items: MenuItemSpec[]) => items.filter((i) => i.type !== 'separator').map((i) => i.label);
const button = (c: CommandContext, id: string) => commandToolbar(mainToolbarViews(c.tab), c).flatMap((g) => g.items).find((i) => i.id === addonCommandId('git', id));

describe('an addon command placed in a project', () => {
  it('is in a project row’s right-click menu, and acts on that project', () => {
    const c = context({ tab: 'projects', project, projectSelected: true });
    expect(labels(contextMenu('project', c))).toContain('Pull');
    runCommand(addonCommandId('git', 'pull'), c);
    expect(c.event).toHaveBeenCalledWith('git', { source: { app: true }, kind: 'command', id: 'pull', project: 'p1' }, undefined);
  });

  it('is on the Projects tab’s toolbar and menus, off while no project is selected', () => {
    const picked = context({ tab: 'projects', project, projectSelected: true });
    expect(button(picked, 'pull')?.enabled).toBe(true);
    expect(labels(menuBar(mainWindowViews('projects'), picked).find((m) => m.key === 'tools')?.submenu ?? [])).toContain('Pull');
    const none = context({ tab: 'projects', project: null, projectSelected: false });
    expect(button(none, 'pull')?.enabled).toBe(false);
    runCommand(addonCommandId('git', 'pull'), none);
    expect(none.event).not.toHaveBeenCalled();
  });

  it('isn’t on the Tasks or Dashboard tab, for the project of the task they show', () => {
    for (const tab of ['tasks', 'dashboard']) {
      const c = context({ tab, project, projectSelected: false });
      expect(labels(menuBar(mainWindowViews(tab), c).find((m) => m.key === 'tools')?.submenu ?? [])).not.toContain('Pull');
      expect(button(c, 'pull')).toBeUndefined();
    }
  });

  it('is on a phone’s project screen, whose project is the selected one', () => {
    const c = context({ here: 'mobile', project, projectSelected: true });
    expect(labels(contextMenu('project', c))).toContain('Pull');
    expect(labels(contextMenu('project', context({ here: 'mobile', project, projectSelected: false })))).not.toContain('Pull');
  });

  it('counts as a button on the Projects tab’s toolbar', () => {
    expect(hasToolbarIn(addon([pull]), 'projects')).toBe(true);
    expect(hasToolbarIn(addon([pull]), 'tasks')).toBe(false);
  });
});

describe('an addon command placed in the Projects tab', () => {
  it('carries the selected project, and none while none is', () => {
    const picked = context({ tab: 'projects', project, projectSelected: true });
    runCommand(addonCommandId('git', 'clone'), picked);
    expect(picked.event).toHaveBeenCalledWith('git', { source: { app: true }, kind: 'command', id: 'clone', project: 'p1' }, undefined);
    const none = context({ tab: 'projects', project: null, projectSelected: false });
    runCommand(addonCommandId('git', 'clone'), none);
    expect(none.event).toHaveBeenCalledWith('git', { source: { app: true }, kind: 'command', id: 'clone' }, undefined);
  });

  it('carries no project from another tab, where the selection isn’t the Projects tab’s', () => {
    const c = context({ tab: 'tasks', project, projectSelected: true, addons: [addon([{ id: 'sync', label: 'Sync', menu: 'tools', in: { app: {} } }])] });
    runCommand(addonCommandId('git', 'sync'), c);
    expect(c.event).toHaveBeenCalledWith('git', { source: { app: true }, kind: 'command', id: 'sync' }, undefined);
  });
});
