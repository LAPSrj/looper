import type { UiEvent } from '@shared/api';
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

const uiListeners = new Set<(e: UiEvent) => void>();

/** Tell this window's own components (Find…, the files just attached): a command runs in the page, so nothing goes through the main process. */
export function emitUi(e: UiEvent): void {
  for (const l of uiListeners) l(e);
}

/** The events a command of this page sends, and the main process's. */
export function onUi(fn: (e: UiEvent) => void): () => void {
  uiListeners.add(fn);
  const off = window.looper.onUi(fn);
  return () => {
    uiListeners.delete(fn);
    off();
  };
}
