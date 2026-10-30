import { useEffect, useState } from 'react';
import { addonPaneKey, matchesSearch } from '@shared/addons';
import type { SessionsState } from '@shared/sessions';
import { subscribe } from '../../events';
import { platform } from '../../platform';
import {
  PHONE_TABS,
  followSelection,
  initialPhoneNav,
  popScreen,
  selectTab,
  selectionOf,
  showTabRoot,
  topScreen,
  type PhoneTab,
} from '../../phone-nav';
import type { MainWindow } from '../../useMainWindow';
import { DEFAULT_SHOWN } from '../../useSessionsWindow';
import { usePageNav, type PageNavAction } from '../../web/page-nav';
import { AddonPaneList } from '../AddonPane';
import { AddonScreenView, AddonToolbarButtons } from '../AddonScreen';
import { ProjectDetail } from '../ProjectDetail';
import { SessionList } from '../SessionList';
import { TaskDetail } from '../TaskDetail';
import { TaskList } from '../TaskList';
import { PhoneDashboard } from './PhoneDashboard';
import { EmptyRow, Group, LargeTitle, Row } from './PhoneList';

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
    setNav((n) => followSelection(n, { task: m.selected, project: m.projectSel, addon: m.addonSel }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.selected, m.projectSel, addonKey]);

  // View → Dashboard.
  useEffect(() => {
    if (m.dashboardShown) setNav((n) => showTabRoot(n, 'dashboard'));
  }, [m.dashboardShown]);

  const back = top ? () => setNav(popScreen) : undefined;
  const { title, actions, body } = screenFor(m, nav.tab);
  usePageNav({ title, back, actions, ownsBottom: true, largeTitle: platform === 'ios' && !top });

  return (
    <div className={`phone-main phone-page tab-${nav.tab}${top ? ' pushed' : ''}`}>
      <div className="phone-screen">{body}</div>
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

/** The current screen: the selected item's, or the tab's list. */
function screenFor(m: MainWindow, tab: PhoneTab): { title: string; actions: PageNavAction[]; body: React.ReactNode } {
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
      body: (
        <div className="phone-detail" onContextMenu={(e) => taskMenuAt(e, m)}>
          <TaskDetail
            key={task.id}
            task={task}
            project={m.projects.find((p) => p.id === task.projectId)}
            environments={m.info?.settings.environments ?? []}
            runtime={rt}
            records={m.records[task.id] ?? []}
            now={m.now}
            tab={m.tab}
            onTab={m.setTab}
            hideNoActionRuns={m.view?.hideNoActionRuns ?? false}
            hideChatsAndTerminals={m.view?.hideChatsAndTerminals ?? false}
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
        { id: 'chat', label: 'New Chat', icon: 'newChat', run: () => void window.looper.projects.newChat(project.id) },
        { id: 'edit', label: 'Edit Project', icon: 'edit', run: () => void window.looper.projects.openEditor(project.id) },
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
            now={m.now}
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
  switch (tab) {
    case 'dashboard':
      return { title: 'Dashboard', actions: [], body: <PhoneDashboard m={m} /> };
    case 'projects':
      return {
        title: 'Projects',
        actions: [{ id: 'new', label: 'New Project', icon: 'add', run: () => void window.looper.projects.openEditor() }],
        body: <PhoneProjects m={m} />,
      };
    case 'tasks':
      return {
        title: 'Tasks',
        actions: [{ id: 'new', label: 'New Task', icon: 'add', run: () => m.uiAction('new-task') }],
        body: <PhoneTasks m={m} />,
      };
    case 'sessions':
      return {
        title: 'Chats',
        actions: [
          { id: 'chat', label: 'New Chat', icon: 'newChat', run: () => window.looper.sessions.showNewMenu('chat', 0, 0) },
          { id: 'terminal', label: 'New Terminal', icon: 'terminal', run: () => window.looper.sessions.showNewMenu('terminal', 0, 0) },
        ],
        body: <PhoneSessionsTab m={m} />,
      };
  }
}

/** A long press on the task's screen: the task's menu, as a right-click on its row. */
function taskMenuAt(e: React.MouseEvent, m: MainWindow) {
  if (!m.task) return;
  // The run log, the terminal and links have menus of their own.
  if ((e.target as HTMLElement).closest('.run-row, .terminal, .terminal-wrap, a, input, textarea, select')) return;
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

function PhoneProjects({ m }: { m: MainWindow }) {
  const projectsMenu = () => window.looper.projects.showContextMenu('');
  return (
    <div className="pg-scroll">
      <LargeTitle>Projects</LargeTitle>
      <Group onTitleMenu={projectsMenu}>
        {m.projects.length === 0 ? (
          <EmptyRow onMenu={projectsMenu}>No projects yet.</EmptyRow>
        ) : (
          m.projects.map((p) => (
            <Row
              key={p.id}
              title={p.name}
              sub={<span className="mono">{p.cwd}</span>}
              chevron
              onOpen={() => m.selectProject(p.id)}
              onMenu={() => {
                m.selectProject(p.id);
                window.looper.projects.showContextMenu(p.id);
              }}
            />
          ))
        )}
      </Group>
    </div>
  );
}

/** Every task in one list (folders as its groups), then the addons' panes and buttons, as the sidebar stacks them. */
function PhoneTasks({ m }: { m: MainWindow }) {
  const [queries, setQueries] = useState<Record<string, string>>({});
  const view = m.view;
  if (!view) return <div className="pg-scroll" />;
  const panes = m.addons
    .filter((a) => a.enabled)
    .flatMap((a) =>
      a.panes
        .filter((p) => (view.addonPanes[addonPaneKey(a.id, p.id)] ?? { visible: true }).visible)
        .map((p) => ({ addon: a, pane: p, key: addonPaneKey(a.id, p.id) })),
    );
  const toolbars = m.addons.filter((a) => a.enabled && a.toolbar.length && !view.hiddenAddonToolbars.includes(a.id));
  return (
    <div className="pg-scroll">
      <LargeTitle>Tasks</LargeTitle>
      <section className="pg-group pg-tasks">
        <TaskList
          tasks={m.tasks}
          folders={m.folders}
          layout={m.layout}
          runtimes={m.runtimes}
          selected={m.selected}
          now={m.now}
          onSelect={(id) => {
            if (id) m.select(id);
          }}
          compact={false}
          pane={null}
          options={view.single}
          showEmptyFolders
          autoOpenFolders={view.autoOpenFolders}
        />
      </section>
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
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const shown = m.addonShown!;
  return (
    <div className="phone-detail">
      {!m.view?.hiddenAddonToolbars.includes(shown.addon.id) && <div className="toolbar pg-addon-toolbar" ref={setSlot} />}
      <AddonScreenView
        key={`${shown.addon.id}/${shown.item.view}/${JSON.stringify(shown.item.params ?? {})}`}
        addonId={shown.addon.id}
        addonName={shown.addon.name}
        view={shown.item.view}
        params={shown.item.params ?? {}}
        mode="main"
        toolbarSlot={slot}
        toolbarSep={false}
      />
    </div>
  );
}

/**
 * The Chats tab: every chat and terminal session, grouped by project with
 * the ones waiting for you first, as the Chats window lists them. A tapped
 * one opens in the Chats window, which pushes over this one.
 */
function PhoneSessionsTab({ m }: { m: MainWindow }) {
  const [state, setState] = useState<SessionsState | null>(null);
  useEffect(() => {
    void window.looper.sessions.state().then(setState);
    return subscribe((e) => {
      if (e.type === 'sessions') setState(e.state);
    });
  }, []);
  const view = m.view;
  const shown = view?.sessions ?? DEFAULT_SHOWN;
  const toggleGroup = (key: string) => {
    if (!view) return;
    const collapsed = shown.collapsed.includes(key) ? shown.collapsed.filter((k) => k !== key) : [...shown.collapsed, key];
    m.changeView({ sessions: { ...shown, collapsed } });
  };
  return (
    <div className="pg-scroll">
      <LargeTitle>Chats</LargeTitle>
      <Group>
        <Row title="Overview" chevron onOpen={() => window.looper.sessions.openWindow()} />
      </Group>
      {state && (
        <section className="pg-group pg-sessions">
          <SessionList
            sessions={state.sessions}
            selected={null}
            now={m.now}
            collapsed={shown.collapsed}
            onToggle={toggleGroup}
            onSelect={(id) => {
              if (id) window.looper.sessions.openWindow(id);
            }}
            selectOnMenu={false}
          />
        </section>
      )}
    </div>
  );
}
