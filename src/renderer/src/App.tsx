import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo } from '@shared/api';
import type { LogLine, RunRecord, Task, TaskRuntime } from '@shared/types';
import { subscribe } from './events';
import { TaskList } from './components/TaskList';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { EngineLog } from './components/EngineLog';

const MAX_RECORDS = 500;
const MAX_LOG = 300;

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [records, setRecords] = useState<Record<string, RunRecord[]>>({});
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('log');
  const [showLog, setShowLog] = useState(false);
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
        case 'record':
          setRecords((m) => {
            const list = m[e.record.taskId];
            if (!list) return m; // not loaded yet: will be fetched on select
            const next = [...list, e.record];
            return { ...m, [e.record.taskId]: next.slice(Math.max(0, next.length - MAX_RECORDS)) };
          });
          break;
        case 'log':
          setLogLines((l) => [...l, e.line].slice(-MAX_LOG));
          break;
      }
    });
    const unsubUi = window.looper.onUi((e) => {
      const { selected: sel, tasks: ts, runtimes: rts } = uiRef.current;
      switch (e.type) {
        case 'toggle-log':
          setShowLog((v) => !v);
          break;
        case 'run-now':
          if (sel) void window.looper.runtime.runNow(sel).catch(() => undefined);
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
        case 'delete-task': {
          const t = ts.find((x) => x.id === sel);
          if (t && window.confirm(`Delete task "${t.name}"?`)) void window.looper.tasks.remove(t.id);
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
    const order: DetailTab[] = ['log', 'terminal'];
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
      } else if (e.key === 'Escape') {
        setShowLog(false);
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

  const select = useCallback((id: string) => {
    setSelected(id);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Tasks</span>
          <button className="btn small" onClick={() => void window.looper.openEditor()} title="New task (Ctrl+N)">
            + New
          </button>
        </div>
        <TaskList tasks={tasks} runtimes={runtimes} selected={selected} now={now} onSelect={select} />
      </aside>
      <main className="main">
        {task ? (
          <TaskDetail
            key={task.id}
            task={task}
            runtime={runtimes[task.id]}
            records={records[task.id] ?? []}
            now={now}
            tab={tab}
            onTab={setTab}
          />
        ) : (
          <div className="empty">
            <h2>No tasks yet</h2>
            <p>
              Create one with <b>+ New</b>, start from{' '}
              <button className="link" onClick={() => void window.looper.openExampleEditor()}>
                the example task
              </button>
              , or drop a task JSON into the inbox
              {info ? <code> {info.inboxDir}</code> : null} (e.g. <code>looper add task.json</code>).
            </p>
          </div>
        )}
        {showLog && <EngineLog lines={logLines} onClose={() => setShowLog(false)} />}
      </main>
    </div>
  );
}
