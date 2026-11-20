// Relative imports only: the main process, the renderer and the unit tests all load the list.
import { chatCanCompact, chatInteractive } from '../chat';
import { chatSettingEntries } from '../chat-settings';
import { folderTree, siblingOrder } from '../folders';
import { mainTabs } from '../main-tabs';
import { ALL_FILTERS, FILTER_LABELS, PANES, type PaneId } from '../panes';
import type { ProjectGroupBy } from '../projects';
import { groupProjects, projectTaskId } from '../projects';
import { SHORTCUTS } from '../shortcuts';
import type { Project, TaskFilter, TaskListOptions } from '../types';
import { NOT_MOBILE } from '../ui-platform';
import { hasToolbarIn } from './addon-commands';
import { menuText, type Command, type Entry, type Hide } from './command';
import type { CommandContext } from './context';

const ON_PHONE = ['mobile'] as const;
const OFF_PHONE = NOT_MOBILE;

const failed = (c: CommandContext) => (e: unknown) => void c.looper.showError((e as Error).message);

const isActive = (c: CommandContext): boolean => {
  const state = c.runtime?.state;
  return state === 'running' || state === 'checking' || state === 'classifying';
};
const canRunNow = (c: CommandContext): boolean => !isActive(c) || (c.runtime?.runs.length ?? 0) < (c.task?.maxConcurrentRuns ?? 1);
const hasTask = (c: CommandContext): boolean => !!c.task;
const hasProject = (c: CommandContext): boolean => !!c.project;
const viewOf = (c: CommandContext) => c.settings?.view;
const summaryOf = (c: CommandContext) => c.chats?.summary;
const onChatsTab = (c: CommandContext): boolean => !!c.chats;
const isChat = (c: CommandContext): boolean => summaryOf(c)?.kind === 'chat';
const isTerminal = (c: CommandContext): boolean => summaryOf(c)?.kind === 'terminal';
const isRun = (c: CommandContext): boolean => summaryOf(c)?.kind === 'run';
const inChatWindow = (c: CommandContext): boolean => !!c.chats?.single;
/** Open Working Directory's name in an iOS menu's top row, whose two lines fit "Open Folder". */
const workFolderToolbarLabel = (c: CommandContext): string => (c.here === 'mobile' ? 'Open Folder' : 'Open Working Directory');

// ---------- what a window's view window and own window don't have ----------

/** A view window creates only what its view shows. */
const onlyInViews = (...tabs: string[]): Hide => ({ view: 'new', if: (c) => !!c.fixed && !tabs.includes(c.tab ?? ''), why: 'A view window has only what its view creates.' });
const PROJECT_NOT_IN_TASK_WINDOW: Hide = { view: 'task', if: (c) => !!c.fixed && c.tab !== 'projects', why: 'A view window of tasks has only the Task menu.' };
/** The Chat menu is a chat's: a terminal or a task run keeps its commands on the toolbar. */
const NOT_IN_CHAT_MENU: Hide = { surface: 'menu', if: (c) => !isChat(c), why: 'A terminal or a task run has no Chat menu: its toolbar has this.' };
/** The Chats window's toolbar starts with New Chat and New Terminal: File has the rest. */
const NOT_ON_CHATS_TOOLBAR: Hide = { surface: 'toolbar', if: (c) => !!c.chats && !c.chats.tab, why: 'The Chats window’s toolbar makes conversations; its File menu has this.' };
/** A phone's run sheet: these change the Details tab's rows, so its Result tab leaves them out. */
const ON_RUN_RESULT: Hide = { on: ON_PHONE, if: (c) => c.run?.tab === 'result', why: 'They change the run’s Details tab, not its Result.' };
/** A phone's run sheet with one message open: these change the list that message covers. */
const ON_RUN_MESSAGE: Hide = { on: ON_PHONE, if: (c) => !!c.run?.message, why: 'They change the list, which the open message covers.' };
/** A phone's run menu keeps the folder commands in one submenu, so the menu stays short. */
const IN_RUN_FOLDERS: Hide = { on: ON_PHONE, why: 'The Folders submenu has it.' };

// ---------- submenus built from state ----------

/**
 * Chat → Watch Task Events: the tasks of the chat's project in the Tasks list's order. A task the chat watches for
 * event ids has a checked item for each id, then its unchecked item, which asks for another id to watch; one it watches
 * for all its events is checked alone. Unchecking an item stops that watch.
 */
const watchTaskEntries = (c: CommandContext): Entry[] => {
  const chat = c.chats?.chat;
  const tasks = chat?.watchTasks ?? [];
  if (!chat || !tasks.length) return [{ id: 'none', label: 'No Tasks', enabled: false }];
  return tasks.flatMap((t): Entry[] => {
    const add: Entry = { id: t.id, label: menuText(t.name), checked: false, run: () => c.looper.chat.openWatch(chat.id, t.id) };
    if (t.events.includes('')) return [{ ...add, checked: true, run: () => c.looper.chat.setWatch(chat.id, t.id, '', false) }];
    const watched = t.events.map(
      (e, i): Entry => ({ id: `${t.id}-event-${i}`, label: menuText(`${t.name} (${e})`), checked: true, run: () => c.looper.chat.setWatch(chat.id, t.id, e, false) }),
    );
    return [...watched, add];
  });
};

/**
 * The projects as the Projects tab shows them: grouped, each group a submenu; or in their folders, each folder a
 * submenu of its own folders and projects in the list's order (a folder with no project anywhere inside is left out).
 */
const projectChoices = (c: CommandContext, kind: 'chat' | 'terminal'): Entry[] => {
  const choice = (p: Project): Entry => ({
    id: p.id,
    label: menuText(p.name),
    run: () => void (kind === 'chat' ? c.looper.projects.newChat(p.id) : c.looper.projects.newTerminal(p.id)),
  });
  const groupBy = viewOf(c)?.projectsPane.groupBy ?? 'none';
  let choices: Entry[];
  if (groupBy === 'none') {
    const order = siblingOrder(c.projects, c.projectFolders, c.projectLayout);
    const byId = new Map(c.projects.map((p) => [p.id, p]));
    const folders = new Map(c.projectFolders.map((f) => [f.id, f]));
    const level = (container: string): Entry[] =>
      (order.get(container) ?? []).flatMap((key): Entry[] => {
        if (!key.startsWith('folder:')) {
          const p = byId.get(key);
          return p ? [choice(p)] : [];
        }
        const id = key.slice('folder:'.length);
        const inside = level(id);
        return inside.length ? [{ id: `folder-${id}`, label: menuText(folders.get(id)!.name), entries: inside }] : [];
      });
    choices = level('');
  } else {
    const groups = groupProjects(c.projects, groupBy, c.settings?.environments ?? []).filter((g) => g.projects.length);
    choices = groups.flatMap((g): Entry[] => (g.title ? [{ id: `group-${g.key}`, label: menuText(g.title), entries: g.projects.map(choice) }] : g.projects.map(choice)));
  }
  return [
    ...choices,
    ...(c.projects.length ? [{ separator: true } as const] : []),
    { id: 'other', label: 'Other &Folder…', run: () => c.host('other-folder', kind) },
  ];
};

/** File → New Chat: on the Chats tab or window a chat and a terminal in the shown conversation's project first, then a list of projects for each. */
function newChatEntries(c: CommandContext): Entry[] {
  const pid = summaryOf(c)?.projectId;
  const project = pid ? c.projects.find((p) => p.id === pid) : undefined;
  const pickers: Entry[] = [
    { id: 'chat', label: '&Chat', icon: 'newChat', entries: projectChoices(c, 'chat').map(prefixed('chat')) },
    { id: 'terminal', label: '&Terminal', icon: 'terminal', entries: projectChoices(c, 'terminal').map(prefixed('terminal')) },
  ];
  if (!onChatsTab(c)) return pickers;
  return [
    {
      id: 'in-project-chat',
      label: project ? `Chat in ${menuText(project.name)}` : 'Chat in Project',
      icon: 'newChat',
      accelerator: SHORTCUTS.newChat,
      pageKey: true,
      enabled: !!project,
      run: () => project && void c.looper.projects.newChat(project.id),
    },
    {
      id: 'in-project-terminal',
      label: project ? `Terminal in ${menuText(project.name)}` : 'Terminal in Project',
      icon: 'terminal',
      accelerator: SHORTCUTS.newTerminal,
      pageKey: true,
      enabled: !!project,
      run: () => project && void c.looper.projects.newTerminal(project.id),
    },
    { separator: true },
    ...pickers,
  ];
}

const prefixed = (prefix: string) => (e: Entry): Entry =>
  'separator' in e ? e : { ...e, id: `${prefix}-${e.id}`, ...(e.entries ? { entries: e.entries.map(prefixed(prefix)) } : {}) };

const SHOW_LABELS: Record<PaneId, string> = { tasks: 'Ta&sks Pane', goals: 'Go&als Pane', watchers: '&Watchers Pane' };

/** View's pane group: the sidebar's panes in the order it shows them. */
function paneEntries(c: CommandContext): Entry[] {
  const view = viewOf(c);
  if (!view) return [];
  const own: Entry[] =
    view.sidebar === 'multiple'
      ? PANES.map((p) => ({
          id: p.id,
          label: SHOW_LABELS[p.id],
          checked: view.panes[p.id].visible,
          run: () => c.setView({ panes: { ...view.panes, [p.id]: { ...view.panes[p.id], visible: !view.panes[p.id].visible } } }),
        }))
      : [{ id: 'single', label: SHOW_LABELS.tasks, checked: view.single.visible, run: () => c.setView({ single: { ...view.single, visible: !view.single.visible } }) }];
  return own;
}

