import { useEffect, useState } from 'react';
import type { RemoteAccessState } from '@shared/remote-access';
import { subscribe } from './events';

/**
 * Remote Access's state, live: what it is now and on every change. Null until
 * known; asked before Remote Access exists (a window opened early), it waits
 * for the first event instead.
 */
export function useRemoteAccessState(): RemoteAccessState | null {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  useEffect(() => {
    let live = true;
    void window.looper.remoteAccess.state().then(
      (s) => live && setState((was) => was ?? s),
      () => undefined,
    );
    const off = subscribe((e) => {
      if (e.type === 'remote-access') setState(e.state);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}
