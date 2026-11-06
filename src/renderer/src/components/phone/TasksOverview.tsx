import type { MainWindow } from '../../useMainWindow';
import { AttentionGroup, RecentGroup, RunningGroup } from './overview-rows';

/**
 * What the Tasks tab sums up while no task is open, as the desktop's main pane
 * does: what's running, what needs attention, and the latest runs. It's its own
 * component because it will differ from the Dashboard tab (PhoneDashboard).
 */
export function TasksOverview({ m }: { m: MainWindow }) {
  return (
    <div className="pg-overview">
      <RunningGroup m={m} rows={m.running} />
      <AttentionGroup m={m} rows={m.attention} />
      <RecentGroup m={m} />
    </div>
  );
}
