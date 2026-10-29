import type { Project, Task, TaskRuntime } from '@shared/types';
import type { UiEvent } from '@shared/api';
import { Icon } from './Icon';
import { ICONS } from './icons';

interface Props {
  task: Task | null;
  /** The selected project: the edit, chat, terminal and folder buttons act on it. */
  project: Project | null;
  /** The project New Task puts the task in: the selected project's, or the selected task's. */
  newTaskProject: Project | null;
  runtime: TaskRuntime | undefined;
  /** The dashboard is showing: its button stays pressed. */
  dashboard: boolean;
  onAction: (type: UiEvent['type']) => void;
  /** The installed addons' own buttons, after Looper's. */
  addonButtons?: React.ReactNode;
  /** Where the shown addon screen puts its toolbar buttons, at the end. */
  addonSlot?: (el: HTMLSpanElement | null) => void;
}

export function TaskToolbar({ task, project, newTaskProject, runtime, dashboard, onAction, addonButtons, addonSlot }: Props) {
  const state = runtime?.state;
  const active = state === 'running' || state === 'checking' || state === 'classifying';
  const paused = state === 'paused';
  const completed = !!task?.completedAt;
  const hasTask = !!task;
  const activeRuns = runtime?.runs.length ?? 0;
  const maxRuns = task?.maxConcurrentRuns ?? 1;
  const canRunNow = !active || activeRuns < maxRuns;

  const button = (
    icon: React.ReactNode,
    title: string,
    type: UiEvent['type'],
    enabled: boolean,
  ) => (
    <button title={title} aria-label={title} disabled={!enabled} onClick={() => onAction(type)}>
      <Icon>{icon}</Icon>
    </button>
  );

  return (
    <div
      className="toolbar"
      onContextMenu={(e) => {
        e.preventDefault();
        window.looper.addons.showToolbarMenu();
      }}
    >
      <button
        className={dashboard ? 'pressed' : undefined}
        title="Dashboard"
        aria-label="Dashboard"
        aria-pressed={dashboard}
        onClick={() => onAction('show-dashboard')}
      >
        <Icon>{ICONS.dashboard}</Icon>
      </button>
      <span className="toolbar-sep" />
      {button(ICONS.add, newTaskProject ? `New Task in ${newTaskProject.name}` : 'New Task', 'new-task', true)}
      <span className="toolbar-sep" />
      {button(ICONS.run, 'Run Now (F5)', 'run-now', hasTask && canRunNow)}
      {button(ICONS.stop, 'Stop Task (Shift+F5)', 'stop-task', active)}
      {button(
        paused ? ICONS.resume : ICONS.pause,
        paused ? 'Resume (Ctrl+P)' : 'Pause (Ctrl+P)',
        'pause-resume',
        hasTask && state !== 'disabled' && !completed,
      )}
      {button(ICONS.power, task?.enabled === false ? 'Enable' : 'Disable', 'enable-disable', hasTask && !completed)}
      {button(
        ICONS.complete,
        completed ? 'Reopen' : 'Complete',
        'complete-reopen',
        hasTask && (completed || !!task?.completion.allowed),
      )}
      {button(ICONS.edit, project ? 'Edit Project' : 'Edit Task (Ctrl+E)', 'edit-task', hasTask || !!project)}
      <span className="toolbar-sep" />
      {button(
        ICONS.guidance,
        task?.note ? 'Edit Guidance for Next Run' : 'Add Guidance for Next Run',
        'edit-note',
        hasTask,
      )}
      <span className="toolbar-sep" />
      {button(ICONS.chat, project ? 'New Chat' : 'Open Project in Chat', 'open-chat', hasTask || !!project)}
      {button(ICONS.terminal, project ? 'New Terminal' : 'Open Project in Terminal (Ctrl+T)', 'open-terminal', hasTask || !!project)}
      {button(ICONS.folder, 'Open Working Directory', 'open-work-folder', hasTask || !!project)}
      {addonButtons}
      <span className="toolbar-slot" ref={addonSlot} />
    </div>
  );
}
