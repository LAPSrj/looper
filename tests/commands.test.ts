import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { specTemplate } from '../src/main/command-menu';
import { CHAT_WINDOW_VIEWS, CHATS_WINDOW_VIEWS, contextMenu, hiddenReasons, mainToolbarViews, mainWindowViews, menuBar, moreViewCommands, runCommand } from '../src/shared/commands/build';
import { addonCommandId } from '../src/shared/commands/addon-commands';
import { COMMAND_VIEWS, DESKTOP_VIEWS, MENU_BAR, noMnemonic, type CommandView } from '../src/shared/commands/command';
import { EMPTY_CONTEXT, HOST_COMMANDS, type CommandContext } from '../src/shared/commands/context';
import { COMMANDS } from '../src/shared/commands/list';
import { readAddonManifest, type AddonCommand, type AddonInfo } from '../src/shared/addons';
import type { MenuItemSpec } from '../src/shared/remote-access';
import { SettingsSchema, type Task, type TaskRuntime } from '../src/shared/types';
import { commandToolbar, phoneActions, phoneMore } from '../src/renderer/src/components/command-surfaces';
import { composeMore } from '../src/renderer/src/web/more-menu';

const task = (o: Partial<Task> = {}) => ({ id: 't1', name: 'Nightly', enabled: true, maxConcurrentRuns: 1, completion: { allowed: true }, ...o }) as Task;
const runtime = (state: string, runs = 0) => ({ taskId: 't1', state, runs: Array.from({ length: runs }, () => ({})) }) as unknown as TaskRuntime;

/** A context whose API calls are spies, by "namespace.method". */
function context(over: Partial<CommandContext> = {}, here: CommandContext['here'] = 'desktop'): CommandContext & { calls: string[] } {
  const calls: string[] = [];
  const spy = (name: string): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key: string) => (key === 'then' ? undefined : spy(`${name}.${key}`)),
      apply: () => {
        calls.push(name);
        return Promise.resolve(true);
      },
    });
  return { ...EMPTY_CONTEXT, looper: spy('looper') as never, here, host: (n) => void calls.push(`host.${n}`), calls, ...over };
}

const labels = (items: MenuItemSpec[]) => items.map((i) => (i.type === 'separator' ? '-' : noMnemonic(i.label ?? '')));
const menu = (views: readonly CommandView[], name: string, c: CommandContext) => menuBar(views, c).find((m) => m.key === name)?.submenu ?? [];
const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const addonWith = (id: string, commands: Partial<AddonCommand>[], over: Partial<AddonInfo> = {}) =>
  ({ id, name: id, enabled: true, status: 'running', commands, tabs: [], panes: [{ id: 'list', title: 'List' }], icons: {}, toolCalls: [], ...over }) as unknown as AddonInfo;

describe('the one list', () => {
  it('has one id for each command', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fails the typecheck for a command with no view, no placement or a hide with no reason', () => {
    // @ts-expect-error A command has to say which views it's in.
    const noView: (typeof COMMANDS)[number] = { id: 'x', label: 'x', group: 'x' };
    // @ts-expect-error A placement has to say where.
    const noPlace: (typeof COMMANDS)[number] = { id: 'x', label: 'x', group: 'x', in: { task: {} } };
    // @ts-expect-error A hide has to say why.
    const noReason: (typeof COMMANDS)[number] = { id: 'x', label: 'x', group: 'x', hide: [{ on: ['mobile'] }], in: { task: { menu: 'task' } } };
    expect([noView, noPlace, noReason]).toHaveLength(3);
  });

  it('says why every time it leaves a command out', () => {
    const reasons = hiddenReasons();
    expect(reasons.length).toBeGreaterThan(20);
    for (const r of reasons) expect(r.why.trim().length, r.id).toBeGreaterThan(10);
  });

  it('puts every view and menu it names in the known lists', () => {
    const menus = new Set<string>(MENU_BAR.map((m) => m.name));
    for (const cmd of COMMANDS) {
      for (const [view, where] of Object.entries(cmd.in)) {
        expect(COMMAND_VIEWS as readonly string[], cmd.id).toContain(view);
        if (where?.menu) expect(menus.has(where.menu), cmd.id).toBe(true);
      }
    }
  });

  it('has a place on a phone for every command, or a written reason', () => {
    const phone = context({}, 'mobile');
    for (const cmd of COMMANDS) {
      const placedOnScreen = (Object.keys(cmd.in) as CommandView[]).some((v) => !DESKTOP_VIEWS.includes(v));
      const hiddenFromPhone = cmd.hide?.some((h) => h.on?.includes('mobile'));
      const inMoreView = moreViewCommands(phone).includes(cmd);
      // A desktop-only view's command needs a phone reason, or it falls to the More view.
      expect(placedOnScreen || hiddenFromPhone || inMoreView || !!cmd.hide?.length, cmd.id).toBe(true);
    }
  });

  it('sends every host command it names to a name the main process knows', () => {
    const named = [...src('shared', 'commands', 'list.ts').matchAll(/(?:c\.host\(|host\s*:\s*)'([a-z-]+)'/g)].map((m) => m[1]);
    for (const name of named) expect(HOST_COMMANDS as readonly string[]).toContain(name);
    const table = src('main', 'index.ts');
    for (const name of HOST_COMMANDS) expect(table, name).toMatch(new RegExp(`(^|\\s)'?${name}'?: (async )?\\(`, 'm'));
  });
});

