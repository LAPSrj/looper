import crypto from 'node:crypto';
import type { ClientMessage, ServerMessage } from '../../shared/remote-access';
import type { IpcTable } from './ipc-table';
import { RemoteClient, type RemoteWindow } from './remote-window';

/** The part of a Remote Access connection the dispatcher uses (see remote-access/server.ts). */
export interface ConnectionLike {
  readonly device: { id: string; name: string };
  readonly platform: string;
  readonly clientId?: string;
  readonly pageId?: string;
  /** The hello's last page message (see ClientMessage). */
  readonly seq?: number;
  /** A string is a message already serialized. */
  send(msg: ServerMessage | string): boolean;
  onMessage(cb: (msg: ClientMessage) => void): () => void;
  onClose(cb: () => void): () => void;
  /** Closes the socket; a takeover uses it on the old connection of a page that reconnected. */
  close?(): void;
}

export interface RemoteClientsOptions {
  ipc: IpcTable;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  version: string;
  /** `<dataDir>/remote-access`. */
  dir: string;
  offerDownload: (file: string, name: string, onDone: () => void) => string;
  /** How long a tab that lost its connection keeps its windows. */
  graceMs?: number;
  /** The same for a phone's installed app, which is locked or away far longer than a tab. */
  phoneGraceMs?: number;
  deliveryQuietMs?: number;
}

export const CLIENT_GRACE_MS = 2 * 60_000;
export const PHONE_GRACE_MS = 24 * 60 * 60_000;

/**
 * The remote clients and their messages: a hello makes a client (or resumes
 * one still in its grace period), and everything after it is routed to that
 * client's own windows, menus and dialogs. Anything naming a window, menu or
 * dialog the client doesn't own is dropped.
 */
export class RemoteClients {
  private readonly clients = new Map<string, RemoteClient>();
  private readonly graceTimers = new Map<RemoteClient, NodeJS.Timeout>();
  /** Each connected client's connection; a close of any other one is stale. */
  private readonly live = new Map<RemoteClient, { conn: ConnectionLike; off: () => void }>();
  private readonly mainCbs = new Set<(w: RemoteWindow) => void>();

  constructor(private readonly opts: RemoteClientsOptions) {}

  /** Each new client's main window, for its menu bar. */
  onMainWindow(cb: (w: RemoteWindow) => void): () => void {
    this.mainCbs.add(cb);
    return () => this.mainCbs.delete(cb);
  }

  list(): RemoteClient[] {
    return [...this.clients.values()];
  }

  windows(): RemoteWindow[] {
    return this.list().flatMap((c) => c.windowList());
  }

  /** To every connected client, or those of the devices `to` takes. */
  broadcast(msg: ServerMessage, to?: (deviceId: string) => boolean): void {
    for (const c of this.clients.values()) if (!to || to(c.device.id)) c.send(msg);
  }

  /** A connection, just after its hello. */
  attach(conn: ConnectionLike): void {
    const known = conn.clientId ? this.clients.get(conn.clientId) : undefined;
    const mine = known && known.device.id === conn.device.id && !known.disposed ? known : undefined;
    // The same page reconnecting before the server noticed its old socket is dead takes the client over;
    // a duplicated tab carries the same clientId but another pageId, and gets a client of its own.
    const old = mine ? this.live.get(mine) : undefined;
    const takeover = !!old && !!conn.pageId && old.conn.pageId === conn.pageId;
    const resume = mine && (!old || takeover) ? mine : undefined;
    const client = resume ?? new RemoteClient(crypto.randomBytes(12).toString('base64url'), conn.device, conn.platform, {
      dir: this.opts.dir,
      offerDownload: this.opts.offerDownload,
      log: this.opts.log,
      ...(this.opts.deliveryQuietMs !== undefined ? { deliveryQuietMs: this.opts.deliveryQuietMs } : {}),
    });
    if (resume && old) {
      old.off();
      this.live.delete(resume);
      resume.setConnection(null);
      old.conn.close?.();
    }
    if (resume) {
      clearTimeout(this.graceTimers.get(resume));
      this.graceTimers.delete(resume);
      resume.platform = conn.platform;
    } else this.clients.set(client.id, client);
    client.setConnection((msg) => conn.send(msg));
    const replayFrom = resume && conn.seq !== undefined && resume.canReplay(conn.seq) ? conn.seq : null;
    conn.send({
      t: 'welcome',
      device: conn.device,
      version: this.opts.version,
      clientId: client.id,
      resumed: !!resume,
      windows: resume ? resume.windowList().map((w) => w.w) : [],
      replayed: replayFrom !== null,
      seq: client.lastPageSeq,
    });
    if (resume) {
      client.resend();
      if (replayFrom !== null) client.replay(replayFrom);
    } else {
      client.main = client.openWindow({ role: 'workspace', hash: '', title: 'Looper', width: 1400, height: 900, resizable: true, modal: false, parent: null });
      for (const cb of this.mainCbs) {
        try {
          cb(client.main);
        } catch (err) {
          this.opts.log.error(`remote access: main window setup failed: ${String(err)}`);
        }
      }
    }
    const off = conn.onMessage((msg) => this.route(client, msg));
    this.live.set(client, { conn, off });
    conn.onClose(() => {
      off();
      if (this.live.get(client)?.conn !== conn) return;
      this.live.delete(client);
      this.detach(client, conn);
    });
  }