/** A list's filters, then its folder options. */
export function listOptionEntries(options: TaskListOptions, offered: (keyof TaskFilter)[], set: (patch: Partial<TaskListOptions>) => void): Entry[] {
  return [
    ...offered.map((k): Entry => ({ id: k, label: FILTER_LABELS[k], checked: options[k], run: () => set({ [k]: !options[k] }) })),
    { separator: true },
    { id: 'showFolders', label: 'Show &Folders', checked: options.showFolders, run: () => set({ showFolders: !options.showFolders }) },
    { id: 'hideEmptyFolders', label: 'Hide &Empty Folders', checked: options.hideEmptyFolders, enabled: options.showFolders, run: () => set({ hideEmptyFolders: !options.hideEmptyFolders }) },
  ];
}

/** View → Task List Options. */
function taskListEntries(c: CommandContext): Entry[] {
  const view = viewOf(c);
  if (!view) return [];
  const multiple = view.sidebar === 'multiple';
  const paneOptions: Entry[] = multiple
    ? [
        ...PANES.map((p): Entry => ({
          id: `pane-${p.id}`,
          label: p.menuLabel,
          entries: listOptionEntries(view.panes[p.id], p.filters, (patch) => c.setView({ panes: { ...view.panes, [p.id]: { ...view.panes[p.id], ...patch } } })).map(prefixed(p.id)),
        })),
        { separator: true },
      ]
    : listOptionEntries(view.single, ALL_FILTERS, (patch) => c.setView({ single: { ...view.single, ...patch } }));
  return [
    { id: 'single', label: 'S&ingle Pane', radio: true, checked: !multiple, run: () => c.setView({ sidebar: 'single' }) },
    { id: 'multiple', label: 'M&ultiple Panes', radio: true, checked: multiple, run: () => c.setView({ sidebar: 'multiple' }) },
    { separator: true },
    { id: 'standard', label: '&Standard', radio: true, checked: view.taskList !== 'compact', run: () => c.setView({ taskList: 'standard' }) },
    { id: 'compact', label: '&Compact', radio: true, checked: view.taskList === 'compact', run: () => c.setView({ taskList: 'compact' }) },
    { separator: true },
    ...paneOptions,
    { id: 'autoOpen', label: '&Open Folders Automatically', checked: view.autoOpenFolders, run: () => c.setView({ autoOpenFolders: !view.autoOpenFolders }) },
  ];
}

const TASK_KIND_FILTER: { id: 'all' | PaneId; label: string }[] = [{ id: 'all', label: 'All' }, ...PANES.map((p) => ({ id: p.id, label: p.title }))];

/** A phone's Filter button: what the Tasks tab lists, and the Show marks that apply to it. */
function taskFilterEntries(c: CommandContext): Entry[] {
  const view = viewOf(c);
  if (!view) return [];
  const kind = view.phoneTaskKind;
  const pane = PANES.find((p) => p.id === kind);
  const offered = pane?.filters ?? ALL_FILTERS;
  return [
    ...TASK_KIND_FILTER.map((k): Entry => ({ id: k.id, label: k.label, radio: true, checked: kind === k.id, run: () => c.setView({ phoneTaskKind: k.id }) })),
    { separator: true },
    // "Disabled", not "Show Disabled Tasks": the check mark says show, and a phone's menu is narrow.
    ...offered.map((k): Entry => ({ id: k, label: FILTER_LABELS[k].replace(/^Show | Tasks$/g, ''), checked: view.single[k], run: () => c.setView({ single: { ...view.single, [k]: !view.single[k] } }) })),
  ];
}

const taskRunEntries = (c: CommandContext): Entry[] => {
  const view = viewOf(c);
  if (!view) return [];
  const set = (patch: Partial<typeof view.runFilter>) => c.setView({ runFilter: { ...view.runFilter, ...patch } });
  return [
    { id: 'skipped', label: 'Show &Skipped Runs', checked: !view.runFilter.hideSkipped, run: () => set({ hideSkipped: !view.runFilter.hideSkipped }) },
    { id: 'noAction', label: 'Show Runs with &No Action', checked: !view.runFilter.hideNoAction, run: () => set({ hideNoAction: !view.runFilter.hideNoAction }) },
  ];
};

// "Parent Folder": the folder the projects' folders are in, not the folders the user makes in the list.
const GROUP_LABELS: Record<ProjectGroupBy, string> = { none: '&None', folder: '&Parent Folder', harness: '&Harness' };

const groupByEntries = (c: CommandContext): Entry[] => {
  const view = viewOf(c);
  if (!view) return [];
  return (Object.keys(GROUP_LABELS) as ProjectGroupBy[]).map((k) => ({
    id: k,
    label: GROUP_LABELS[k],
    radio: true,
    checked: view.projectsPane.groupBy === k,
    run: () => c.setView({ projectsPane: { ...view.projectsPane, groupBy: k } }),
  }));
};

const tabEntries = (c: CommandContext): Entry[] => {
  const view = viewOf(c);
  if (!view) return [];
  const tabs = view.tabs;
  const set = (patch: Partial<typeof tabs>) => c.setView({ tabs: { ...tabs, ...patch } });
  return [
    { id: 'top', label: '&Top', radio: true, checked: tabs.position === 'top', run: () => set({ position: 'top' }) },
    { id: 'left', label: '&Left', radio: true, checked: tabs.position === 'left', run: () => set({ position: 'left' }) },
    { id: 'bottom', label: '&Bottom', radio: true, checked: tabs.position === 'bottom', run: () => set({ position: 'bottom' }) },
    { separator: true },
    tabs.position === 'left'
      ? { id: 'labels', label: 'Show &Labels', checked: tabs.labels, run: () => set({ labels: !tabs.labels }) }
      : { id: 'icons', label: 'Show &Icons', checked: tabs.icons, run: () => set({ icons: !tabs.icons }) },
  ];
};

/** "<Addon> Toolbar": whether each addon's buttons show. A view window lists the addons with a button for its view. */
export function addonToolbarEntries(c: CommandContext, only?: string): Entry[] {
  const view = viewOf(c);
  if (!view) return [];
  return c.addons
    .filter((a) => a.enabled && hasToolbarIn(a, only))
    .map((a) => {
      const shown = !view.hiddenAddonToolbars.includes(a.id);
      return {
        id: a.id,
        label: `${menuText(a.toolbarName ?? a.name)} Toolbar`,
        checked: shown,
        run: () => c.setView({ hiddenAddonToolbars: shown ? [...view.hiddenAddonToolbars, a.id] : view.hiddenAddonToolbars.filter((id) => id !== a.id) }),
      };
    });
}

const PREVENT_SLEEP: [string, string][] = [
  ['off', '&Off'],
  ['30', '&30 Minutes'],
  ['60', '&1 Hour'],
  ['120', '&2 Hours'],
  ['until-off', '&Until Turned Off'],
];

function preventSleepEntries(c: CommandContext): Entry[] {
  const timer = String(c.preventSleep?.timer ?? 'off');
  const working = c.settings?.preventSleepWhileWorking ?? false;
  return [
    ...PREVENT_SLEEP.map(([value, label]): Entry => ({ id: value, label, radio: true, checked: timer === value, run: () => c.host('prevent-sleep', value) })),
    { separator: true },
    { id: 'working', label: 'While a Session Is &Working', checked: working, run: () => void c.looper.updateSettings({ preventSleepWhileWorking: !working }).catch(failed(c)) },
  ];
}

function remoteAccessEntries(c: CommandContext): Entry[] {
  const state = c.remoteAccess;
  const on = !!state && state.phase !== 'off';
  const tailscaleChosen = c.settings?.remoteAccess.sources.includes('tailscale');
  const tailscale = state?.sources.find((s) => s.id === 'tailscale');
  const signedIn = tailscale?.phase === 'running' && !!tailscale.account;
  return [
    { id: 'toggle', label: on ? 'Turn &Off Remote Access' : 'Turn &On Remote Access', icon: 'power', run: () => c.host('remote-access-toggle') },
    { id: 'setup', label: 'Set &Up…', run: () => c.host('remote-access-setup') },
    { separator: true },
    { id: 'pair', label: '&Pair Device…', icon: 'add', enabled: state?.phase === 'running', run: () => c.host('pair-device') },
    { id: 'devices', label: 'Paired &Devices', run: () => c.host('paired-devices') },
    ...(tailscaleChosen
      ? [
          { separator: true } as const,
          signedIn
            ? { id: 'tailscale-out', label: 'Sign Ou&t of Tailscale…', run: () => c.host('tailscale-sign-out') }
            : { id: 'tailscale-in', label: 'Sign &In to Tailscale…', enabled: tailscale?.phase === 'needs-login', run: () => c.host('tailscale-sign-in') },
        ]
      : []),
    { separator: true },
    { id: 'settings', label: 'S&ettings', icon: 'settings', run: () => c.host('remote-access-settings') },
  ];
}

function remoteControlEntries(c: CommandContext): Entry[] {
  return [
    { id: 'toggle', label: c.settings?.remote.enabled ? 'Turn &Off Remote Control' : 'Turn &On Remote Control', icon: 'power', run: () => c.host('remote-control-toggle') },
    { separator: true },
    { id: 'conversations', label: '&Conversations', run: () => c.host('remote-conversations') },
    { id: 'helpers', label: '&Helpers', run: () => c.host('remote-helpers') },
  ];
}