describe('a task on every surface', () => {
  const views = mainWindowViews('tasks');

  it('builds the Task menu in the one order, with the project’s New Chat and New Terminal, Delete in its own last group', () => {
    const c = context({ task: task(), tab: 'tasks' });
    const order = [
      'Run Now', 'Stop Task', 'Pause', 'Disable', 'Complete', '-',
      'Edit Task…', 'Edit with Agent…', 'Add Guidance for Next Run…', 'Clear Guidance', '-',
      'Move to Folder…', 'Version History', 'Clear Run History…', 'Open Working Directory', '-',
      'New Chat', 'New Terminal', '-',
      'Delete Task',
    ];
    expect(labels(menu(views, 'task', c))).toEqual(order);
    // A task's own window, and a view window of tasks, which have no Project menu.
    expect(labels(menu(mainWindowViews('tasks', true, true), 'task', context({ task: task(), tab: 'tasks', fixed: true, item: true })))).toEqual(order);
    expect(labels(menu(mainWindowViews('tasks', true), 'task', context({ task: task(), tab: 'tasks', fixed: true })))).toEqual(order);
    // The Project menu keeps them too.
    expect(labels(menu(views, 'project', context({ task: task(), tab: 'tasks', project: { id: 'p', name: 'Site' } as never })))).toEqual(expect.arrayContaining(['New Chat', 'New Terminal']));
  });

  it('builds the toolbar in that order, on the Tasks tab only', () => {
    const c = context({ task: task(), tab: 'tasks' });
    const groups = commandToolbar(['task'], c).map((g) => g.items.map((i) => i.label));
    expect(groups).toEqual([
      ['Run Now', 'Stop Task', 'Pause', 'Disable', 'Complete'],
      ['Edit Task', 'Add Guidance for Next Run', 'Open Working Directory'],
    ]);
    expect(mainToolbarViews('dashboard')).not.toContain('task');
    expect(mainToolbarViews('tasks')).toContain('task');
  });

  it('builds the right-click menu with the project’s two and without Export', () => {
    const c = context({ task: task(), project: { id: 'p', name: 'Site' } as never });
    const items = labels(contextMenu('task', c));
    expect(items).toContain('New Chat');
    expect(items).toContain('New Terminal');
    expect(items).not.toContain('Export Task…');
    expect(items).not.toContain('Edit Project…');
  });

  it('follows the state: the same rules on every surface', () => {
    const idle = context({ task: task(), runtime: runtime('idle') });
    const atCap = context({ task: task(), runtime: runtime('running', 1) });
    const enabled = (c: CommandContext, label: string) => menu(views, 'task', c).find((i) => noMnemonic(i.label ?? '') === label)?.enabled;
    expect(enabled(idle, 'Run Now')).toBe(true);
    expect(enabled(idle, 'Stop Task')).toBe(false);
    expect(enabled(atCap, 'Run Now')).toBe(false);
    expect(enabled(atCap, 'Stop Task')).toBe(true);
    expect(enabled(atCap, 'Clear Run History…')).toBe(false);
    const buttons = (c: CommandContext) => commandToolbar(['task'], c).flatMap((g) => g.items);
    expect(buttons(idle).find((i) => i.id === 'runNow')?.enabled).toBe(true);
    expect(buttons(atCap).find((i) => i.id === 'runNow')?.enabled).toBe(false);
  });

  it('shows the alternate label and icon', () => {
    const paused = context({ task: task({ enabled: false, completedAt: 'x', note: 'n' } as never), runtime: runtime('paused') });
    const items = menu(views, 'task', paused);
    const byId = (id: string) => items.find((i) => i.id === id);
    expect(byId('pauseResume')).toMatchObject({ label: '&Resume', icon: 'resume' });
    expect(byId('enableDisable')?.label).toBe('E&nable');
    expect(byId('completeReopen')?.label).toBe('Re&open');
    expect(byId('note')?.label).toBe('Edit &Guidance for Next Run…');
  });

  it('puts what fits on a phone’s bar, and the rest in More without repeating it', () => {
    const bar = (c: CommandContext) => phoneActions(['task'], c).map((a) => a.label);
    const phone = (state: string, runs: number, max = 1) => context({ task: task({ maxConcurrentRuns: max }), runtime: runtime(state, runs) }, 'mobile');
    expect(bar(phone('idle', 0))).toEqual(['Run Now', 'Edit Task']);
    expect(bar(phone('running', 1))).toEqual(['Stop Task', 'Edit Task']);
    expect(bar(phone('running', 1, 3))).toEqual(['Run Now', 'Stop Task']);
    const more = labels(phoneMore(['task'], phone('idle', 0)));
    expect(more).not.toContain('Run Now');
    expect(more).not.toContain('Edit Task…');
    expect(more).toContain('Pause');
    expect(more).toContain('Delete Task');
    expect(more).not.toContain('Edit Project…');
  });

  it('shows a phone’s More in the one order, what can’t run hidden and the red ones last', () => {
    const items = composeMore({ more: { items: phoneMore(['task'], context({ task: task({ note: 'n' } as never), runtime: runtime('idle'), project: { id: 'p', name: 'Site' } as never, settings: { view: { runFilter: { hideSkipped: false, hideNoAction: false } } } as never }, 'mobile')), run: () => undefined } }).items;
    expect(labels(items)).toEqual([
      'Pause', 'Disable', 'Complete', '-',
      'Edit with Agent…', 'Edit Guidance for Next Run…', '-',
      'Move to Folder…', 'Version History', 'Open Working Directory', '-',
      'Export Task…', '-',
      'New Chat', 'New Terminal', '-',
      'Task Runs', '-',
      'Clear Guidance', 'Clear Run History…', 'Delete Task',
    ]);
  });

  it('runs the same code from every surface, on the task it was asked for', () => {
    const c = context({ task: task(), runtime: runtime('running', 1) });
    runCommand('stopTask', c);
    expect(c.calls).toEqual(['looper.runtime.stopTask']);
    const idle = context({ task: task(), runtime: runtime('idle') });
    runCommand('stopTask', idle);
    expect(idle.calls).toEqual([]);
  });
});

