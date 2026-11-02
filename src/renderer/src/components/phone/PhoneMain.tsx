import { useEffect, useRef, useState } from 'react';
import { addonPaneKey, matchesSearch } from '@shared/addons';
import { ALL_FILTERS, passesFilter } from '@shared/panes';
import { groupProjects } from '@shared/projects';
import { dashboardOrder } from '@shared/sessions';
import type { Project } from '@shared/types';
import { platform } from '../../platform';
import {
  PHONE_TABS,
  followSelection,
  initialPhoneNav,
  popScreen,
  pushScreen,
  rootScreen,
  selectTab,
  selectionOf,
  showTabRoot,
  topScreen,
  type PhoneScreen,
  type PhoneTab,
} from '../../phone-nav';
import { TEXT_LARGER, TEXT_SMALLER } from '../../phone-lists';
import { taskEntries } from '../../task-tree';
import type { MainWindow } from '../../useMainWindow';
import { DEFAULT_SHOWN } from '../../useSessionsWindow';
import type { MoreGroup } from '../../web/more-menu';
import { usePageNav, type PageNavAction } from '../../web/page-nav';
import { AddonPaneList } from '../AddonPane';
import { AddonScreenView, AddonToolbarButtons } from '../AddonScreen';
import { Icon } from '../Icon';
import { ICONS } from '../icons';
import { ProjectDetail } from '../ProjectDetail';
import { DashboardCard } from '../../SessionsApp';
import { SessionList } from '../SessionList';
import { TaskDetail } from '../TaskDetail';
import { showTaskMenu } from '../TaskList';
import { TaskSubText } from '../Live';
import { newToolbarGroups, projectToolbarGroups, taskToolbarGroups } from '../TaskToolbar';
import { PhoneDashboard } from './PhoneDashboard';
import { EmptyRow, Group, LargeTitle, Row, Segmented } from './PhoneList';
import { SplitEmpty, SplitView, useSplit } from './PhoneSplit';
import { useSessionsState } from './useSessionsState';

/** The tab bar's icons, drawn on a 24-point grid as the platforms' own are. */
const TAB_ICONS: Record<PhoneTab, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  projects: <path d="M2.5 18.5v-12a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z" />,
  tasks: (
    <>
      <path d="m3.5 6 1.8 1.8L8.5 4.5M3.5 13l1.8 1.8 3.2-3.3M3.5 20l1.8 1.8" />
      <path d="M11.5 6.5h9M11.5 13.5h9M11.5 20.5h9" />
    </>
  ),
  sessions: (
    <>
      <path d="M2.5 4h12v8.5H7.5l-3.5 3v-3H2.5Z" />
      <path d="M17.5 8h4v8.5h-1.5v3l-3.5-3H10v-1.5" />
    </>
  ),
};

/**
 * The main window on a phone: a bottom tab bar (Dashboard, Projects, Tasks,
 * Chats), each tab a list that pushes its items' screens. What a screen
 * shows is the window's selection, so the menus and notifications act on it
 * as on the desktop.
 */
