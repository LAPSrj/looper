import { useEffect, useRef, useState } from 'react';
import { isLooperTab, mainTabs } from '@shared/main-tabs';
import { sidebarHasPanes } from '@shared/panes';
import { remoteAccessStatusItems } from '@shared/remote-access';
import { addonMainGroups, AddonScreenView } from './components/AddonScreen';
import type { AddonSelection } from './components/AddonPane';
import { Dashboard } from './components/Dashboard';
import { useDragResize } from './components/hooks';
import { RestStatusText } from './components/Live';
import { PhoneMain } from './components/phone/PhoneMain';
import { ProjectDetail } from './components/ProjectDetail';
import { ProjectsSidebar, Sidebar } from './components/Sidebar';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { newToolbarGroups, projectToolbarGroups, taskToolbarGroups } from './components/TaskToolbar';
import { Toolbar } from './components/Toolbar';
import type { ToolbarGroup } from './components/toolbar-model';
import { sessionLimits } from './components/usage';
import { ViewTabs } from './components/ViewTabs';
import { SessionsBody, SessionsStatusBar, sessionsToolbarGroups } from './SessionsApp';
import { preventSleepStatus, useMainWindow } from './useMainWindow';
import { useRemoteAccessState } from './useRemoteAccess';
import { useSessionsWindow, type SessionsWindow } from './useSessionsWindow';
import { isPhone } from './web/page-nav';

/**
 * The main window: its tabs (Dashboard, Projects, Tasks, Chats and the
 * addons'), drawn for the desktop or a phone. `fixed`: a view window (View →
 * Dashboard and the rest), which shows that tab alone.
 */
export function App({ fixed }: { fixed?: string }) {
  return isPhone ? <PhoneApp /> : <DesktopMain fixed={fixed} />;
}

function PhoneApp() {
  return <PhoneMain m={useMainWindow()} />;
}

const SIDEBAR_WIDTH_KEY = 'main.sidebarWidth';
/** The tab the main window showed last, which it opens on. */
const TAB_KEY = 'main.tab';

/** The sidebar's width as last dragged (a window's own, like the Chats window's panes). */
function savedSidebarWidth(): number {
  const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return width >= 180 ? width : 300;
}

/** What each tab had selected when it was left, so coming back shows it again. */
interface TabMemory {
  projects: string | null;
  tasks: { task: string } | { addon: AddonSelection } | null;
}

/** The Chats tab's toolbar part: the Chats window's, without the New buttons (the main window's are there already), its Dashboard named Overview, as the phone names it. */
function chatsToolbarGroups(s: SessionsWindow): ToolbarGroup[] {
  return sessionsToolbarGroups(s)
    .filter((g) => g.id !== 'new')
    .map((g) => (g.id === 'views' ? { ...g, items: g.items.map((it) => (it.id === 'dashboard' ? { ...it, label: 'Overview' } : it)) } : g));
}

/**
 * The desktop main window: the toolbar (the New buttons, then the shown tab's
 * own and the addons'), the tabs, the shown tab's view, and the status bar
 * (the tab's facts, then the computer's). The window's selection is the shown
 * tab's, so the menus act on what's in view; each tab keeps its own while
 * another shows. A selection made elsewhere (a notification, a project's task,
 * a new chat) shows its tab.
 */
