import { TASK_COMMANDS } from '../shared/commands/task';
import { commandMenuItem } from './command-menu';

type Item = Electron.MenuItemConstructorOptions;

/** What the task list says about the task right-clicked. */
export interface TaskMenuInfo {
  enabled: boolean;
  completed: boolean;
  allowComplete: boolean;
  state?: string;
  held: boolean;
  hasNote: boolean;
  activeRuns?: number;
  maxRuns?: number;
}

/**
 * A task's context menu: the Task menu's commands (from the catalog, so the
 * label, glyph, key and destructive mark are the Task menu's) in the context
 * menu's own order, then the project's. `send` names the ui:event the page
 * carries out.
 */
export function taskContextMenuItems(info: TaskMenuInfo, send: (type: string) => void): Item[] {
  const active = info.state === 'running' || info.state === 'checking' || info.state === 'classifying';
  // A task allowed several simultaneous runs can start another until its cap.
  const canRun = !active || (info.activeRuns ?? 1) < (info.maxRuns ?? 1);
  const on = (type: string) => () => send(type);
  const t = TASK_COMMANDS;
  return [
    commandMenuItem(t.runNow, { enabled: canRun, click: on('run-now') }),
    commandMenuItem(t.stop, { enabled: active, click: on('stop-task') }),
    commandMenuItem(t.pauseResume, { alt: info.state === 'paused', enabled: info.state !== 'disabled' && !info.completed, click: on('pause-resume') }),
    commandMenuItem(t.enableDisable, { alt: !info.enabled, enabled: !info.completed, click: on('enable-disable') }),
    commandMenuItem(t.complete, { alt: info.completed, enabled: info.completed || info.allowComplete, click: on('complete-reopen') }),
    commandMenuItem(t.edit, { click: on('edit-task') }),
    commandMenuItem(t.editAgent, { click: on('edit-with-agent') }),
    commandMenuItem(t.versions, { click: on('version-history') }),
    commandMenuItem(t.delete, { click: on('delete-task') }),
    { type: 'separator' },
    commandMenuItem(t.note, { alt: info.hasNote, click: on('edit-note') }),
    commandMenuItem(t.noteClear, { enabled: info.hasNote, click: on('clear-note') }),
    { type: 'separator' },
    commandMenuItem(t.moveFolder, { click: on('move-to-folder') }),
    commandMenuItem(t.clearRuns, { enabled: !active, click: on('clear-runs') }),
    { type: 'separator' },
    { label: 'Open Project in Terminal', click: on('open-terminal') },
    { label: 'Open Project in Chat', click: on('open-chat') },
    commandMenuItem(t.workFolder, { click: on('open-work-folder') }),
  ];
}
