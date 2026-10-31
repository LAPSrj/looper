import type { Project, Task, TaskRuntime } from '@shared/types';
import type { UiEvent } from '@shared/api';
import { DESKTOP_ONLY } from '@shared/ui-platform';
import { SHORTCUTS, hint } from '@shared/shortcuts';
import { Toolbar } from './Toolbar';
import type { ToolbarGroup } from './toolbar-model';

export interface TaskToolbarState {
  task: Task | null;
  /** The selected project: the edit, chat, terminal and folder buttons act on it. */
  project: Project | null;
  /** The project New Task puts the task in: the selected project's, or the selected task's. */
  newTaskProject: Project | null;
  /** The project New Chat and New Terminal start in; null makes them ask. */
  sessionProject: Project | null;
  runtime: TaskRuntime | undefined;
  /** The dashboard is showing: its button stays pressed. */
  dashboard: boolean;
  onAction: (type: UiEvent['type']) => void;
}

/** The main window's toolbar as data: the desktop draws it, a phone's More menu offers it. */
export function taskToolbarGroups({ task, project, newTaskProject, sessionProject, runtime, dashboard, onAction }: TaskToolbarState): ToolbarGroup[] {
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
      id: 'views',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', pressed: dashboard, run: act('show-dashboard') },
        { id: 'chats', label: 'Chats', icon: 'chat', run: () => window.looper.sessions.openWindow() },
      ],
    },
    {
      id: 'new',
      items: [
        { id: 'new-task', label: newTaskProject ? `New Task in ${newTaskProject.name}` : 'New Task', icon: 'newTask', run: act('new-task') },
        { id: 'new-project', label: 'New Project', icon: 'newProject', run: () => void window.looper.projects.openEditor() },
      ],
    },
    {
      id: 'task',
      items: [
        { id: 'run-now', label: 'Run Now', shortcut: 'F5', icon: 'run', enabled: hasTask && canRunNow, run: act('run-now') },
        { id: 'stop-task', label: 'Stop Task', shortcut: 'Shift+F5', icon: 'stop', enabled: active, run: act('stop-task') },
        {
          id: 'pause-resume',
          label: paused ? 'Resume' : 'Pause',
          shortcut: hint(SHORTCUTS.pauseResume),
          icon: paused ? 'resume' : 'pause',
          enabled: hasTask && state !== 'disabled' && !completed,
          run: act('pause-resume'),
        },
        { id: 'enable-disable', label: task?.enabled === false ? 'Enable' : 'Disable', icon: 'power', enabled: hasTask && !completed, run: act('enable-disable') },
        { id: 'complete-reopen', label: completed ? 'Reopen' : 'Complete', icon: 'complete', enabled: hasTask && (completed || !!task?.completion.allowed), run: act('complete-reopen') },
        {
          id: project ? 'edit-project' : 'edit-task',
          label: project ? 'Edit Project' : 'Edit Task',
          shortcut: project ? undefined : 'Ctrl+E',
          icon: 'edit',
          enabled: hasTask || !!project,
          run: act('edit-task'),
        },
      ],
    },
    {
      id: 'guidance',
      items: [{ id: 'edit-note', label: task?.note ? 'Edit Guidance for Next Run' : 'Add Guidance for Next Run', icon: 'guidance', enabled: hasTask, run: act('edit-note') }],
    },
    {
      id: 'sessions',
      items: [
        {
          id: 'new-chat',
          label: sessionProject ? `New Chat in ${sessionProject.name}` : 'New Chat',
          shortcut: sessionProject ? hint(SHORTCUTS.newChat) : undefined,
          icon: 'newChat',
          run: sessionProject ? () => void window.looper.projects.newChat(sessionProject.id) : null,
          menu: { label: sessionProject ? 'New Chat in Another Project' : 'New Chat in Project', open: (x, y) => window.looper.sessions.showNewMenu('chat', x, y) },
        },
        {
          id: 'new-terminal',
          label: sessionProject ? `New Terminal in ${sessionProject.name}` : 'New Terminal',
          shortcut: sessionProject ? hint(SHORTCUTS.newTerminal) : undefined,
          icon: 'terminal',
          run: sessionProject ? () => void window.looper.projects.newTerminal(sessionProject.id) : null,
          menu: { label: sessionProject ? 'New Terminal in Another Project' : 'New Terminal in Project', open: (x, y) => window.looper.sessions.showNewMenu('terminal', x, y) },
        },
        { id: 'open-work-folder', label: 'Open Working Directory', icon: 'folder', platforms: DESKTOP_ONLY, enabled: hasTask || !!project, run: act('open-work-folder') },
      ],
    },
  ];
}

interface Props extends TaskToolbarState {
  /** The installed addons' own buttons, after Looper's. */
  addonGroups?: ToolbarGroup[];
  /** Where the shown addon screen puts its toolbar buttons, at the end. */
  addonSlot?: (el: HTMLSpanElement | null) => void;
}

export function TaskToolbar({ addonGroups = [], addonSlot, ...state }: Props) {
  return (
    <Toolbar
      groups={[...taskToolbarGroups(state), ...addonGroups]}
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.addons.showToolbarMenu();
      }}
    >
      <span className="toolbar-slot" ref={addonSlot} />
    </Toolbar>
  );
}
