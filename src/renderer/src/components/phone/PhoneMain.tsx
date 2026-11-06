import { useEffect, useRef, useState } from 'react';
import { addonPaneKey, matchesSearch } from '@shared/addons';
import { siblingOrder, withSiblingsOrdered } from '@shared/folders';
import { mainTabs } from '@shared/main-tabs';
import { ALL_FILTERS, PANES, passesFilter } from '@shared/panes';
import { groupProjects } from '@shared/projects';
import type { MainTabDef } from '@shared/main-tabs';
import type { SessionsState } from '@shared/sessions';
import type { Project } from '@shared/types';
import { platform } from '../../platform';
import {
  followSelection,
  initialPhoneNav,
  phoneTabs,
  popScreen,
  pushScreen,
  rootScreen,
  selectTab,
  selectionOf,
  showTabRoot,
  stackOf,
  topScreen,
  type PhoneScreen,
  type PhoneTab,
} from '../../phone-nav';
import { taskScreenMore } from '../../phone-lists';
import { taskEntries } from '../../task-tree';
import type { MainWindow } from '../../useMainWindow';
import { DEFAULT_SHOWN } from '../../useSessionsWindow';
import type { MoreGroup } from '../../web/more-menu';
import type { PageNavAction } from '../../web/nav-bar-model';
import { NavBar } from '../NavBar';
import { AddonPaneList } from '../AddonPane';
import { AddonScreenView, AddonToolbarButtons } from '../AddonScreen';
import { Icon } from '../Icon';
import { ICONS } from '../icons';
import { ListDetail } from '../ListDetail';
import { ProjectDetail } from '../ProjectDetail';
import { PhoneOverview } from '../../SessionsApp';
import { SessionList } from '../SessionList';
import { TaskDetail } from '../TaskDetail';
import { showTaskMenu } from '../TaskList';
import { TaskSubText } from '../Live';
import { newToolbarGroups, projectToolbarGroups, taskToolbarGroups } from '../TaskToolbar';
import { PhoneDashboard } from './PhoneDashboard';
import { OverviewSwitch, type OverviewChoice } from './OverviewSwitch';
import { ReorderSheet } from './ReorderSheet';
import { EmptyRow, Group, LargeTitle, Row } from './PhoneList';
import { usePageWidth, useSplit } from './PhoneSplit';
import { TabIcon } from './tab-icons';
import { TasksOverview } from './TasksOverview';
import { useSessionsState } from './useSessionsState';

/** What the Tasks tab's Filter shows: everything, or one of the desktop's panes (shared/panes.ts). */
export type TaskKind = 'all' | (typeof PANES)[number]['id'];
const TASK_KINDS: { id: TaskKind; label: string }[] = [{ id: 'all', label: 'All' }, ...PANES.map((p) => ({ id: p.id, label: p.title }))];
const NO_KIND_TEXT: Record<TaskKind, string> = { all: 'No tasks yet.', tasks: 'No tasks yet.', goals: 'No goals yet.', watchers: 'No watchers yet.' };

/**
 * The main window on a phone: a bottom tab bar (Dashboard, Projects, Tasks,
 * Chats, and the addons' tabs), each tab a list that pushes its items' screens.
 * What a screen shows is the window's selection, so the menus and notifications
 * act on it as on the desktop.
 */
