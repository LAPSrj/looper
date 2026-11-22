import { useEffect, useRef, useState } from 'react';
import { mainWindowViews } from '@shared/commands/build';
import { toolbarEntries } from '@shared/commands/list';
import { noMnemonic } from '@shared/commands/command';
import { MAIN_TOOLBARS, addonToolbarId, toolbarRows, type MainToolbarId } from '@shared/toolbars';
import type { CommandContext } from '@shared/commands/context';
import { isLooperTab, mainTabs } from '@shared/main-tabs';
import { addonPaneKey } from '@shared/addons';
import { sidebarHasPanes } from '@shared/panes';
import { remoteAccessStatusItems } from '@shared/remote-access';
import { AddonScreenView, type AddonScreenReport } from './components/AddonScreen';
import { useSessionsState } from './live-state';
import { AddonPaneList, addonSearch, showPaneItemMenu, showPaneMenu } from './components/AddonPane';
import { AddonNotRunning } from './components/AddonNotRunning';
import { SearchBox } from './components/SearchBox';
import { useFindFocus } from './components/FindBar';
import { mainToolbarBands, popupEntries, popupToolbarCommands } from './components/command-surfaces';
import { setRowMenuContext } from './components/row-menus';
import { useCommandMenu, useCommandState } from './components/useCommands';
import { Dashboard } from './components/Dashboard';
import { EmptyState } from './components/EmptyState';
import { RestStatusText } from './components/Live';
import { PhoneMain } from './components/phone/PhoneMain';
import { ProjectCollection } from './components/ProjectCollection';
import { ProjectDetail } from './components/ProjectDetail';
import { ListDetail } from './components/ListDetail';
import { PaneStack } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TaskCollection } from './components/TaskCollection';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { Rebar, type RebarBand } from './components/Rebar';
import { sessionLimits } from './components/usage';
import { ViewTabs } from './components/ViewTabs';
import { SessionsBody, SessionsStatusBar } from './SessionsApp';
import { preventSleepStatus, useMainWindow, type MainWindow } from './useMainWindow';
import { useRemoteAccessState } from './useRemoteAccess';
import { useSessionsWindow } from './useSessionsWindow';
import { isPhone } from './web/page-nav';

/**
 * The main window: its tabs (Dashboard, Projects, Tasks, Chats and the
 * addons'), drawn for the desktop or a phone. `fixed`: a view window (View →
 * Dashboard and the rest), which shows that tab alone. `item`: with `fixed`
 * the Tasks or Projects tab, a task's or project's own window (a double-click
 * on its row), which shows that one alone, without the list.
 */
export function App({ fixed, item }: { fixed?: string; item?: string }) {
  return isPhone ? <PhoneApp /> : <DesktopMain fixed={fixed} item={item} />;
}

function PhoneApp() {
  return <PhoneMain m={useMainWindow()} />;
}

/** Where the sidebar's width is kept, as last dragged (a window's own, like the Chats window's panes). */
const SIDEBAR_WIDTH_KEY = 'main.sidebarWidth';
/** The tab the main window showed last, which it opens on. */
const TAB_KEY = 'main.tab';

/** A tab's list beside what it shows, or what it shows alone. */
function WithSidebar({ sidebar, children }: { sidebar: React.ReactNode | false; children: React.ReactNode }) {
  return (
    <div className="app single">
      {sidebar ? <ListDetail panes={{ axis: 'x', initial: 300, min: 180, maxShare: 0.5, storageKey: SIDEBAR_WIDTH_KEY }} list={sidebar} detail={children} /> : children}
    </div>
  );
}

/**
 * A task's or project's own window: it keeps that one selected, so its view,
 * toolbar and menus act on it, takes its name as the window's title, and
 * closes once it's deleted.
 */
