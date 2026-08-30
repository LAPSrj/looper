import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo } from '@shared/api';
import type { LogLine, RunRecord, Task, TaskRuntime } from '@shared/types';
import { subscribe } from './events';
import { TaskList } from './components/TaskList';
import { TaskDetail, type DetailTab } from './components/TaskDetail';
import { TaskEditor } from './components/TaskEditor';
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
  const [creating, setCreating] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [now, setNow] = useState(Date.now());

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
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsub();
      clearInterval(t);
    };
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
    setCreating(false);
  }, []);

  const task = useMemo(() => tasks.find((t) => t.id === selected) ?? null, [tasks, selected]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">Looper</span>
          <button className="btn small" onClick={() => setCreating(true)} title="New task">
            + New
          </button>
        </div>
        <TaskList tasks={tasks} runtimes={runtimes} selected={creating ? null : selected} now={now} onSelect={select} />
        <div className="sidebar-footer">
          <button className="link" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'hide' : 'show'} engine log
          </button>
          {info && (
            <button className="link" title={info.dataDir} onClick={() => void window.looper.openPath(info.dataDir)}>
              data dir
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        {creating ? (
          <TaskEditor
            task={null}
            onSaved={(t) => {
              setCreating(false);
              setSelected(t.id);
              setTab('log');
            }}
            onCancel={() => setCreating(false)}
          />
        ) : task ? (
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
              Create one with <b>+ New</b>, or drop a task JSON into the inbox
              {info ? <code> {info.inboxDir}</code> : null} (e.g. <code>looper add task.json</code>).
            </p>
          </div>
        )}
        {showLog && <EngineLog lines={logLines} onClose={() => setShowLog(false)} />}
      </main>
    </div>
  );
}
