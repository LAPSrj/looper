import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo } from '@shared/api';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { subscribe } from './events';
import { TaskList } from './components/TaskList';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { useDialogKeys, useDragResize } from './components/hooks';

const MAX_RECORDS = 500;

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [records, setRecords] = useState<Record<string, RunRecord[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('status');
  const [now, setNow] = useState(Date.now());

  // Menu commands arrive through a single subscription; the ref keeps them acting on current state.
  const uiRef = useRef({ selected, tasks, runtimes });
  uiRef.current = { selected, tasks, runtimes };

  useEffect(() => {
    void window.looper.info().then(setInfo);
    void window.looper.tasks.list().then((t) => {
      setTasks(t);
      setSelected((s) => s ?? t[0]?.id ?? null);
    });
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
      const { selected: sel, tasks: ts, runtimes: rts } = uiRef.current;
      switch (e.type) {
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
        case 'stop-agent':
          if (sel) void window.looper.runtime.stopAgent(sel);
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
      }
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsub();
      unsubUi();
      clearInterval(t);
    };
  }, []);

  useDialogKeys<DetailTab>({ tabs: ['status', 'log', 'terminal'], tab, onTab: setTab });

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
    window.looper.reportSelection(!!selected, t?.enabled, selectedState === 'paused', selectedState);
  }, [selected, tasks, selectedState]);

  const select = useCallback((id: string) => {
    setSelected(id);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const appRef = useRef<HTMLDivElement>(null);

  const onSidebarDragStart = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => setSidebarWidth(Math.max(180, Math.min(rect.width * 0.5, x))),
  });

  return (
    <div className="app" ref={appRef} style={{ gridTemplateColumns: `${sidebarWidth}px 5px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="pane-title">Tasks</span>
        </div>
        <TaskList tasks={tasks} runtimes={runtimes} selected={selected} now={now} onSelect={select} />
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
          />
        ) : (
          <div className="empty" />
        )}
      </main>
    </div>
  );
}
