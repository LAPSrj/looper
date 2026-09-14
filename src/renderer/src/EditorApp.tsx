import { useEffect, useState } from 'react';
import type { Environment, Task, TaskInput } from '@shared/types';
import { importTaskDraft } from '@shared/validate';

import { TaskEditor } from './components/TaskEditor';

interface EditorAppProps {
  taskId?: string;
  templateId?: string;
  fromTemplateId?: string;
  /** Key of a pending File → Import Task draft held by the main process. */
  importKey?: string;
  /** The import draft's id is already in the store and the user chose to update that item. */
  importUpdate?: boolean;
  mode?: 'task' | 'template';
}

/** Standalone editor window (opened from the menu or the + New button). */
export function EditorApp({ taskId, templateId, fromTemplateId, importKey, importUpdate, mode = 'task' }: EditorAppProps) {
  const editId = mode === 'template' ? templateId : taskId;
  // undefined = still loading; null = new task/template
  const [task, setTask] = useState<Task | null | undefined>(editId ? undefined : null);
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [defaultEnvironmentId, setDefaultEnvironmentId] = useState<string | undefined>(undefined);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [initial, setInitial] = useState<TaskInput | undefined>(undefined);
  // The editor reads `initial` once at mount, so a prefilled window must not
  // render before the draft has been resolved.
  const [initialReady, setInitialReady] = useState(!fromTemplateId && !importKey);

  useEffect(() => {
    if (mode === 'template') {
      document.title = templateId || importUpdate ? 'Edit Template' : 'New Template';
    } else {
      document.title = taskId || importUpdate ? 'Edit Task' : 'New Task';
    }
    const info = window.looper.info().then((i) => {
      setEnvironments(i.settings.environments);
      setDefaultEnvironmentId(i.settings.defaultEnvironmentId);
      setHost(i.host);
      return i;
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
        setInitialReady(true);
      });
    } else if (importKey) {
      const existing = mode === 'template' ? window.looper.templates.list() : window.looper.tasks.list();
      void Promise.all([info, window.looper.importDraft(importKey), existing]).then(([i, raw, items]) => {
        if (raw !== null && raw !== undefined) {
          const draft = importTaskDraft(raw, {
            environments: i.settings.environments,
            host: i.host,
            defaultEnvironmentId: i.settings.defaultEnvironmentId,
            // Updating keeps the id, so saving overwrites the existing item.
            existingIds: importUpdate ? undefined : items.map((t) => t.id),
          });
          if (importUpdate) {
            const current = items.find((t) => t.id === draft.id);
            if (current) {
              // Placement and the pending run note are app state, not part of
              // the imported definition: the existing task keeps its own.
              draft.folderId = current.folderId;
              draft.note = current.note;
              document.title = current.name;
            }
          }
          setInitial(draft);
        }
        setInitialReady(true);
      });
    } else if (taskId) {
      void window.looper.tasks.list().then((tasks) => {
        const found = tasks.find((t) => t.id === taskId) ?? null;
        setTask(found);
        if (found) document.title = found.name;
      });
    }
  }, [taskId, templateId, fromTemplateId, importKey, importUpdate, mode]);

  if (task === undefined || !environments || !initialReady) return <div className="empty">Loading…</div>;
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