const VIEW_WINDOW_LABELS: Record<string, string> = { dashboard: '&Dashboard', projects: '&Projects', tasks: 'Tas&ks', chats: '&Chats' };

/** Move to Folder on a project: the top level, each folder (at the end of it), or a new one. */
function projectFolderEntries(c: CommandContext): Entry[] {
  const project = c.project;
  if (!project) return [];
  const moveTo = (folderId: string | null) => () => void c.looper.projects.reorder(c.projects.map((p) => p.id), { [project.id]: folderId }).catch(failed(c));
  const tree = folderTree(c.projectFolders);
  return [
    { id: 'top', label: '&Top Level', radio: true, checked: !project.folderId, run: moveTo(null) },
    ...(tree.length ? [{ separator: true } as const] : []),
    ...tree.map(({ folder, depth }): Entry => ({ id: folder.id, label: ' '.repeat(depth * 3) + menuText(folder.name), radio: true, checked: project.folderId === folder.id, run: moveTo(folder.id) })),
    { separator: true },
    { id: 'new', label: '&New Folder…', run: () => c.host('new-folder', 'project', project.id) },
  ];
}

const FIND_ON_CHAT_WHY = 'A phone’s text fields have their own edit menu.';
const CLIPBOARD_ROLES: [string, string, string][] = [
  ['undo', '&Undo', 'history'],
  ['redo', '&Redo', 'history'],
  ['cut', 'Cu&t', 'clipboard'],
  ['copy', '&Copy', 'clipboard'],
  ['paste', '&Paste', 'clipboard'],
  ['selectAll', 'Select &All', 'clipboard'],
];

/**
 * Where the addons' commands go in the one order (addonCommandSlots): their New
 * items after Looper's, their Tools items after Templates (so the settings stay
 * last), and the rest before File's Close Window and Exit.
 */
export const ADDON_SLOTS = { new: 'newTerminal', tools: 'templates', rest: 'closeWindow' } as const;

// ---------- the one list: every command of every window, in its order on every surface ----------

