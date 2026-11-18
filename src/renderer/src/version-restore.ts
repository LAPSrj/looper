import { useEffect, useState } from 'react';
import type { VersionSummary } from '@shared/versions';
import { reportError } from './report-error';

/** Whether a task builder (Edit Task with Agent) is open on the task, checked again each time the window gets the focus. */
export function useBuilderOpen(taskId: string): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => void window.looper.builder.forTask(taskId).then((id) => setOpen(id !== null));
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [taskId]);
  return open;
}

/**
 * Restore: with a task builder open on the task, the version is loaded into it
 * (unsaved, undoable) instead; otherwise, once the user agrees, it replaces
 * the task's definition and files as a new version. True when it went through.
 */
export async function restoreVersion(taskId: string, version: VersionSummary): Promise<boolean> {
  try {
    if ((await window.looper.builder.forTask(taskId)) !== null) {
      await window.looper.builder.loadVersion(taskId, version.n);
      return true;
    }
    const task = (await window.looper.tasks.list()).find((t) => t.id === taskId);
    if (!task) return false;
    const files = version.files.length > 0 ? ' and the files it recorded' : '';
    if (!(await window.looper.confirm(`Restore version ${version.n} of "${task.name}"? Its definition${files} replace the current ones, and the restore is saved as a new version.`))) return false;
    await window.looper.versions.restore(taskId, version.n);
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
}