export function PhoneMain({ m }: { m: MainWindow }) {
  const [nav, setNav] = useState(() => initialPhoneNav());
  const top = topScreen(nav);
  const topKey = JSON.stringify(top);
  // iPad: the tab's list stays in a leading column and what it opens shows beside it.
  const split = useSplit();
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
  const shown = screenFor(m, nav.tab, top, openFolder, openTasks);
  // The main toolbar's commands go to the More menu, except on a task's screen (its own menu) and an addon's (its toolbar).
  const toolbar =
    m.task || m.addonShown
      ? undefined
      : [
          {
            id: 'views',
            items: [
              { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', pressed: !top && nav.tab === 'dashboard', run: () => m.uiAction('show-dashboard') },
              { id: 'chats', label: 'Chats', icon: 'chat', run: () => window.looper.sessions.openWindow() },
            ],
          },
          ...newToolbarGroups({ newTaskProject: m.project, sessionProject: m.sessionProject, onAction: m.uiAction }),
          ...taskToolbarGroups({ task: null, runtime: undefined, onAction: m.uiAction }),
          ...(m.project ? projectToolbarGroups(m.project, m.uiAction) : []),
        ];
  // iPad: the list column shows the tab's own list; its rows replace the detail column's screen.
  const list = split
    ? rootFor(
        listWindow(m, fromList),
        nav.tab,
        '',
        (id) => setNav((n) => rootScreen(n, { kind: 'folder', id })),
        openTasks,
        { current: nav.stacks[nav.tab][0] ?? null },
      )
    : null;
  // With nothing opened, the Chats tab's detail is its Overview (a chat opens in a Chats window of its own).
  const detail: ShownScreen | null = !split || top ? shown : nav.tab === 'sessions' ? { title: 'Overview', actions: [], body: <PhoneSessionsTab m={m} show="overview" /> } : null;
  usePageNav(
    list
      ? {
          title: detail?.title ?? '',
          back,
          // A folder's New Task is the list's own, already in the list column's bar.
          actions: (detail?.actions ?? []).filter((a) => !list.actions.some((l) => l.id === a.id)),
          more: detail?.more,
          toolbar,
          largeTitle: false,
          split: { width: split!.lead, title: list.title, actions: list.actions, largeTitle: true },
          tabs: { items: PHONE_TABS, value: nav.tab, select: (id) => setNav((n) => selectTab(n, id as PhoneTab)) },
        }
      : { title: shown.title, back, actions: shown.actions, more: shown.more, toolbar, ownsBottom: true, largeTitle: platform === 'ios' && !top },
  );

  if (split && list) {
    return (
      <div className={`phone-main phone-page split tab-${nav.tab}${top ? ' pushed' : ''}`}>
        <SplitView split={split} lead={list.body} detail={detail?.body ?? <SplitEmpty>{EMPTY_DETAIL[nav.tab]}</SplitEmpty>} />
      </div>
    );
  }

  return (
    <div className={`phone-main phone-page tab-${nav.tab}${top ? ' pushed' : ''}`}>
      <div className="phone-screen">{shown.body}</div>
      <nav className="phone-tabbar" aria-label="Looper">
        {PHONE_TABS.map(([id, label]) => (
          <button
            key={id}
            className={`phone-tab${nav.tab === id ? ' active' : ''}`}
            aria-current={nav.tab === id ? 'page' : undefined}
            onClick={() => setNav((n) => selectTab(n, id))}
          >
            <span className="phone-tab-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {TAB_ICONS[id]}
              </svg>
            </span>
            <span className="phone-tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
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
      more: TASK_MORE,
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
            hideNoActionRuns={m.view?.hideNoActionRuns ?? false}
            focusRun={m.focusRun}
            terminalRun={m.terminalRun}
            onTerminalRun={m.setTerminalRun}
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
  return rootFor(m, tab, top?.kind === 'folder' ? top.id : '', openFolder, openTasks);
}

/** What the detail column shows before a row is opened (the Chats tab shows its Overview instead). */
const EMPTY_DETAIL: Record<PhoneTab, string> = {
  dashboard: 'No Task Selected',
  projects: 'No Project Selected',
  tasks: 'No Task Selected',
  sessions: '',
};

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
      return {
        title: folder?.name ?? 'Tasks',
        actions: [{ id: 'new-task', label: 'New Task', icon: 'add', run: () => m.uiAction('new-task') }],
        body: <PhoneTasks m={m} container={folder?.id ?? ''} onOpenFolder={openFolder} current={current} />,
      };
    }
    case 'sessions':
      return {
        title: 'Chats',
        actions: [
          { id: 'new-chat', label: 'New Chat', icon: 'newChat', run: () => window.looper.sessions.showNewMenu('chat', 0, 0) },
          { id: 'new-terminal', label: 'New Terminal', icon: 'terminal', run: () => window.looper.sessions.showNewMenu('terminal', 0, 0) },
        ],
        body: <PhoneSessionsTab m={m} show={split ? 'sessions' : undefined} />,
      };
  }
}

/**
 * A task screen's More menu: the Task menu's commands that apply to the task
 * shown (the menu bar follows the selection, which is this task), what can't
 * be done now left out, Delete last in red; and its project's New Chat and New
 * Terminal. Nothing about the menu bar's other menus.
 */
const TASK_MORE: MoreGroup[] = [
  [{ item: 'task-run-now' }, { item: 'task-stop' }, { item: 'task-pause-resume' }, { item: 'task-enable-disable' }, { item: 'task-complete' }],
  [{ item: 'task-edit' }, { item: 'task-edit-agent' }, { item: 'task-note' }, { item: 'task-note-clear' }],
  [{ item: 'task-move-folder' }, { item: 'task-versions' }, { item: 'task-export' }, { item: 'task-clear-runs' }],
  // The Terminal tab's text size (it reports these while it shows; nothing otherwise).
  [{ toolbar: TEXT_SMALLER }, { toolbar: TEXT_LARGER }],
  [{ item: 'project-new-chat' }, { item: 'project-new-terminal' }],
  [{ item: 'task-delete' }],
];

/** A long press on the task's screen: the task's menu, as a right-click on its row. */
function taskMenuAt(e: React.MouseEvent, m: MainWindow) {
  if (!m.task) return;
  // The run log, the terminal and links have menus of their own.
  if ((e.target as HTMLElement).closest('.run-row, .pg-row, .terminal, .terminal-wrap, .terminal-empty, a, input, textarea, select')) return;
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
  const groups = groupProjects(m.projects, m.view?.projectsPane.groupBy ?? 'none', m.info?.settings.environments ?? []);
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
function PhoneTasks({ m, container, onOpenFolder, current = null }: { m: MainWindow; container: string; onOpenFolder: (id: string) => void; current?: string | null }) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const view = m.view;
  if (!view) return <div className="pg-scroll" />;
  const entries = taskEntries(container, {
    tasks: m.tasks,
    folders: m.folders,
    layout: m.layout,
    passes: (t) => passesFilter(t, view.single, ALL_FILTERS),
    showFolders: view.single.showFolders,
    hideEmptyFolders: view.single.hideEmptyFolders,
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
  const toolbars = container !== '' ? [] : m.addons.filter((a) => a.enabled && a.toolbar.length && !view.hiddenAddonToolbars.includes(a.id));
  return (
    <div
      className="pg-scroll"
      // A long press between the rows: the list's menu (New Folder…), at the top level.
      onContextMenu={(e) => {
        if (container !== '' || (e.target as HTMLElement).closest('.pg-row, .pg-group-title, .pg-addon-pane, .pg-addon-toolbar')) return;
        e.preventDefault();
        emptyMenu();
      }}
    >
      {container === '' && <LargeTitle>Tasks</LargeTitle>}
      <Group>
        {entryRows.length === 0 ? (
          <EmptyRow onMenu={container === '' ? emptyMenu : undefined}>{container === '' ? 'No tasks yet.' : 'This folder is empty.'}</EmptyRow>
        ) : (
          entryRows
        )}
      </Group>
      {toolbars.map((a) => (
        <Group key={`tb-${a.id}`} title={a.name}>
          <div className="toolbar pg-addon-toolbar">
            <AddonToolbarButtons
              items={a.toolbar.map((b) => ({ ...b, disabled: a.status !== 'running' }))}
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

type ChatsList = 'sessions' | 'overview';
const CHATS_LISTS: [ChatsList, string][] = [
  ['sessions', 'Chats'],
  ['overview', 'Overview'],
];

/**
 * The Chats tab is the Chats window's list: its Chats and Overview segments
 * here, on the tab. A tapped chat (or an Overview card) opens only its
 * conversation, in a Chats window whose Back closes it and returns here, so the
 * list exists once. `show`: one of the two alone, without the segments (iPad:
 * the chats in the list column, the Overview in the detail column).
 */
function PhoneSessionsTab({ m, show }: { m: MainWindow; show?: ChatsList }) {
  const state = useSessionsState();
  const [picked, setList] = useState<ChatsList>('sessions');
  const list = show ?? picked;
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
      {!show && (
        <div className="pg-segmented-wrap">
          <Segmented items={CHATS_LISTS} value={list} onChange={setList} label="Show" />
        </div>
      )}
      {!state ? null : list === 'sessions' ? (
        <section className="pg-group pg-sessions">
          <SessionList
            sessions={state.sessions}
            selected={null}
            collapsed={shown.collapsed}
            waitingFirst={shown.waitingFirst}
            onToggle={toggleGroup}
            onSelect={open}
            selectOnMenu={false}
          />
        </section>
      ) : state.sessions.length === 0 ? (
        <div className="empty">No chats are open.</div>
      ) : (
        <div className="sessions-overview">
          {dashboardOrder(state.sessions, shown.cardOrder, shown.waitingFirst).map((s) => (
            <DashboardCard key={s.id} s={s} onOpen={open} />
          ))}
        </div>
      )}
    </div>
  );
}
