import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, UiEvent } from '@shared/api';
import type { RemoteState } from '@shared/remote';
import { isStandInTaskId, projectTaskId } from '@shared/projects';
import type { PreventSleepState, Project, RestState, RunRecord, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { attentionRows, runningRows, type RecentRun } from '@shared/dashboard';
import { addonPaneKey } from '@shared/addons';
import { subscribe } from './events';
import { useAddons, type AddonSelection } from './components/AddonPane';
import { MenuTarget } from './menu-target';
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
 * selected, the dashboard's lists, and the toolbar and menu commands.
 * `menuTab`: the desktop's shown tab, which the menu bar follows (a phone has
 * every menu at once).
 */
export function useMainWindow(menuTab?: string) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  // False until the tasks and the runtimes have both answered: the counts before that are placeholders.
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
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
  // The run picked in the Terminal tab when several are in flight; Stop Task targets it.
  const [terminalRun, setTerminalRun] = useState<string | null>(null);
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

  const attention = useMemo(() => attentionRows(tasks, runtimes), [tasks, runtimes]);
  const running = useMemo(() => runningRows(tasks, runtimes), [tasks, runtimes]);
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
      : list === 'recent'
        ? (recentShown ?? []).map((r) => ({ taskId: r.taskId, runId: r.runId }))
        : (list === 'attention' ? attention : running).map((r) => ({ taskId: r.task.id, runId: r.runId }));
  // A row picked on the Dashboard tab counts only while it shows.
  const onDashboard = menuTab === undefined || menuTab === 'dashboard';
  const livePick =
    !selected && onDashboard && pick && pickedRows(pick.list).some((r) => r.taskId === pick.taskId && r.runId === pick.runId) ? pick : null;
  // The task menus act on: the selected task, or the dashboard row's (a task's, not a conversation's or a folder project's run).
  const taskPick = livePick?.list === 'remote' || (livePick && isStandInTaskId(livePick.taskId)) ? null : livePick;
  const target = selected ?? taskPick?.taskId ?? null;

  // Menu and toolbar commands act on the target task; the ref keeps them acting on current state.
  // On the dashboard, Stop Task stops the picked row's run.
  // The selected project, while no task is: the toolbar's edit, chat, terminal and folder buttons act on it.
  const projectTarget = selected ? null : projectSel;
  // The project the Project menu acts on: the selected project, else the target task's.
  const taskProject = tasks.find((t) => t.id === target)?.projectId;
  const menuProject = projectSel ?? (taskProject && projects.some((p) => p.id === taskProject) ? taskProject : null);
  const uiRef = useRef({ selected: target, project: projectTarget, menuProject, tasks, runtimes, terminalRun });
  uiRef.current = { selected: target, project: projectTarget, menuProject, tasks, runtimes, terminalRun: selected ? terminalRun : (taskPick?.runId ?? null) };

  const openTask = useCallback((e: { taskId: string; runId: string; view: DetailTab }) => {
    setSelected(e.taskId);
    setTab(e.view);
    setFocusRun(e.view === 'runs' && e.runId ? { runId: e.runId } : null);
  }, []);

  // The task a long-pressed row's menu is open for: its command acts on it, not on the selection (which the press must not change).
  const menuTarget = useRef(new MenuTarget()).current;
  const setMenuTarget = useCallback((taskId: string | null) => menuTarget.set(taskId), [menuTarget]);
  useEffect(() => {
    // The popup is drawn outside this page: a touch on the page means it closed without a command.
    const drop = () => menuTarget.clear();
    document.addEventListener('pointerdown', drop, true);
    return () => document.removeEventListener('pointerdown', drop, true);
  }, [menuTarget]);

  const uiAction = useCallback((type: UiEvent['type']) => {
    const forced = menuTarget.take<string | null>(null);
    const ui = uiRef.current;
    const { menuProject: menuProj, tasks: ts, runtimes: rts } = ui;
    const sel = forced ?? ui.selected;
    const proj = forced ? null : ui.project;
    const pickedRun = forced ? null : ui.terminalRun;
    switch (type) {
      case 'edit-project':
        if (menuProj) void window.looper.projects.openEditor(menuProj);
        return;
      case 'open-project-folder':
        if (menuProj) void window.looper.openTaskWorkFolder(projectTaskId(menuProj)).catch((e) => void window.looper.showError((e as Error).message));
        return;
      case 'delete-project':
        if (menuProj) void window.looper.projects.remove(menuProj);
        return;
    }
    if (proj) {
      switch (type) {
        case 'edit-task':
          void window.looper.projects.openEditor(proj);
          return;
        case 'open-chat':
          void window.looper.projects.newChat(proj);
          return;
        case 'open-terminal':
          void window.looper.projects.newTerminal(proj);
          return;
        case 'open-work-folder':
          void window.looper.openTaskWorkFolder(projectTaskId(proj)).catch((e) => void window.looper.showError((e as Error).message));
          return;
        case 'new-task':
          void window.looper.projects.newTask(proj);
          return;
      }
    }
    switch (type) {
      case 'new-task': {
        const t = ts.find((x) => x.id === sel);
        if (t?.projectId) void window.looper.projects.newTask(t.projectId);
        else void window.looper.openEditor();
        break;
      }
      case 'run-now':
        if (sel) {
          const rt = rts[sel];
          if (rt?.state === 'disabled' || rt?.state === 'completed') {
            const t = ts.find((x) => x.id === sel);
            const what = rt.state === 'completed' ? 'completed' : 'disabled';
            void window.looper.confirm(`"${t?.name ?? sel}" is ${what}. Run it anyway?`).then((ok) => {
              if (ok) void window.looper.runtime.runNow(sel).catch(() => undefined);
            });
          } else {
            void window.looper.runtime.runNow(sel).catch(() => undefined);
          }
        }
        break;
      case 'stop-task':
        if (sel) void window.looper.runtime.stopTask(sel, pickedRun ?? undefined);
        break;
      case 'pause-resume':
        if (sel) {
          const rt = rts[sel];
          if (rt?.state === 'paused') void window.looper.runtime.resume(sel);
          else void window.looper.runtime.pause(sel);
        }
        break;
      case 'edit-task':
        if (sel) void window.looper.openEditor(sel);
        break;
      case 'edit-with-agent':
        if (sel) void window.looper.builder.editTask(sel);
        break;
      case 'version-history':
        if (sel) void window.looper.versions.open(sel);
        break;
      case 'edit-note':
        if (sel) void window.looper.openNoteEditor(sel);
        break;
      case 'move-to-folder':
        if (sel) void window.looper.openMoveToFolder(sel);
        break;
      case 'clear-note': {
        const t = ts.find((x) => x.id === sel);
        if (t?.note) void window.looper.tasks.save({ ...t, note: undefined });
        break;
      }
      case 'export-task':
        if (sel) void window.looper.tasks.export(sel);
        break;
      case 'enable-disable': {
        const t = ts.find((x) => x.id === sel);
        if (t && !t.completedAt) void window.looper.tasks.save({ ...t, enabled: !t.enabled });
        break;
      }
      case 'complete-reopen': {
        const t = ts.find((x) => x.id === sel);
        if (!t) break;
        if (t.completedAt) {
          void window.looper.runtime.reopen(t.id);
        } else if (!t.completion.allowed) {
          break;
        } else {
          void window.looper
            .confirm(`Mark "${t.name}" as completed? It won't run again, and after a while it moves to the Recycle Bin.`)
            .then((ok) => {
              if (ok) void window.looper.runtime.complete(t.id);
            });
        }
        break;
      }
      case 'delete-task': {
        // The Recycle Bin can undo a delete, but not a run it stopped: only that asks first.
        const t = ts.find((x) => x.id === sel);
        if (!t) break;
        if ((rts[t.id]?.runs.length ?? 0) > 0) {
          void window.looper
            .confirm(`"${t.name}" is running. Stop it and move it to the Recycle Bin?`)
            .then((ok) => { if (ok) void window.looper.tasks.remove(t.id); });
        } else {
          void window.looper.tasks.remove(t.id);
        }
        break;
      }
      // A task's project: a new session there, on the project's harness and settings.
      case 'open-terminal': {
        const t = ts.find((x) => x.id === sel);
        if (t?.projectId) void window.looper.projects.newTerminal(t.projectId);
        break;
      }
      case 'open-chat': {
        const t = ts.find((x) => x.id === sel);
        if (t?.projectId) void window.looper.projects.newChat(t.projectId);
        break;
      }
      case 'open-work-folder':
        if (sel) void window.looper.openTaskWorkFolder(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'show-dashboard':
        setSelected(null);
        setAddonSel(null);
        setProjectSel(null);
        setDashboardShown((n) => n + 1);
        break;
      case 'clear-runs': {
        const t = ts.find((x) => x.id === sel);
        if (!t) break;
        void window.looper.confirm(`Clear the run history of "${t.name}"? All run logs and outputs are deleted.`).then((ok) => {
          if (!ok) return;
          void window.looper.runs
            .clear(t.id)
            .then(() => {
              setRecords((m) => ({ ...m, [t.id]: [] }));
              setRunsChanged((n) => n + 1);
            })
            .catch((e) => void window.looper.showError((e as Error).message));
        });
        break;
      }
    }
  }, [menuTarget]);

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
    void window.looper.folders.list().then(setFolders);
    void window.looper.folders.layout().then(setLayout);
    void window.looper.restState().then(setRest);
    void window.looper.preventSleepState().then(setPreventSleep);
    void window.looper.remote.state().then(setRemote);
    const unsub = subscribe((e) => {
      switch (e.type) {
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
      else uiAction(e.type);
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
  useDialogKeys<DetailTab>({ tabs: ['status', 'runs', 'terminal'], tab, onTab: menuTab === undefined || menuTab === 'tasks' ? setTab : undefined });

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
  const hideNoActionRuns = info?.settings.view.hideNoActionRuns ?? false;
  // Each run another list shows can hide one from Recent runs: read that many more.
  const recentLimit = RECENT_RUNS + listedRuns.size;
  useEffect(() => {
    if (selected || !infoLoaded) return;
    // A run writes its records in quick bursts: read once the burst is over.
    const t = setTimeout(() => {
      void window.looper.runs.recent(recentLimit, { hideNoAction: hideNoActionRuns }).then(setRecent);
    }, 200);
    return () => clearTimeout(t);
  }, [selected, infoLoaded, hideNoActionRuns, runsChanged, recentLimit]);

  const selectedState = target ? runtimes[target]?.state : undefined;
  const selectedActiveRuns = target ? runtimes[target]?.runs.length ?? 0 : 0;

  useEffect(() => {
    const t = tasks.find((x) => x.id === target);
    const active = selectedState === 'running' || selectedState === 'checking' || selectedState === 'classifying';
    const canRunNow = !active || selectedActiveRuns < (t?.maxConcurrentRuns ?? 1);
    window.looper.reportSelection(
      !!target,
      t?.enabled,
      selectedState === 'paused',
      selectedState,
      !!t?.note,
      canRunNow,
      !!t?.completedAt,
      !!t?.completion.allowed,
      !!menuProject,
      menuTab,
    );
  }, [target, tasks, selectedState, selectedActiveRuns, menuProject, menuTab]);

  // A terminal pick belongs to one task.
  useEffect(() => setTerminalRun(null), [selected]);

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
    folders,
    layout,
    runtimes,
    records,
    rest,
    preventSleep,
    remote,
    remoteOpen,
    // False until Remote Control's state answers: before that its sessions can't be told from none.
    remoteLoaded: remote !== null,
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
    terminalRun,
    dashboardShown,
    // The dashboard.
    attention,
    running,
    recentShown,
    livePick,
    // Commands.
    select,
    selectProject,
    selectAddon,
    setTab,
    setPick,
    setMenuTarget,
    setTerminalRun,
    openFromDashboard,
    uiAction,
    changeView,
  };
}

export type MainWindow = ReturnType<typeof useMainWindow>;
