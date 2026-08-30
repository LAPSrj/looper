import { useEffect } from 'react';
import type { Task, TaskRuntime } from '@shared/types';
import { capFirst, fmtCountdown, stateLabel } from '../format';

interface Props {
  tasks: Task[];
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, runtimes, selected, now, onSelect }: Props) {
  useEffect(() => {
    if (!selected) return;
    document.getElementById(`task-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!tasks.length) return;
    const idx = tasks.findIndex((t) => t.id === selected);
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(tasks.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tasks.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (tasks[next] && tasks[next].id !== selected) onSelect(tasks[next].id);
  };

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
              : capFirst(rt?.lastResult ?? '');
        return (
          <li
            key={t.id}
            id={`task-${t.id}`}
            role="option"
            aria-selected={selected === t.id}
            className={`task-item ${selected === t.id ? 'selected' : ''} ${rt?.held ? 'held' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="task-item-row">
              <span className="task-name">{t.name}</span>
              <span className={`badge state-${rt?.held ? 'held' : rt?.state ?? 'idle'}`}>{label}</span>
            </div>
            <div className="task-item-sub" title={sub}>
              {sub}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