describe('the menu bar', () => {
  it('keeps its order, and shows a Chat menu only with a chat', () => {
    const none = context({ tab: 'chats', chats: undefined });
    expect(menuBar(mainWindowViews('chats'), none).map((m) => m.key)).toEqual(['file', 'edit', 'view', 'tools', 'advanced', 'window', 'help']);
    const chat = { id: 'c', status: 'idle', queued: [], history: [], rows: [], models: [], harnessId: 'h', harnesses: [{ id: 'h', name: 'Claude Code' }], settings: { permissionMode: 'default' }, permissions: [], harnessKind: 'claude-code' };
    const summary = { id: 'c', kind: 'chat', taskId: 't', status: 'idle' };
    const withChat = context({ tab: 'chats', chats: { single: false, tab: true, selected: 'c', summary, chat, sessions: [summary], shown: {} } as never });
    expect(menuBar(mainWindowViews('chats'), withChat).map((m) => m.key)).toEqual(['file', 'edit', 'view', 'chat', 'tools', 'advanced', 'window', 'help']);
  });

  it('has only what a view window’s view is about', () => {
    const c = context({ tab: 'tasks', fixed: true });
    const keys = menuBar(mainWindowViews('tasks', true), c).map((m) => m.key);
    expect(keys).toEqual(['file', 'view', 'task', 'window']);
    expect(labels(menu(mainWindowViews('tasks', true), 'file', c))).toContain('Close Window');
    expect(labels(menu(mainWindowViews('tasks', true), 'file', c))).not.toContain('New Project…');
  });

  it('has only a chat’s own items in a single chat’s window, Close Conversation and Close Window together', () => {
    const summary = { id: 'c', kind: 'chat', taskId: 't', status: 'idle' };
    const c = context({ chats: { single: true, tab: false, selected: 'c', summary, chat: null, sessions: [summary], shown: { windowToolbar: true } } as never });
    const file = labels(menu(CHAT_WINDOW_VIEWS, 'file', c));
    expect(file).toContain('Save as Markdown…');
    expect(file).not.toContain('Send to Chats…');
    expect(file).not.toContain('Open in New Window');
    expect(file).not.toContain('New Chat');
    expect(file.slice(-3)).toEqual(['-', 'Close Conversation', 'Close Window']);
    expect(labels(menu(CHAT_WINDOW_VIEWS, 'view', c))).toContain('Toolbar');
    const toolbar = commandToolbar(['conversation'], c).flatMap((g) => g.items.map((i) => i.id));
    expect(toolbar).toEqual(expect.arrayContaining(['stop', 'activity', 'closeConversation']));
    expect(toolbar).not.toContain('sendToChats');
  });

  it('puts History first in Tools, then Recycle Bin and Templates, the addons’ tools, and the settings last', () => {
    const c = context({ addons: [addonWith('a', [{ id: 't', label: 'Servers', menu: 'tools', in: { app: {} } }])] });
    expect(labels(menu(mainWindowViews('tasks'), 'tools', c))).toEqual(['History', 'Recycle Bin', 'Templates', '-', 'Servers', '-', 'Agent Settings…', 'Settings']);
    expect(labels(menu(mainWindowViews('tasks'), 'window', c))).not.toContain('History');
    expect(labels(menu(CHATS_WINDOW_VIEWS, 'tools', context({ chats: { single: false, tab: false, selected: null, summary: undefined, chat: null, sessions: [], shown: {} } as never })))).toEqual(['History']);
  });

  it('puts an addon’s New items beside Looper’s, and only its own in a view window of its tab', () => {
    const addon = (id: string) => addonWith(id, [{ id: 'new', label: `New ${id}…`, icon: 'add', in: { new: { toolbar: true } } }]);
    const c = context({ tab: 'tasks', addons: [addon('servers'), addon('keys')] });
    const newGroup = commandToolbar(mainToolbarViews('tasks'), c)[0].items.map((i) => i.label);
    expect(newGroup).toEqual(['New Project', 'New Task', 'New Chat', 'New servers', 'New keys']);
    expect(labels(menu(mainWindowViews('tasks'), 'file', c))).toEqual(expect.arrayContaining(['New servers…', 'New keys…']));
    const own = context({ tab: 'addon/servers/overview', fixed: true, addons: [addon('servers'), addon('keys')] });
    expect(commandToolbar(mainToolbarViews('addon/servers/overview', true), own).flatMap((g) => g.items.map((i) => i.label))).toEqual(['New servers']);
    runCommand(addonCommandId('servers', 'new'), c);
    expect(c.calls).toEqual(['looper.addons.event']);
  });

  it('draws the Chats window’s toolbar without File’s other New items', () => {
    const c = context({ chats: { single: false, tab: false, selected: null, summary: undefined, chat: null, sessions: [], shown: {} } as never });
    const ids = commandToolbar(['new', 'chats', 'conversation'], c).flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain('newProject');
    expect(ids).not.toContain('newTask');
    expect(ids).toContain('newChat');
    expect(ids).toContain('newTerminal');
    // Off with nothing shown, not gone, so the buttons don't move.
    const buttons = commandToolbar(['new', 'chats', 'conversation'], c).flatMap((g) => g.items);
    expect(buttons.filter((i) => ['stop', 'sendNow', 'restartAgent', 'compact', 'closeConversation', 'conversationWorkFolder'].includes(i.id)).map((i) => [i.id, i.enabled])).toEqual([
      ['stop', false],
      ['sendNow', false],
      ['restartAgent', false],
      ['compact', false],
      ['conversationWorkFolder', false],
      ['closeConversation', false],
    ]);
    expect(labels(menu(CHATS_WINDOW_VIEWS, 'file', c))).toContain('New Project…');
  });
});