export function PhoneMain({ m }: { m: MainWindow }) {
  const [nav, setNav] = useState(() => initialPhoneNav());
  const top = topScreen(nav);
  const topKey = JSON.stringify(top);
  // iPad: the tab's list stays in a leading column and what it opens shows beside it.
  const split = useSplit();
  const width = usePageWidth();
  // The selection about to change came from the list column: its screen replaces the detail column's.
  const fromList = useRef(false);

  // The screen shown is the window's selection: the menus' commands act on it.
  useEffect(() => {
    const sel = selectionOf(top);
    if (sel.task) m.select(sel.task);
    else if (sel.project) m.selectProject(sel.project);
    else m.selectAddon(sel.addon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKey]);

  // A selection made elsewhere (a row tapped, a notification, an addon) pushes its screen.
  const addonKey = JSON.stringify(m.addonSel);
  useEffect(() => {
    const replace = fromList.current;
    fromList.current = false;
    setNav((n) => followSelection(n, { task: m.selected, project: m.projectSel, addon: m.addonSel }, replace));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.selected, m.projectSel, addonKey]);

  // View → Dashboard.
  useEffect(() => {
    if (m.dashboardShown) setNav((n) => showTabRoot(n, 'dashboard'));
  }, [m.dashboardShown]);

  // A folder that was deleted (or never existed) takes its screen away.
  const folderGone = top?.kind === 'folder' && m.loaded && !m.folders.some((f) => f.id === top.id);
  useEffect(() => {
    if (folderGone) setNav(popScreen);
  }, [folderGone]);

  const back = top ? () => setNav(popScreen) : undefined;
  const openFolder = (id: string) => setNav((n) => pushScreen(n, { kind: 'folder', id }));
  const openTasks = () => setNav((n) => selectTab(n, 'tasks'));
  // The Tasks tab's switch: its list goes away while a task it opened shows, and the choice comes back with it.
  const [tasksShow, setTasksShow] = useState<OverviewChoice>('list');
  const [taskKind, setTaskKind] = useState<TaskKind>('all');
  const tasksSwitch = { value: tasksShow, onChange: setTasksShow, kind: taskKind, onKind: setTaskKind };
  // The Chats tab's switch, and the bar's Reorder of its Overview's cards.
  const [chatsShow, setChatsShow] = useState<OverviewChoice>('list');
  const [reorderingCards, setReorderingCards] = useState(false);
  const sessions = useSessionsState();
  const chatsTab: ChatsTab = { sessions, show: chatsShow, onShow: setChatsShow, reordering: reorderingCards, onReordered: () => setReorderingCards(false) };
  const addonTabs = mainTabs(m.addons).filter((t) => t.addon);
  const tabs = phoneTabs(addonTabs.map((t) => [t.id as PhoneTab, t.label] as const), platform === 'android' ? 'android' : 'ios', width, !!split);
  const openTab = (id: PhoneTab) => setNav((n) => selectTab(n, id));
  // An addon's tab goes when its addon stops, and More when everything fits (an iPad turned to landscape).
  const tabGone = (nav.tab.startsWith('addon/') && m.addonsLoaded && !addonTabs.some((t) => t.id === nav.tab)) || (nav.tab === 'more' && tabs.more.length === 0);
  useEffect(() => {
    if (tabGone) setNav((n) => selectTab(n, 'dashboard'));
  }, [tabGone]);
  const allTabs: AllTabs = { addons: addonTabs, more: tabs.more, open: openTab };
  const shown = screenFor(m, nav.tab, top, openFolder, openTasks, tasksSwitch, chatsTab, allTabs);
  // The list shown, in the sheet that moves its rows: a screen of a folder or a tab's own, not an item's.
  const [reordering, setReordering] = useState(false);
  const reorderable = m.task || m.project || m.addonShown ? null : reorderSheet(m, nav.tab, top?.kind === 'folder' ? top.id : '');
  // The Overview's cards, where it shows: beside the list on a tablet, or chosen with the switch.
  const cardsReorderable = nav.tab === 'sessions' && !top && (sessions?.sessions.length ?? 0) > 1 && (!!split || chatsShow === 'overview');
  // The main toolbar's commands go to the More menu, except on a task's screen (its own menu) and an addon's (its toolbar).
  const toolbar =
    m.task || m.addonShown
      ? undefined
      : [
          {
            id: 'views',
            items: [
              { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', pressed: !top && nav.tab === 'dashboard', run: () => m.uiAction('show-dashboard') },
              { id: 'chats', label: 'Chats', icon: 'chatsTab', run: () => window.looper.sessions.openWindow() },
              { id: 'history', label: 'History', icon: 'history', run: () => window.looper.history.open() },
            ],
          },
          ...(reorderable ? [{ id: 'list', items: [{ id: 'reorder', label: 'Reorder', run: () => setReordering(true) }] }] : []),
          ...(cardsReorderable ? [{ id: 'cards', items: [{ id: 'reorder-cards', label: 'Reorder', run: () => setReorderingCards(true) }] }] : []),
          ...newToolbarGroups({ newTaskProject: m.project, sessionProject: m.sessionProject, onAction: m.uiAction }),
          ...taskToolbarGroups({ task: null, runtime: undefined, onAction: m.uiAction }),
          ...(m.project ? projectToolbarGroups(m.project, m.uiAction) : []),
        ];
  // A tablet: the list column shows the tab's own list; its rows replace the detail column's screen. The Dashboard, More and an addon's tab fill the width.
  const list = split && (nav.tab === 'projects' || nav.tab === 'tasks' || nav.tab === 'sessions')
    ? rootFor(
        listWindow(m, fromList),
        nav.tab,
        '',
        (id) => setNav((n) => rootScreen(n, { kind: 'folder', id })),
        openTasks,
        tasksSwitch,
        chatsTab,
        allTabs,
        { current: stackOf(nav)[0] ?? null },
      )
    : null;
  // With nothing opened, the detail column of the Chats and Tasks tabs is their Overview (a chat opens in a Chats window of its own).
  const overview = nav.tab === 'sessions' ? <PhoneSessionsTab m={m} tab={chatsTab} show="overview" /> : nav.tab === 'tasks' ? <div className="pg-scroll phone-sessions"><TasksOverview m={m} /></div> : null;
  const detail: ShownScreen | null = !split || top ? shown : overview ? { title: 'Overview', actions: [], body: overview } : null;
  const select = (id: string) => openTab(id as PhoneTab);
  const addonIcon = (id: string) => addonTabs.find((t) => t.id === id)?.icon;
  const currentTab = tabs.more.some(([id]) => id === nav.tab) ? 'more' : nav.tab;
  const topTabs = tabs.form === 'top' ? { items: tabs.shown, value: currentTab, select } : undefined;
  const navigation = tabs.menu ? { items: tabs.menu.map(([id, label]) => [id, label, addonIcon(id)] as const), value: nav.tab, select } : undefined;
  const bar = (
    <NavBar
      navigation={navigation}
      {...(list
      ? {
          title: detail?.title ?? '',
          back,
          // A folder's New Task is the list's own, already in the list column's bar.
          actions: (detail?.actions ?? []).filter((a) => !list.actions.some((l) => l.id === a.id)),
          more: detail?.more,
          toolbar,
          largeTitle: false,
          split: { width: split!.lead, title: list.title, actions: list.actions, largeTitle: platform === 'ios' },
          tabs: topTabs,
        }
      : { title: shown.title, back, actions: shown.actions, more: shown.more, toolbar, ownsBottom: tabs.form === 'bar', largeTitle: platform === 'ios' && !top, tabs: topTabs })}
    />
  );

  const tabButtons = tabs.shown.map(([id, label]) => (
    <button
      key={id}
      className={`phone-tab${currentTab === id ? ' active' : ''}`}
      aria-current={currentTab === id ? 'page' : undefined}
      onClick={() => openTab(id)}
    >
      <span className="phone-tab-icon">
        <TabIcon id={id} addonIcon={addonIcon(id)} />
      </span>
      <span className="phone-tab-label">{label}</span>
    </button>
  ));
  const sheets = reordering && reorderable && <ReorderSheet {...reorderable} onClose={() => setReordering(false)} />;
  const tabClass = `tab-${nav.tab.startsWith('addon/') ? 'addon' : nav.tab}${top ? ' pushed' : ''}`;

  if (split || tabs.form === 'rail') {
    return (
      <div className={`phone-main phone-page${split ? ' split' : ''} ${tabClass}`}>
        {bar}
        <div className="phone-main-row">
          {tabs.form === 'rail' && (
            <nav className="phone-tabbar rail" aria-label="Looper">
              {tabButtons}
            </nav>
          )}
          {list ? (
            <ListDetail split={split!} list={list.body} open={!!detail} detail={detail?.body} empty={EMPTY_DETAIL[nav.tab]} />
          ) : (
            <div className="phone-screen">{shown.body}</div>
          )}
        </div>
        {sheets}
      </div>
    );
  }

  return (
    <div className={`phone-main phone-page ${tabClass}`}>
      {bar}
      <div className="phone-screen">{shown.body}</div>
      {sheets}
      {tabs.form === 'bar' && (
        <nav className="phone-tabbar" aria-label="Looper">
          {tabButtons}
        </nav>
      )}
    </div>
  );
}

const failed = (e: unknown) => void window.looper.showError((e as Error).message);

/** What a tab's Reorder moves and how it saves, through the same calls as the desktop's drags; null: nothing to order there. */
function reorderSheet(m: MainWindow, tab: PhoneTab, folderId: string): Omit<React.ComponentProps<typeof ReorderSheet>, 'onClose'> | null {
  const view = m.view;
  if (tab === 'tasks' && view) {
    const entries = taskEntries(folderId, { tasks: m.tasks, folders: m.folders, layout: m.layout, passes: (t) => passesFilter(t, view.single, ALL_FILTERS), showFolders: view.single.showFolders, hideEmptyFolders: view.single.hideEmptyFolders });
    if (entries.length < 2) return null;
    return {
      title: 'Reorder Tasks',
      sections: [{ key: folderId, items: entries.map((e) => (e.kind === 'folder' ? { key: `folder:${e.folder.id}`, title: e.folder.name } : { key: e.task.id, title: e.task.name })) }],
      onReorder: (container, keys) => {
        const nextLayout = withSiblingsOrdered(siblingOrder(m.tasks, m.folders, m.layout), container, keys);
        void window.looper.tasks.reorder(m.tasks.map((t) => t.id), undefined, nextLayout).catch(failed);
      },
    };
  }
  // Grouped by folder or harness the groups have their own order: only the user's own folders can be arranged.
  if (tab === 'projects' && (view?.projectsPane.groupBy ?? 'none') === 'none' && m.projects.length > 1) {
    const groups = groupProjects(m.projects, 'none', m.info?.settings.environments ?? [], m.projectFolders).filter((g) => g.projects.length > 1);
    if (groups.length === 0) return null;
    return {
      title: 'Reorder Projects',
      sections: groups.map((g) => ({ key: g.folderId ?? '', title: g.title || undefined, items: g.projects.map((p) => ({ key: p.id, title: p.name })) })),
      onReorder: (container, keys) => {
        const nextLayout = withSiblingsOrdered(siblingOrder(m.projects, m.projectFolders, m.projectLayout), container, keys);
        void window.looper.projects.reorder(m.projects.map((p) => p.id), undefined, nextLayout).catch(failed);
      },
    };
  }
  return null;
}

/** A screen: its bar's title, actions and More menu, and its content. */
interface ShownScreen {
  title: string;
  actions: PageNavAction[];
  more?: MoreGroup[];
  body: React.ReactNode;
}

/** The current screen: the selected item's, or the tab's list. */
function screenFor(
  m: MainWindow,
  tab: PhoneTab,
  top: PhoneScreen | null,
  openFolder: (id: string) => void,
  openTasks: () => void,
  tasksSwitch: TasksSwitch,
  chatsTab: ChatsTab,
  allTabs: AllTabs,
): ShownScreen {
  const { task, project, addonShown, runtimes } = m;
  if (task) {
    const rt = runtimes[task.id];
    const state = rt?.state;
    const active = state === 'running' || state === 'checking' || state === 'classifying';
    const canRunNow = !active || (rt?.runs.length ?? 0) < (task.maxConcurrentRuns ?? 1);
    return {
      title: task.name,
      // Two buttons fit beside a title: Run Now, or Stop once no more runs can start. The rest is in the menus.
      actions: [
        active && !canRunNow
          ? { id: 'stop', label: 'Stop Task', icon: 'stop', run: () => m.uiAction('stop-task') }
          : { id: 'run', label: 'Run Now', icon: 'run', run: () => m.uiAction('run-now') },
        { id: 'edit', label: 'Edit Task', icon: 'edit', run: () => m.uiAction('edit-task') },
      ],
      more: TASK_SCREEN_MORE,
      body: (
        <div className="phone-detail" onContextMenu={(e) => taskMenuAt(e, m)}>
          <TaskDetail
            key={task.id}
            task={task}
            project={m.projects.find((p) => p.id === task.projectId)}
            environments={m.info?.settings.environments ?? []}
            runtime={rt}
            records={m.records[task.id] ?? []}
            tab={m.tab}
            onTab={m.setTab}
            runFilter={m.view?.runFilter}
            focusRun={m.focusRun}
          />
        </div>
      ),
    };
  }
  if (project) {
    return {
      title: project.name,
      actions: [
        // New Terminal, New Task and the rest: the project's menu (a long press on the screen).
        { id: 'new-chat', label: 'New Chat', icon: 'newChat', run: () => void window.looper.projects.newChat(project.id) },
        { id: 'edit-project', label: 'Edit Project', icon: 'edit', run: () => void window.looper.projects.openEditor(project.id) },
      ],
      body: (
        <div
          className="phone-detail"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.pg-row, .run-row, .git-file, .git-commit')) return;
            e.preventDefault();
            window.looper.projects.showContextMenu(project.id);
          }}
        >
          <ProjectDetail
            key={project.id}
            project={project}
            tasks={m.tasks}
            runtimes={runtimes}
            environments={m.info?.settings.environments ?? []}
            remote={m.remote}
            onSelectTask={m.select}
          />
        </div>
      ),
    };
  }
  if (addonShown) {
    return {
      title: addonShown.item.label,
      actions: [],
      body: <PhoneAddonScreen m={m} />,
    };
  }
  return rootFor(m, tab, top?.kind === 'folder' ? top.id : '', openFolder, openTasks, tasksSwitch, chatsTab, allTabs);
}

