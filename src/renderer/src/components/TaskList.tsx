import type { Task, TaskRuntime } from '@shared/types';
import { capFirst, fmtCountdown, resultLabel, stateLabel } from '../format';
import { useListNav } from './hooks';

interface Props {
  tasks: Task[];
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, runtimes, selected, now, onSelect }: Props) {
  const idx = tasks.findIndex((t) => t.id === selected);
  const onKeyDown = useListNav({
    count: tasks.length,
    index: idx,
    onIndex: (i) => {
      if (tasks[i].id !== selected) onSelect(tasks[i].id);
    },
    scrollToId: selected ? `task-${selected}` : null,
  });

  return (
    <ul
      className="task-list"
      role="listbox"
      aria-label="Tasks"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={selected ? `task-${selected}` : undefined}
    >
      {tasks.map((t) => {
        const rt = runtimes[t.id];
        const label = stateLabel(rt);
        const countdown = rt?.state === 'idle' ? fmtCountdown(rt.nextRunAt, now) : '';
        const sub =
          rt?.state === 'idle'
            ? countdown === ''
              ? 'Not scheduled'
              : countdown === 'now'
                ? 'Next run now'
                : `Next run in ${countdown}`
            : rt?.state === 'paused'
              ? capFirst(rt.pausedReason ?? 'paused')
              : capFirst(rt?.lastDetail ?? '') || resultLabel(rt?.lastResult ?? '');
        const active = rt?.state === 'running' || rt?.state === 'checking' || rt?.state === 'classifying';
        const subLine = active
          ? label
          : rt?.state === 'disabled'
            ? 'Disabled'
            : sub;
        return (
          <li
            key={t.id}
            id={`task-${t.id}`}
            role="option"
            aria-selected={selected === t.id}
            className={`task-item ${selected === t.id ? 'selected' : ''} ${rt?.held ? 'held' : ''}`}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelect(t.id);
              const rt2 = runtimes[t.id];
              window.looper.showTaskContextMenu({ enabled: t.enabled, state: rt2?.state, held: !!rt2?.held, hasNote: !!t.note });
            }}
          >
            <div className="task-item-row">
              <span className="task-name">{t.name}</span>
            </div>
            <div className="task-item-sub" title={subLine}>
              {subLine}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
