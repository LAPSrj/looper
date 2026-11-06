import type { Project, Task, TaskRuntime } from '@shared/types';
import type { UiEvent } from '@shared/api';
import { SHORTCUTS, hint } from '@shared/shortcuts';
import { TASK_COMMANDS } from '@shared/commands/task';
import { commandToolbar, type ToolbarGroup } from './toolbar-model';

export interface NewToolbarState {
  /** The project New Task puts the task in; null asks for one in the editor. */
  newTaskProject: Project | null;
  /** The project New Chat and New Terminal start in; null makes them ask. */
  sessionProject: Project | null;
  /** Show New Terminal after New Chat (the Chats tab). */
  terminal?: boolean;
  onAction: (type: UiEvent['type']) => void;
}

/** The main window's New buttons, in the order of the tabs: New Project, New Task and New Chat, and New Terminal on the Chats tab. */
export function newToolbarGroups({ newTaskProject, sessionProject, terminal, onAction }: NewToolbarState): ToolbarGroup[] {
  return [
    {
      id: 'new',
      items: [
        { id: 'new-project', label: 'New Project', icon: 'newProject', run: () => void window.looper.projects.openEditor() },
        { id: 'new-task', label: newTaskProject ? `New Task in ${newTaskProject.name}` : 'New Task', icon: 'newTask', run: () => onAction('new-task') },
        {
          id: 'new-chat',
          label: sessionProject ? `New Chat in ${sessionProject.name}` : 'New Chat',
          shortcut: sessionProject ? hint(SHORTCUTS.newChat) : undefined,
          icon: 'newChat',
          run: sessionProject ? () => void window.looper.projects.newChat(sessionProject.id) : null,
          menu: { label: sessionProject ? 'New Chat in Another Project' : 'New Chat in Project', open: (x, y) => window.looper.sessions.showNewMenu('chat', x, y) },
        },
        ...(terminal
          ? [
              {
                id: 'new-terminal',
                label: sessionProject ? `New Terminal in ${sessionProject.name}` : 'New Terminal',
                shortcut: sessionProject ? hint(SHORTCUTS.newTerminal) : undefined,
                icon: 'terminal',
                run: sessionProject ? () => void window.looper.projects.newTerminal(sessionProject.id) : null,
                menu: {
                  label: sessionProject ? 'New Terminal in Another Project' : 'New Terminal in Project',
                  open: (x: number, y: number) => window.looper.sessions.showNewMenu('terminal', x, y),
                },
              },
            ]
          : []),
      ],
    },
  ];
}

export interface TaskToolbarState {
  task: Task | null;
  runtime: TaskRuntime | undefined;
  onAction: (type: UiEvent['type']) => void;
}

/** The Tasks tab's buttons, for the selected task: running it, its state and its guidance, then editing it and its folder. */
export function taskToolbarGroups({ task, runtime, onAction }: TaskToolbarState): ToolbarGroup[] {
  const state = runtime?.state;
  const active = state === 'running' || state === 'checking' || state === 'classifying';
  const paused = state === 'paused';
  const completed = !!task?.completedAt;
  const hasTask = !!task;
  const activeRuns = runtime?.runs.length ?? 0;
  const maxRuns = task?.maxConcurrentRuns ?? 1;
  const canRunNow = !active || activeRuns < maxRuns;
  const act = (type: UiEvent['type']) => () => onAction(type);
  return [
    {
      id: 'task',
      items: commandToolbar(TASK_COMMANDS, 'task', {
        runNow: { enabled: hasTask && canRunNow, run: act('run-now') },
        stop: { enabled: active, run: act('stop-task') },
        pauseResume: { alt: paused, enabled: hasTask && state !== 'disabled' && !completed, run: act('pause-resume') },
        enableDisable: { alt: task?.enabled === false, enabled: hasTask && !completed, run: act('enable-disable') },
        complete: { alt: completed, enabled: hasTask && (completed || !!task?.completion.allowed), run: act('complete-reopen') },
        note: { alt: !!task?.note, enabled: hasTask, run: act('edit-note') },
      }),
    },
    {
      id: 'edit',
      items: commandToolbar(TASK_COMMANDS, 'edit', {
        edit: { enabled: hasTask, run: act('edit-task') },
        workFolder: { enabled: hasTask, run: act('open-work-folder') },
      }),
    },
  ];
}

/** The Projects tab's buttons, for the selected project. */
export function projectToolbarGroups(project: Project | null, onAction: (type: UiEvent['type']) => void): ToolbarGroup[] {
  return [
    {
      id: 'project',
      items: [
        { id: 'edit-project', label: 'Edit Project', icon: 'edit', enabled: !!project, run: () => onAction('edit-project') },
        { id: 'open-project-folder', label: 'Open Folder', icon: 'openFolder', enabled: !!project, run: () => onAction('open-project-folder') },
      ],
    },
  ];
}