/** What the detail column shows before a row is opened (the Chats and Tasks tabs show their Overview instead). */
const EMPTY_DETAIL: Partial<Record<PhoneTab, string>> = {
  projects: 'No Project Selected',
};

interface TasksSwitch {
  value: OverviewChoice;
  onChange: (v: OverviewChoice) => void;
  kind: TaskKind;
  onKind: (k: TaskKind) => void;
}

interface ChatsTab {
  sessions: SessionsState | null;
  show: OverviewChoice;
  onShow: (v: OverviewChoice) => void;
  reordering: boolean;
  onReordered: () => void;
}

interface AllTabs {
  addons: MainTabDef[];
  /** The addon tabs that don't fit in the bar, listed on the More tab. */
  more: readonly (readonly [PhoneTab, string])[];
  open: (id: PhoneTab) => void;
}

/**
 * The iPad list column's window: a row it opens (a task, a project, an addon
 * item, a Dashboard row) marks the selection as the list's, so it replaces the
 * detail column's screen rather than going over it.
 */
function listWindow(m: MainWindow, fromList: React.RefObject<boolean>): MainWindow {
  const mark = () => {
    fromList.current = true;
    // A row whose screen already shows changes nothing, and no selection effect clears the mark.
    setTimeout(() => (fromList.current = false), 0);
  };
  return {
    ...m,
    select: (id) => (mark(), m.select(id)),
    selectProject: (id) => (mark(), m.selectProject(id)),
    selectAddon: (sel) => (mark(), m.selectAddon(sel)),
    openFromDashboard: (taskId, view) => (mark(), m.openFromDashboard(taskId, view)),
  };
}