describe('a menu sent as data', () => {
  it('becomes Electron’s, with a click that comes back as the item’s id', () => {
    const pick = vi.fn();
    const template = specTemplate(
      [
        { id: 'a', key: 'a', type: 'normal', label: '&A', enabled: true, accelerator: 'F5', icon: 'run', destructive: true },
        { id: '-1', type: 'separator', enabled: true },
        { id: 'b', key: 'b', type: 'checkbox', label: 'B', enabled: false, checked: true },
        { id: 'c', key: 'c', type: 'normal', label: 'C', enabled: true, role: 'copy', registerAccelerator: false },
      ],
      pick,
    );
    expect(template[0]).toMatchObject({ id: 'a', label: '&A', accelerator: 'F5', glyph: 'run', destructive: true });
    expect(template[1]).toEqual({ type: 'separator' });
    expect(template[2]).toMatchObject({ type: 'checkbox', checked: true, enabled: false });
    expect(template[3]).toMatchObject({ role: 'copy', registerAccelerator: false });
    expect(template[3].click).toBeUndefined();
    (template[0].click as () => void)();
    expect(pick).toHaveBeenCalledWith('a');
  });

  it('fills in what only the main process knows, and leaves no stray separator', () => {
    const template = specTemplate(
      [
        { id: 'x', key: 'x', type: 'normal', label: 'X', enabled: true },
        { id: '-1', type: 'separator', enabled: true },
        { id: 'w', key: 'open-windows', type: 'normal', label: 'Open Windows', enabled: true },
      ],
      () => undefined,
      (key) => (key === 'open-windows' ? [] : undefined),
    );
    expect(template.map((t) => t.label)).toEqual(['X']);
  });

  it('runs a choice through its command', () => {
    const run = vi.fn();
    const c = context({ settings: { view: { tabs: { position: 'top', labels: true, icons: true } } } as never, setView: run });
    runCommand('tabs/left', c);
    expect(run).toHaveBeenCalledWith({ tabs: { position: 'left', labels: true, icons: true } });
  });
});

describe('a phone', () => {
  const settings = { view: { runFilter: { hideSkipped: false, hideNoAction: false }, single: {}, panes: {}, phoneTaskKind: 'all', projectsPane: { groupBy: 'none' } } } as never;

  it('offers Task Runs only on a task’s screen', () => {
    const c = context({ task: task(), settings }, 'mobile');
    expect(labels(phoneMore(['task'], c))).toContain('Task Runs');
    expect(labels(phoneMore(['tasks'], c))).not.toContain('Task Runs');
    expect(labels(phoneMore(['dashboard'], c))).not.toContain('Task Runs');
  });

  const runContext = (tab: 'result' | 'details', message = false, platform: 'mobile' | 'desktop' = 'mobile') =>
    context(
      {
        run: {
          taskId: 't1',
          runId: 'r',
          title: 'x',
          workFolder: true,
          canContinue: { chat: true, terminal: true, guidance: true, compact: true },
          raw: false,
          rawOutput: false,
          autoScroll: false,
          filter: '',
          tab,
          message,
          findInMessage: message ? () => undefined : undefined,
          set: () => undefined,
        },
      },
      platform,
    );

  it('keeps a run’s Raw Messages, Raw Agent Output and Auto Scroll on its Details tab, filters with the list’s search field, and has no Show Run Log', () => {
    const details = labels(phoneMore(['run'], runContext('details')));
    expect(details).toEqual(expect.arrayContaining(['Raw Messages', 'Raw Agent Output', 'Auto Scroll']));
    expect(details).not.toContain('Filter…');
    const result = labels(phoneMore(['run'], runContext('result')));
    for (const label of ['Raw Messages', 'Raw Agent Output', 'Auto Scroll']) expect(result).not.toContain(label);
    expect(result).toContain('Save as Markdown…');
    expect(COMMANDS.some((cmd) => cmd.id === 'runShowLog')).toBe(false);
  });

  it('leaves out what changes a run’s list on one message’s screen, and offers Find in Message there only', () => {
    const message = labels(phoneMore(['run'], runContext('details', true)));
    for (const label of ['Raw Messages', 'Auto Scroll']) expect(message).not.toContain(label);
    expect(message).toContain('Find in Message…');
    expect(labels(phoneMore(['run'], runContext('details')))).not.toContain('Find in Message…');
  });

  it('keeps a run’s folder commands in one Folders submenu, which the desktop’s File menu lists flat', () => {
    const phone = labels(phoneMore(['run'], runContext('details')));
    expect(phone).toContain('Folders');
    for (const label of ['Open Run Folder', 'Copy Run Folder Path', 'Open Working Directory']) expect(phone).not.toContain(label);
    const file = labels(menu(['run'], 'file', runContext('details', false, 'desktop')));
    expect(file).toEqual(expect.arrayContaining(['Open Run Folder', 'Copy Run Folder Path', 'Open Working Directory']));
    expect(file).not.toContain('Folders');
  });

  it('names New Chat in Project in a conversation, and keeps Send to Chats on the Chats list', () => {
    const summary = { id: 'c', kind: 'chat', taskId: 't', status: 'idle', projectId: 'p' };
    const c = context({ chats: { single: false, tab: true, selected: 'c', summary, chat: null, sessions: [summary], shown: {} } as never }, 'mobile');
    const more = labels(phoneMore(['conversation'], c));
    expect(more).toContain('New Chat in Project');
    expect(more).not.toContain('Send to Chats…');
    expect([...phoneActions(['chats'], c).map((a) => a.label), ...labels(phoneMore(['chats'], c))]).toContain('Send to Chats');
  });
});

