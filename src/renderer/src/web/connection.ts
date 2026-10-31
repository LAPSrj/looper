import { useSyncExternalStore } from 'react';
import type { ShellController } from './controller';
import { useShellState } from './store';

export interface Connection {
  connected: boolean;
  /** The screens show what the phone kept: the computer was reached before, and isn't now. */
  stale: boolean;
  /** When the data shown was last known to be live; null when it never was. */
  updatedAt: number | null;
  /** Try the computer now instead of at the next retry. */
  retry: () => void;
}

/** The connection to the computer, for the offline banner. */
export function useConnection(controller: ShellController): Connection {
  const { session, store } = controller;
  const { connected } = useShellState(store);
  const subscribe = (cb: () => void) => session.onConnection(() => cb());
  const stale = useSyncExternalStore(subscribe, () => session.isStale());
  const updatedAt = useSyncExternalStore(subscribe, () => session.lastLive());
  return { connected, stale, updatedAt, retry: () => session.retryNow() };
}
