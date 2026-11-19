import { useEffect, useRef, useState } from 'react';
import { addonPaneKey } from '@shared/addons';
import { addonCommandId } from '@shared/commands/addon-commands';
import { commandSpec, moreViewCommands, runCommand } from '@shared/commands/build';
import { plainLabel, type Command } from '@shared/commands/command';
import type { CommandContext } from '@shared/commands/context';
import { siblingOrder, withSiblingsOrdered } from '@shared/folders';
import { mainTabs } from '@shared/main-tabs';
import { ALL_FILTERS, passesFilter } from '@shared/panes';
import type { MainTabDef } from '@shared/main-tabs';
import type { SessionsState } from '@shared/sessions';
import type { View } from '@shared/types';
import { platform } from '../../platform';
import {
  PHONE_TABS,
  followSelection,
  initialPhoneNav,
  keptNav,
  popScreen,
  pruneNav,
  pushScreen,
  rootScreen,
  selectTab,
  selectionOf,
  showTabRoot,
  stackOf,
  topScreen,
  type PhoneNav,
  type PhoneScreen,
  type PhoneTab,
} from '../../phone-nav';
import { taskEntries } from '../../task-tree';
import type { MainWindow } from '../../useMainWindow';
import { DEFAULT_SHOWN } from '../../useSessionsWindow';
import type { MoreMenuInput } from '../../web/more-menu';
import type { PageNavAction } from '../../web/nav-bar-model';
import { NavBar } from '../NavBar';
import { AddonPaneList, AddonSearchBox, addonSearch, showPaneItemMenu, showPaneMenu, shownItems } from '../AddonPane';
import { AddonScreenView, type AddonScreenReport } from '../AddonScreen';
import { phoneNav, popupCommands } from '../command-surfaces';
import { setRowMenuContext, showProjectMenu, showTaskMenu } from '../row-menus';
import { ProjectCollection, projectEntries } from '../ProjectCollection';
import { useCommandMenu, useCommandState } from '../useCommands';
import { ListDetail } from '../ListDetail';
import { ProjectDetail } from '../ProjectDetail';
import { PhoneOverview } from '../../SessionsApp';
import { SessionList } from '../SessionList';
import { TaskDetail } from '../TaskDetail';
import { PhoneDashboard } from './PhoneDashboard';
import { OverviewSwitch, type OverviewChoice } from './OverviewSwitch';
import type { TasksSwitch } from '../TaskCollection';
import { ReorderSheet } from './ReorderSheet';
import { Group, LargeTitle, Row } from './PhoneList';
import { usePageWidth, useSplit } from './PhoneSplit';
import { TaskCollection } from '../TaskCollection';
import { ViewTabs, phoneViewTabsForm, type ViewTab } from '../ViewTabs';
import { TasksOverview } from './TasksOverview';
import { useSessionsState } from '../../live-state';
import { reportError } from '../../report-error';

const KEPT_NAV_KEY = 'looper.phone-nav';

/** The views the tabs switch between: Looper's own and More, which lists the addons' tabs. */
const VIEW_TABS: readonly ViewTab[] = PHONE_TABS.map(([id, label]) => ({ id, label }));