describe('an addon’s commands', () => {
  const id = (name: string) => addonCommandId('srv', name);
  const NEW = { id: 'new', label: '&New Server…', icon: 'add', in: { new: { toolbar: true }, panes: {} } } as const;
  const LIST = { id: 'list', label: '&Servers', icon: 'terminal', opens: { tab: 'panes' }, menu: 'tools', in: { app: { toolbar: true } } } as const;
  const EDIT = { id: 'edit', label: '&Edit Server…', icon: 'edit', menu: 'edit', in: { item: { toolbar: true, main: true } } } as const;
  const COPY = { id: 'copy', label: 'Copy &Host', group: 'copy', menu: 'edit', in: { item: {} } } as const;
  const SHOW = { id: 'show', label: '&Linux', group: 'filter', check: 'radio', menu: 'view', in: { panes: {} } } as const;
  const addons = [addonWith('srv', [NEW, LIST, EDIT, COPY, SHOW])];
  const ids = (groups: { items: { id: string }[] }[]) => groups.flatMap((g) => g.items.map((i) => i.id));
  const onPanes = (over: Partial<CommandContext> = {}, here: CommandContext['here'] = 'desktop') =>
    context({ tab: 'addon/srv/panes', addons, addon: { id: 'srv', panes: { pane: 'list' }, item: null }, ...over }, here);
  const picked = (state?: Record<string, object>) => ({ id: 'srv', panes: { pane: 'list' }, item: { pane: 'list', id: 'web-1', ...(state ? { state } : {}) } });

  it('writes each once, and every surface draws it', () => {
    const c = onPanes({ addon: picked() });
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'file', c))).toContain('New Server…');
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'edit', c))).toEqual(expect.arrayContaining(['Edit Server…', 'Copy Host']));
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'view', c))).toContain('Linux');
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'tools', c))).toContain('Servers');
    expect(ids(commandToolbar(mainToolbarViews('addon/srv/panes'), c))).toEqual(expect.arrayContaining([id('new'), id('edit'), id('list')]));
    expect(labels(contextMenu('addonItem', c))).toEqual(['Edit Server…', '-', 'Copy Host']);
    const phone = onPanes({ addon: picked() }, 'mobile');
    expect(phoneActions(['addonItem', 'addonScreen'], phone).map((a) => a.label)).toEqual(['Edit Server']);
    expect(labels(phoneMore(['addonItem', 'addonScreen'], phone))).toEqual(['Copy Host']);
  });

  it('stays on its own panes and tabs, and joins the list’s order at its three places', () => {
    const tasks = context({ tab: 'tasks', addons });
    expect(labels(menu(mainWindowViews('tasks'), 'edit', tasks))).not.toContain('Edit Server…');
    expect(labels(menu(mainWindowViews('tasks'), 'view', tasks))).not.toContain('Linux');
    expect(ids(commandToolbar(mainToolbarViews('tasks'), tasks))).toEqual(expect.arrayContaining([id('new'), id('list')]));
    expect(labels(menu(mainWindowViews('tasks'), 'tools', tasks))).toEqual(['History', 'Recycle Bin', 'Templates', '-', 'Servers', '-', 'Agent Settings…', 'Settings']);
    expect(labels(menu(mainWindowViews('tasks'), 'file', tasks)).indexOf('New Server…')).toBeLessThan(labels(menu(mainWindowViews('tasks'), 'file', tasks)).indexOf('Exit'));
  });

  it('turns off what needs an item while none is picked: grayed out on the desktop, gone on a phone', () => {
    const none = onPanes();
    expect(menu(mainWindowViews('addon/srv/panes'), 'edit', none).filter((i) => i.type !== 'separator').map((i) => i.enabled)).toEqual([false, false]);
    expect(commandToolbar(mainToolbarViews('addon/srv/panes'), none).flatMap((g) => g.items).find((i) => i.id === id('edit'))?.enabled).toBe(false);
    expect(phoneActions(['addonPanes', 'addonItem'], onPanes({}, 'mobile')).map((a) => a.id)).not.toContain(id('edit'));
    expect(labels(contextMenu('addonItem', context({ tab: 'tasks', addons })))).toEqual([]);
  });

  it('reads how it is from the pane, the item and the screen, the most specific winning', () => {
    const c = onPanes({
      addon: {
        id: 'srv',
        panes: { pane: 'list', state: { show: { checked: true }, edit: { label: 'From Pane', enabled: false } } },
        item: { pane: 'list', id: 'web-1', state: { edit: { label: 'From Item' }, copy: { hidden: true } } },
      },
    });
    expect(menu(mainWindowViews('addon/srv/panes'), 'view', c).find((i) => i.label === '&Linux')).toMatchObject({ type: 'radio', checked: true });
    const edit = menu(mainWindowViews('addon/srv/panes'), 'edit', c).find((i) => i.label === 'From Item');
    expect(edit?.enabled).toBe(false);
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'edit', c))).not.toContain('Copy Host');
    const screen = onPanes({ addon: { ...picked({ edit: { label: 'From Item' } }), screen: { view: 'server', state: { edit: { label: 'From Screen' } }, run: () => undefined } } });
    expect(labels(menu(mainWindowViews('addon/srv/panes'), 'edit', screen))).toContain('From Screen');
  });

  it('sends each its event from where it acts', () => {
    const sent: unknown[] = [];
    const looper = { addons: { event: (...a: unknown[]) => void sent.push(a) } } as never;
    runCommand(id('edit'), onPanes({ looper, addon: picked() }));
    expect(sent.pop()).toEqual(['srv', { source: { pane: 'list' }, kind: 'command', id: 'edit', item: 'web-1' }, undefined]);
    runCommand(id('show'), onPanes({ looper }));
    expect(sent.pop()).toEqual(['srv', { source: { pane: 'list' }, kind: 'command', id: 'show' }, undefined]);
    runCommand(id('new'), context({ looper, addons, tab: 'tasks' }));
    expect(sent.pop()).toEqual(['srv', { source: { app: true }, kind: 'command', id: 'new' }, undefined]);
  });

  it('runs one placed on a screen through the screen, with its fields', () => {
    const screen = vi.fn();
    const list = [addonWith('srv', [{ id: 'go', label: 'Go', confirm: 'Sure?', menu: 'edit', in: { screen: { views: ['server'] } } }])];
    const at = (view: string) => context({ addons: list, addon: { id: 'srv', screen: { view, run: screen } } });
    expect(labels(menu(['addonScreen'], 'edit', at('other')))).toEqual([]);
    expect(labels(menu(['addonScreen'], 'edit', at('server')))).toEqual(['Go']);
    runCommand(id('go'), at('server'));
    expect(screen).toHaveBeenCalledWith('go', 'Sure?');
  });

  it('opens a screen’s window through the main process, and a tab in the window, or its own window from elsewhere', () => {
    const opensWindow = [addonWith('srv', [{ id: 's', label: 'Settings', opens: { view: 'settings' }, menu: 'tools', in: { app: {} } }, { ...LIST }])];
    const c = context({ addons: opensWindow });
    runCommand(id('s'), c);
    expect(c.calls).toEqual(['looper.addons.open']);

    const openTab = vi.fn();
    runCommand(id('list'), context({ addons: opensWindow, openTab }));
    expect(openTab).toHaveBeenCalledWith('addon/srv/panes');
    const fromAnother = context({ addons: opensWindow });
    runCommand(id('list'), fromAnother);
    expect(fromAnother.calls).toEqual(['host.open-view']);
  });

  it('asks first when it has a confirm, for a window too', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const open = vi.fn();
    const looper = { confirm, addons: { open } } as never;
    const list = [addonWith('srv', [{ id: 's', label: 'Reset', confirm: 'Reset?', opens: { view: 'reset' }, menu: 'tools', in: { app: {} } }])];
    runCommand(id('s'), context({ looper, addons: list }));
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledWith('Reset?');
    expect(open).not.toHaveBeenCalled();
  });

  it('lists an addon’s commands no phone screen has once in the More view, and not one that opens a tab', () => {
    const phone = context({ addons }, 'mobile');
    const list = moreViewCommands(phone).map((c) => c.id);
    expect(list).not.toContain(id('list'));
    expect(list).not.toContain(id('edit'));
    // On its panes tab, that tab has it; only in New, the More view does.
    expect(list).not.toContain(id('new'));
    expect(moreViewCommands(context({ addons: [addonWith('srv', [{ ...NEW, in: { new: {} } }])] }, 'mobile')).map((c) => c.id)).toContain(id('new'));
  });

  it('leaves out one its addon keeps to some devices, one whose toolbar is hidden, and all of a stopped addon’s', () => {
    const only = [addonWith('srv', [{ ...NEW, in: { new: {} }, platforms: ['desktop'] }])];
    expect(moreViewCommands(context({ addons: only }, 'mobile')).map((c) => c.id)).not.toContain(id('new'));
    const hidden = context({ addons, tab: 'tasks', settings: SettingsSchema.parse({ view: { hiddenAddonToolbars: ['srv'] } }) });
    expect(ids(commandToolbar(mainToolbarViews('tasks'), hidden))).not.toContain(id('new'));
    expect(labels(menu(mainWindowViews('tasks'), 'file', hidden))).toContain('New Server…');
    const stopped = context({ addons: [addonWith('srv', [NEW], { enabled: false })], tab: 'tasks' });
    expect(labels(menu(mainWindowViews('tasks'), 'file', stopped))).not.toContain('New Server…');
    const notRunning = context({ addons: [addonWith('srv', [NEW], { status: 'starting' })], tab: 'tasks' });
    expect(menu(mainWindowViews('tasks'), 'file', notRunning).find((i) => i.label === '&New Server…')?.enabled).toBe(false);
  });

  it('shows its icon alone on a toolbar unless it asks for its label, and always its label when it has no icon', () => {
    const list = [
      addonWith('srv', [
        { id: 'icon', label: 'Icon', icon: 'key', menu: 'tools', in: { app: { toolbar: true } } },
        { id: 'both', label: 'Both', icon: 'key', labeled: true, menu: 'tools', in: { app: { toolbar: true } } },
        { id: 'text', label: 'Text', menu: 'tools', in: { app: { toolbar: true } } },
      ]),
    ];
    const items = commandToolbar(mainToolbarViews('tasks'), context({ tab: 'tasks', addons: list })).flatMap((g) => g.items);
    const labeled = (name: string) => items.find((i) => i.id === id(name))?.labeled;
    expect([labeled('icon'), labeled('both'), labeled('text')]).toEqual([undefined, true, true]);
  });

  it('draws the addon’s own icon by its name, and changes it with its state', () => {
    const list = [addonWith('srv', [{ id: 'lock', label: 'Lock', icon: 'vault', menu: 'edit', in: { item: { toolbar: true } } }], { icons: { vault: 'svg:{"a":1}', unlocked: 'svg:{"b":2}' } })];
    const at = (state?: Record<string, object>) => context({ tab: 'addon/srv/panes', addons: list, addon: picked(state) });
    const iconAt = (c: CommandContext) => commandToolbar(mainToolbarViews('addon/srv/panes'), c).flatMap((g) => g.items).find((i) => i.id === id('lock'))?.icon;
    expect(iconAt(at())).toBe('svg:{"a":1}');
    expect(iconAt(at({ lock: { icon: 'unlocked' } }))).toBe('svg:{"b":2}');
    expect(iconAt(at({ lock: { icon: 'key' } }))).toBe('key');
    expect(iconAt(at({ lock: { icon: 'unknown' } }))).toBe('svg:{"a":1}');
  });

  it('keeps the icon a New command chooses on every surface, with no plus added', () => {
    const list = [addonWith('srv', [{ id: 'new', label: '&New Key…', icon: 'key', in: { new: { toolbar: true }, panes: { main: true } } }])];
    const toolbarIcon = commandToolbar(mainToolbarViews('tasks'), context({ tab: 'tasks', addons: list })).flatMap((g) => g.items).find((i) => i.id === id('new'))?.icon;
    expect(toolbarIcon).toBe('key');
    const phone = context({ addons: list, tab: 'addon/srv/panes', addon: { id: 'srv', panes: { pane: 'list' }, item: null } }, 'mobile');
    expect(phoneActions(['addonPanes'], phone).map((a) => a.icon)).toEqual(['key']);
  });

  it('shows Looper’s own New icons on a phone’s bar', () => {
    const phone = context({ addons: [] }, 'mobile');
    expect(phoneActions(['projects'], phone).find((a) => a.id === 'newProject')?.icon).toBe('newProject');
    expect(phoneActions(['tasks'], phone).find((a) => a.id === 'newTask')?.icon).toBe('newTask');
  });

  it('gives a command its key, and of two addons with one key the first listed keeps it', () => {
    const keyed = (addon: string) => addonWith(addon, [{ id: 'k', label: 'K', accelerator: 'CmdOrCtrl+Shift+K', menu: 'tools', in: { app: {} } }]);
    const c = context({ addons: [keyed('a'), keyed('b')] });
    const items = menu(mainWindowViews('tasks'), 'tools', c);
    expect(items.find((i) => i.id === addonCommandId('a', 'k'))?.accelerator).toBe('CmdOrCtrl+Shift+K');
    expect(items.find((i) => i.id === addonCommandId('b', 'k'))?.accelerator).toBeUndefined();
    const stopped = context({ addons: [{ ...keyed('a'), enabled: false }, keyed('b')] });
    expect(menu(mainWindowViews('tasks'), 'tools', stopped).find((i) => i.id === addonCommandId('b', 'k'))?.accelerator).toBe('CmdOrCtrl+Shift+K');
  });

  describe('with a submenu', () => {
    const SOURCE = {
      id: 'source',
      label: '&Source',
      icon: 'folder',
      menu: 'view',
      entries: [
        { id: 'all', label: '&All', check: 'radio', icon: 'key' },
        { id: 'local', label: '&Local', check: 'radio', accelerator: 'CmdOrCtrl+Shift+L' },
        { separator: true },
        { id: 'manage', label: '&Manage…', opens: { view: 'manage' } },
        { id: 'reset', label: '&Reset', confirm: 'Reset?', destructive: true },
      ],
      in: { panes: { toolbar: true, main: true } },
    } as const;
    const list = [addonWith('srv', [SOURCE as unknown as Partial<AddonCommand>])];
    const at = (over: Partial<CommandContext> = {}, here: CommandContext['here'] = 'desktop') => context({ tab: 'addon/srv/panes', addons: list, addon: { id: 'srv', panes: { pane: 'list' }, item: null }, ...over }, here);
    const panesState = (state: Record<string, object>) => ({ addon: { id: 'srv', panes: { pane: 'list', state }, item: null } });
    const sub = (c: CommandContext) => menu(mainWindowViews('addon/srv/panes'), 'view', c).find((i) => i.id === id('source'))?.submenu ?? [];

    it('draws its items in the menu, with their icons, keys and state', () => {
      const items = sub(at(panesState({ all: { checked: true }, local: { enabled: false, label: 'Here', icon: 'lock' } })));
      expect(items.map((i) => i.label)).toEqual(['&All', 'Here', undefined, '&Manage…', '&Reset']);
      expect(items[0]).toMatchObject({ id: `${id('source')}/all`, type: 'radio', checked: true, icon: 'key' });
      expect(items[1]).toMatchObject({ type: 'radio', checked: false, enabled: false, icon: 'lock', accelerator: 'CmdOrCtrl+Shift+L' });
      expect(items[4]).toMatchObject({ destructive: true });
    });

    it('leaves out a hidden item and the line it would leave at the end', () => {
      const items = sub(at(panesState({ manage: { hidden: true }, reset: { hidden: true } })));
      expect(items.map((i) => i.label)).toEqual(['&All', '&Local']);
    });

    it('sends an item’s own event, asks its question, and opens its screen', () => {
      const sent: unknown[] = [];
      const open = vi.fn();
      const looper = { addons: { event: (...a: unknown[]) => void sent.push(a), open } } as never;
      runCommand(`${id('source')}/all`, at({ looper }));
      expect(sent.pop()).toEqual(['srv', { source: { pane: 'list' }, kind: 'command', id: 'all' }, undefined]);
      runCommand(`${id('source')}/reset`, at({ looper }));
      expect(sent.pop()).toEqual(['srv', { source: { pane: 'list' }, kind: 'command', id: 'reset' }, 'Reset?']);
      runCommand(`${id('source')}/manage`, at({ looper }));
      expect(open).toHaveBeenCalledWith('srv', 'manage');
    });

    it('is a drop-down on a toolbar with nothing of its own to do, and a split button with `primary`', () => {
      const button = (over: object) => {
        const c = context({ tab: 'addon/srv/panes', addons: [addonWith('srv', [{ ...(SOURCE as unknown as Partial<AddonCommand>), ...over }])], addon: { id: 'srv', panes: { pane: 'list' }, item: null } });
        return commandToolbar(mainToolbarViews('addon/srv/panes'), c).flatMap((g) => g.items).find((i) => i.id === id('source'));
      };
      expect(button({})).toMatchObject({ run: null, menu: { label: 'Source' } });
      expect(button({ primary: true })?.run).toEqual(expect.any(Function));
      expect(button({ opens: { view: 'v' } })?.run).toEqual(expect.any(Function));
    });

    it('opens its list from a phone’s bar, with the items’ icons and state', () => {
      const [action] = phoneActions(['addonPanes'], at(panesState({ local: { enabled: false } }), 'mobile'));
      expect(action.menu?.map((e) => e.label)).toEqual(['All', 'Local', '', 'Manage…', 'Reset']);
      expect(action.menu?.[0]).toMatchObject({ icon: 'key', checked: false, type: 'radio' });
      expect(action.menu?.[1]).toMatchObject({ enabled: false });
      expect(action.menu?.[4]).toMatchObject({ destructive: true });
    });

    it('keeps an item that opens a tab off phones, as a command that opens one is', () => {
      const withTab = [addonWith('srv', [{ ...(SOURCE as unknown as Partial<AddonCommand>), entries: [{ id: 'tab', label: 'Tab', opens: { tab: 'panes' } }, { id: 'all', label: 'All' }] }])];
      const [action] = phoneActions(['addonPanes'], at({ addons: withTab }, 'mobile'));
      expect(action.menu?.map((e) => e.id)).toEqual(['all']);
    });
  });

  it('accepts the demo addon’s manifest and draws it', () => {
    const file = path.join(__dirname, '..', 'scripts', 'screenshots', 'demo', 'home', 'addons', 'servers.looperaddon');
    const r = readAddonManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(r.ok, !r.ok ? r.error : '').toBe(true);
    if (!r.ok) return;
    const demo = addonWith('servers', r.manifest.commands, { tabs: r.manifest.tabs, panes: r.manifest.panes });
    const c = context({ tab: 'addon/servers/panes', addons: [demo], addon: { id: 'servers', panes: { pane: 'servers' }, item: { pane: 'servers', id: 'web-1' } } });
    expect(labels(contextMenu('addonItem', c))).toEqual(['Edit Server…', '-', 'Copy Host', 'Copy Password']);
    expect(labels(contextMenu('addonPanes', c))).toEqual(['New Server…', '-', 'All', 'Linux', 'Windows']);
  });
});

