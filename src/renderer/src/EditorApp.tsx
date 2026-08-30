import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { TaskEditor } from './components/TaskEditor';

/** Standalone editor window (opened from the menu or the + New button). */
export function EditorApp({ taskId }: { taskId?: string }) {
  // undefined = still loading the task; null = new task
  const [task, setTask] = useState<Task | null | undefined>(taskId ? undefined : null);

  useEffect(() => {
    document.title = taskId ? 'Looper — Edit Task' : 'Looper — New Task';
    if (!taskId) return;
    void window.looper.tasks.list().then((tasks) => {
      setTask(tasks.find((t) => t.id === taskId) ?? null);
    });
  }, [taskId]);

  if (task === undefined) return <div className="empty">Loading…</div>;
  return (
    <div className="editor-window">
      <TaskEditor task={task} onSaved={() => window.close()} onCancel={() => window.close()} />
    </div>
  );
}
