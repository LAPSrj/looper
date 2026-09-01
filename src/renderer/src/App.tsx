import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { AppInfo } from '@shared/api';
import type { RunRecord, Task, TaskRuntime } from '@shared/types';
import { subscribe } from './events';
import { TaskList } from './components/TaskList';
import { TaskDetail, type DetailTab } from './components/TaskDetail';

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

  // Keyboard: Ctrl+Tab / Ctrl+PageDown|PageUp cycle the detail tabs; Esc closes the engine log.
  useEffect(() => {
    const order: DetailTab[] = ['status', 'log', 'terminal'];
    const onKey = (e: KeyboardEvent) => {
      const cycle = (dir: number) =>
        setTab((t) => order[(order.indexOf(t) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const draggingSidebar = useRef(false);

  const onSidebarDragStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    draggingSidebar.current = true;
    document.body.style.cursor = 'col-resize';
    const onMove = (me: globalThis.MouseEvent) => {
      if (!draggingSidebar.current || !appRef.current) return;
      const rect = appRef.current.getBoundingClientRect();
      const w = me.clientX - rect.left;
      setSidebarWidth(Math.max(180, Math.min(rect.width * 0.5, w)));
    };
    const onUp = () => {
      draggingSidebar.current = false;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

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