function DesktopMain({ fixed }: { fixed?: string }) {
  const [picked, setPicked] = useState(() => fixed ?? localStorage.getItem(TAB_KEY) ?? 'dashboard');
  const m = useMainWindow(picked);
  const s = useSessionsWindow(undefined, false, { active: picked === 'chats' });
  const { view, tasks, projects, runtimes, addons, rest, counts, remoteOpen } = m;
  const tabs = mainTabs(addons);
  const tabDef = tabs.find((t) => t.id === picked);
  // The main toolbar's end, where the shown addon screen puts its buttons.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const appRef = useRef<HTMLDivElement>(null);
  const memory = useRef<TabMemory>({ projects: null, tasks: null });
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const preventSleepText = m.preventSleep ? preventSleepStatus(m.preventSleep) : null;
  const remoteAccess = useRemoteAccessState();

  const showTab = (id: string) => {
    if (fixed) return;
    setPicked(id);
    localStorage.setItem(TAB_KEY, id);
  };
  /** The user picked a tab: the window's selection becomes the one that tab had. */
  const pick = (id: string) => {
    showTab(id);
    const { projects: project, tasks: kept } = memory.current;
    if (id === 'projects') m.selectProject(project);
    else if (id === 'tasks' && kept) {
      if ('task' in kept) m.select(kept.task);
      else m.selectAddon(kept.addon);
    } else m.selectProject(null);
  };

  // A tab whose addon was stopped or removed leaves the window on the Dashboard.
  const gone = !tabDef && !isLooperTab(picked) && m.addonsLoaded;
  useEffect(() => {
    if (gone && !fixed) pick('dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);

  // A selection, from the tab's list or from elsewhere, is that tab's; one from elsewhere shows its tab.
  const addonKey = JSON.stringify(m.addonSel);
  useEffect(() => {
    const mem = memory.current;
    const at = pickedRef.current;
    if (m.selected) mem.tasks = { task: m.selected };
    else if (m.addonSel) mem.tasks = { addon: m.addonSel };
    else if (m.projectSel) mem.projects = m.projectSel;
    else if (at === 'tasks') mem.tasks = null;
    else if (at === 'projects') mem.projects = null;
    const to = m.selected || m.addonSel ? 'tasks' : m.projectSel ? 'projects' : null;
    if (to && to !== at) showTab(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.selected, m.projectSel, addonKey]);

  // View → Dashboard (the menu bar before the page reports its tab).
  useEffect(() => {
    if (m.dashboardShown) showTab('dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.dashboardShown]);

  // A chat started or picked elsewhere shows on the Chats tab.
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'sessions-select' || e.type === 'sessions-dashboard') pick('chats');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onSidebarDragStart = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => {
      const width = Math.max(180, Math.min(rect.width * 0.5, x));
      setSidebarWidth(width);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
    },
  });

  const tab = tabDef?.id ?? picked;
  const onChats = tab === 'chats';
  const environments = m.info?.settings.environments ?? [];
  // A view window has no Tasks tab: its tasks open in the main window.
  const openTask = (id: string, at: DetailTab) => (fixed ? window.looper.showTaskInMain(id, at) : m.openFromDashboard(id, at));
  const hiddenToolbars = view?.hiddenAddonToolbars ?? [];

  const chatProject = onChats && s.summary?.projectId ? (projects.find((p) => p.id === s.summary!.projectId) ?? null) : null;
  const toolbarGroups: ToolbarGroup[] = [
    ...newToolbarGroups({
      newTaskProject: onChats ? null : (m.project ?? projects.find((p) => p.id === m.targetTask?.projectId) ?? null),
      sessionProject: onChats ? chatProject : m.sessionProject,
      terminal: onChats,
      onAction: m.uiAction,
    }),
    ...(tab === 'tasks'
      ? taskToolbarGroups({ task: m.task, runtime: m.task ? runtimes[m.task.id] : undefined, onAction: m.uiAction })
      : tab === 'projects'
        ? projectToolbarGroups(m.project, m.uiAction)
        : onChats
          ? chatsToolbarGroups(s)
          : []),
    ...addonMainGroups(addons, hiddenToolbars),
  ];

  const sidebarColumns = (shown: boolean) => ({ gridTemplateColumns: shown ? `${sidebarWidth}px 5px 1fr` : '1fr' });
  const divider = <div className="sidebar-divider" onMouseDown={onSidebarDragStart} />;
  const alone = (content: React.ReactNode) => (
    <div className="app single">
      <main className="main">{content}</main>
    </div>
  );

  let body: React.ReactNode;
  if (tab === 'dashboard') {
    body = alone(
      <Dashboard
        attention={m.attention}
        running={m.running}
        remote={remoteOpen}
        recent={m.recentShown}
        runtimes={runtimes}
        pick={m.livePick}
        onPick={m.setPick}
        onOpen={openTask}
      />,
    );
  } else if (tab === 'projects') {
    body = (
      <div className="app" ref={appRef} style={sidebarColumns(true)}>
        {view ? <ProjectsSidebar projects={projects} selected={m.projectSel} onSelect={m.selectProject} environments={environments} view={view} /> : <aside className="sidebar" />}
        {divider}
        <main className="main">
          {m.project ? (
            <ProjectDetail
              key={m.project.id}
              project={m.project}
              tasks={tasks}
              runtimes={runtimes}
              environments={environments}
              remote={m.remote}
              onSelectTask={(id) => openTask(id, 'status')}
            />
          ) : (
            <div className="empty">No project selected.</div>
          )}
        </main>
      </div>
    );
  } else if (tab === 'tasks') {
    // With every pane hidden (View menu) there is no sidebar: the task takes the whole width.
    const sidebar = !view || sidebarHasPanes(view, addons);
    const { task, addonShown } = m;
    body = (
      <div className="app" ref={appRef} style={sidebarColumns(sidebar)}>
        {sidebar &&
          (view ? (
            <Sidebar
              tasks={tasks}
              folders={m.folders}
              layout={m.layout}
              runtimes={runtimes}
              selected={m.selected}
              onSelect={m.select}
              onCommand={m.uiAction}
              view={view}
              onView={m.changeView}
              addons={addons}
              addonPanes={m.addonPanes}
              addonSelected={m.addonSel}
              onAddonSelect={m.selectAddon}
              onAddonRetry={m.reloadAddon}
            />
          ) : (
            <aside className="sidebar" />
          ))}
        {sidebar && divider}
        <main className="main">
          {task ? (
            <TaskDetail
              key={task.id}
              task={task}
              project={projects.find((p) => p.id === task.projectId)}
              environments={environments}
              runtime={runtimes[task.id]}
              records={m.records[task.id] ?? []}
              tab={m.tab}
              onTab={m.setTab}
              hideNoActionRuns={view?.hideNoActionRuns ?? false}
              focusRun={m.focusRun}
              terminalRun={m.terminalRun}
              onTerminalRun={m.setTerminalRun}
            />
          ) : addonShown ? (
            <AddonScreenView
              key={`${addonShown.addon.id}/${addonShown.item.view}/${JSON.stringify(addonShown.item.params ?? {})}`}
              addonId={addonShown.addon.id}
              addonName={addonShown.addon.name}
              view={addonShown.item.view}
              params={addonShown.item.params ?? {}}
              mode="main"
              toolbarSlot={hiddenToolbars.includes(addonShown.addon.id) ? null : toolbarSlot}
            />
          ) : (
            <div className="empty">No task selected.</div>
          )}
        </main>
      </div>
    );
  } else if (onChats) {
    body = <SessionsBody s={s} />;
  } else if (tabDef?.addon) {
    const { addon } = tabDef;
    body = alone(
      <AddonScreenView
        key={tabDef.id}
        addonId={addon.id}
        addonName={addon.name}
        view={addon.tab.view}
        params={addon.tab.params ?? {}}
        mode="main"
        toolbarSlot={hiddenToolbars.includes(addon.id) ? null : toolbarSlot}
      />,
    );
  } else {
    body = alone(m.addonsLoaded ? <div className="empty">The addon this tab comes from isn’t started.</div> : null);
  }

  const computerStatus = (
    <>
      {rest?.armed && (
        <span>
          <RestStatusText rest={rest} />
        </span>
      )}
      {preventSleepText && <span>{preventSleepText}</span>}
      {remoteAccess && remoteAccessStatusItems(remoteAccess).map((text) => <span key={text}>{text}</span>)}
    </>
  );
  const statusBar =
    (view?.statusBar ?? true) &&
    (onChats ? (
      <SessionsStatusBar summary={s.summary} chat={s.chat} limits={sessionLimits(s.state, s.summary)}>
        {computerStatus}
      </SessionsStatusBar>
    ) : (
      <div className="statusbar">
        <span>{counts.enabled} enabled</span>
        <span>{counts.disabled} disabled</span>
        <span>{counts.completed} completed</span>
        <span>{counts.paused} paused</span>
        <span>{counts.running} running</span>
        {remoteOpen && <span>{remoteOpen.length} Remote Control conversation{remoteOpen.length === 1 ? '' : 's'}</span>}
        {addons.length > 0 && <span>{m.runningAddons} addon{m.runningAddons === 1 ? '' : 's'} running</span>}
        <span className="spacer" />
        {computerStatus}
      </div>
    ));

  const position = view?.tabs.position ?? 'top';
  const strip = !fixed && view && <ViewTabs tabs={tabs} active={tab} onSelect={pick} layout={view.tabs} />;

  return (
    <div className="app-shell">
      {(view?.toolbar ?? true) && (
        <Toolbar
          groups={toolbarGroups}
          onContextMenu={(e) => {
            e.preventDefault();
            window.looper.addons.showToolbarMenu();
          }}
        >
          <span className="toolbar-slot" ref={setToolbarSlot} />
        </Toolbar>
      )}
      {position === 'top' && strip}
      <div className="app-views">
        {position === 'left' && strip}
        <div className="app-view">{body}</div>
      </div>
      {position === 'bottom' && strip}
      {statusBar}
    </div>
  );
}