/**
 * A tab's own list (a folder's contents on the Tasks tab). `split`: it's the
 * list column of an iPad's split view, `current` the screen its detail column
 * starts from (that row shows selected); the Chats tab shows its chats alone,
 * the Overview going to the detail column.
 */
function rootFor(
  m: MainWindow,
  tab: PhoneTab,
  folderId: string,
  openFolder: (id: string) => void,
  openTasks: () => void,
  tasksSwitch: TasksSwitch,
  chatsTab: ChatsTab,
  allTabs: AllTabs,
  split?: { current: PhoneScreen | null },
): ShownScreen {
  const current = split?.current && split.current.kind !== 'addon' ? split.current.id : null;
  switch (tab) {
    case 'dashboard':
      return { title: 'Dashboard', actions: [], body: <PhoneDashboard m={m} onOpenTasks={openTasks} /> };
    case 'projects':
      return {
        title: 'Projects',
        actions: [{ id: 'new-project', label: 'New Project', icon: 'add', run: () => void window.looper.projects.openEditor() }],
        body: <PhoneProjects m={m} current={current} />,
      };
    case 'tasks': {
      // A folder's screen shows what the folder holds, as the tab shows the top level.
      const folder = folderId ? m.folders.find((f) => f.id === folderId) : undefined;
      const listShows = !!split || !!folder || tasksSwitch.value === 'list';
      return {
        title: folder?.name ?? 'Tasks',
        actions: [
          ...(listShows
            ? [
                {
                  id: 'filter',
                  label: 'Filter',
                  icon: 'filter',
                  on: tasksSwitch.kind !== 'all',
                  run: () => undefined,
                  menu: TASK_KINDS.map((k) => ({ id: k.id, label: k.label, checked: tasksSwitch.kind === k.id, run: () => tasksSwitch.onKind(k.id) })),
                },
              ]
            : []),
          { id: 'new-task', label: 'New Task', icon: 'add', run: () => m.uiAction('new-task') },
        ],
        body: <PhoneTasks m={m} container={folder?.id ?? ''} onOpenFolder={openFolder} current={current} show={split ? 'list' : undefined} tasksSwitch={tasksSwitch} />,
      };
    }
    case 'sessions':
      return {
        title: 'Chats',
        actions: [
          { id: 'new-chat', label: 'New Chat', icon: 'newChat', run: () => window.looper.sessions.showNewMenu('chat', 0, 0) },
          { id: 'new-terminal', label: 'New Terminal', icon: 'terminal', run: () => window.looper.sessions.showNewMenu('terminal', 0, 0) },
        ],
        body: <PhoneSessionsTab m={m} tab={chatsTab} show={split ? 'list' : undefined} />,
      };
    case 'more':
      return {
        title: 'More',
        actions: [],
        body: (
          <div className="pg-scroll">
            <LargeTitle>More</LargeTitle>
            <Group>
              {allTabs.more.map(([id, label]) => (
                <Row key={id} title={label} chevron onOpen={() => allTabs.open(id)} />
              ))}
            </Group>
          </div>
        ),
      };
    default: {
      const def = allTabs.addons.find((t) => t.id === tab);
      if (!def?.addon) return { title: '', actions: [], body: <div className="pg-scroll" /> };
      const { addon } = def;
      return {
        title: def.label,
        actions: [],
        body: (
          <div className="phone-detail">
            <AddonScreenView key={def.id} addonId={addon.id} addonName={addon.name} view={addon.tab.view} params={addon.tab.params ?? {}} mode="main" toolbarHidden={!!m.view?.hiddenAddonToolbars.includes(addon.id)} />
          </div>
        ),
      };
    }
  }
}

