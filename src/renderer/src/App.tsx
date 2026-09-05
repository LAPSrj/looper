import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, UiEvent } from '@shared/api';
import type { RunRecord, Task, TaskFolder, TaskRuntime } from '@shared/types';
import { subscribe } from './events';
import { TaskList } from './components/TaskList';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { TaskToolbar } from './components/TaskToolbar';
import { useDialogKeys, useDragResize } from './components/hooks';

const MAX_RECORDS = 500;

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [folders, setFolders] = useState<TaskFolder[]>([]);
  const [layout, setLayout] = useState<Record<string, string[]>>({});
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [records, setRecords] = useState<Record<string, RunRecord[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('status');
  // Run to select in the run log (notification click); a fresh object per click re-triggers.
  const [focusRun, setFocusRun] = useState<{ runId: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  // Menu and toolbar commands act on the selected task; the ref keeps them acting on current state.
  const uiRef = useRef({ selected, tasks, runtimes });
  uiRef.current = { selected, tasks, runtimes };

  const openTask = useCallback((e: { taskId: string; runId: string; view: 'terminal' | 'log' }) => {
    setSelected(e.taskId);
    setTab(e.view);
    setFocusRun(e.view === 'log' ? { runId: e.runId } : null);
  }, []);

  const uiAction = useCallback((type: UiEvent['type']) => {
    const { selected: sel, tasks: ts, runtimes: rts } = uiRef.current;
    switch (type) {
      case 'run-now':
        if (sel) {
          const rt = rts[sel];
          if (rt?.state === 'disabled') {
            const t = ts.find((x) => x.id === sel);
            void window.looper.confirm(`"${t?.name ?? sel}" is disabled. Run it anyway?`).then((ok) => {
              if (ok) void window.looper.runtime.runNow(sel).catch(() => undefined);
            });
          } else {
            void window.looper.runtime.runNow(sel).catch(() => undefined);
          }
        }
        break;
      case 'stop-task':
        if (sel) void window.looper.runtime.stopTask(sel);
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
        if (t) void window.looper.tasks.save({ ...t, enabled: !t.enabled });
        break;
      }
      case 'delete-task': {
        const t = ts.find((x) => x.id === sel);
        if (t) void window.looper.confirm(`Delete task "${t.name}"?`).then((ok) => { if (ok) void window.looper.tasks.remove(t.id); });
        break;
      }
      case 'open-terminal':
        if (sel) void window.looper.openTaskTerminal(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'open-work-folder':
        if (sel) void window.looper.openTaskWorkFolder(sel).catch((e) => void window.looper.showError((e as Error).message));
        break;
      case 'clear-runs': {
        const t = ts.find((x) => x.id === sel);
        if (!t) break;
        void window.looper.confirm(`Clear the run history of "${t.name}"? All run logs and outputs are deleted.`).then((ok) => {
          if (!ok) return;
          void window.looper.runs
            .clear(t.id)
            .then(() => setRecords((m) => ({ ...m, [t.id]: [] })))
            .catch((e) => void window.looper.showError((e as Error).message));
        });
        break;
      }
    }
  }, []);

  useEffect(() => {
    void window.looper.info().then(setInfo);
    void window.looper.tasks.list().then((t) => {
      setTasks(t);
      setSelected((s) => s ?? t[0]?.id ?? null);
    });
    void window.looper.folders.list().then(setFolders);
    void window.looper.folders.layout().then(setLayout);
    void window.looper.runtime.list().then((list) => {
      const map: Record<string, TaskRuntime> = {};
      for (const rt of list) map[rt.taskId] = rt;
      setRuntimes(map);
    });
    const unsub = subscribe((e) => {
      switch (e.type) {
        case 'tasks':
          setTasks(e.tasks);
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
        case 'record':
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

  useDialogKeys<DetailTab>({ tabs: ['status', 'log', 'messages', 'terminal'], tab, onTab: setTab });

  useEffect(() => {
    if (!selected || records[selected]) return;
    void window.looper.runs.list(selected, MAX_RECORDS).then((list) =>
      setRecords((m) => ({ ...m, [selected]: list })),
    );
  }, [selected, records]);

  useEffect(() => {
    if (selected && !tasks.some((t) => t.id === selected)) setSelected(tasks[0]?.id ?? null);
  }, [tasks, selected]);

  const selectedState = selected ? runtimes[selected]?.state : undefined;

  useEffect(() => {
    const t = tasks.find((x) => x.id === selected);
    window.looper.reportSelection(!!selected, t?.enabled, selectedState === 'paused', selectedState, !!t?.note);
  }, [selected, tasks, selectedState]);

  const select = useCallback((id: string) => {
    setSelected(id);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);
  const view = info?.settings.view;

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const appRef = useRef<HTMLDivElement>(null);

  const onSidebarDragStart = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => setSidebarWidth(Math.max(180, Math.min(rect.width * 0.5, x))),
  });

  const counts = useMemo(() => {
    const enabled = tasks.filter((t) => t.enabled).length;
    let paused = 0;
    let running = 0;
    for (const t of tasks) {
      const state = runtimes[t.id]?.state;
      if (state === 'paused') paused += 1;
      else if (state === 'running') running += 1;
    }
    return { enabled, disabled: tasks.length - enabled, paused, running };
  }, [tasks, runtimes]);

  return (
    <div className="app-shell">
      {(view?.toolbar ?? true) && (
        <TaskToolbar task={task} runtime={task ? runtimes[task.id] : undefined} onAction={uiAction} />
      )}
      <div className="app" ref={appRef} style={{ gridTemplateColumns: `${sidebarWidth}px 5px 1fr` }}>
        <aside className="sidebar">
          <div
            className="sidebar-header"
            onContextMenu={(e) => {
              e.preventDefault();
              window.looper.showTasksEmptyContextMenu();
            }}
          >
            <span className="pane-title">Tasks</span>
          </div>
          <TaskList
            tasks={tasks}
            folders={folders}
            layout={layout}
            runtimes={runtimes}
            selected={selected}
            now={now}
            onSelect={select}
            compact={view?.taskList === 'compact'}
            showDisabled={view?.showDisabledTasks ?? true}
            showScheduled={view?.showScheduledTasks ?? true}
            showManual={view?.showManualTasks ?? true}
            autoOpenFolders={view?.autoOpenFolders ?? false}
          />
        </aside>
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
              focusRun={focusRun}
            />
          ) : (
            <div className="empty" />
          )}
        </main>
      </div>
      {(view?.statusBar ?? true) && (
        <div className="statusbar">
          <span className="spacer" />
          <span>
            {counts.enabled} enabled · {counts.disabled} disabled · {counts.paused} paused · {counts.running} running
          </span>
        </div>
      )}
    </div>
  );
}
