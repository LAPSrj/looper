import type { Task, TaskRuntime } from '@shared/types';
import { fmtCountdown, stateLabel } from '../format';

interface Props {
  tasks: Task[];
  runtimes: Record<string, TaskRuntime>;
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, runtimes, selected, now, onSelect }: Props) {
  return (
    <ul className="task-list">
      {tasks.map((t) => {
        const rt = runtimes[t.id];
        const label = stateLabel(rt);
        const sub =
          rt?.state === 'idle'
            ? `next ${fmtCountdown(rt.nextRunAt, now)}`
            : rt?.state === 'paused'
              ? rt.pausedReason ?? 'paused'
              : rt?.lastResult ?? '';
        return (
          <li
            key={t.id}
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