/**
 * A task screen's More menu: the Task menu's commands that apply to the task
 * shown (the menu bar follows the selection, which is this task), what can't
 * be done now left out, Delete last in red; and its project's New Chat and New
 * Terminal (phone-lists.ts taskScreenMore, from the command catalogs).
 */
const TASK_SCREEN_MORE = taskScreenMore();

/** A long press on the task's screen: the task's menu, as a right-click on its row. */
function taskMenuAt(e: React.MouseEvent, m: MainWindow) {
  if (!m.task) return;
  // The run log and links have menus of their own.
  if ((e.target as HTMLElement).closest('.run-row, .pg-row, a, input, textarea, select')) return;
  e.preventDefault();
  window.looper.showTaskContextMenu({
    enabled: m.task.enabled,
    completed: !!m.task.completedAt,
    allowComplete: m.task.completion.allowed,
    state: m.runtimes[m.task.id]?.state,
    held: !!m.runtimes[m.task.id]?.held,
    hasNote: !!m.task.note,
    activeRuns: m.runtimes[m.task.id]?.runs.length ?? 0,
    maxRuns: m.task.maxConcurrentRuns,
  });
}

function PhoneProjects({ m, current = null }: { m: MainWindow; current?: string | null }) {
  const projectsMenu = () => window.looper.projects.showContextMenu('');
  // The user's folders show as groups too, those with projects in them.
  const groups = groupProjects(m.projects, m.view?.projectsPane.groupBy ?? 'none', m.info?.settings.environments ?? [], m.projectFolders).filter(
    (g) => g.projects.length > 0,
  );
  const rows = (list: Project[]) =>
    list.map((p) => (
      <Row
        key={p.id}
        title={p.name}
        sub={<span className="mono">{p.cwd}</span>}
        chevron
        selected={p.id === current}
        onOpen={() => m.selectProject(p.id)}
        onMenu={() => {
          m.selectProject(p.id);
          window.looper.projects.showContextMenu(p.id);
        }}
      />
    ));
  return (
    <div className="pg-scroll">
      <LargeTitle>Projects</LargeTitle>
      {m.projects.length === 0 ? (
        <Group onTitleMenu={projectsMenu}>
          <EmptyRow onMenu={projectsMenu}>No projects yet.</EmptyRow>
        </Group>
      ) : (
        groups.map((g) => (
          <Group key={g.key} title={g.title || undefined} onTitleMenu={projectsMenu}>
            {rows(g.projects)}
          </Group>
        ))
      )}
    </div>
  );
}

