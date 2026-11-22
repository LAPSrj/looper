import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, migrateSettings } from '../src/engine/store/settings';
import { mainToolbarViews, mainWindowViews, menuBar } from '../src/shared/commands/build';
import { noMnemonic, type CommandView } from '../src/shared/commands/command';
import { EMPTY_CONTEXT, type CommandContext } from '../src/shared/commands/context';
import { toolbarEntries } from '../src/shared/commands/list';
import type { AddonCommand, AddonInfo } from '../src/shared/addons';
import { SettingsSchema, type View } from '../src/shared/types';
import { moveToolbar, resizeToolbar, toolbarRows } from '../src/shared/toolbars';
import { commandToolbar, mainToolbarBands } from '../src/renderer/src/components/command-surfaces';

const settings = SettingsSchema.parse({});
const addonWith = (id: string, commands: Partial<AddonCommand>[]) =>
  ({ id, name: id, enabled: true, status: 'running', commands, tabs: [], panes: [{ id: 'list', title: 'List' }], icons: {}, toolCalls: [] }) as unknown as AddonInfo;
const addons = [
  addonWith('srv', [
    { id: 'new', label: '&New Server…', icon: 'add', in: { new: { toolbar: true }, panes: {} } },
    { id: 'list', label: '&Servers', icon: 'terminal', opens: { tab: 'panes' }, menu: 'tools', in: { app: { toolbar: true } } },
    { id: 'edit', label: '&Edit Server…', icon: 'edit', menu: 'edit', in: { item: { toolbar: true } } },
  ]),
];
const chats = { single: false, tab: true, selected: null, summary: undefined, chat: null, sessions: [], shown: {} } as never;

function context(over: Partial<CommandContext> = {}): CommandContext & { patches: Partial<View>[] } {
  const patches: Partial<View>[] = [];
  return { ...EMPTY_CONTEXT, settings, addons, setView: (p) => void patches.push(p), patches, ...over };
}
const labels = (entries: ReturnType<typeof toolbarEntries>) => entries.map((e) => ('separator' in e ? '-' : noMnemonic(e.label)));
const viewMenu = (views: readonly CommandView[], c: CommandContext) => (menuBar(views, c).find((m) => m.key === 'view')?.submenu ?? []).map((i) => noMnemonic(i.label ?? ''));

