import type { AddonInfo } from '@shared/addons';
import { EmptyState } from './EmptyState';

/**
 * An addon that isn't running, in place of its panes and screens: starting, or stopped on its own with Restart (Windows'
 * in-place error). A crash says only that, as its exit and output are for whoever writes the addon (they're in the Engine
 * Log); one that couldn't start says why. The desktop draws it across the tab, without the panes' list.
 */
export function AddonNotRunning({ addon }: { addon: AddonInfo }) {
  if (addon.status !== 'stopped') return <EmptyState busy>Starting {addon.name}…</EmptyState>;
  return (
    <EmptyState
      level="error"
      title={addon.crashed ? `${addon.name} stopped unexpectedly` : `${addon.name} can't start`}
      action={
        <button className="btn" onClick={() => void window.looper.addons.restart(addon.id)}>
          Restart
        </button>
      }
    >
      {addon.crashed ? null : addon.error}
    </EmptyState>
  );
}
