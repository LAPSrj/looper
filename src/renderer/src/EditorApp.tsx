import { useEffect, useState } from 'react';
import type { Environment, Task, TaskInput } from '@shared/types';

import { TaskEditor } from './components/TaskEditor';

interface EditorAppProps {
  taskId?: string;
  templateId?: string;
  fromTemplateId?: string;
  mode?: 'task' | 'template';
}

/** Standalone editor window (opened from the menu or the + New button). */
export function EditorApp({ taskId, templateId, fromTemplateId, mode = 'task' }: EditorAppProps) {
  const editId = mode === 'template' ? templateId : taskId;
  // undefined = still loading; null = new task/template
  const [task, setTask] = useState<Task | null | undefined>(editId ? undefined : null);
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [defaultEnvironmentId, setDefaultEnvironmentId] = useState<string | undefined>(undefined);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [initial, setInitial] = useState<TaskInput | undefined>(undefined);

  useEffect(() => {
    if (mode === 'template') {
      document.title = templateId ? 'Edit Template' : 'New Template';
    } else {
      document.title = taskId ? 'Edit Task' : 'New Task';
    }
    void window.looper.info().then((info) => {
      setEnvironments(info.settings.environments);
      setDefaultEnvironmentId(info.settings.defaultEnvironmentId);
      setHost(info.host);
    });
    if (mode === 'template' && templateId) {
      void window.looper.templates.list().then((templates) => {
        const found = templates.find((t) => t.id === templateId) ?? null;
        setTask(found);
        if (found) document.title = found.name;
      });
    } else if (fromTemplateId) {
      void window.looper.templates.list().then((templates) => {
        const found = templates.find((t) => t.id === fromTemplateId);
        if (found) setInitial({ ...found, id: '' });
      });
    } else if (taskId) {
      void window.looper.tasks.list().then((tasks) => {
        const found = tasks.find((t) => t.id === taskId) ?? null;
        setTask(found);
        if (found) document.title = found.name;
      });
    }
  }, [taskId, templateId, fromTemplateId, mode]);

  if (task === undefined || !environments) return <div className="empty">Loading…</div>;
  return (
    <div className="editor-window">
      <TaskEditor
        task={task}
        initial={initial}
        environments={environments}
        defaultEnvironmentId={defaultEnvironmentId}
        host={host}
        mode={mode}
        onSaved={() => window.close()}
        onCancel={() => window.close()}
      />
    </div>
  );
}