function readKeptNav(): PhoneNav | null {
  try {
    return keptNav(JSON.parse(localStorage.getItem(KEPT_NAV_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

/**
 * The main window on a phone: a bottom tab bar (Dashboard, Projects, Tasks,
 * Chats and More), each tab a list that pushes its items' screens. What a
 * screen shows is the window's selection, so its commands act on it. The More
 * view has the addons, then every menu item no screen has.
 */
export function PhoneMain({ m }: { m: MainWindow }) {
  const commandState = useCommandState();
  // The tab and its screens come back where they were when the page loads again (a phone back from another app, the
  // app relaunched): the tab at once, so Back from a conversation shows the list it came from, and the screens once
  // the window has loaded, without any whose item is gone.
  const [kept] = useState(readKeptNav);
  const [nav, setNav] = useState(() => initialPhoneNav(kept?.tab));
  const restored = useRef(!kept);
  useEffect(() => {
    if (restored.current || !m.loaded || !m.addonsLoaded) return;
    restored.current = true;
    const exists = (s: PhoneScreen) =>
      s.kind === 'task' ? m.tasks.some((t) => t.id === s.id)
      : s.kind === 'project' ? m.projects.some((p) => p.id === s.id)
      : s.kind === 'folder' ? m.folders.some((f) => f.id === s.id) || m.projectFolders.some((f) => f.id === s.id)
      : s.kind === 'addon' ? m.addons.some((a) => a.id === s.addonId)
      : true;
    // Not over what the reader already opened since the page loaded.
    setNav((n) => (n.tab === kept!.tab && !Object.values(n.stacks).some((s) => s?.length) ? pruneNav(kept!, exists) : n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.loaded, m.addonsLoaded]);
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(KEPT_NAV_KEY, JSON.stringify(nav));
    } catch {
      // Storage full or off: the next load starts on the Dashboard.
    }
  }, [nav]);
  const top = topScreen(nav);
  const topKey = JSON.stringify(top);
  // A screen pushed onto the tab or popped off it slides in (phone.css, web/motion.ts); a tab's own screen doesn't.
  const depth = nav.stacks[nav.tab]?.length ?? 0;
  const screenKey = `${nav.tab}:${depth}`;
  const lastScreen = useRef({ key: screenKey, tab: nav.tab, depth, enter: '' });
  if (lastScreen.current.key !== screenKey) {
    const was = lastScreen.current;
    const enter = was.tab !== nav.tab ? '' : depth > was.depth ? ' enter-push' : ' enter-pop';
    lastScreen.current = { key: screenKey, tab: nav.tab, depth, enter };
  }
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

  // Window → Dashboard.
  useEffect(() => {
    if (m.dashboardShown) setNav((n) => showTabRoot(n, 'dashboard'));
  }, [m.dashboardShown]);

  // A folder that was deleted (or never existed) takes its screen away.
  const folderGone = top?.kind === 'folder' && m.loaded && !(nav.tab === 'projects' ? m.projectFolders : m.folders).some((f) => f.id === top.id);
  useEffect(() => {
    if (folderGone) setNav(popScreen);
  }, [folderGone]);

  const back = top ? () => setNav(popScreen) : nav.tab.startsWith('addon/') ? () => setNav((n) => selectTab(n, 'more')) : undefined;
  const openFolder = (id: string) => setNav((n) => pushScreen(n, { kind: 'folder', id }));
  const openTasks = () => setNav((n) => selectTab(n, 'tasks'));
  // The Tasks tab's switch: its list goes away while a task it opened shows, and the choice comes back with it.
  const [tasksShow, setTasksShow] = useState<OverviewChoice>('list');
  const tasksSwitch = { value: tasksShow, onChange: setTasksShow };
  // The Chats tab's switch, and the bar's Reorder of its Overview's cards.
  const [chatsShow, setChatsShow] = useState<OverviewChoice>('list');
  const [reorderingCards, setReorderingCards] = useState(false);
  const sessions = useSessionsState();
  const chatsTab: ChatsTab = { sessions, show: chatsShow, onShow: setChatsShow, reordering: reorderingCards, onReordered: () => setReorderingCards(false) };
  const addonTabs = mainTabs(m.addons).filter((t) => t.addon);
  const tabForm = phoneViewTabsForm(width, !!split);
  const openTab = (id: PhoneTab) => setNav((n) => selectTab(n, id));
  // An addon's tab goes when its addon stops.
  const tabGone = nav.tab.startsWith('addon/') && m.addonsLoaded && !addonTabs.some((t) => t.id === nav.tab);
  useEffect(() => {
    if (tabGone) setNav((n) => selectTab(n, 'more'));
  }, [tabGone]);
  const shown_ = m.view?.sessions ?? DEFAULT_SHOWN;
  const nothing = () => undefined;
  // The addon screen showing (a tab's, or a pane item's), for the commands its addon placed on it.
  const [addonScreen, setAddonScreen] = useState<AddonScreenReport | null>(null);
  const commands: CommandContext = {
    ...m.commandContext(commandState),
    addon: m.addonContext(nav.tab, addonScreen),
    ...(nav.tab === 'sessions'
      ? {
          chats: {
            single: false,
            tab: true,
            selected: null,
            summary: undefined,
            chat: null,
            sessionId: null,
            sessions: sessions?.sessions ?? [],
            stoppable: false,
            shown: shown_,
            setShown: (patch: Partial<View['sessions']>) => m.changeView({ sessions: { ...shown_, ...patch } }),
            setSelected: nothing,
            activityOpen: false,
            toggleActivity: nothing,
            step: nothing,
            focusPane: nothing,
          },
        }
      : {}),
  };
  useCommandMenu(null, commands);
  setRowMenuContext(commands);
  const allTabs: AllTabs = { addons: addonTabs, open: openTab, list: (id) => setNav((n) => pushScreen(n, { kind: 'list', id })) };
  const shown = screenFor(m, commands, nav.tab, top, openFolder, openTasks, tasksSwitch, chatsTab, allTabs, setAddonScreen);
  // The list shown, in the sheet that moves its rows: a screen of a folder or a tab's own, not an item's.
  const [reordering, setReordering] = useState(false);
  const reorderable = m.task || m.project || m.addonShown ? null : reorderSheet(m, nav.tab, top?.kind === 'folder' ? top.id : '');
  // The Overview's cards, where it shows: beside the list on a tablet, or chosen with the switch.
  const cardsReorderable = nav.tab === 'sessions' && !top && (sessions?.sessions.length ?? 0) > 1 && (!!split || chatsShow === 'overview');
  // Reorder is the list's own: its rows move in a sheet.
  const toolbar = [
    ...(reorderable ? [{ id: 'list', items: [{ id: 'reorder', label: 'Reorder', run: () => setReordering(true) }] }] : []),
    ...(cardsReorderable ? [{ id: 'cards', items: [{ id: 'reorder-cards', label: 'Reorder', run: () => setReorderingCards(true) }] }] : []),
  ];
  // A tablet: the list column shows the tab's own list; its rows replace the detail column's screen. The Dashboard, More and an addon's tab fill the width.
  const list = split && (nav.tab === 'projects' || nav.tab === 'tasks' || nav.tab === 'sessions')
    ? rootFor(
        listWindow(m, fromList),
        commands,
        nav.tab,
        '',
        (id) => setNav((n) => rootScreen(n, { kind: 'folder', id })),
        openTasks,
        tasksSwitch,
        chatsTab,
        allTabs,
        setAddonScreen,
        { current: stackOf(nav)[0] ?? null },
      )
    : null;
  // With nothing opened, the detail column of the Chats and Tasks tabs is their Overview (a chat opens in a Chats window of its own).
  const overview = nav.tab === 'sessions' ? <PhoneSessionsTab m={m} tab={chatsTab} show="overview" /> : nav.tab === 'tasks' ? <div className="pg-scroll phone-sessions"><TasksOverview m={m} /></div> : null;
  const detail: ShownScreen | null = !split || top ? shown : overview ? { title: 'Overview', actions: [], body: overview } : null;
  const currentTab: PhoneTab = nav.tab.startsWith('addon/') ? 'more' : nav.tab;
  const viewTabs = <ViewTabs tabs={VIEW_TABS} active={currentTab} onSelect={(id) => openTab(id as PhoneTab)} layout={tabForm} />;
  const bar = (
    <NavBar
      {...(list
      ? {
          title: detail?.title ?? '',
          back,
          // A folder's New Task is the list's own, already in the list column's bar.
          actions: (detail?.actions ?? []).filter((a) => !list.actions.some((l) => l.id === a.id)),
          // With nothing opened beside it, the list's own commands are the screen's.
          more: detail?.more ?? list.more,
          toolbar,
          largeTitle: false,
          split: { width: split!.lead, title: list.title, actions: list.actions, largeTitle: true },
        }
      : { title: shown.title, back, actions: shown.actions, more: shown.more, toolbar, largeTitle: !top })}
    />
  );

  const sheets = reordering && reorderable && <ReorderSheet {...reorderable} onClose={() => setReordering(false)} />;
  const tabClass = `tab-${nav.tab.startsWith('addon/') ? 'addon' : nav.tab}${top ? ' pushed' : ''}`;

  if (split || tabForm === 'rail') {
    return (
      <div className={`phone-main phone-page${split ? ' split' : ''} ${tabClass}`}>
        {bar}
        <div className="phone-main-row">
          {/* A rail beside the content; iPad's tabs go to the frame's bar and draw nothing here. */}
          {tabForm !== 'bar' && viewTabs}
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
      <div key={depth} className={`phone-screen${lastScreen.current.enter}`}>
        {shown.body}
      </div>
      {sheets}
      {tabForm === 'bar' && viewTabs}
    </div>
  );
}


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
        void window.looper.tasks.reorder(m.tasks.map((t) => t.id), undefined, nextLayout).catch(reportError);
      },
    };
  }
  // Grouped by harness or environment the groups have their own order: only the user's own folders can be arranged.
  if (tab === 'projects' && (view?.projectsPane.groupBy ?? 'none') === 'none') {
    const entries = projectEntries(m, folderId);
    if (entries.length < 2) return null;
    return {
      title: 'Reorder Projects',
      sections: [{ key: folderId, items: entries.map((e) => (e.kind === 'folder' ? { key: `folder:${e.folder.id}`, title: e.folder.name } : { key: e.task.id, title: e.task.name })) }],
      onReorder: (container, keys) => {
        const nextLayout = withSiblingsOrdered(siblingOrder(m.projects, m.projectFolders, m.projectLayout), container, keys);
        void window.looper.projects.reorder(m.projects.map((p) => p.id), undefined, nextLayout).catch(reportError);
      },
    };
  }
  return null;
}

/** A screen: its bar's title, actions and More menu, and its content. */
interface ShownScreen {
  title: string;
  actions: PageNavAction[];
  more?: MoreMenuInput;
  body: React.ReactNode;
}

/** The current screen: the selected item's, or the tab's list. */
function screenFor(
  m: MainWindow,
  c: CommandContext,
  tab: PhoneTab,
  top: PhoneScreen | null,
  openFolder: (id: string) => void,
  openTasks: () => void,
  tasksSwitch: TasksSwitch,
  chatsTab: ChatsTab,
  allTabs: AllTabs,
  onAddonScreen: (screen: AddonScreenReport | null) => void,
): ShownScreen {
  const { task, project, addonShown, runtimes } = m;
  if (task) {
    const rt = runtimes[task.id];
    return {
      title: task.name,
      ...phoneNav(['task'], c),
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
      ...phoneNav(['project'], c),
      body: (
        <div
          className="phone-detail"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.pg-row, .run-row, .git-file, .git-commit')) return;
            e.preventDefault();
            showProjectMenu(project);
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
      ...phoneNav(['addonItem', 'addonScreen'], c),
      body: <PhoneAddonScreen m={m} onScreen={onAddonScreen} />,
    };
  }
  if (top?.kind === 'list') return { title: top.id === 'advanced' ? 'Advanced' : '', actions: [], body: <MoreMenuList c={c} menu="advanced" /> };
  return rootFor(m, c, tab, top?.kind === 'folder' ? top.id : '', openFolder, openTasks, tasksSwitch, chatsTab, allTabs, onAddonScreen);
}

/** What the detail column shows before a row is opened (the Chats and Tasks tabs show their Overview instead). */
const EMPTY_DETAIL: Partial<Record<PhoneTab, string>> = {
  projects: 'No Project Selected',
};

interface ChatsTab {
  sessions: SessionsState | null;
  show: OverviewChoice;
  onShow: (v: OverviewChoice) => void;
  reordering: boolean;
  onReordered: () => void;
}

interface AllTabs {
  /** The addons' tabs, which the More view opens. */
  addons: MainTabDef[];
  open: (id: PhoneTab) => void;
  /** Push a menu's own list (Advanced). */
  list: (id: string) => void;
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
  c: CommandContext,
  tab: PhoneTab,
  folderId: string,
  openFolder: (id: string) => void,
  openTasks: () => void,
  tasksSwitch: TasksSwitch,
  chatsTab: ChatsTab,
  allTabs: AllTabs,
  onAddonScreen: (screen: AddonScreenReport | null) => void,
  split?: { current: PhoneScreen | null },
): ShownScreen {
  const current = split?.current && split.current.kind !== 'addon' ? split.current.id : null;
  switch (tab) {
    case 'dashboard':
      return { title: 'Dashboard', ...phoneNav(['dashboard'], c), body: <PhoneDashboard m={m} /> };
    case 'projects': {
      // A folder's screen shows what the folder holds, as the tab shows the top level.
      const folder = folderId ? m.projectFolders.find((f) => f.id === folderId) : undefined;
      return { title: folder?.name ?? 'Projects', ...phoneNav(['projects'], c), body: <ProjectCollection m={m} current={current} phone={{ container: folder?.id ?? '', onOpenFolder: openFolder }} /> };
    }
    case 'tasks': {
      // A folder's screen shows what the folder holds, as the tab shows the top level.
      const folder = folderId ? m.folders.find((f) => f.id === folderId) : undefined;
      const listShows = !!split || !!folder || tasksSwitch.value === 'list';
      const nav = phoneNav(['tasks'], c, listShows ? 0 : -1);
      return {
        title: folder?.name ?? 'Tasks',
        // Filter narrows the list, so it goes while the Overview shows.
        actions: nav.actions.filter((a) => listShows || a.id !== 'tasksFilter'),
        more: nav.more,
        body: <TaskCollection m={m} phone={{ container: folder?.id ?? '', onOpenFolder: openFolder, current, show: split ? 'list' : undefined, tasksSwitch }} />,
      };
    }
    case 'sessions':
      return { title: 'Chats', ...phoneNav(['chats'], c), body: <PhoneSessionsTab m={m} tab={chatsTab} show={split ? 'list' : undefined} /> };
    case 'more':
      return { title: 'More', actions: [], body: <MoreView m={m} c={c} allTabs={allTabs} /> };
    default: {
      const def = allTabs.addons.find((t) => t.id === tab);
      if (!def?.addon) return { title: '', actions: [], body: <div className="pg-scroll" /> };
      const { addon } = def;
      if (!addon.tab) return { title: def.label, ...phoneNav(['addonPanes'], c), body: <PhoneAddonPanes m={m} c={c} addonId={addon.id} /> };
      return {
        title: def.label,
        ...phoneNav(['addonScreen'], c),
        body: (
          <div className="phone-detail">
            <AddonScreenView key={def.id} addonId={addon.id} addonName={addon.name} view={addon.tab.view} params={addon.tab.params ?? {}} mode="main" onScreen={onAddonScreen} />
          </div>
        ),
      };
    }
  }
}

/** A long press on the task's screen: the task's menu, as a right-click on its row. */
function taskMenuAt(e: React.MouseEvent, m: MainWindow) {
  if (!m.task) return;
  // The run log and links have menus of their own.
  if ((e.target as HTMLElement).closest('.run-row, .pg-row, a, input, textarea, select')) return;
  e.preventDefault();
  showTaskMenu(m.task, m.runtimes[m.task.id]);
}

/** Each started addon in the More view: its tabs, then its commands no phone screen shows (moreViewCommands). */
function addonRows(m: MainWindow, c: CommandContext, allTabs: AllTabs) {
  const listed = moreViewCommands(c);
  return m.addons
    .filter((a) => a.enabled)
    .map((a) => ({
      addon: a,
      tabs: allTabs.addons.filter((t) => t.addon?.id === a.id),
      commands: listed.filter((cmd) => cmd.id.startsWith(addonCommandId(a.id, ''))),
    }))
    .filter((x) => x.tabs.length > 0 || x.commands.length > 0);
}

/** One menu's rows from the command list: a choice opens its menu, anything else runs. */
function CommandRows({ c, list }: { c: CommandContext; list: Command[] }) {
  return (
    <>
      {list.flatMap((cmd) =>
        commandSpec(cmd, c)
          .filter((it) => it.type !== 'separator')
          .map((it) => (
            <Row
              key={it.id}
              title={plainLabel(it.label ?? '')}
              chevron={it.type === 'submenu'}
              checked={it.checked}
              disabled={!it.enabled}
              onOpen={() => (it.submenu ? popupCommands(c, it.submenu) : runCommand(it.id, c))}
            />
          )),
      )}
    </>
  );
}

/** The menu items of `menu` no screen has. */
const menuCommands = (c: CommandContext, menu: string): Command[] =>
  moreViewCommands(c).filter((cmd) => !cmd.id.startsWith('addon:') && Object.values(cmd.in).some((w) => w?.menu === menu));

/** A menu's own list screen (Advanced): three levels of submenus are more than a phone should have. */
function MoreMenuList({ c, menu }: { c: CommandContext; menu: string }) {
  const list = menuCommands(c, menu);
  const groups = [...new Set(list.map((cmd) => cmd.group))];
  return (
    <div className="pg-scroll">
      {groups.map((g) => (
        <Group key={g}>
          <CommandRows c={c} list={list.filter((cmd) => cmd.group === g)} />
        </Group>
      ))}
    </div>
  );
}

/**
 * The More view: the addons first, then every menu item no screen has, Settings
 * and Help at the end (Material: after all other items). A rule of the list, so
 * a new command with no screen shows here by itself.
 */
function MoreView({ m, c, allTabs }: { m: MainWindow; c: CommandContext; allTabs: AllTabs }) {
  const tools = menuCommands(c, 'tools');
  // Every other menu's items no screen has: the list's rule, so a new one shows here by itself.
  const others = moreViewCommands(c).filter((cmd) => !cmd.id.startsWith('addon:') && !Object.values(cmd.in).some((w) => w?.menu === 'tools' || w?.menu === 'advanced' || w?.menu === 'help'));
  const addons = addonRows(m, c, allTabs);
  return (
    <div className="pg-scroll">
      <LargeTitle>More</LargeTitle>
      {addons.map(({ addon, tabs, commands }) => (
        <Group key={addon.id} title={addon.name}>
          {tabs.map((t) => (
            <Row key={t.id} title={t.label} chevron onOpen={() => allTabs.open(t.id as PhoneTab)} />
          ))}
          <CommandRows c={c} list={commands} />
        </Group>
      ))}
      {others.length > 0 && (
        <Group>
          <CommandRows c={c} list={others} />
        </Group>
      )}
      <Group>
        <CommandRows c={c} list={tools.filter((cmd) => cmd.id !== 'settings')} />
        <Row title="Advanced" chevron onOpen={() => allTabs.list('advanced')} />
      </Group>
      <Group>
        <CommandRows c={c} list={tools.filter((cmd) => cmd.id === 'settings')} />
        <CommandRows c={c} list={menuCommands(c, 'help')} />
      </Group>
      <Group>
        <Row title={platform === 'android' ? 'This device' : 'This Device'} chevron onOpen={() => window.top?.__looperFrame?.openDevice?.()} />
      </Group>
    </div>
  );
}

/** An addon with only panes: its panes as a list, a tap opens the item's screen. */
/**
 * An addon's panes, one group each, with the addon's search field, which stays put as the list scrolls: at the
 * top on Android (Material) and an iPad (the top of the list), at the bottom over the tab bar on an iPhone
 * (HIG: "Place search at the bottom if there's room").
 */
function PhoneAddonPanes({ m, c, addonId }: { m: MainWindow; c: CommandContext; addonId: string }) {
  const addon = m.addons.find((a) => a.id === addonId);
  if (!addon) return <div className="pg-scroll" />;
  const search = addonSearch(addon, m.addonPanes);
  const query = m.addonQueries[addon.id] ?? '';
  return (
    <>
      {search && (
        <div className="pg-search">
          <AddonSearchBox value={query} onChange={(q) => m.setAddonQuery(addon.id, q)} placeholder={search.prompt} />
        </div>
      )}
      <div className={`pg-scroll${search ? ' has-search' : ''}`}>
        {addon.panes.map((pane) => {
          const key = addonPaneKey(addon.id, pane.id);
          const state = m.addonPanes[key];
          const ready = addon.status === 'running' && state?.status === 'ready' ? state : null;
          const total = ready?.content.items.length ?? 0;
          const filtered = ready?.content.search && query.trim() ? shownItems(ready, query).length : null;
          return (
            <Group
              key={key}
              title={`${pane.title}${ready ? ` (${filtered === null ? total : `${filtered} of ${total}`})` : ''}`}
              onTitleMenu={() => showPaneMenu(c, addon.id, pane.id, state)}
            >
              <div className="pg-addon-pane">
                <AddonPaneList
                  addon={addon}
                  pane={pane.id}
                  state={state}
                  selected={m.addonSel?.addonId === addon.id && m.addonSel.pane === pane.id ? m.addonSel.item : null}
                  compact={false}
                  query={query}
                  onSelect={(item) => m.selectAddon({ addonId: addon.id, pane: pane.id, item: item.id })}
                  onMenu={(item) => showPaneItemMenu(c, addon.id, pane.id, state, item)}
                  onRetry={() => m.reloadAddon(addon.id)}
                />
              </div>
            </Group>
          );
        })}
      </div>
    </>
  );
}

/** An addon item's screen; the bar and More have the commands placed on items and on the screen. */
function PhoneAddonScreen({ m, onScreen }: { m: MainWindow; onScreen: (screen: AddonScreenReport | null) => void }) {
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
        onScreen={onScreen}
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