function useItemWindow(m: MainWindow, fixed: string | undefined, item: string | undefined): void {
  const isTask = fixed === 'tasks';
  const name = !item ? undefined : isTask ? m.tasks.find((t) => t.id === item)?.name : m.projects.find((p) => p.id === item)?.name;
  const seen = useRef(false);
  useEffect(() => {
    if (!item) return;
    if (!name) {
      if (seen.current) window.close();
      return;
    }
    seen.current = true;
    document.title = name;
    if (isTask && m.selected !== item) m.select(item);
    else if (!isTask && m.projectSel !== item) m.selectProject(item);
  }, [item, name, isTask, m.selected, m.projectSel]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What each tab had selected when it was left, so coming back shows it again. */
interface TabMemory {
  projects: string | null;
  tasks: string | null;
}

/**
 * The desktop main window: its toolbars (New, the shown tab's own and the
 * addons', in the rows their grips dragged them to), the tabs, the shown tab's view, and the status bar
 * (the tab's facts, then the computer's). The window's selection is the shown
 * tab's, so the menus act on what's in view; each tab keeps its own while
 * another shows. A selection made elsewhere (a notification, a project's task,
 * a new chat) shows its tab.
 */
function DesktopMain({ fixed, item }: { fixed?: string; item?: string }) {
  const [picked, setPicked] = useState(() => fixed ?? localStorage.getItem(TAB_KEY) ?? 'dashboard');
  const m = useMainWindow(picked);
  useItemWindow(m, fixed, item);
  const s = useSessionsWindow(undefined, false, { active: picked === 'chats' });
  const commandState = useCommandState();
  const chatsState = useSessionsState();
  const { view, tasks, projects, runtimes, addons, rest, counts, remoteOpen } = m;
  const tabs = mainTabs(addons);
  const tabDef = tabs.find((t) => t.id === picked);
  // The addon screen showing (a tab's, or a pane item's), for the commands its addon placed on it.
  const [addonScreen, setAddonScreen] = useState<AddonScreenReport | null>(null);
  const searchField = useFindFocus();
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
    else if (id === 'tasks' && kept) m.select(kept);
    else m.selectProject(null);
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
    if (m.selected) mem.tasks = m.selected;
    else if (m.addonSel) {
      // Showing an addon's item doesn't change what the Tasks tab remembers.
    } else if (m.projectSel) mem.projects = m.projectSel;
    else if (at === 'tasks') mem.tasks = null;
    else if (at === 'projects') mem.projects = null;
    const addonTab = m.addonSel && tabs.find((t) => t.addon?.id === m.addonSel!.addonId && !t.addon.tab)?.id;
    const to = m.selected ? 'tasks' : (addonTab ?? (m.projectSel ? 'projects' : null));
    if (to && to !== at) showTab(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.selected, m.projectSel, addonKey]);

  // Window → Dashboard.
  useEffect(() => {
    if (m.dashboardShown) showTab('dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.dashboardShown]);

  // A chat started or picked elsewhere shows on the Chats tab.
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'sessions-select' || e.type === 'sessions-terminal') pick('chats');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const tab = tabDef?.id ?? picked;
  const onChats = tab === 'chats';
  // An addon's panes tab: its Search box, at the toolbar's right end (Windows: "locate Search in the upper-right corner").
  const paneAddon = tabDef?.addon && !tabDef.addon.tab ? addons.find((a) => a.id === tabDef.addon!.id) : undefined;
  const search = paneAddon ? addonSearch(paneAddon, m.addonPanes) : null;
  const query = paneAddon ? (m.addonQueries[paneAddon.id] ?? '') : '';
  // The status bar of an addon's panes tab with no item's screen showing: its first pane's.
  const firstPane = paneAddon?.panes[0] && m.addonPanes[addonPaneKey(paneAddon.id, paneAddon.panes[0].id)];
  const paneStatus = firstPane?.status === 'ready' ? firstPane.content.status : undefined;
  // The Search box is the addon's toolbar's: View → Toolbars hides it with the addon's buttons.
  const searchShown = !!search && !view?.hiddenAddonToolbars.includes(paneAddon!.id);
  // View > Filter: the Search box takes the focus, or with it hidden the Filter dialog asks for the text.
  const openSearch = () => (searchShown ? searchField.focus() : commands.host('filter', 'Show items containing', query));

  // The Filter dialog's text is the shown addon's search.
  const searchAddon = useRef<string | null>(null);
  searchAddon.current = search ? paneAddon!.id : null;
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'filter' && searchAddon.current) m.setAddonQuery(searchAddon.current, e.value);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const environments = m.info?.settings.environments ?? [];
  // A view window other than the Tasks one has no Tasks tab: its tasks open in the main window.
  const openTask = (id: string, at: DetailTab) => (fixed && fixed !== 'tasks' ? window.looper.showTaskInMain(id, at) : m.openFromDashboard(id, at));

  // The menu bar and the toolbar, from the one list: what this tab shows, in this window.
  const commands: CommandContext = {
    ...m.commandContext(commandState),
    fixed: !!fixed,
    item: !!item,
    ...(fixed ? {} : { openTab: pick }),
    ...(onChats ? { chats: s.chatsContext() } : {}),
    addon: m.addonContext(tab, addonScreen, openSearch),
  };
  useCommandMenu(mainWindowViews(tab, !!fixed, !!item), commands);
  setRowMenuContext(commands);
  // The toolbars View → Toolbars shows (an addon's hidden one has no buttons).
  const bands: RebarBand[] = mainToolbarBands(tab, !!fixed, !!item, commands).flatMap((b) => {
    const own = MAIN_TOOLBARS.find((t) => t.id === b.id);
    if (own) return !view || view.toolbars[own.id as MainToolbarId] ? [{ ...b, label: noMnemonic(own.label) }] : [];
    const addon = addons.find((a) => addonToolbarId(a.id) === b.id);
    return [{ ...b, label: `${addon?.toolbarName ?? addon?.name ?? ''} Toolbar` }];
  });
  const toolbarShown = bands.length > 0 || searchShown;
  // Every toolbar has a place, the ones this tab doesn't show too, so dragging one keeps the others where they were.
  const savedRows = view?.toolbars.rows ?? [];
  const rows = toolbarRows(savedRows, [...MAIN_TOOLBARS.map((t) => t.id), ...bands.map((b) => b.id)]);

  const alone = (content: React.ReactNode) => (
    <div className="app single">
      <main className="main">{content}</main>
    </div>
  );

  let body: React.ReactNode;
  if (tab === 'dashboard') {
    body = alone(
      <Dashboard
        attention={m.attention} logins={m.loginAttention}
        running={m.running}
        remote={remoteOpen}
        chats={chatsState?.sessions ?? []}
        recent={m.recentShown}
        runtimes={runtimes}
        pick={m.livePick}
        onPick={m.setPick}
        onOpen={openTask}
        onClearAttention={m.clearAttention}
      />,
    );
  } else if (tab === 'projects') {
    // A project's own window has the project alone.
    body = (
      <WithSidebar sidebar={!item && <ProjectCollection m={m} />}>
        <main className="main">
          {m.project ? (
            <ProjectDetail
              key={m.project.id}
              project={m.project}
              tasks={tasks}
              runtimes={runtimes}
              environments={environments}
              remote={m.remote}
              onSelectTask={(id) => window.looper.openItemWindow('task', id)}
              untitled={!!item}
            />
          ) : (
            <EmptyState>{item ? 'Loading…' : 'No project selected.'}</EmptyState>
          )}
        </main>
      </WithSidebar>
    );
  } else if (tab === 'tasks') {
    // With every pane hidden (View menu) there is no sidebar: the task takes the whole width. A task's own window has the task alone.
    const sidebar = !item && (!view || sidebarHasPanes(view));
    const { task } = m;
    body = (
      <WithSidebar sidebar={sidebar && <TaskCollection m={m} />}>
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
              runFilter={view?.runFilter}
              focusRun={m.focusRun}
              untitled={!!item}
            />
          ) : item ? (
            <EmptyState>Loading…</EmptyState>
          ) : (
            // No task selected: the tasks' dashboard, as the Chats tab shows its own.
            <Dashboard
              attention={m.attention} logins={m.loginAttention}
              running={m.running}
              remote={null}
              recent={m.recentShown}
              runtimes={runtimes}
              pick={m.livePick}
              onPick={m.setPick}
              onOpen={openTask}
              onClearAttention={m.clearAttention}
            />
          )}
        </main>
      </WithSidebar>
    );
  } else if (onChats) {
    body = <SessionsBody s={s} menu={commands} />;
  } else if (tabDef?.addon && !tabDef.addon.tab) {
    // An addon with only panes: its panes as the list, the item picked beside them.
    const addon = addons.find((a) => a.id === tabDef.addon!.id);
    const { addonShown } = m;
    if (addon && addon.status !== 'running') body = alone(<AddonNotRunning addon={addon} />);
    else {
    // Equal panes: the view has no place to keep an addon pane's height.
    const panes = (
      <PaneStack
        panes={(addon?.panes ?? []).map((p) => {
          const state = m.addonPanes[addonPaneKey(addon!.id, p.id)];
          return {
            key: p.id,
            title: p.title,
            onMenu: () => showPaneMenu(commands, addon!.id, p.id, state),
            body: (
              <AddonPaneList
                addon={addon!}
                pane={p.id}
                state={state}
                selected={m.addonSel?.addonId === addon!.id && m.addonSel.pane === p.id ? m.addonSel.item : null}
                compact={view?.taskList === 'compact'}
                query={query}
                onSelect={(it) => m.selectAddon({ addonId: addon!.id, pane: p.id, item: it.id })}
                onMenu={(it) => showPaneItemMenu(commands, addon!.id, p.id, state, it)}
                onRetry={() => m.reloadAddon(addon!.id)}
              />
            ),
          };
        })}
      />
    );
    body = (
      <WithSidebar sidebar={panes}>
        <main className="main">
          {addonShown ? (
            <AddonScreenView
              key={`${addonShown.addon.id}/${addonShown.item.view}/${JSON.stringify(addonShown.item.params ?? {})}`}
              addonId={addonShown.addon.id}
              addonName={addonShown.addon.name}
              view={addonShown.item.view}
              params={addonShown.item.params ?? {}}
              mode="main"
              onScreen={setAddonScreen}
            />
          ) : (
            <EmptyState>Nothing selected.</EmptyState>
          )}
        </main>
      </WithSidebar>
    );
    }
  } else if (tabDef?.addon?.tab) {
    const addon = { ...tabDef.addon, tab: tabDef.addon.tab };
    const info = addons.find((a) => a.id === addon.id);
    body = alone(
      info && info.status !== 'running' ? (
        <AddonNotRunning addon={info} />
      ) : (
      <AddonScreenView
        key={tabDef.id}
        addonId={addon.id}
        addonName={addon.name}
        view={addon.tab.view}
        params={addon.tab.params ?? {}}
        mode="main"
        onScreen={setAddonScreen}
      />
      ),
    );
  } else {
    body = alone(m.addonsLoaded ? <EmptyState>The addon this tab comes from isn’t started.</EmptyState> : null);
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
      <StatusBar end={computerStatus}>
        {/* The task counts are the tasks' status: an addon's tab shows none of them. */}
        {!tabDef?.addon && (
          <>
            <span>{counts.enabled} enabled</span>
            <span>{counts.disabled} disabled</span>
            <span>{counts.completed} completed</span>
            <span>{counts.paused} paused</span>
            <span>{counts.running} running</span>
            {remoteOpen && <span>{remoteOpen.length} Remote Control conversation{remoteOpen.length === 1 ? '' : 's'}</span>}
          </>
        )}
        {tabDef?.addon && addons.find((a) => a.id === tabDef.addon!.id)?.status === 'running' && (addonScreen?.status ?? paneStatus)?.map((text, n) => <span key={n}>{text}</span>)}
        {m.stoppedAddons.length > 0 && <span>{m.stoppedAddons.length === 1 ? `${m.stoppedAddons[0]} addon stopped` : `${m.stoppedAddons.length} addons stopped`}</span>}
      </StatusBar>
    ));

  const position = view?.tabs.position ?? 'top';
  const strip = !fixed && view && <ViewTabs tabs={tabs} active={tab} onSelect={pick} layout={view.tabs} />;

  return (
    <div className="app-shell">
      {toolbarShown && (
        <Rebar
          bands={bands}
          rows={rows}
          onLayout={(next) => view && commands.setView({ toolbars: { ...view.toolbars, rows: next } })}
          onOverflow={(ids, at) => popupToolbarCommands(commands, ids, at)}
          end={searchShown && <SearchBox value={query} onChange={(q) => m.setAddonQuery(paneAddon!.id, q)} placeholder={search!.prompt} inputRef={searchField.inputRef} />}
          onContextMenu={(e) => {
            if ((e.target as Element).closest('input')) return;
            e.preventDefault();
            popupEntries(commands, 'toolbars', toolbarEntries(commands));
          }}
        />
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
