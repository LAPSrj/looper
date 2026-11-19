import { useEffect, useState } from 'react';
import type { Environment, Project, Task, TaskInput } from '@shared/types';
import { importTaskDraft } from '@shared/validate';
import { windowTitle } from '@shared/window-title';

import { TaskEditor } from './components/TaskEditor';
import { EmptyWindow } from './components/ui';
import { TASKS, TEMPLATES, useDiscardUnsaved, useLiveItem } from './components/hooks';

interface EditorAppProps {
  taskId?: string;
  templateId?: string;
  fromTemplateId?: string;
  /** Key of a pending File → Import Task draft held by the main process. */
  importKey?: string;
  /** The import draft's id is already in the store and the user chose to update that item. */
  importUpdate?: boolean;
  /** The draft came from a task builder's Create/Update: saving records the agent's version. */
  builderId?: string;
  mode?: 'task' | 'template';
  /** A new task in this project (a project's New Task…). */
  projectId?: string;
  /** A template the Templates window's Add just created: closing without Create deletes it again. */
  isNew?: boolean;
}

/** Standalone editor window (opened from the menu or the + New button). */
export function EditorApp({ taskId, templateId, fromTemplateId, importKey, importUpdate, builderId, mode = 'task', projectId, isNew }: EditorAppProps) {
  const editId = mode === 'template' ? templateId : taskId;
  const savedRef = useDiscardUnsaved(isNew, () => {
    if (templateId) void window.looper.templates.remove(templateId);
  });
  // The editor keeps its draft; the item is only watched for its deletion.
  const { item, missing } = useLiveItem(mode === 'template' ? TEMPLATES : TASKS, editId, (found) => {
    if (isNew) return;
    document.title = windowTitle(mode === 'template' ? 'Edit Template' : 'Edit Task', found.name);
  });
  // undefined = still loading; null = new task/template
  const task: Task | null | undefined = editId ? (item ?? undefined) : null;
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [defaultEnvironmentId, setDefaultEnvironmentId] = useState<string | undefined>(undefined);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [initial, setInitial] = useState<TaskInput | undefined>(undefined);
  // The editor reads `initial` once at mount, so a prefilled window must not
  // render before the draft has been resolved.
  const [initialReady, setInitialReady] = useState(!fromTemplateId && !importKey);

  useEffect(() => {
    if (mode === 'template') {
      document.title = (templateId && !isNew) || importUpdate ? 'Edit Template' : 'New Template';
    } else {
      document.title = taskId || importUpdate ? 'Edit Task' : 'New Task';
    }
    void window.looper.projects.list().then(setProjects);
    const info = window.looper.info().then((i) => {
      setEnvironments(i.settings.environments);
      setDefaultEnvironmentId(i.settings.defaultEnvironmentId);
      setHost(i.host);
      return i;
    });
    // A template being edited comes from useLiveItem.
    if (mode === 'template' && templateId) return;
    if (fromTemplateId) {
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
              document.title = windowTitle(mode === 'template' ? 'Edit Template' : 'Edit Task', current.name);
            }
          }
          setInitial(draft);
        }
        setInitialReady(true);
      });
    }
  }, [taskId, templateId, fromTemplateId, importKey, importUpdate, mode, isNew]);

  if (missing) return <EmptyWindow gone={mode === 'template' ? 'This template no longer exists.' : 'This task no longer exists.'} />;
  if (task === undefined || !environments || !projects || !initialReady) return <EmptyWindow />;
  return (
    <div className="editor-window">
      <TaskEditor
        task={task}
        initial={initial}
        environments={environments}
        projects={projects}
        projectId={projectId}
        defaultEnvironmentId={defaultEnvironmentId}
        host={host}
        mode={mode}
        builderId={builderId}
        isNew={isNew}
        onSaved={() => {
          savedRef.current = true;
          window.close();
        }}
        onCancel={() => window.close()}
      />
    </div>
  );
}