/** A folder row's symbol. */
const FOLDER_ICON = (
  <span className="pg-folder-icon">
    <Icon>{ICONS.folder}</Icon>
  </span>
);

/**
 * The Tasks tab: a container's folders (a row with the folder's symbol, the
 * count of tasks inside and a chevron, which opens the folder's own screen) and
 * tasks, as iOS lists a hierarchy: one level a screen, no outline. At the top
 * level the addons' panes and buttons follow, as the sidebar stacks them.
 */
function PhoneTasks({
  m,
  container,
  onOpenFolder,
  current = null,
  show,
  tasksSwitch,
}: {
  m: MainWindow;
  container: string;
  onOpenFolder: (id: string) => void;
  current?: string | null;
  show?: OverviewChoice;
  tasksSwitch: TasksSwitch;
}) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const view = m.view;
  if (!view) return <div className="pg-scroll" />;
  const pane = PANES.find((p) => p.id === tasksSwitch.kind);
  const entries = taskEntries(container, {
    tasks: m.tasks,
    folders: m.folders,
    layout: m.layout,
    passes: (t) => passesFilter(t, view.single, ALL_FILTERS) && (!pane || pane.member(t)),
    showFolders: view.single.showFolders,
    // A filter's folders are the ones with something it shows.
    hideEmptyFolders: view.single.hideEmptyFolders || !!pane,
  });
  const emptyMenu = () => window.looper.showTasksEmptyContextMenu();
  const entryRows = entries.map((e) => {
    if (e.kind === 'folder') {
      return (
        <Row
          key={`folder-${e.folder.id}`}
          lead={FOLDER_ICON}
          title={e.folder.name}
          value={e.count}
          chevron
          selected={e.folder.id === current}
          onOpen={() => onOpenFolder(e.folder.id)}
          onMenu={() => window.looper.showFolderContextMenu({ folderId: e.folder.id })}
        />
      );
    }
    const t = e.task;
    const rt = m.runtimes[t.id];
    return (
      <Row
        key={t.id}
        title={t.name}
        sub={<TaskSubText task={t} runtime={rt} />}
        tone={rt?.held || rt?.asking ? 'warning' : t.enabled ? undefined : 'muted'}
        chevron
        selected={t.id === current}
        onOpen={() => m.select(t.id)}
        // The press must not open the task: its menu acts on this row's task, not the selected one.
        onMenu={() => {
          m.setMenuTarget(t.id);
          showTaskMenu(t, rt);
        }}
      />
    );
  });
  const panes = container !== '' ? [] : m.addons
    .filter((a) => a.enabled)
    .flatMap((a) =>
      a.panes
        .filter((p) => (view.addonPanes[addonPaneKey(a.id, p.id)] ?? { visible: true }).visible)
        .map((p) => ({ addon: a, pane: p, key: addonPaneKey(a.id, p.id) })),
    );
  const onTasks = (b: { view?: string }) => !b.view || b.view === 'tasks';
  const toolbars = container !== '' ? [] : m.addons.filter((a) => a.enabled && a.toolbar.some(onTasks) && !view.hiddenAddonToolbars.includes(a.id));
  const listBody = (
    <>
      <Group>
        {entryRows.length === 0 ? (
          <EmptyRow onMenu={container === '' ? emptyMenu : undefined}>{container === '' ? NO_KIND_TEXT[tasksSwitch.kind] : 'This folder is empty.'}</EmptyRow>
        ) : (
          entryRows
        )}
      </Group>
      {toolbars.map((a) => (
        <Group key={`tb-${a.id}`} title={a.name}>
          <div className="toolbar pg-addon-toolbar">
            <AddonToolbarButtons
              items={a.toolbar.filter(onTasks).map((b) => ({ ...b, disabled: a.status !== 'running' }))}
              onClick={(id) => {
                const b = a.toolbar.find((x) => x.id === id);
                if (b?.tool) void window.looper.addons.openTool(a.id, b.tool);
                else void window.looper.addons.event(a.id, { source: { toolbar: 'main' }, kind: 'click', id });
              }}
            />
          </div>
        </Group>
      ))}
      {panes.map(({ addon, pane, key }) => {
        const state = m.addonPanes[key];
        const items = state?.status === 'ready' ? state.content.items : [];
        const query = queries[key] ?? '';
        return (
          <Group
            key={key}
            title={`${pane.title}${addon.status === 'running' && state?.status === 'ready' ? ` (${query.trim() ? `${items.filter((it) => matchesSearch(it, query)).length} of ${items.length}` : items.length})` : ''}`}
            onTitleMenu={() => window.looper.addons.showMenu(addon.id, pane.id, state?.status === 'ready' ? (state.content.menu ?? []) : [], { header: true })}
          >
            <div className="pg-addon-pane">
              <AddonPaneList
                addon={addon}
                pane={pane.id}
                state={state}
                selected={m.addonSel?.addonId === addon.id && m.addonSel.pane === pane.id ? m.addonSel.item : null}
                compact={false}
                query={query}
                onQuery={(q) => setQueries((s) => ({ ...s, [key]: q }))}
                onSelect={(item) => m.selectAddon({ addonId: addon.id, pane: pane.id, item: item.id })}
                onRetry={() => m.reloadAddon(addon.id)}
              />
            </div>
          </Group>
        );
      })}
    </>
  );
  return (
    <div
      className="pg-scroll"
      // A long press between the rows: the list's menu (New Folder…), at the top level.
      onContextMenu={(e) => {
        if (container !== '' || (e.target as HTMLElement).closest('.pg-row, .pg-group-title, .pg-addon-pane, .pg-addon-toolbar, .pg-segmented, .pg-overview')) return;
        e.preventDefault();
        emptyMenu();
      }}
    >
      {container === '' && <LargeTitle>Tasks</LargeTitle>}
      {container === '' ? (
        <OverviewSwitch listLabel="Tasks" show={show} {...tasksSwitch} list={listBody} overview={<TasksOverview m={m} />} />
      ) : (
        listBody
      )}
    </div>
  );
}

