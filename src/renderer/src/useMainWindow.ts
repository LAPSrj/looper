import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo } from '@shared/api';
import type { AddonContext, CommandContext } from '@shared/commands/context';
import { mainTabs } from '@shared/main-tabs';
import type { RemoteState } from '@shared/remote';
import { isStandInTaskId } from '@shared/projects';
import type { PreventSleepState, Project, ProjectFolder, RestState, RunRecord, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { attentionKey, attentionRows, runningRows, type AttentionRow, type RecentRun } from '@shared/dashboard';
import { addonPaneKey } from '@shared/addons';
import { loginRowKey, loginRows, type ClaudeLogin, type LoginRow } from '@shared/logins';
import { subscribe } from './events';
import { useAddons, type AddonSelection } from './components/AddonPane';
import type { DashboardPick } from './components/Dashboard';
import type { DetailTab } from './components/TaskDetail';
import { useDialogKeys } from './components/hooks';

const MAX_RECORDS = 500;
const RECENT_RUNS = 10;

/** The status bar's Prevent Sleep text while its timer is on; null while it's off. */
export function preventSleepStatus(state: PreventSleepState): string | null {
  if (state.timer === 'off') return null;
  if (state.until === null) return 'Preventing sleep';
  return `Preventing sleep until ${new Date(state.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * The main window's state and commands, shared by its desktop and phone
 * views: the tasks, projects and runtimes it shows and keeps current, what is
 * selected, and the dashboard's lists. `menuTab`: the desktop's shown tab, which
 * the commands follow.
 */
export function useMainWindow(menuTab?: string) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  // False until the tasks and the runtimes have both answered: the counts before that are placeholders.
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [projectLayout, setProjectLayout] = useState<Record<string, string[]>>({});
  // The project whose view shows; picking a task or an addon item clears it.
  const [projectSel, setProjectSel] = useState<string | null>(null);
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [layout, setLayout] = useState<Record<string, string[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [records, setRecords] = useState<Record<string, RunRecord[]>>({});
  // null = no task selected: the dashboard shows.
  const [selected, setSelected] = useState<string | null>(null);
  // The dashboard row picked while it shows.
  const [pick, setPick] = useState<DashboardPick | null>(null);
  const [tab, setTab] = useState<DetailTab>('status');
  // Run to select in the run log (notification click); a fresh object per click re-triggers.
  const [focusRun, setFocusRun] = useState<{ runId: string } | null>(null);
  const [rest, setRest] = useState<RestState | null>(null);
  const [preventSleep, setPreventSleep] = useState<PreventSleepState | null>(null);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  // null until the dashboard first loads them.
  const [recent, setRecent] = useState<RecentRun[] | null>(null);
  // Counts run records and task changes, so the dashboard reads the recent runs again.
  const [runsChanged, setRunsChanged] = useState(0);
  // Counts View → Dashboard, so a phone view can go back to its dashboard.
  const [dashboardShown, setDashboardShown] = useState(0);
  const { addons, panes: addonPanes, reload: reloadAddon, loaded: addonsLoaded } = useAddons();
  // The addon pane item whose screen shows; picking a task clears it.
  const [addonSel, setAddonSel] = useState<AddonSelection | null>(null);
  const runningAddons = addons.filter((a) => a.status === 'running').length;

  const allAttention = useMemo(() => attentionRows(tasks, runtimes), [tasks, runtimes]);
  const attentionCleared = info?.settings.view.attentionCleared;
  const attention = useMemo(() => allAttention.filter((r) => !attentionCleared?.includes(attentionKey(r))), [allAttention, attentionCleared]);
  // The Claude Code logins; null until they load.
  const [logins, setLogins] = useState<ClaudeLogin[] | null>(null);
  const allLoginRows = useMemo(() => loginRows(logins ?? []), [logins]);
  const loginAttention = useMemo(() => allLoginRows.filter((r) => !attentionCleared?.includes(loginRowKey(r))), [allLoginRows, attentionCleared]);
  const running =useMemo(() => runningRows(tasks, runtimes), [tasks, runtimes]);
  // Remote Control's open conversations while it runs; null while it's stopped.
  const remoteOpen = useMemo(
    () => (remote?.running ? remote.conversations.filter((c) => c.status !== 'ended') : null),
    [remote],
  );
  // Runs another dashboard list shows stay out of Recent runs: one in progress shows there once it ends.
  const listedRuns = useMemo(
    () =>
      new Set([
        ...attention.map((r) => `${r.task.id}/${r.runId ?? r.lastRunId}`),
        ...running.map((r) => `${r.task.id}/${r.runId}`),
        ...(remoteOpen ?? []).map((c) => `${c.taskId}/${c.id}`),
      ]),
    [attention, running, remoteOpen],
  );
  const recentShown = useMemo(
    () => recent?.filter((r) => !listedRuns.has(`${r.taskId}/${r.runId}`)).slice(0, RECENT_RUNS) ?? null,
    [recent, listedRuns],
  );
  // A picked row that left its list (the run ended, the problem cleared) no longer counts.
  const pickedRows = (list: DashboardPick['list']) =>
    list === 'remote'
      ? (remoteOpen ?? []).map((c) => ({ taskId: c.taskId, runId: c.id }))
      : list === 'login'
        ? loginAttention.map((r) => ({ taskId: r.login.key, runId: null }))
        : list === 'recent'
          ? (recentShown ?? []).map((r) => ({ taskId: r.taskId, runId: r.runId }))
          : (list === 'attention' ? attention : running).map((r) => ({ taskId: r.task.id, runId: r.runId }));
  // A row picked on a dashboard (the Dashboard tab's, or the Tasks tab's with no task selected) counts only while it shows.
  const onDashboard = menuTab === undefined || menuTab === 'dashboard' || (menuTab === 'tasks' && !addonSel);
  const livePick =
    !selected && onDashboard && pick && pickedRows(pick.list).some((r) => r.taskId === pick.taskId && r.runId === pick.runId) ? pick : null;
  // The task menus act on: the selected task, or the dashboard row's (a task's, not a conversation's or a folder project's run).
  const taskPick = livePick?.list === 'remote' || livePick?.list === 'login' || (livePick && isStandInTaskId(livePick.taskId)) ? null : livePick;
  const target = selected ?? taskPick?.taskId ?? null;

  // On the dashboard, Stop Task stops the picked row's run.
  // The selected project, while no task is: the toolbar's edit, chat, terminal and folder buttons act on it.
  const taskProject = tasks.find((t) => t.id === target)?.projectId;
  const menuProject = projectSel ?? (taskProject && projects.some((p) => p.id === taskProject) ? taskProject : null);
  const pickedRun = selected ? null : (taskPick?.runId ?? null);

  const openTask = useCallback((e: { taskId: string; runId: string; view: DetailTab }) => {
    setSelected(e.taskId);
    setTab(e.view);
    setFocusRun(e.view === 'runs' && e.runId ? { runId: e.runId } : null);
  }, []);

  useEffect(() => {
    void window.looper.info().then(setInfo);
    void Promise.all([
      window.looper.tasks.list().then(setTasks),
      window.looper.runtime.list().then((list) => {
        const map: Record<string, TaskRuntime> = {};
        for (const rt of list) map[rt.taskId] = rt;
        setRuntimes(map);
      }),
    ]).finally(() => setLoaded(true));
    void window.looper.projects.list().then(setProjects);
    void window.looper.projects.folders().then(setProjectFolders);
    void window.looper.projects.layout().then(setProjectLayout);
    void window.looper.folders.list().then(setFolders);
    void window.looper.folders.layout().then(setLayout);
    void window.looper.restState().then(setRest);
    void window.looper.preventSleepState().then(setPreventSleep);
    void window.looper.remote.state().then(setRemote);
    void window.looper.logins.list().then(setLogins);
    const unsub = subscribe((e) => {
      switch (e.type) {
        case 'logins':
          setLogins(e.logins);
          break;
        case 'remote':
          setRemote(e.state);
          break;
        case 'tasks':
          setTasks(e.tasks);
          setRunsChanged((n) => n + 1);
          break;
        case 'projects':
          setProjects(e.projects);
          break;
        case 'project-folders':
          setProjectFolders(e.folders);
          setProjectLayout(e.layout);
          break;
        case 'folders':
          setFolders(e.folders);
          setLayout(e.layout);
          break;
        case 'runtime':
          setRuntimes((m) => ({ ...m, [e.runtime.taskId]: e.runtime }));
          break;
        case 'settings':
          setInfo((i) => (i ? { ...i, settings: e.settings } : i));
          break;
        case 'rest':
          setRest(e.rest);
          break;
        case 'prevent-sleep':
          setPreventSleep(e.state);
          break;
        case 'record':
          setRunsChanged((n) => n + 1);
          setRecords((m) => {
            const list = m[e.record.taskId];
            if (!list) return m; // not loaded yet: will be fetched on select
            const next = [...list, e.record];
            return { ...m, [e.record.taskId]: next.slice(Math.max(0, next.length - MAX_RECORDS)) };
          });
          break;
      }
    });
    const unsubUi = window.looper.onUi((e) => {
      if (e.type === 'open-task') openTask(e);
    });
    const unsubAddons = window.looper.addons.onEvent((e) => {
      if (e.type !== 'select') return;
      setSelected(null);
      setProjectSel(null);
      setAddonSel({ addonId: e.addonId, pane: e.pane, item: e.item });
    });
    return () => {
      unsub();
      unsubUi();
      unsubAddons();
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    setAddonSel(null);
    setProjectSel(null);
  }, [selected]);

  useEffect(() => {
    if (projectSel && !projects.some((p) => p.id === projectSel)) setProjectSel(null);
  }, [projects, projectSel]);

  // Ctrl+Tab and Ctrl+PageUp/PageDown step through a task's tabs where the task shows.
  useDialogKeys<DetailTab>({ tabs: ['status', 'runs'], tab, onTab: menuTab === undefined || menuTab === 'tasks' ? setTab : undefined });

  useEffect(() => {
    if (!selected || records[selected]) return;
    void window.looper.runs.list(selected, MAX_RECORDS).then((list) =>
      setRecords((m) => ({ ...m, [selected]: list })),
    );
  }, [selected, records]);

  useEffect(() => {
    if (selected && !tasks.some((t) => t.id === selected)) setSelected(null);
  }, [tasks, selected]);

  const infoLoaded = info !== null;
  const runFilter = info?.settings.view.runFilter;
  const filterKey = JSON.stringify(runFilter ?? null);
  // Each run another list shows can hide one from Recent runs: read that many more.
  const recentLimit = RECENT_RUNS + listedRuns.size;
  useEffect(() => {
    if (selected || !infoLoaded) return;
    // A run writes its records in quick bursts: read once the burst is over.
    const t = setTimeout(() => {
      void window.looper.runs.recent(recentLimit, runFilter ?? { hideSkipped: false, hideNoAction: false }).then(setRecent);
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, infoLoaded, filterKey, runsChanged, recentLimit]);

  const select = useCallback((id: string | null) => {
    setSelected(id);
  }, []);

  const selectProject = useCallback((id: string | null) => {
    setSelected(null);
    setAddonSel(null);
    setProjectSel(id);
  }, []);

  const selectAddon = useCallback((sel: AddonSelection | null) => {
    setSelected(null);
    setProjectSel(null);
    setAddonSel(sel);
  }, []);

  const openFromDashboard = useCallback((taskId: string, view: DetailTab) => {
    setSelected(taskId);
    setTab(view);
    setFocusRun(null);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);
  const project = useMemo(() => (task ? null : (projects.find((p) => p.id === projectSel) ?? null)), [task, projects, projectSel]);
  const addonShown = useMemo(() => {
    if (!addonSel) return null;
    const addon = addons.find((a) => a.id === addonSel.addonId);
    const pane = addonPanes[addonPaneKey(addonSel.addonId, addonSel.pane)];
    const item = pane?.status === 'ready' ? pane.content.items.find((it) => it.id === addonSel.item) : undefined;
    return addon?.enabled && item ? { addon, item } : null;
  }, [addonSel, addons, addonPanes]);
  const targetTask = useMemo(() => tasks.find((t) => t.id === target) ?? null, [tasks, target]);
  // New Chat and New Terminal start in the selected project, or the selected task's.
  const sessionProject = project ?? (selected ? (projects.find((p) => p.id === targetTask?.projectId) ?? null) : null);
  const view = info?.settings.view;

  // Shown at once; the settings event that follows carries the same view back.
  const changeView = (patch: Partial<View>) => {
    if (!view) return;
    const next = { ...view, ...patch };
    setInfo((i) => (i ? { ...i, settings: { ...i.settings, view: next } } : i));
    void window.looper.updateSettings({ view: next }).catch((e) => void window.looper.showError((e as Error).message));
  };

  /** Clear: these Needs attention rows leave the dashboards, and their runs show in Recent runs. */
  const clearAttention = (rows: AttentionRow[], logins: LoginRow[] = []) =>
    changeView({ attentionCleared: [...(attentionCleared ?? []), ...rows.map(attentionKey), ...logins.map(loginRowKey)] });
  // A row that's gone is forgotten, so the same problem coming back (a run that holds again) shows.
  const loginsLoaded = logins !== null;
  useEffect(() => {
    if (!loaded || !loginsLoaded || !attentionCleared?.length) return;
    const live = new Set([...allAttention.map(attentionKey), ...allLoginRows.map(loginRowKey)]);
    const kept = attentionCleared.filter((k) => live.has(k));
    if (kept.length !== attentionCleared.length) changeView({ attentionCleared: kept });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, loginsLoaded, allAttention, allLoginRows, attentionCleared]);

  /** Show the dashboard, its tab on a phone (Window → Dashboard). */
  const showDashboard = useCallback(() => {
    setSelected(null);
    setAddonSel(null);
    setProjectSel(null);
    setDashboardShown((n) => n + 1);
  }, []);
  const runsCleared = useCallback((taskId: string) => {
    setRecords((m) => ({ ...m, [taskId]: [] }));
    setRunsChanged((n) => n + 1);
  }, []);
  /** What the commands read, on `base` (useCommandState). */
  /**
   * The addon a tab of the window is (its panes tab, or one its screen fills),
   * for the commands it placed there: the pane picked from (or its first), the
   * item picked, and the screen showing.
   */
  const addonContext = (tab: string | undefined, screen: NonNullable<AddonContext['screen']> | null): AddonContext | undefined => {
    const addon = tab ? mainTabs(addons).find((t) => t.id === tab)?.addon : undefined;
    if (!addon) return undefined;
    const own = { id: addon.id, ...(screen ? { screen } : {}) };
    if (addon.tab) return own;
    const sel = addonSel?.addonId === addon.id ? addonSel : null;
    const pane = sel?.pane ?? addons.find((a) => a.id === addon.id)?.panes[0]?.id;
    if (!pane) return own;
    const content = addonPanes[addonPaneKey(addon.id, pane)];
    const picked = sel && addonShown?.addon.id === addon.id ? { pane: sel.pane, id: sel.item, state: addonShown.item.commands } : null;
    return { ...own, panes: { pane, state: content?.status === 'ready' ? content.content.commands : undefined }, item: picked };
  };

  const commandContext = (base: CommandContext): CommandContext => ({
    ...base,
    settings: info?.settings ?? base.settings,
    tab: menuTab,
    task: targetTask,
    runtime: targetTask ? runtimes[targetTask.id] : undefined,
    pickedRun,
    project: projects.find((p) => p.id === menuProject) ?? null,
    projectSelected: !!projectSel && !selected,
    taskSelected: !!selected,
    selectTask: select,
    projects,
    taskFolders: folders,
    projectFolders,
    addons,
    rest,
    preventSleep,
    setView: changeView,
    runsCleared,
    showDashboard,
  });

  const counts = useMemo(() => {
    const enabled = tasks.filter((t) => t.enabled).length;
    const completed = tasks.filter((t) => t.completedAt).length;
    let paused = 0;
    let running = 0;
    for (const t of tasks) {
      const state = runtimes[t.id]?.state;
      if (state === 'paused') paused += 1;
      // A cycle in its check or classifier step is running too.
      else if (state === 'running' || state === 'checking' || state === 'classifying') running += 1;
    }
    return { enabled, disabled: tasks.length - enabled - completed, completed, paused, running };
  }, [tasks, runtimes]);

  return {
    info,
    loaded,
    view,
    tasks,
    projects,
    projectFolders,
    projectLayout,
    folders,
    layout,
    runtimes,
    records,
    rest,
    preventSleep,
    remote,
    remoteOpen,
    counts,
    addons,
    addonsLoaded,
    addonPanes,
    runningAddons,
    reloadAddon,
    // What is selected and shown.
    selected,
    projectSel,
    addonSel,
    task,
    project,
    addonShown,
    targetTask,
    sessionProject,
    tab,
    focusRun,
    dashboardShown,
    // The dashboard.
    attention,
    loginAttention,
    running,
    recentShown,
    livePick,
    // Commands.
    select,
    selectProject,
    selectAddon,
    setTab,
    setPick,
    openFromDashboard,
    commandContext,
    addonContext,
    changeView,
    clearAttention,
  };
}

export type MainWindow = ReturnType<typeof useMainWindow>;
