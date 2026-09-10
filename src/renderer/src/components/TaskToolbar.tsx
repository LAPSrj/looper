import type { Task, TaskRuntime } from '@shared/types';
import type { UiEvent } from '@shared/api';

interface Props {
  task: Task | null;
  runtime: TaskRuntime | undefined;
  onAction: (type: UiEvent['type']) => void;
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  run: <path d="M4.5 2.8v10.4L13 8Z" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  resume: <path d="M3.5 3.5v9M6.5 3.2 13.5 8l-7 4.8Z" />,
  power: (
    <>
      <path d="M8 2v5.5" />
      <path d="M11.5 4.2a5 5 0 1 1-7 0" />
    </>
  ),
  guidance: <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5Z" />,
  edit: <path d="m11.3 2.7 2 2L5.5 12.5l-2.8.8.8-2.8Z" />,
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="m4 6 2.5 2L4 10M8.5 10.5h3.5" />
    </>
  ),
  folder: <path d="M1.5 12.5v-8a1 1 0 0 1 1-1h3.2L7 5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />,
};

export function TaskToolbar({ task, runtime, onAction }: Props) {
  const state = runtime?.state;
  const active = state === 'running' || state === 'checking' || state === 'classifying';
  const paused = state === 'paused';
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
    <div className="toolbar">
      {button(ICONS.run, 'Run Now (F5)', 'run-now', hasTask && canRunNow)}
      {button(ICONS.stop, 'Stop Task (Shift+F5)', 'stop-task', active)}
      {button(
        paused ? ICONS.resume : ICONS.pause,
        paused ? 'Resume (Ctrl+P)' : 'Pause (Ctrl+P)',
        'pause-resume',
        hasTask && state !== 'disabled',
      )}
      {button(ICONS.power, task?.enabled === false ? 'Enable' : 'Disable', 'enable-disable', hasTask)}
      {button(ICONS.edit, 'Edit Task (Ctrl+E)', 'edit-task', hasTask)}
      <span className="toolbar-sep" />
      {button(
        ICONS.guidance,
        task?.note ? 'Edit Guidance for Next Run' : 'Add Guidance for Next Run',
        'edit-note',
        hasTask,
      )}
      <span className="toolbar-sep" />
      {button(ICONS.terminal, 'Open Project in Terminal (Ctrl+T)', 'open-terminal', hasTask)}
      {button(ICONS.folder, 'Open Working Directory', 'open-work-folder', hasTask)}
    </div>
  );
}
