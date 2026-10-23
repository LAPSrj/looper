import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, UiEvent } from '@shared/api';
import { isRemoteTaskId, type RemoteState } from '@shared/remote';
import type { RestState, RunRecord, Task, TaskFolder, TaskRuntime, View } from '@shared/types';
import { subscribe } from './events';
import { setAppLocale } from './format';
import { attentionRows, runningRows, type RecentRun } from '@shared/dashboard';
import { Dashboard, type DashboardPick } from './components/Dashboard';
import { Sidebar } from './components/Sidebar';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { TaskToolbar } from './components/TaskToolbar';
import { useDialogKeys, useDragResize } from './components/hooks';

const MAX_RECORDS = 500;
const RECENT_RUNS = 10;

function restStatus(rest: RestState, now: number): string {
  if (rest.phase === 'countdown' && rest.sleepAt !== null) {
    return `Rest Mode — sleeping in ${Math.max(0, Math.ceil((rest.sleepAt - now) / 1000))} s`;
  }
  if (rest.phase === 'sleeping') {
    const wake = rest.wakeAt !== null
      ? ` until ${new Date(rest.wakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    return `Rest Mode — sleeping${wake}`;
  }
  return 'Rest Mode — waiting for tasks to finish';
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
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
  const [now, setNow] = useState(Date.now());
  const [rest, setRest] = useState<RestState | null>(null);
  // The run picked in the Terminal tab when several are in flight; Stop Task targets it.
  const [terminalRun, setTerminalRun] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  // null until the dashboard first loads them.
  const [recent, setRecent] = useState<RecentRun[] | null>(null);
  // Counts run records and task changes, so the dashboard reads the recent runs again.
  const [runsChanged, setRunsChanged] = useState(0);

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
  const livePick =
    !selected && pick && pickedRows(pick.list).some((r) => r.taskId === pick.taskId && r.runId === pick.runId) ? pick : null;
  // The task menus act on: the selected task, or the dashboard row's (a task's, not a conversation's or a folder project's run).
  const taskPick = livePick?.list === 'remote' || (livePick && isRemoteTaskId(livePick.taskId)) ? null : livePick;
  const target = selected ?? taskPick?.taskId ?? null;

  // Menu and toolbar commands act on the target task; the ref keeps them acting on current state.
  // On the dashboard, Stop Task stops the picked row's run.
  const uiRef = useRef({ selected: target, tasks, runtimes, terminalRun });
  uiRef.current = { selected: target, tasks, runtimes, terminalRun: selected ? terminalRun : (taskPick?.runId ?? null) };

  const openTask = useCallback((e: { taskId: string; runId: string; view: 'terminal' | 'runs' }) => {
    setSelected(e.taskId);
    setTab(e.view);
    setFocusRun(e.view === 'runs' ? { runId: e.runId } : null);
  }, []);

  const uiAction = useCallback((type: UiEvent['type']) => {
    const { selected: sel, tasks: ts, runtimes: rts, terminalRun: pickedRun } = uiRef.current;
    switch (type) {
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
      case 'open-terminal':
        if (sel) void window.looper.openTaskTerminal(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'open-chat':
        if (sel) void window.looper.openTaskChat(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'open-work-folder':
        if (sel) void window.looper.openTaskWorkFolder(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'show-dashboard':
        setSelected(null);
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
  }, []);

  useEffect(() => {
    void window.looper.info().then((i) => {
      setAppLocale(i.locale);
      setInfo(i);
    });
    void window.looper.tasks.list().then(setTasks);
    void window.looper.folders.list().then(setFolders);
    void window.looper.folders.layout().then(setLayout);
    void window.looper.runtime.list().then((list) => {
      const map: Record<string, TaskRuntime> = {};
      for (const rt of list) map[rt.taskId] = rt;
      setRuntimes(map);
    });
    void window.looper.restState().then(setRest);
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
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsub();
      unsubUi();
      clearInterval(t);
    };
  }, []);

  useDialogKeys<DetailTab>({ tabs: ['status', 'runs', 'terminal'], tab, onTab: setTab });

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
  const hideChatsAndTerminals = info?.settings.view.hideChatsAndTerminals ?? false;
  // Each run another list shows can hide one from Recent runs: read that many more.
  const recentLimit = RECENT_RUNS + listedRuns.size;
  useEffect(() => {
    if (selected || !infoLoaded) return;
    // A run writes its records in quick bursts: read once the burst is over.
    const t = setTimeout(() => {
      void window.looper.runs.recent(recentLimit, { hideNoAction: hideNoActionRuns, hideChatsAndTerminals }).then(setRecent);
    }, 200);
    return () => clearTimeout(t);
  }, [selected, infoLoaded, hideNoActionRuns, hideChatsAndTerminals, runsChanged, recentLimit]);

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
    );
  }, [target, tasks, selectedState, selectedActiveRuns]);

  // A terminal pick belongs to one task.
  useEffect(() => setTerminalRun(null), [selected]);

  const select = useCallback((id: string | null) => {
    setSelected(id);
  }, []);

  const openFromDashboard = useCallback((taskId: string, view: DetailTab) => {
    setSelected(taskId);
    setTab(view);
    setFocusRun(null);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);
  const targetTask = useMemo(() => tasks.find((t) => t.id === target) ?? null, [tasks, target]);
  const view = info?.settings.view;

  // Shown at once; the settings event that follows carries the same view back.
  const changeView = (patch: Partial<View>) => {
    if (!view) return;
    const next = { ...view, ...patch };
    setInfo((i) => (i ? { ...i, settings: { ...i.settings, view: next } } : i));
    void window.looper.updateSettings({ view: next }).catch((e) => void window.looper.showError((e as Error).message));
  };

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const appRef = useRef<HTMLDivElement>(null);

  const onSidebarDragStart = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => setSidebarWidth(Math.max(180, Math.min(rect.width * 0.5, x))),
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

  return (
    <div className="app-shell">
      {(view?.toolbar ?? true) && (
        <TaskToolbar
          // On the dashboard the task buttons are off; the menus still act on the picked row.
          task={selected ? targetTask : null}
          runtime={selected && targetTask ? runtimes[targetTask.id] : undefined}
          dashboard={!selected}
          onAction={uiAction}
        />
      )}
      <div className="app" ref={appRef} style={{ gridTemplateColumns: `${sidebarWidth}px 5px 1fr` }}>
        {view ? (
          <Sidebar
            tasks={tasks}
            folders={folders}
            layout={layout}
            runtimes={runtimes}
            selected={selected}
            now={now}
            onSelect={select}
            view={view}
            onView={changeView}
          />
        ) : (
          <aside className="sidebar" />
        )}
        <div className="sidebar-divider" onMouseDown={onSidebarDragStart} />
        <main className="main">
          {task ? (
            <TaskDetail
              key={task.id}
              task={task}
              environments={info?.settings.environments ?? []}
              runtime={runtimes[task.id]}
              records={records[task.id] ?? []}
              now={now}
              tab={tab}
              onTab={setTab}
              hideNoActionRuns={view?.hideNoActionRuns ?? false}
              hideChatsAndTerminals={view?.hideChatsAndTerminals ?? false}
              focusRun={focusRun}
              terminalRun={terminalRun}
              onTerminalRun={setTerminalRun}
            />
          ) : (
            <Dashboard
              attention={attention}
              running={running}
              remote={remoteOpen}
              recent={recentShown}
              runtimes={runtimes}
              now={now}
              pick={livePick}
              onPick={setPick}
              onOpen={openFromDashboard}
            />
          )}
        </main>
      </div>
      {(view?.statusBar ?? true) && (
        <div className="statusbar">
          {rest?.armed && <span>{restStatus(rest, now)}</span>}
          <span className="spacer" />
          <span>
            {counts.enabled} enabled · {counts.disabled} disabled · {counts.completed} completed · {counts.paused} paused ·{' '}
            {counts.running} running
            {remoteOpen && ` · ${remoteOpen.length} Remote Control session${remoteOpen.length === 1 ? '' : 's'}`}
          </span>
        </div>
      )}
    </div>
  );
}
