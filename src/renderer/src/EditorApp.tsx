import { useEffect, useState } from 'react';
import type { Target, Task } from '@shared/types';
import { TaskEditor } from './components/TaskEditor';

/** Standalone editor window (opened from the menu or the + New button). */
export function EditorApp({ taskId }: { taskId?: string }) {
  // undefined = still loading; null = new task
  const [task, setTask] = useState<Task | null | undefined>(taskId ? undefined : null);
  const [defaultTarget, setDefaultTarget] = useState<Target | undefined>(undefined);
  const [ready, setReady] = useState(!!taskId);

  useEffect(() => {
    document.title = taskId ? 'Edit Task — Looper' : 'New Task — Looper';
    if (taskId) {
      void window.looper.tasks.list().then((tasks) => {
        const found = tasks.find((t) => t.id === taskId) ?? null;
        setTask(found);
        if (found) document.title = `${found.name} — Looper`;
      });
    } else {
      void window.looper.info().then((info) => {
        const s = info.settings;
        setDefaultTarget(s.defaultTarget === 'windows' ? { kind: 'windows' } : { kind: 'wsl', distro: s.defaultDistro });
        setReady(true);
      });
    }
  }, [taskId]);

  if (task === undefined || !ready) return <div className="empty">Loading…</div>;
  return (
    <div className="editor-window">
      <TaskEditor
        task={task}
        defaultTarget={defaultTarget}
        standalone
        onSaved={() => window.close()}
        onCancel={() => window.close()}
      />
    </div>
  );
}
