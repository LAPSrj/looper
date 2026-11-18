import { useEffect, useRef, useState } from 'react';
import type { RemoteAccessState } from '@shared/remote-access';
import { subscribe } from './events';

/**
 * Remote Access's state, live: what it is now and on every change. Null until
 * known; asked before Remote Access exists (a window opened early), it waits
 * for the first event instead, after telling `onError` when there is one.
 */
export function useRemoteAccessState(onError?: (e: unknown) => void): RemoteAccessState | null {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let live = true;
    void window.looper.remoteAccess.state().then(
      (s) => live && setState((was) => was ?? s),
      (e: unknown) => live && onErrorRef.current?.(e),
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
