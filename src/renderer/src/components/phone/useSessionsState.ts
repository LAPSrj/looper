import { useEffect, useState } from 'react';
import type { SessionsState } from '@shared/sessions';
import { subscribe } from '../../events';

/** Every chat and terminal session, kept current; null until the first answer. */
export function useSessionsState(): SessionsState | null {
  const [state, setState] = useState<SessionsState | null>(null);
  useEffect(() => {
    void window.looper.sessions.state().then((s) => setState((prev) => prev ?? s));
    return subscribe((e) => {
      if (e.type === 'sessions') setState(e.state);
    });
  }, []);
  return state;
}
