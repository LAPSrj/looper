import type { EngineEvent } from '@shared/types';

type Listener = (e: EngineEvent) => void;
const listeners = new Set<Listener>();
let attached = false;

/** Single IPC subscription fanned out to any number of components. */
export function subscribe(fn: Listener): () => void {
  if (!attached) {
    attached = true;
    window.looper.onEvent((e) => {
      for (const l of listeners) {
        try {
          l(e);
        } catch (err) {
          console.error(err);
        }
      }
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