describe('the More view', () => {
  it('lists every menu item no phone screen has, Tools, Advanced and Help', () => {
    const list = moreViewCommands(context({}, 'mobile')).map((c) => c.id);
    for (const id of ['settings', 'agentSettings', 'recycleBin', 'remoteAccess', 'remoteControl', 'addons', 'preventSleep', 'updateModels', 'engineLog', 'openDataDirectory', 'instructions', 'about']) {
      expect(list, id).toContain(id);
    }
    for (const id of ['exit', 'tabs', 'toolbar', 'statusBar', 'reloadUi', 'viewWindows', 'runNow', 'templates']) expect(list, id).not.toContain(id);
  });
});

describe('no command outside the list', () => {
  const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

  it('leaves the main process with only the tray’s, the row menus’ and an addon’s menus', () => {
    const index = src('main', 'index.ts');
    expect(index).not.toMatch(/function mainMenuTemplate|function sessionsTemplate|function historyTemplate/);
    for (const label of ['&Run Now', 'S&ettings', 'Recycle &Bin', '&About Looper', 'Show Task &Runs']) expect(index, label).not.toContain(`label: '${label}'`);
  });

  it('builds a screen’s bar buttons from the list', () => {
    const phoneMain = src('renderer', 'src', 'components', 'phone', 'PhoneMain.tsx');
    expect(phoneMain).not.toMatch(/label: 'Run Now'|label: 'Edit Task'|label: 'New Chat'|label: 'Edit Project'/);
    const sessions = src('renderer', 'src', 'SessionsApp.tsx');
    expect(sessions).not.toMatch(/label: 'Activity'|label: 'New Chat'|label: 'Stop'/);
  });

  it('keeps every screen on the shared hook, with no menu commands sent by hand', () => {
    for (const file of walk(renderer).filter((f) => /\.tsx?$/.test(f))) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bshowTaskContextMenu|\breportSelection|\bshowNewMenu|\bshowSettingMenu\(state\.id/);
    }
  });
});
