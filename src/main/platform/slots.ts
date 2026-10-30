import { caller } from './context';
import { RemoteWindow, type AppWindow } from './remote-window';

export const DESKTOP = 'desktop';

/** Whose request is running: the remote client's id, or 'desktop'. */
export function clientKey(): string {
  return caller()?.client.id ?? DESKTOP;
}

export function clientKeyOf(w: AppWindow): string {
  return w instanceof RemoteWindow ? w.client.id : DESKTOP;
}

/** The windows that belong to whoever is asking (the desktop's when no remote client is). */
export function ofCaller<W extends AppWindow>(windows: W[]): W[] {
  const key = clientKey();
  return windows.filter((w) => !w.isDestroyed() && clientKeyOf(w) === key);
}

/**
 * Windows kept one per client and key ("one Recycle Bin window", "one
 * Version History window per task"): the desktop is one client and each
 * browser tab another, so opening one on a phone never just focuses the
 * desktop's.
 */
export class WindowSlots<W extends AppWindow = AppWindow> {
  private readonly map = new Map<string, W>();

  private slot(key: string, client: string): string {
    return `${client}\n${key}`;
  }

  /** The caller's open window for `key`. */
  get(key = ''): W | undefined {
    const w = this.map.get(this.slot(key, clientKey()));
    return w && !w.isDestroyed() ? w : undefined;
  }

  /** Keep `w` as its own client's window for `key`, until it closes. */
  set(w: W, key = ''): void {
    const slot = this.slot(key, clientKeyOf(w));
    this.map.set(slot, w);
    w.on('closed', () => {
      if (this.map.get(slot) === w) this.map.delete(slot);
    });
  }

  /** Every client's open window for `key`. */
  all(key = ''): W[] {
    const out: W[] = [];
    for (const [slot, w] of this.map) if (slot.slice(slot.indexOf('\n') + 1) === key && !w.isDestroyed()) out.push(w);
    return out;
  }

  /** Every open window, with its key. */
  entries(): [string, W][] {
    return [...this.map].filter(([, w]) => !w.isDestroyed()).map(([slot, w]) => [slot.slice(slot.indexOf('\n') + 1), w]);
  }
}