describe('the settings migration', () => {
  it('gives each of the four toolbars the old single check, and leaves a current file alone', () => {
    expect(migrateSettings({ view: { toolbar: false, statusBar: true } })).toEqual({
      view: { statusBar: true, toolbars: { new: false, projects: false, tasks: false, chats: false } },
    });
    expect(migrateSettings({ tickMs: 5, view: { toolbar: true } })).toEqual({ tickMs: 5, view: { toolbars: { new: true, projects: true, tasks: true, chats: true } } });
    expect(migrateSettings({ view: { toolbars: { new: true } } })).toBeNull();
    expect(migrateSettings({})).toBeNull();
    expect(migrateSettings(null)).toBeNull();
  });

  it('rewrites an old settings file when it loads, and the settings read the new shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-settings-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ view: { toolbar: false, statusBar: false } }));
      const loaded = loadSettings(dir);
      expect(loaded.view.toolbars).toEqual({ new: false, projects: false, tasks: false, chats: false, rows: [] });
      expect(loaded.view.statusBar).toBe(false);
      const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { view: Record<string, unknown> };
      expect(written.view).not.toHaveProperty('toolbar');
      expect(written.view.toolbars).toEqual({ new: false, projects: false, tasks: false, chats: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the main window’s toolbars', () => {
  const ids = (groups: { items: { id: string }[] }[]) => groups.flatMap((g) => g.items.map((i) => i.id));

  it('splits each tab’s toolbar into New, the tab’s own and each addon’s, losing and repeating no button', () => {
    const cases: [string, Partial<CommandContext>][] = [
      ['dashboard', {}],
      ['tasks', {}],
      ['projects', {}],
      ['chats', { chats }],
      ['addon/srv/panes', { addon: { id: 'srv', panes: { pane: 'list' }, item: null } }],
    ];
    for (const [tab, over] of cases) {
      for (const [fixed, item] of [[false, false], [true, false], [true, true]] as const) {
        if (item && tab !== 'tasks' && tab !== 'projects') continue;
        const c = context({ tab, fixed, item, ...over });
        const whole = ids(commandToolbar(mainToolbarViews(tab, fixed, item), c));
        const split = mainToolbarBands(tab, fixed, item, c).flatMap((b) => ids(b.groups));
        expect(split.sort(), `${tab} ${fixed} ${item}`).toEqual([...whole].sort());
      }
    }
  });

  it('puts the New items on New, the tab’s buttons on its toolbar, and an addon’s others on its own', () => {
    const bands = mainToolbarBands('tasks', false, false, context({ tab: 'tasks' }));
    expect(bands.map((b) => b.id)).toEqual(['new', 'tasks', 'addon:srv']);
    expect(ids(bands[0].groups)).toEqual(['newProject', 'newTask', 'newChat', 'addon:srv:new']);
    expect(ids(bands[1].groups)).toContain('runNow');
    expect(ids(bands[2].groups)).toEqual(['addon:srv:list']);
    expect(mainToolbarBands('chats', false, false, context({ tab: 'chats', chats })).map((b) => b.id)).toEqual(['new', 'chats', 'addon:srv']);
    expect(mainToolbarBands('projects', true, true, context({ tab: 'projects', fixed: true, item: true })).map((b) => b.id)).toEqual(['projects']);
  });

  it('lists the toolbars a window can show in View → Toolbars, and turns one off on its own', () => {
    const main = context({ tab: 'tasks' });
    expect(labels(toolbarEntries(main))).toEqual(['New Toolbar', 'Projects Toolbar', 'Tasks Toolbar', 'Chats Toolbar', '-', 'srv Toolbar']);
    // A view window lists only the addons with a button for its view: srv's are in New and app-wide.
    expect(labels(toolbarEntries(context({ tab: 'tasks', fixed: true })))).toEqual(['New Toolbar', 'Tasks Toolbar']);
    expect(labels(toolbarEntries(context({ tab: 'dashboard', fixed: true })))).toEqual([]);
    expect(labels(toolbarEntries(context({ tab: 'projects', fixed: true, item: true })))).toEqual(['Projects Toolbar']);
    const tasks = toolbarEntries(main).find((e) => 'id' in e && e.id === 'tasks')!;
    if ('separator' in tasks) throw new Error('not an item');
    expect(tasks.checked).toBe(true);
    tasks.run!();
    expect(main.patches).toEqual([{ toolbars: { new: true, projects: true, tasks: false, chats: true, rows: [] } }]);
  });

  it('has View → Toolbars in the main window, and View → Toolbar in the Chats window', () => {
    const main = viewMenu(mainWindowViews('tasks'), context({ tab: 'tasks' }));
    expect(main).toContain('Toolbars');
    expect(main).not.toContain('Toolbar');
    expect(main).not.toContain('srv Toolbar');
    const window = viewMenu(['new', 'frame', 'chats', 'conversation', 'chatWindow'], context({ chats: { ...(chats as object), tab: false } as never }));
    expect(window).toContain('Toolbar');
    expect(window).not.toContain('Toolbars');
  });
});

describe('the toolbars’ rows', () => {
  const p = (id: string, width = 0) => ({ id, width });
  const four = ['new', 'projects', 'tasks', 'chats'];

  it('starts with every toolbar in one row, and puts one no row lists at the end of the first', () => {
    expect(toolbarRows([], four)).toEqual([four.map((id) => p(id))]);
    expect(toolbarRows([[p('tasks')], [p('new', 120)]], [...four, 'addon:srv'])).toEqual([[p('tasks'), p('projects'), p('chats'), p('addon:srv')], [p('new', 120)]]);
    // An empty row in a saved file is left out.
    expect(toolbarRows([[], [p('new')]], ['new'])).toEqual([[p('new')]]);
    // The main window asks for its own four and then the shown ones, which are among them: each comes once.
    expect(toolbarRows([], [...four, 'new', 'chats', 'addon:srv'])).toEqual([[...four, 'addon:srv'].map((id) => p(id))]);
  });

  it('moves a toolbar before another, to a row’s end, or into a new row, keeping its width and dropping an emptied row', () => {
    const rows = [[p('new'), p('projects', 90)], [p('tasks')]];
    expect(moveToolbar(rows, 'projects', { row: 0, before: 'new' })).toEqual([[p('projects', 90), p('new')], [p('tasks')]]);
    expect(moveToolbar(rows, 'new', { row: 1, before: null })).toEqual([[p('projects', 90)], [p('tasks'), p('new')]]);
    expect(moveToolbar(rows, 'tasks', { row: 0, before: 'projects' })).toEqual([[p('new'), p('tasks'), p('projects', 90)]]);
    expect(moveToolbar(rows, 'new', { newRow: 0 })).toEqual([[p('new')], [p('projects', 90)], [p('tasks')]]);
    expect(moveToolbar(rows, 'projects', { newRow: 2 })).toEqual([[p('new')], [p('tasks')], [p('projects', 90)]]);
  });

  it('sets a toolbar’s width, 0 giving it its buttons’ width again', () => {
    const rows = [[p('new'), p('tasks', 200)]];
    expect(resizeToolbar(rows, 'new', 80.4)).toEqual([[p('new', 80), p('tasks', 200)]]);
    expect(resizeToolbar(rows, 'tasks', 0)).toEqual([[p('new'), p('tasks')]]);
  });

  it('keeps the rows in View settings', () => {
    const view = SettingsSchema.parse({ view: { toolbars: { tasks: false, rows: [[{ id: 'tasks', width: 150 }], [{ id: 'new' }]] } } }).view;
    expect(view.toolbars).toEqual({ new: true, projects: true, tasks: false, chats: true, rows: [[p('tasks', 150)], [p('new')]] });
  });
});