export const COMMANDS: readonly Command[] = [
  {
    id: 'tasksFilter',
    label: 'Filter',
    group: 'list',
    icon: 'filter',
    on: (c) => viewOf(c)?.phoneTaskKind !== 'all',
    hide: [{ on: OFF_PHONE, why: 'The desktop stacks the kinds as panes, and Task List Options has the Show check marks.' }],
    entries: taskFilterEntries,
    in: { tasks: { main: true } },
  },
  // ---------- creating ----------
  {
    id: 'newProject',
    label: 'New P&roject…',
    group: 'new',
    icon: 'newProject',
    hide: [onlyInViews('projects'), NOT_ON_CHATS_TOOLBAR],
    run: (c) => void c.looper.projects.openEditor(),
    in: { new: { menu: 'file', toolbar: true }, projects: { menu: 'file', main: true } },
  },
  {
    id: 'newTask',
    label: '&New Task',
    toolbarLabel: (c) => (c.project && !onChatsTab(c) && c.here !== 'mobile' ? `New Task in ${c.project.name}` : 'New Task'),
    group: 'new',
    icon: 'newTask',
    hide: [onlyInViews('tasks'), NOT_ON_CHATS_TOOLBAR],
    entries: (c) => [
      { id: 'blank', label: '&Blank Task…', accelerator: onChatsTab(c) ? undefined : 'CmdOrCtrl+N', run: () => void (c.project ? c.looper.projects.newTask(c.project.id) : c.looper.openEditor()) },
      { id: 'template', label: 'From &Template…', accelerator: onChatsTab(c) ? undefined : 'CmdOrCtrl+Shift+N', run: () => void c.looper.openTemplatePicker() },
      { id: 'agent', label: 'With A&gent…', run: () => void c.looper.builder.openNew() },
    ],
    dropdown: 'New Task From',
    run: (c) => void (c.project ? c.looper.projects.newTask(c.project.id) : c.looper.openEditor()),
    in: { new: { menu: 'file', toolbar: true }, tasks: { menu: 'file', main: true } },
  },
  {
    id: 'newChatMenu',
    label: 'New &Chat',
    group: 'new',
    icon: 'newChat',
    hide: [onlyInViews('projects'), { on: ON_PHONE, why: 'The Chats list’s New Chat and New Terminal buttons open these lists.' }],
    entries: newChatEntries,
    in: { new: { menu: 'file' } },
  },
  {
    id: 'newFolder',
    label: 'New &Folder…',
    group: 'new',
    icon: 'folder',
    enabled: (c) => !onChatsTab(c),
    hide: [onlyInViews('tasks', 'projects')],
    run: (c) => c.host('new-folder', c.tab === 'projects' ? 'project' : 'task'),
    in: { new: { menu: 'file' }, tasks: { menu: 'file' }, projects: { menu: 'file' } },
  },
  {
    id: 'newChat',
    label: (c) => {
      const pid = onChatsTab(c) ? summaryOf(c)?.projectId : c.project?.id;
      const project = pid ? c.projects.find((p) => p.id === pid) : undefined;
      return project && c.here !== 'mobile' ? `New Chat in ${project.name}` : 'New Chat';
    },
    group: 'new',
    icon: 'newChat',
    accelerator: (c) => ((onChatsTab(c) ? summaryOf(c)?.projectId : c.project?.id) ? SHORTCUTS.newChat : undefined),
    pageKey: true,
    hide: [onlyInViews('projects')],
    entries: (c) => projectChoices(c, 'chat'),
    dropdown: 'New Chat in Project',
    runnable: (c) => !!(onChatsTab(c) ? summaryOf(c)?.projectId : c.project?.id),
    run: (c) => {
      const pid = onChatsTab(c) ? summaryOf(c)?.projectId : c.project?.id;
      if (pid) void c.looper.projects.newChat(pid);
    },
    in: { new: { toolbar: true }, chats: { main: true } },
  },
  {
    id: 'newTerminal',
    label: (c) => {
      const pid = summaryOf(c)?.projectId;
      const project = pid ? c.projects.find((p) => p.id === pid) : undefined;
      return project && c.here !== 'mobile' ? `New Terminal in ${project.name}` : 'New Terminal';
    },
    group: 'new',
    icon: 'terminal',
    accelerator: (c) => (summaryOf(c)?.projectId ? SHORTCUTS.newTerminal : undefined),
    pageKey: true,
    hide: [{ if: (c) => !onChatsTab(c), view: 'new', why: 'New Terminal shows on the Chats tab; the Project menu has it elsewhere.' }],
    entries: (c) => [...projectChoices(c, 'terminal'), { id: 'new-project', label: 'New P&roject…', run: () => void c.looper.projects.openEditor() }],
    dropdown: 'New Terminal in Project',
    runnable: (c) => !!summaryOf(c)?.projectId,
    run: (c) => {
      const pid = summaryOf(c)?.projectId;
      if (pid) void c.looper.projects.newTerminal(pid);
    },
    in: { new: { toolbar: true }, chats: { main: true } },
  },
  {
    id: 'importTask',
    label: '&Import Task…',
    group: 'transfer',
    hide: [{ if: (c) => !!c.fixed && c.tab !== 'tasks', view: 'new', why: 'Only the Tasks view adds tasks.' }, { if: (c) => !!c.chats && !c.chats.tab, view: 'new', why: 'The Chats window doesn’t list tasks.' }],
    run: (c) => c.host('import-task'),
    in: { new: { menu: 'file' }, tasks: { menu: 'file' } },
  },

  // ---------- the Tasks list: on its toolbar after the New buttons, Recycle Bin joining it ----------
  {
    id: 'tasksDashboard',
    label: '&Dashboard',
    group: 'views',
    icon: 'dashboard',
    checked: (c) => !c.taskSelected,
    hide: [{ on: ON_PHONE, why: 'A phone’s Dashboard tab shows the dashboard.' }],
    run: (c) => c.selectTask?.(null),
    in: { tasks: { menu: 'view', toolbar: true, context: false } },
  },

  // ---------- a task ----------
  {
    id: 'removeFromAttention',
    label: 'Remove from &Needs Attention',
    group: 'attention',
    hide: [{ if: (c) => !c.clearAttention, why: 'Only a Needs attention row has it.' }],
    run: (c) => c.clearAttention?.(),
    in: { task: { menu: 'task' } },
  },
  {
    id: 'runNow',
    label: '&Run Now',
    group: 'state',
    icon: 'run',
    accelerator: 'F5',
    enabled: (c) => hasTask(c) && canRunNow(c),
    run: (c) => {
      const t = c.task;
      if (!t) return;
      const state = c.runtime?.state;
      if (state === 'disabled' || state === 'completed') {
        void c.looper.confirm(`"${t.name}" is ${state}. Run it anyway?`).then((ok) => {
          if (ok) void c.looper.runtime.runNow(t.id).catch(() => undefined);
        });
      } else void c.looper.runtime.runNow(t.id).catch(() => undefined);
    },
    in: { task: { menu: 'task', toolbar: true, main: true } },
  },
  {
    id: 'stopTask',
    label: '&Stop Task',
    group: 'state',
    icon: 'stop',
    accelerator: 'Shift+F5',
    destructive: true,
    enabled: (c) => hasTask(c) && isActive(c),
    run: (c) => c.task && void c.looper.runtime.stopTask(c.task.id, c.pickedRun ?? undefined),
    in: { task: { menu: 'task', toolbar: true, main: true } },
  },
  {
    id: 'pauseResume',
    label: '&Pause',
    group: 'state',
    icon: 'pause',
    alt: { label: '&Resume', icon: 'resume', when: (c) => c.runtime?.state === 'paused' },
    accelerator: SHORTCUTS.pauseResume,
    enabled: (c) => hasTask(c) && c.runtime?.state !== 'disabled' && !c.task?.completedAt,
    run: (c) => {
      if (!c.task) return;
      if (c.runtime?.state === 'paused') void c.looper.runtime.resume(c.task.id);
      else void c.looper.runtime.pause(c.task.id);
    },
    in: { task: { menu: 'task', toolbar: true } },
  },
  {
    id: 'enableDisable',
    label: '&Disable',
    group: 'state',
    icon: 'power',
    alt: { label: 'E&nable', when: (c) => c.task?.enabled === false },
    enabled: (c) => hasTask(c) && !c.task?.completedAt,
    run: (c) => c.task && !c.task.completedAt && void c.looper.tasks.save({ ...c.task, enabled: !c.task.enabled }),
    in: { task: { menu: 'task', toolbar: true } },
  },
  {
    id: 'completeReopen',
    label: 'C&omplete',
    group: 'state',
    icon: 'complete',
    alt: { label: 'Re&open', when: (c) => !!c.task?.completedAt },
    enabled: (c) => hasTask(c) && (!!c.task?.completedAt || !!c.task?.completion.allowed),
    run: (c) => {
      const t = c.task;
      if (!t) return;
      if (t.completedAt) void c.looper.runtime.reopen(t.id);
      else if (t.completion.allowed) {
        void c.looper.confirm(`Mark "${t.name}" as completed? It won't run again, and after a while it moves to the Recycle Bin.`).then((ok) => {
          if (ok) void c.looper.runtime.complete(t.id);
        });
      }
    },
    in: { task: { menu: 'task', toolbar: true } },
  },
  {
    id: 'editTask',
    label: '&Edit Task…',
    group: 'edit',
    toolbarGroup: 'state',
    icon: 'edit',
    accelerator: 'CmdOrCtrl+E',
    enabled: hasTask,
    run: (c) => c.task && void c.looper.openEditor(c.task.id),
    in: { task: { menu: 'task', toolbar: true, main: true } },
  },
  {
    id: 'editWithAgent',
    label: 'Edit with &Agent…',
    group: 'edit',
    enabled: hasTask,
    run: (c) => c.task && void c.looper.builder.editTask(c.task.id),
    in: { task: { menu: 'task' } },
  },
  {
    id: 'note',
    label: 'Add &Guidance for Next Run…',
    group: 'edit',
    toolbarGroup: 'state',
    icon: 'guidance',
    alt: { label: 'Edit &Guidance for Next Run…', when: (c) => !!c.task?.note },
    enabled: hasTask,
    run: (c) => c.task && void c.looper.openNoteEditor(c.task.id),
    in: { task: { menu: 'task', toolbar: true } },
  },
  {
    id: 'clearNote',
    label: 'Clear Guidance',
    group: 'edit',
    destructive: true,
    enabled: (c) => !!c.task?.note,
    run: (c) => c.task?.note && void c.looper.tasks.save({ ...c.task, note: undefined }),
    in: { task: { menu: 'task' } },
  },
  {
    id: 'moveToFolder',
    label: 'Move to &Folder…',
    group: 'organize',
    icon: 'folder',
    enabled: hasTask,
    run: (c) => c.task && void c.looper.openMoveToFolder(c.task.id),
    in: { task: { menu: 'task' } },
  },
  {
    id: 'versionHistory',
    label: '&Version History',
    group: 'organize',
    enabled: hasTask,
    run: (c) => c.task && void c.looper.versions.open(c.task.id),
    in: { task: { menu: 'task' } },
  },
  {
    id: 'clearRuns',
    label: 'Clear Run &History…',
    group: 'organize',
    destructive: true,
    enabled: (c) => hasTask(c) && !isActive(c),
    run: (c) => {
      const t = c.task;
      if (!t) return;
      void c.looper.confirm(`Clear the run history of "${t.name}"? All run logs and outputs are deleted.`).then((ok) => {
        if (!ok) return;
        void c.looper.runs.clear(t.id).then(() => c.runsCleared?.(t.id)).catch(failed(c));
      });
    },
    in: { task: { menu: 'task' } },
  },
  {
    id: 'taskWorkFolder',
    label: 'Open &Working Directory',
    toolbarLabel: workFolderToolbarLabel,
    group: 'organize',
    toolbarGroup: 'state',
    icon: 'openFolder',
    menuGlyph: false,
    enabled: hasTask,
    run: (c) => c.task && void c.looper.openTaskWorkFolder(c.task.id).catch(failed(c)),
    in: { task: { menu: 'task', toolbar: true } },
  },
  {
    id: 'exportTask',
    label: 'Ex&port Task…',
    group: 'transfer',
    enabled: hasTask,
    run: (c) => c.task && void c.looper.tasks.export(c.task.id),
    in: { task: { menu: 'file', context: false } },
  },
  // ---------- a project: first its New items, which the Task menu shares for the task's project ----------
  {
    id: 'projectNewTask',
    label: 'New &Task…',
    group: 'project-new',
    icon: 'newTask',
    enabled: hasProject,
    hide: [PROJECT_NOT_IN_TASK_WINDOW, { on: ON_PHONE, view: 'task', why: 'A task’s screen doesn’t make tasks: the Tasks tab’s bar has New Task.' }],
    run: (c) => c.project && void c.looper.projects.newTask(c.project.id),
    in: { project: { menu: 'project' }, task: { menu: 'project', context: false } },
  },
  {
    id: 'projectNewChat',
    label: 'New &Chat',
    group: 'project-new',
    icon: 'newChat',
    accelerator: SHORTCUTS.newChat,
    enabled: hasProject,
    run: (c) => c.project && void c.looper.projects.newChat(c.project.id),
    in: { project: { menu: 'project', main: true }, task: { menu: 'task' } },
  },
  {
    id: 'projectNewTerminal',
    label: 'New Ter&minal',
    group: 'project-new',
    icon: 'terminal',
    accelerator: SHORTCUTS.newTerminal,
    enabled: hasProject,
    run: (c) => c.project && void c.looper.projects.newTerminal(c.project.id),
    in: { project: { menu: 'project' }, task: { menu: 'task' } },
  },
  {
    id: 'deleteTask',
    label: 'De&lete Task',
    group: 'delete',
    icon: 'delete',
    destructive: true,
    enabled: hasTask,
    run: (c) => {
      const t = c.task;
      if (!t) return;
      // The Recycle Bin can undo a delete, but not a run it stopped: only that asks first.
      if ((c.runtime?.runs.length ?? 0) > 0) {
        void c.looper.confirm(`"${t.name}" is running. Stop it and move it to the Recycle Bin?`).then((ok) => {
          if (ok) void c.looper.tasks.remove(t.id);
        });
      } else void c.looper.tasks.remove(t.id);
    },
    in: { task: { menu: 'task' } },
  },

  // ---------- a project ----------
  {
    id: 'editProject',
    label: '&Edit Project…',
    group: 'project',
    icon: 'edit',
    enabled: hasProject,
    hide: [PROJECT_NOT_IN_TASK_WINDOW, { on: ON_PHONE, view: 'task', why: 'The project’s own screen has Edit Project.' }],
    run: (c) => c.project && void c.looper.projects.openEditor(c.project.id),
    in: { project: { menu: 'project', toolbar: true, main: true }, task: { menu: 'project', context: false } },
  },
  {
    id: 'openProjectFolder',
    label: 'Open &Folder',
    group: 'project',
    icon: 'openFolder',
    menuGlyph: false,
    enabled: hasProject,
    hide: [PROJECT_NOT_IN_TASK_WINDOW, { on: ON_PHONE, view: 'task', why: 'The project’s own screen has Open Folder.' }],
    run: (c) => c.project && void c.looper.openTaskWorkFolder(projectTaskId(c.project.id)).catch(failed(c)),
    in: { project: { menu: 'project', toolbar: true }, task: { menu: 'project', context: false } },
  },
  {
    id: 'moveProject',
    label: 'Move to F&older',
    group: 'project',
    enabled: hasProject,
    hide: [{ if: (c) => !c.projectSelected, why: 'Only a project’s own row or screen moves it.' }],
    entries: projectFolderEntries,
    in: { project: { menu: 'project' } },
  },
  {
    id: 'deleteProject',
    label: '&Delete Project…',
    group: 'project-delete',
    icon: 'delete',
    destructive: true,
    enabled: hasProject,
    hide: [PROJECT_NOT_IN_TASK_WINDOW, { on: ON_PHONE, view: 'task', why: 'The project’s own screen has Delete Project.' }],
    run: (c) => c.project && void c.looper.projects.remove(c.project.id),
    in: { project: { menu: 'project' }, task: { menu: 'project', context: false } },
  },

  // ---------- a window's frame: first on View ----------
  {
    id: 'toolbar',
    label: '&Toolbar',
    group: 'bars',
    checked: (c) => (c.chats && !c.chats.tab ? (c.chats.single ? c.chats.shown.windowToolbar : c.chats.shown.toolbar) : (viewOf(c)?.toolbar ?? true)),
    hide: [
      { on: ON_PHONE, why: 'A phone has no toolbar row: its commands are on the bar and in More.' },
      // A window of the Dashboard alone has an empty toolbar unless an addon has a button for it.
      { if: (c) => !!c.fixed && c.tab === 'dashboard' && !c.addons.some((a) => a.enabled && hasToolbarIn(a, 'dashboard')), why: 'Its toolbar would be empty.' },
    ],
    run: (c) => {
      if (c.chats && !c.chats.tab) {
        if (c.chats.single) c.chats.setShown({ windowToolbar: !c.chats.shown.windowToolbar });
        else c.chats.setShown({ toolbar: !c.chats.shown.toolbar });
      } else if (viewOf(c)) c.setView({ toolbar: !viewOf(c)!.toolbar });
    },
    in: { frame: { menu: 'view' } },
  },
  {
    id: 'addonToolbars',
    label: 'Addon Toolbars',
    group: 'bars',
    inline: true,
    hide: [{ on: ON_PHONE, why: 'Addons are in the More view, each with its own screen.' }, { if: (c) => !!c.item || inChatWindow(c), why: 'A single item’s window has no addon buttons.' }],
    entries: (c) => addonToolbarEntries(c, c.fixed ? c.tab : c.chats && !c.chats.tab ? 'chats' : undefined),
    in: { frame: { menu: 'view' } },
  },
  {
    id: 'statusBar',
    label: 'Status &Bar',
    group: 'bars',
    checked: (c) => (c.chats && !c.chats.tab ? (c.chats.single ? c.chats.shown.windowStatusBar : c.chats.shown.statusBar) : (viewOf(c)?.statusBar ?? true)),
    hide: [{ on: ON_PHONE, why: 'A phone shows its facts in its lists and sheets.' }],
    run: (c) => {
      if (c.chats && !c.chats.tab) {
        if (c.chats.single) c.chats.setShown({ windowStatusBar: !c.chats.shown.windowStatusBar });
        else c.chats.setShown({ statusBar: !c.chats.shown.statusBar });
      } else if (viewOf(c)) c.setView({ statusBar: !viewOf(c)!.statusBar });
    },
    in: { frame: { menu: 'view' } },
  },
  {
    id: 'tabs',
    // Not Ta&bs: Status &Bar has that letter.
    label: 'T&abs',
    group: 'tabs',
    hide: [{ on: ON_PHONE, why: 'Each OS decides where its tabs go.' }],
    entries: tabEntries,
    in: { app: { menu: 'view' } },
  },

  // ---------- the Chats list: first on its toolbar ----------
  {
    id: 'chatsOverview',
    label: (c) => (c.chats?.tab ? 'Overview' : '&Dashboard'),
    group: 'views',
    icon: 'dashboard',
    checked: (c) => !c.chats?.selected,
    hide: [{ on: ON_PHONE, why: 'The Overview switch above the list shows it.' }],
    run: (c) => c.chats?.setSelected(null),
    in: { chats: { menu: 'view', toolbar: true } },
  },
  {
    id: 'sendToChats',
    label: 'Send to C&hats…',
    group: 'open',
    toolbarGroup: 'views',
    icon: 'bullhorn',
    enabled: (c) => c.chats?.sessions.some((s) => s.kind !== 'run') ?? false,
    run: (c) => c.looper.sessions.openSend(),
    in: { chats: { menu: 'file', toolbar: true, main: true } },
  },

  // ---------- a conversation: Chat ----------
  {
    id: 'stop',
    label: '&Stop',
    group: 'turn',
    icon: 'stop',
    // Esc is a chat's and a task run's: a terminal's goes to its agent, so its tooltip names none.
    accelerator: (c) => (isChat(c) || isRun(c) ? 'Esc' : undefined),
    pageKey: true,
    destructive: true,
    enabled: (c) => !!c.chats?.stoppable,
    hide: [NOT_IN_CHAT_MENU],
    run: (c) => summaryOf(c) && void c.looper.sessions.stop(summaryOf(c)!.id).catch(failed(c)),
    in: { conversation: { menu: 'chat', toolbar: true, main: true, box: true } },
  },
  {
    id: 'sendNow',
    label: 'Send &Now',
    group: 'turn',
    icon: 'sendNow',
    accelerator: 'CmdOrCtrl+Enter',
    enabled: (c) => !!c.chats?.chat?.queued.some((q) => !q.delivered) || !!c.chats?.runQueued,
    run: (c) => {
      const s = summaryOf(c);
      if (c.chats?.chat) void c.looper.chat.sendNow(c.chats.chat.id).catch(failed(c));
      else if (s?.kind === 'run') void c.looper.runs.sendNow(s.taskId, s.id).catch(failed(c));
    },
    // The desktop's toolbar keeps it, off, so its buttons don't move.
    hide: [NOT_IN_CHAT_MENU, { on: ON_PHONE, if: (c) => !isChat(c) && !isRun(c), why: 'Only a chat and a task run queue messages.' }],
    in: { conversation: { menu: 'chat', toolbar: true, box: true } },
  },
  {
    id: 'restartAgent',
    label: '&Restart Agent',
    group: 'turn',
    icon: 'restartAgent',
    // A chat, or a terminal session on Claude Code or Codex (a custom harness has no conversation to go on with).
    enabled: (c) => !!summaryOf(c) && (isChat(c) || (isTerminal(c) && summaryOf(c)!.harnessKind !== 'custom')),
    hide: [NOT_IN_CHAT_MENU, { on: ON_PHONE, if: isRun, why: 'A task run’s agent isn’t restarted from here.' }],
    run: (c) => summaryOf(c) && void c.looper.sessions.restart(summaryOf(c)!.id).catch(failed(c)),
    in: { conversation: { menu: 'chat', toolbar: true } },
  },
  ...(['harness', 'model', 'effort', 'permission', 'mode'] as const).map((which): Command => ({
    id: `chat-${which}`,
    label: { harness: '&Harness', model: '&Model', effort: '&Effort', permission: '&Permission Mode', mode: 'Session T&ype' }[which],
    group: 'settings',
    hide: [{ if: (c) => !isChat(c), why: 'Only a chat has these settings.' }, { on: ON_PHONE, why: 'The Usage sheet has them, beside the usage facts.' }],
    entries: (c) => (c.chats?.chat ? chatSettingEntries(c.chats.chat, c.looper)[which] : []),
    in: { conversation: { menu: 'chat' } },
  })),
  {
    id: 'chatTerminal',
    label: 'Show &Terminal',
    group: 'settings',
    checked: (c) => !!c.chats?.terminal,
    enabled: (c) => !!c.chats?.chat && chatInteractive(c.chats.chat),
    hide: [{ if: (c) => !isChat(c), why: 'Only an interactive chat has a terminal beside its conversation.' }],
    run: (c) => c.chats?.showTerminal?.(!c.chats.terminal),
    in: { conversation: { menu: 'chat' } },
  },
  {
    id: 'compact',
    label: '&Compact into New Chat',
    toolbarLabel: (c) => (c.here === 'mobile' ? 'Compact' : 'Compact into New Chat'),
    group: 'conversation',
    toolbarGroup: 'turn',
    icon: 'compact',
    enabled: (c) => !!c.chats?.chat && chatCanCompact(c.chats.chat),
    hide: [NOT_IN_CHAT_MENU, { on: ON_PHONE, if: (c) => !isChat(c), why: 'Only a chat can be compacted.' }],
    run: (c) => c.chats?.chat && void c.looper.chat.compact(c.chats.chat.id).catch(failed(c)),
    in: { conversation: { menu: 'chat', toolbar: true } },
  },
  {
    id: 'rename',
    // Not Re&name or &Rename: Send &Now and &Restart Agent have those letters.
    label: 'Ren&ame…',
    group: 'conversation',
    accelerator: 'F2',
    pageKey: true,
    hide: [{ if: (c) => !isChat(c), why: 'A terminal’s and a run’s names come from elsewhere.' }],
    run: (c) => summaryOf(c) && c.looper.sessions.openRename(summaryOf(c)!.id),
    in: { conversation: { menu: 'chat' } },
  },
  {
    id: 'autoContinue',
    label: 'Continue &When Limit Resets',
    group: 'conversation',
    checked: (c) => !!c.chats?.chat?.autoContinue,
    hide: [{ if: (c) => !isChat(c), why: 'Only a chat continues by itself.' }],
    run: (c) => c.chats?.chat && c.looper.chat.setAutoContinue(c.chats.chat.id, !c.chats.chat.autoContinue),
    in: { conversation: { menu: 'chat' } },
  },
  {
    id: 'watchTaskEvents',
    label: 'Watch Task E&vents',
    group: 'conversation',
    hide: [{ if: (c) => !isChat(c), why: 'Only a chat’s agent watches the tasks of its project.' }],
    entries: watchTaskEntries,
    in: { conversation: { menu: 'chat' } },
  },
  {
    id: 'copySessionId',
    label: 'Copy Session &ID',
    group: 'conversation',
    icon: 'copy',
    enabled: (c) => !!c.chats?.sessionId,
    hide: [{ if: (c) => !isChat(c), why: 'Only a chat has a Chat menu.' }],
    run: (c) => summaryOf(c) && c.host('copy-session-id', summaryOf(c)!.id),
    in: { conversation: { menu: 'chat' } },
  },
  // ---------- a conversation: File and Edit ----------
  {
    id: 'attachFiles',
    label: '&Attach Files…',
    group: 'conversation-file',
    icon: 'attach',
    accelerator: 'CmdOrCtrl+O',
    enabled: (c) => !!c.chats?.chat && c.chats.chat.status !== 'ended',
    run: (c) => {
      const chat = c.chats?.chat;
      if (chat) void c.looper.chat.pickFiles(chat.id).then((attachments) => { if (attachments.length) c.ui({ type: 'chat-attached', attachments }); }).catch(failed(c));
    },
    in: { conversation: { menu: 'file', box: true } },
  },
  {
    id: 'saveMarkdown',
    label: '&Save as Markdown…',
    group: 'conversation-file',
    accelerator: 'CmdOrCtrl+S',
    enabled: (c) => !!c.chats?.chat || isRun(c),
    hide: [{ on: ON_PHONE, if: (c) => isTerminal(c), why: 'A terminal’s output isn’t messages.' }],
    run: (c) => summaryOf(c) && c.host('save-markdown', summaryOf(c)!.id),
    in: { conversation: { menu: 'file' } },
  },
  {
    id: 'chatInProject',
    label: 'New Chat in Project',
    group: 'open',
    icon: 'newChat',
    enabled: (c) => !!summaryOf(c)?.projectId,
    hide: [{ on: OFF_PHONE, why: 'File → New Chat has it, named after the project.' }],
    run: (c) => summaryOf(c)?.projectId && void c.looper.projects.newChat(summaryOf(c)!.projectId!),
    in: { conversation: { menu: 'file' } },
  },
  {
    id: 'openInNewWindow',
    label: 'O&pen in New Window',
    group: 'open',
    enabled: (c) => isChat(c) || isRun(c),
    hide: [{ on: ON_PHONE, why: 'Opens a window beside the others, and a phone or tablet shows one screen.' }, { if: inChatWindow, why: 'It’s already a window of its own.' }],
    run: (c) => summaryOf(c) && c.looper.openItemWindow('chat', summaryOf(c)!.id),
    in: { conversation: { menu: 'file' } },
  },
  {
    id: 'conversationWorkFolder',
    label: 'Open &Working Directory',
    toolbarLabel: workFolderToolbarLabel,
    group: 'open',
    toolbarGroup: 'turn',
    toolbarLast: true,
    icon: 'openFolder',
    menuGlyph: false,
    enabled: (c) => !!summaryOf(c),
    run: (c) => summaryOf(c) && void c.looper.openTaskWorkFolder(summaryOf(c)!.taskId).catch(failed(c)),
    in: { conversation: { menu: 'file', toolbar: true } },
  },
  ...CLIPBOARD_ROLES.map(([role, label, group]): Command => ({
    id: role,
    label,
    group,
    role,
    // The page handles these keys in a Chats window, so a terminal still gets Ctrl+C and the rest.
    pageKey: (c) => !!c.chats,
    hide: [{ on: ON_PHONE, why: FIND_ON_CHAT_WHY }],
    in: { history: { menu: 'edit' }, chatWindow: { menu: 'edit' } },
  })),
  {
    id: 'findInChat',
    label: '&Find…',
    group: 'find',
    icon: 'search',
    accelerator: 'CmdOrCtrl+F',
    enabled: (c) => !!c.chats?.chat,
    hide: [{ on: ON_PHONE, if: (c) => !isChat(c), why: 'Only a chat’s messages can be searched.' }],
    run: (c) => c.ui({ type: 'chat-find' }),
    in: { conversation: { menu: 'edit' } },
  },
  {
    id: 'findInHistory',
    label: '&Find…',
    group: 'find',
    icon: 'search',
    accelerator: 'CmdOrCtrl+F',
    run: (c) => c.history?.find(),
    in: { history: { menu: 'edit' } },
  },

  {
    id: 'closeConversation',
    label: 'Close C&onversation',
    group: 'close',
    toolbarGroup: 'turn',
    icon: 'close',
    accelerator: 'CmdOrCtrl+W',
    pageKey: true,
    destructive: true,
    enabled: (c) => !!summaryOf(c) && !isRun(c),
    run: (c) => summaryOf(c) && void c.looper.sessions.close(summaryOf(c)!.id),
    in: { conversation: { menu: 'file', toolbar: true } },
  },
  {
    id: 'closeAllConversations',
    label: 'Close A&ll Conversations',
    group: 'close',
    destructive: true,
    enabled: (c) => c.chats?.sessions.some((s) => s.kind !== 'run') ?? false,
    run: (c) => c.host('close-all'),
    in: { chats: { menu: 'file' } },
  },
  {
    id: 'activity',
    label: 'A&ctivity Pane',
    toolbarLabel: (c) => (c.here === 'mobile' ? 'Activity' : 'Activity Pane'),
    group: 'panes',
    icon: 'activity',
    enabled: (c) => !!summaryOf(c),
    checked: (c) => !!c.chats?.activityOpen,
    run: (c) => c.chats?.toggleActivity(),
    in: { conversation: { menu: 'view', toolbar: true, main: true } },
  },
  {
    id: 'usage',
    label: (c) => c.chats?.usageLabel ?? 'Usage',
    group: 'panes',
    ring: (c) => c.chats?.usageRing ?? { context: null },
    hide: [{ on: OFF_PHONE, why: 'The status bar shows usage all the time.' }],
    run: (c) => c.chats?.showUsage?.(),
    in: { conversation: { main: true } },
  },

  // ---------- the Chats list ----------
  {
    id: 'showThinking',
    label: 'Show Thin&king',
    group: 'panes',
    checked: (c) => c.settings?.chats.expandThinking ?? false,
    run: (c) => {
      const chats = c.settings?.chats;
      if (chats) void c.looper.updateSettings({ chats: { ...chats, expandThinking: !chats.expandThinking } }).catch(failed(c));
    },
    in: { chats: { menu: 'view' }, conversation: { menu: 'view' } },
  },
  {
    id: 'showTaskRuns',
    label: 'Show Task &Runs',
    group: 'list',
    checked: (c) => !!c.chats?.shown.showRuns,
    run: (c) => c.chats?.setShown({ showRuns: !c.chats.shown.showRuns }),
    in: { chats: { menu: 'view' } },
  },
  {
    id: 'waitingFirst',
    label: '&Waiting Chats First',
    group: 'list',
    checked: (c) => !!c.chats?.shown.waitingFirst,
    run: (c) => c.chats?.setShown({ waitingFirst: !c.chats.shown.waitingFirst }),
    in: { chats: { menu: 'view' } },
  },
  // The Window menu, from the widest to the narrowest: windows, this window's panes, the chats in its list.
  {
    id: 'viewWindows',
    label: 'View Windows',
    group: 'view-windows',
    inline: true,
    hide: [{ on: ON_PHONE, why: 'These open separate windows, and a phone has the tabs.' }],
    entries: (c) =>
      mainTabs(c.addons).map((t) => ({ id: t.id, label: VIEW_WINDOW_LABELS[t.id] ?? menuText(t.label), icon: t.icon, run: () => c.host('open-view', t.id) })),
    in: { app: { menu: 'window' } },
  },
  {
    id: 'alwaysOnTop',
    label: 'Always on &Top',
    group: 'on-top',
    provided: 'always-on-top',
    hide: [{ on: ['web', 'mobile'], why: 'A browser tab or a phone can’t keep a window above the device’s others.' }, { if: (c) => !c.chats?.single, why: 'Only a single chat’s window stays on top.' }],
    in: { chatWindow: { menu: 'window' } },
  },
  ...([
    ['previousPane', 'Prev&ious Pane', 'Shift+F6', -1],
    ['nextPane', 'Next Pan&e', 'F6', 1],
  ] as const).map(([id, label, accelerator, dir]): Command => ({
    id,
    label,
    group: 'panes-nav',
    accelerator,
    pageKey: true,
    hide: [{ on: ON_PHONE, why: 'A phone shows one pane at a time.' }],
    run: (c) => c.chats?.focusPane(dir),
    in: { conversation: { menu: 'window' }, chatWindow: { menu: 'window' } },
  })),
  ...([
    ['previousWaiting', 'Pre&vious Waiting Chat', 'F8', -1, true],
    ['nextWaiting', 'Next W&aiting Chat', 'F9', 1, true],
    ['previousChat', 'P&revious Chat', 'Shift+F8', -1, false],
    ['nextChat', '&Next Chat', 'Shift+F9', 1, false],
  ] as const).map(([id, label, accelerator, dir, waiting]): Command => ({
    id,
    label,
    group: 'nav',
    accelerator,
    hide: [{ if: inChatWindow, why: 'A single chat’s window has no list to step through.' }],
    run: (c) => c.chats?.step(dir, waiting),
    in: { chats: { menu: 'window' }, conversation: { menu: 'window' } },
  })),

  // ---------- the Tasks list ----------
  {
    id: 'taskPanes',
    label: 'Panes',
    group: 'task-panes',
    inline: true,
    hide: [{ on: ON_PHONE, why: 'A phone has one list, which the Filter button narrows.' }],
    entries: paneEntries,
    in: { tasks: { menu: 'view', context: false } },
  },
  {
    id: 'taskListOptions',
    label: 'Task &List Options',
    group: 'task-list',
    hide: [{ on: ON_PHONE, why: 'A phone’s Filter button has the Show marks, and its More has the folder options.' }],
    entries: taskListEntries,
    in: { tasks: { menu: 'view', context: false } },
  },
  {
    id: 'showFolders',
    label: 'Show &Folders',
    group: 'list',
    checked: (c) => viewOf(c)?.single.showFolders ?? true,
    hide: [{ on: OFF_PHONE, why: 'Task List Options has it, for each pane.' }],
    run: (c) => {
      const view = viewOf(c);
      if (view) c.setView({ single: { ...view.single, showFolders: !view.single.showFolders } });
    },
    in: { tasks: { menu: 'view' } },
  },
  {
    id: 'hideEmptyFolders',
    label: 'Hide &Empty Folders',
    group: 'list',
    enabled: (c) => viewOf(c)?.single.showFolders ?? true,
    checked: (c) => viewOf(c)?.single.hideEmptyFolders ?? false,
    hide: [{ on: OFF_PHONE, why: 'Task List Options has it, for each pane.' }],
    run: (c) => {
      const view = viewOf(c);
      if (view) c.setView({ single: { ...view.single, hideEmptyFolders: !view.single.hideEmptyFolders } });
    },
    in: { tasks: { menu: 'view' } },
  },
  {
    id: 'taskRuns',
    label: 'Task &Runs',
    group: 'task-list',
    entries: taskRunEntries,
    hide: [
      { on: ON_PHONE, view: 'dashboard', why: 'A phone keeps a list’s More short: a task’s screen has it, beside the runs it filters.' },
      { on: ON_PHONE, view: 'tasks', why: 'A phone keeps a list’s More short: a task’s screen has it, beside the runs it filters.' },
    ],
    in: { dashboard: { menu: 'view' }, tasks: { menu: 'view', context: false }, task: { menu: 'view', context: false } },
  },

  // ---------- the Projects list ----------
  {
    id: 'groupProjects',
    label: '&Group Projects By',
    group: 'list',
    entries: groupByEntries,
    in: { projects: { menu: 'view' } },
  },

  // ---------- the run window ----------
  {
    id: 'runSaveMarkdown',
    label: '&Save as Markdown…',
    group: 'run-save',
    accelerator: 'CmdOrCtrl+S',
    run: (c) => c.run && c.host('save-markdown', c.run.runId, c.run.taskId, c.run.agentId ?? '', c.run.title),
    in: { run: { menu: 'file' } },
  },
  {
    id: 'runOutputFile',
    label: 'Open &Output File',
    group: 'run-save',
    hide: [{ if: (c) => !!c.run?.agentId, why: 'A subagent’s window shows only its conversation.' }],
    run: (c) => c.run && c.host('run-output-file', c.run.taskId, c.run.runId, c.run.rawOutput ? 'raw' : ''),
    in: { run: { menu: 'file' } },
  },
  ...([
    ['runTerminal', 'Continue in &Terminal', 'terminal', 'run-terminal'],
    ['runChat', 'Continue in &Chat', 'chat', 'run-chat'],
    ['runCompact', 'Continue Co&mpacted', 'compact', 'run-compact'],
    ['runGuidance', 'Continue with &Guidance…', 'guidance', 'run-guidance'],
  ] as const).map(([id, label, can, host]): Command => ({
    id,
    label,
    group: 'run-continue',
    enabled: (c) => !!c.run?.canContinue[can],
    hide: [{ if: (c) => !!c.run?.agentId, why: 'A subagent’s window shows only its conversation.' }],
    run: (c) => c.run && c.host(host, c.run.taskId, c.run.runId),
    in: { run: { menu: 'file' } },
  })),
  {
    id: 'runFolder',
    label: 'Open &Run Folder',
    group: 'run-folders',
    hide: [IN_RUN_FOLDERS],
    run: (c) => c.run && c.host('run-folder', c.run.taskId, c.run.runId),
    in: { run: { menu: 'file' } },
  },
  {
    id: 'runCopyFolder',
    label: 'Copy Run Folder &Path',
    group: 'run-folders',
    hide: [IN_RUN_FOLDERS],
    run: (c) => c.run && c.host('run-copy-folder', c.run.taskId, c.run.runId),
    in: { run: { menu: 'file' } },
  },
  {
    id: 'runWorkFolder',
    label: 'Open &Working Directory',
    group: 'run-folders',
    hide: [IN_RUN_FOLDERS],
    enabled: (c) => !!c.run?.workFolder,
    run: (c) => c.run && c.host('run-work-folder', c.run.taskId, c.run.runId),
    in: { run: { menu: 'file' } },
  },
  {
    id: 'runFolders',
    label: '&Folders',
    group: 'run-folders',
    icon: 'openFolder',
    hide: [{ on: OFF_PHONE, why: 'The File menu lists the folder commands as a group of their own.' }],
    entries: (c) => {
      const run = c.run;
      if (!run) return [];
      return [
        { id: 'run', label: 'Open &Run Folder', run: () => c.host('run-folder', run.taskId, run.runId) },
        { id: 'copy', label: 'Copy Run Folder &Path', run: () => c.host('run-copy-folder', run.taskId, run.runId) },
        { id: 'work', label: 'Open &Working Directory', enabled: run.workFolder, run: () => c.host('run-work-folder', run.taskId, run.runId) },
      ];
    },
    in: { run: { menu: 'file' } },
  },
  {
    id: 'runRaw',
    label: '&Raw Messages',
    group: 'run-view',
    checked: (c) => !!c.run?.raw,
    hide: [ON_RUN_RESULT, ON_RUN_MESSAGE],
    run: (c) => c.run?.set({ raw: !c.run.raw }),
    in: { run: { menu: 'view' } },
  },
  {
    id: 'runRawOutput',
    label: 'Raw Agent &Output',
    group: 'run-view',
    checked: (c) => !!c.run?.rawOutput,
    hide: [{ if: (c) => !!c.run?.agentId, why: 'A subagent’s window shows only its conversation.' }, ON_RUN_RESULT],
    run: (c) => c.run?.set({ rawOutput: !c.run.rawOutput }),
    in: { run: { menu: 'view' } },
  },
  {
    id: 'runAutoScroll',
    label: '&Auto Scroll',
    group: 'run-view',
    checked: (c) => !!c.run?.autoScroll,
    hide: [ON_RUN_RESULT, ON_RUN_MESSAGE],
    run: (c) => c.run?.set({ autoScroll: !c.run.autoScroll }),
    in: { run: { menu: 'view' } },
  },
  {
    id: 'runFilter',
    label: '&Filter…',
    group: 'run-filter',
    accelerator: 'CmdOrCtrl+F',
    checked: (c) => !!c.run?.filter.trim(),
    hide: [{ on: ON_PHONE, why: 'The list has a search field under its rows.' }],
    run: (c) => c.run && c.host('filter', 'Show messages containing', c.run.filter),
    in: { run: { menu: 'view' } },
  },
  {
    id: 'runFindInMessage',
    label: 'Find in &Message…',
    group: 'run-filter',
    icon: 'search',
    enabled: (c) => !!c.run?.findInMessage,
    hide: [{ on: ON_PHONE, if: (c) => !c.run?.message, why: 'It searches the open message; the list has its own search field.' }],
    run: (c) => c.run?.findInMessage?.(),
    in: { run: { menu: 'view' } },
  },

  {
    id: 'runKeepInAttention',
    label: 'Close and &Keep in Needs Attention',
    group: 'close',
    hide: [{ if: (c) => !c.run?.inAttention, why: 'Only a run its window took off Needs attention has it.' }],
    run: (c) => {
      const run = c.run;
      if (run) void c.looper.runtime.markRunUnseen(run.taskId, run.runId).then(() => c.closeWindow(), failed(c));
    },
    in: { run: { menu: 'file' } },
  },

  // ---------- the History window ----------
  ...([
    ['historyChat', 'Continue in &Chat', 'chat', 'chat', 'continue'],
    ['historyCompact', 'Continue Co&mpacted', 'compact', 'compact', 'continue'],
    ['historyTerminal', 'Continue in &Terminal', 'terminal', 'terminal', 'continue'],
  ] as const).map(([id, label, icon, command, group]): Command => ({
    id,
    label,
    group,
    icon,
    enabled: (c) => !!c.history?.commands[command],
    run: (c) => c.history?.selected && void c.looper.history.run(c.history.selected, command).catch(failed(c)),
    in: { historyItem: { menu: 'file', toolbar: true } },
  })),
  {
    id: 'historyCopyId',
    label: 'Copy Session &ID',
    group: 'history-item',
    icon: 'copy',
    enabled: (c) => !!c.history?.commands.sessionId,
    run: (c) => c.history?.selected && void c.looper.history.run(c.history.selected, 'copy-id').catch(failed(c)),
    in: { historyItem: { menu: 'file', toolbar: true } },
  },
  {
    id: 'historyWorkFolder',
    label: 'Open &Working Directory',
    toolbarLabel: workFolderToolbarLabel,
    group: 'history-item',
    icon: 'openFolder',
    enabled: (c) => !!c.history?.commands.folder,
    run: (c) => c.history?.selected && void c.looper.history.run(c.history.selected, 'open-folder').catch(failed(c)),
    in: { historyItem: { menu: 'file', toolbar: true } },
  },
  {
    id: 'historyGroupDate',
    label: 'Group by &Date',
    group: 'history-group',
    radio: true,
    checked: (c) => c.history?.shown.groupBy === 'date',
    run: (c) => c.history?.setShown({ groupBy: 'date' }),
    in: { history: { menu: 'view' } },
  },
  {
    id: 'historyGroupFolder',
    label: 'Group by Fo&lder',
    group: 'history-group',
    radio: true,
    checked: (c) => c.history?.shown.groupBy === 'folder',
    run: (c) => c.history?.setShown({ groupBy: 'folder' }),
    in: { history: { menu: 'view' } },
  },
  {
    id: 'historyFolderFilter',
    label: 'Fold&er',
    group: 'history-filter',
    entries: (c) => {
      const h = c.history;
      if (!h) return [];
      return [
        { id: 'all', label: '&All Folders', radio: true, checked: h.folder === '', run: () => h.setFolder('') },
        ...(c.projects.length ? [{ separator: true } as const] : []),
        ...c.projects.map((p): Entry => ({ id: p.id, label: menuText(p.name), radio: true, checked: h.folder === `project:${p.id}`, run: () => h.setFolder(`project:${p.id}`) })),
        { separator: true },
        { id: 'other', label: '&Outside Projects', radio: true, checked: h.folder === 'other', run: () => h.setFolder('other') },
      ];
    },
    in: { history: { menu: 'view' } },
  },
  {
    id: 'historyShowRuns',
    label: 'Show Task &Runs',
    group: 'history-filter',
    checked: (c) => !!c.history?.shown.showRuns,
    run: (c) => c.history?.setShown({ showRuns: !c.history.shown.showRuns }),
    in: { history: { menu: 'view' } },
  },
  {
    id: 'historyActivity',
    label: 'A&ctivity Pane',
    group: 'history-panes',
    icon: 'activity',
    enabled: (c) => !!c.history?.selected,
    checked: (c) => !!c.history?.activity,
    run: (c) => c.history?.setActivity(!c.history.activity),
    in: { historyItem: { menu: 'view', toolbar: true, main: true } },
  },
  {
    id: 'historyRefresh',
    label: 'Re&fresh',
    group: 'history-refresh',
    accelerator: 'F5',
    run: (c) => c.history?.refresh(),
    in: { history: { menu: 'view' } },
  },

  // ---------- a window's frame: last on File ----------
  {
    id: 'closeWindow',
    label: 'Clos&e Window',
    // With Close Conversation in a chat's window: both close what it shows.
    group: 'close',
    accelerator: 'Alt+F4',
    pageKey: true,
    hide: [{ on: ON_PHONE, why: 'Back or ✕ closes a screen.' }, { view: 'frame', if: (c) => !c.fixed && (!c.chats || c.chats.tab), why: 'The main window’s File has Exit.' }],
    run: (c) => c.closeWindow(),
    in: { frame: { menu: 'file' }, history: { menu: 'file' }, run: { menu: 'file' } },
  },
  {
    id: 'exit',
    label: 'E&xit',
    group: 'quit',
    role: 'quit',
    hide: [{ on: ON_PHONE, why: 'Quitting from a phone would leave no way to start Looper again.' }],
    in: { app: { menu: 'file' } },
  },

  // ---------- Tools: Looper's windows, the addons' tools, then the settings ----------
  {
    id: 'chatsHistory',
    label: '&History',
    group: 'tools',
    toolbarGroup: 'views',
    icon: 'history',
    dropdown: 'Recent Conversations',
    openDropdown: (c, x, y) => c.looper.sessions.showHistoryMenu(x, y),
    run: (c) => c.looper.history.open(),
    in: { chats: { menu: 'tools', toolbar: true }, app: { menu: 'tools' } },
  },
  {
    id: 'recycleBin',
    label: 'Recycle &Bin',
    group: 'tools',
    toolbarGroup: 'views',
    icon: 'recycleBin',
    run: (c) => c.host('recycle-bin'),
    in: { app: { menu: 'tools' }, tasks: { toolbar: true } },
  },
  {
    id: 'templates',
    label: 'Temp&lates',
    group: 'tools',
    run: (c) => c.host('templates'),
    in: { app: { menu: 'tools' }, tasks: { menu: 'view' } },
    hide: [{ on: OFF_PHONE, view: 'tasks', why: 'The desktop has Templates in Tools.' }, { on: ON_PHONE, view: 'app', why: 'The Tasks tab has Templates, since templates make tasks.' }],
  },
  {
    id: 'agentSettings',
    label: 'A&gent Settings…',
    group: 'settings',
    run: (c) => c.host('agent-settings'),
    in: { app: { menu: 'tools' } },
  },
  {
    id: 'settings',
    label: 'S&ettings',
    group: 'settings',
    icon: 'settings',
    accelerator: (c) => (onChatsTab(c) ? undefined : 'CmdOrCtrl+,'),
    run: (c) => c.host('settings'),
    in: { app: { menu: 'tools' } },
  },

  // ---------- Advanced ----------
  { id: 'remoteAccess', label: 'Remote Acc&ess', group: 'remote', entries: remoteAccessEntries, in: { app: { menu: 'advanced' } } },
  { id: 'remoteControl', label: 'Remote &Control', group: 'remote', entries: remoteControlEntries, in: { app: { menu: 'advanced' } } },
  { id: 'addons', label: '&Addons', group: 'remote', run: (c) => c.host('addons'), in: { app: { menu: 'advanced' } } },
  {
    id: 'restMode',
    label: (c) => (c.rest?.armed ? 'Stop Res&t Mode' : 'Start Res&t Mode'),
    group: 'power',
    // A sleeping computer drops Remote Control's sessions, and a Prevent Sleep timer keeps it awake: Rest Mode waits until both are off.
    enabled: (c) => !!c.rest?.armed || (!c.remoteRunning && String(c.preventSleep?.timer ?? 'off') === 'off'),
    hide: [{ if: (c) => !c.windowsHost, why: 'Only a Windows computer has Rest Mode.' }],
    run: (c) => c.host('rest-toggle'),
    in: { app: { menu: 'advanced' } },
  },
  { id: 'preventSleep', label: 'Prevent &Sleep', group: 'power', entries: preventSleepEntries, in: { app: { menu: 'advanced' } } },
  { id: 'updateModels', label: 'Update &Models…', group: 'maintenance', icon: 'refresh', run: (c) => c.host('update-models'), in: { app: { menu: 'advanced' } } },
  { id: 'engineLog', label: 'Engine &Log', group: 'maintenance', run: (c) => c.host('engine-log'), in: { app: { menu: 'advanced' } } },
  { id: 'openDataDirectory', label: 'Open &Data Directory', group: 'maintenance', run: (c) => c.host('open-data-directory'), in: { app: { menu: 'advanced' } } },
  {
    id: 'reloadUi',
    label: '&Reload UI',
    group: 'maintenance',
    role: 'reload',
    pageKey: (c) => !!c.chats,
    hide: [{ on: ON_PHONE, why: 'A phone reloads Looper’s pages by itself when they lose their connection.' }],
    in: { app: { menu: 'advanced' } },
  },

  // ---------- Window (its windows, panes and chats come with the chats' commands above) ----------
  {
    id: 'openWindows',
    label: 'Open Windows',
    group: 'open-windows',
    provided: 'open-windows',
    hide: [{ on: ['web', 'mobile'], why: 'They’re the computer’s own windows.' }],
    in: { frame: { menu: 'window' } },
  },

  // ---------- Help ----------
  { id: 'instructions', label: '&Instructions', group: 'help', accelerator: (c) => (onChatsTab(c) ? undefined : 'F1'), run: (c) => c.host('instructions'), in: { app: { menu: 'help' } } },
  { id: 'about', label: '&About Looper', group: 'about', run: (c) => c.host('about'), in: { app: { menu: 'help' } } },

  // ---------- an addon's panes tab ----------
  {
    id: 'addonFilter',
    label: '&Filter…',
    group: 'addon-filter',
    accelerator: 'CmdOrCtrl+F',
    checked: (c) => !!c.addon?.search?.query.trim(),
    hide: [
      { on: ON_PHONE, why: 'The list has a search field over its rows.' },
      { if: (c) => !c.addon?.search, why: 'None of the addon’s panes can be searched.' },
    ],
    run: (c) => c.addon?.search?.open(),
    in: { addonPanes: { menu: 'view', context: false } },
  },

  // ---------- an addon's screen ----------
  {
    id: 'addonShowSecrets',
    // Windows keeps a toolbar button's label as it is and shows its state by pressing it.
    label: (c) => `&Show ${c.addon?.screen?.secrets?.label ?? 'Password'}`,
    group: 'addon-secrets',
    icon: 'eye',
    labeled: true,
    checked: (c) => !!c.addon?.screen?.secrets?.shown,
    hide: [
      { on: ON_PHONE, why: 'Each secret has a Show check box beside it.' },
      { if: (c) => !c.addon?.screen?.secrets, why: 'The screen shows no password or other secret.' },
    ],
    run: (c) => c.addon?.screen?.secrets?.toggle(),
    in: { addonScreen: { menu: 'view', toolbar: true, context: false } },
  },

  // ---------- the Engine Log window ----------
  {
    id: 'logSources',
    label: 'Sources',
    group: 'log-sources',
    inline: true,
    entries: (c) => (c.engineLog?.sources ?? []).map((s): Entry => ({ id: s.key, label: s.label, checked: !c.engineLog!.hiddenSources.includes(s.key), run: () => c.engineLog!.toggleSource(s.key) })),
    in: { engineLog: { menu: 'view' } },
  },
  {
    id: 'logLevels',
    label: 'Levels',
    group: 'log-levels',
    inline: true,
    entries: (c) =>
      ([['debug', '&Debug'], ['info', '&Info'], ['warn', '&Warn'], ['error', '&Error']] as const).map(([level, label]): Entry => ({ id: level, label, checked: !c.engineLog?.hiddenLevels.includes(level), run: () => c.engineLog?.toggleLevel(level) })),
    in: { engineLog: { menu: 'view' } },
  },
];