/** An addon item's screen; its toolbar buttons go in a row above it. */
function PhoneAddonScreen({ m }: { m: MainWindow }) {
  const shown = m.addonShown!;
  return (
    <div className="phone-detail">
      <AddonScreenView
        key={`${shown.addon.id}/${shown.item.view}/${JSON.stringify(shown.item.params ?? {})}`}
        addonId={shown.addon.id}
        addonName={shown.addon.name}
        view={shown.item.view}
        params={shown.item.params ?? {}}
        mode="main"
        toolbarHidden={!!m.view?.hiddenAddonToolbars.includes(shown.addon.id)}
      />
    </div>
  );
}

/**
 * The Chats tab is the Chats window's list: its Chats and Overview segments
 * here, on the tab. A tapped chat (or an Overview card) opens only its
 * conversation, in a Chats window whose Back closes it and returns here, so the
 * list exists once. `show`: one of the two alone, without the segments (iPad:
 * the chats in the list column, the Overview in the detail column).
 */
function PhoneSessionsTab({ m, tab, show }: { m: MainWindow; tab: ChatsTab; show?: OverviewChoice }) {
  const state = tab.sessions;
  const view = m.view;
  const shown = view?.sessions ?? DEFAULT_SHOWN;
  const toggleGroup = (key: string) => {
    if (!view) return;
    const collapsed = shown.collapsed.includes(key) ? shown.collapsed.filter((k) => k !== key) : [...shown.collapsed, key];
    m.changeView({ sessions: { ...shown, collapsed } });
  };
  const open = (id: string | null) => {
    if (id) window.looper.sessions.openWindow(id);
  };
  return (
    <div className="pg-scroll phone-sessions">
      {show !== 'overview' && <LargeTitle>Chats</LargeTitle>}
      <OverviewSwitch
        listLabel="Chats"
        show={show}
        value={tab.show}
        onChange={tab.onShow}
        list={
          state && (
            <section className="pg-group pg-sessions">
              <SessionList
                sessions={state.sessions}
                selected={null}
                collapsed={shown.collapsed}
                waitingFirst={shown.waitingFirst}
                onToggle={toggleGroup}
                onSelect={open}
              />
            </section>
          )
        }
        overview={
          state && <PhoneOverview sessions={state.sessions} shown={shown} setShown={(patch) => m.changeView({ sessions: { ...shown, ...patch } })} onOpen={open} reordering={tab.reordering} onReordered={tab.onReordered} />
        }
      />
    </div>
  );
}
