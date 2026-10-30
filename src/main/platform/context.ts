import { AsyncLocalStorage } from 'node:async_hooks';
import type { RemoteClient, RemoteWindow } from './remote-window';

/** Who asked: a remote client and the window the request came from. Absent on the desktop. */
export interface CallContext {
  client: RemoteClient;
  window: RemoteWindow;
}

const store = new AsyncLocalStorage<CallContext>();

/** Run `fn` (and everything it awaits or schedules) as a request from that remote window. */
export function runAs<T>(ctx: CallContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * The remote caller of the code running now, or undefined for the desktop.
 * A context that outlived its client (a timer started by a remote request
 * that fires after the tab is gone for good) counts as the desktop.
 */
export function caller(): CallContext | undefined {
  const ctx = store.getStore();
  return ctx && !ctx.client.disposed ? ctx : undefined;
}