  private detach(client: RemoteClient, conn: ConnectionLike): void {
    if (client.disposed) return;
    client.setConnection(null);
    const phone = conn.platform === 'ios' || conn.platform === 'android';
    const grace = phone ? (this.opts.phoneGraceMs ?? PHONE_GRACE_MS) : (this.opts.graceMs ?? CLIENT_GRACE_MS);
    const timer = setTimeout(() => this.expire(client, conn.device.name), grace);
    timer.unref?.();
    this.graceTimers.set(client, timer);
  }

  private expire(client: RemoteClient, name: string): void {
    this.graceTimers.delete(client);
    this.clients.delete(client.id);
    const n = client.windowList().length;
    client.dispose();
    this.opts.log.info(`remote access: ${name} didn't come back; closed its ${n === 1 ? 'window' : `${n} windows`}`);
  }

  /** Remote Access went off: every client counts as disconnected and keeps its windows for the grace period. */
  disconnectAll(): void {
    for (const [client, { conn, off }] of [...this.live]) {
      off();
      this.live.delete(client);
      this.detach(client, conn);
    }
  }

  /** Close every client of the device now (it was removed): no grace period. */
  disposeDevice(deviceId: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.device.id !== deviceId) continue;
      this.drop(client);
      client.dispose();
    }
  }

  /** Close every client now (Remote Access stopped for good). */
  disposeAll(): void {
    for (const c of [...this.clients.values()]) {
      this.drop(c);
      c.dispose();
    }
  }

  private drop(client: RemoteClient): void {
    clearTimeout(this.graceTimers.get(client));
    this.graceTimers.delete(client);
    this.live.get(client)?.off();
    this.live.delete(client);
    this.clients.delete(client.id);
  }

  private route(client: RemoteClient, msg: ClientMessage): void {
    if (client.disposed) return;
    switch (msg.t) {
      case 'invoke': {
        const win = client.window(msg.w);
        if (!win) return;
        void this.opts.ipc.invoke({ client, window: win }, msg.channel, msg.args).then((r) => {
          const sent = client.send(r.ok ? { t: 'result', id: msg.id, ok: true, value: r.value } : { t: 'result', id: msg.id, ok: false, error: r.error });
          // Its value couldn't be made into JSON (the connection's log says why); a long one goes as parts.
          if (!sent && r.ok && client.connected) {
            client.send({ t: 'result', id: msg.id, ok: false, error: `The answer to ${msg.channel} couldn't be sent.` });
          }
        });
        return;
      }
      case 'send': {
        const win = client.window(msg.w);
        if (!win) return;
        this.opts.ipc.send({ client, window: win }, msg.channel, msg.args, (err) =>
          this.opts.log.error(`remote access: ${msg.channel} from ${client.device.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
        );
        return;
      }
      case 'menu-pick':
        try {
          client.pick(msg.menuId, msg.itemId, msg.checked);
        } catch (err) {
          this.opts.log.error(`remote access: menu item from ${client.device.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
        return;
      case 'menu-dismiss':
        client.dismiss(msg.menuId);
        return;
      case 'dialog-result':
        client.answer(msg.dialogId, msg.result);
        return;
      case 'window-close':
      case 'window-closed-by-page': {
        const win = client.window(msg.w);
        if (win) win.close();
        // It closed while the tab was away, so the tab never heard: it goes now.
        else client.send({ t: 'window-close', w: msg.w });
        return;
      }
      case 'window-focus': {
        const win = client.window(msg.w);
        if (win) client.focusChanged(win);
        return;
      }
      case 'window-ready': {
        const win = client.window(msg.w);
        if (win) win.pageReady();
        else client.send({ t: 'window-close', w: msg.w });
        return;
      }
      case 'window-title':
        client.window(msg.w)?.pageTitle(msg.title);
        return;
      default:
        return;
    }
  }
}
