import { decodeBytes, encodeBytes } from './bytes';
import { runAs, type CallContext } from './context';

export type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;
export type SendListener = (event: Electron.IpcMainEvent, ...args: any[]) => void;

/** The part of Electron's ipcMain the table mirrors its registrations into. */
export interface IpcMainLike {
  handle(channel: string, handler: InvokeHandler): void;
  on(channel: string, listener: SendListener): unknown;
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: SendListener): unknown;
}

export type InvokeOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Every IPC handler and listener of the main process, registered with
 * Electron's ipcMain (when there is one) and kept here as well, so a remote
 * client's invoke or send reaches the same code with a stand-in event whose
 * `sender` is the remote window's webContents.
 */
export class IpcTable {
  private readonly handlers = new Map<string, InvokeHandler>();
  private readonly listeners = new Map<string, SendListener[]>();

  constructor(private readonly electron?: IpcMainLike) {}

  handle(channel: string, handler: InvokeHandler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.electron?.handle(channel, handler);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.electron?.removeHandler(channel);
    this.handlers.delete(channel);
  }

  on(channel: string, listener: SendListener): void {
    this.electron?.on(channel, listener);
    const list = this.listeners.get(channel) ?? [];
    list.push(listener);
    this.listeners.set(channel, list);
  }

  removeListener(channel: string, listener: SendListener): void {
    this.electron?.removeListener(channel, listener);
    const list = this.listeners.get(channel);
    const i = list?.indexOf(listener) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    if (list?.length === 0) this.listeners.delete(channel);
  }

  /** A remote invoke: the handler runs as the caller; the answer has its bytes encoded and errors as their plain message. */
  async invoke(ctx: CallContext, channel: string, args: unknown[]): Promise<InvokeOutcome> {
    const handler = this.handlers.get(channel);
    if (!handler) return { ok: false, error: `No handler registered for '${channel}'` };
    const event = { sender: ctx.window.webContents } as unknown as Electron.IpcMainInvokeEvent;
    try {
      const value = await runAs(ctx, () => handler(event, ...(decodeBytes(args) as unknown[])));
      return { ok: true, value: encodeBytes(value) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A remote send: every listener runs as the caller; one that throws doesn't stop the rest. */
  send(ctx: CallContext, channel: string, args: unknown[], onError: (err: unknown) => void): void {
    const list = [...(this.listeners.get(channel) ?? [])];
    if (list.length === 0) return;
    const event = { sender: ctx.window.webContents } as unknown as Electron.IpcMainEvent;
    const decoded = decodeBytes(args) as unknown[];
    runAs(ctx, () => {
      for (const listener of list) {
        try {
          listener(event, ...decoded);
        } catch (err) {
          onError(err);
        }
      }
    });
  }
}
