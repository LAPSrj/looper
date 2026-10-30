import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../engine/log';
import type { PairingCode, PushPayload, PwaIconName, RemoteAccessProviderId, RemoteAccessState, RemoteAccessStatus } from '../../shared/remote-access';
import type { SessionSummary } from '../../shared/sessions';
import type { RemoteAccessSettings } from '../../shared/types';
import { RemoteClients } from '../platform/clients';
import { IpcTable } from '../platform/ipc-table';
import { DeviceStore, Pairing, type Clock } from './devices';
import { LocalProvider, TailscaleProvider, type AccessProvider, type ProviderStatus } from './providers';
import { PushSender, PushStore, WaitWatcher, waitingPayload, webPushSend, type PushSend } from './push';
import { RemoteServer, freePort, type RemoteConnection } from './server';

export type { RemoteConnection } from './server';
export type { AccessProvider, ProviderStartOptions, ProviderStatus } from './providers';

export interface RemoteAccessOptions {
  dataDir: string;
  log: Logger;
  settings: () => RemoteAccessSettings;
  /** Every state change, for the desktop windows. */
  emit: (state: RemoteAccessState) => void;
  /** Looper's version, for the welcome message. */
  version: string;
  now?: Clock;
  /** The built renderer; defaults to out/renderer next to out/main. */
  staticDir?: string;
  /** Tests swap in their own providers. */
  createProvider?: (id: RemoteAccessProviderId) => AccessProvider;
  /** The main process's IPC handlers, which remote invokes and sends reach; none when left out. */
  ipc?: IpcTable;
  /** Tests: how long a disconnected tab keeps its windows. */
  graceMs?: number;
  /** The home-screen icons, as PNG. */
  icon?: (name: PwaIconName) => Buffer | null;
  /** Tests swap in their own push service. */
  pushSend?: PushSend;
}

/** How long a push service keeps a message for a device that's off. */
const TOAST_TTL_S = 60 * 60;
const WAITING_TTL_S = 15 * 60;

type Applied = Pick<RemoteAccessSettings, 'provider' | 'hostname' | 'port'>;

/** A wanted port that is the one already listened on counts as unchanged (saving the port 0 picked). */
const sameConfig = (want: Applied | null, applied: Applied | null, listening: number): boolean =>
  want === applied ||
  (!!want && !!applied && want.provider === applied.provider && want.hostname === applied.hostname && (want.port === applied.port || want.port === listening));

/**
 * Remote Access: the server, its provider, paired devices and the pairing
 * code. `apply` follows the settings; everything else comes from the desktop
 * windows.
 */
export class RemoteAccess {
  private readonly dir: string;
  private readonly now: Clock;
  private readonly devices: DeviceStore;
  private readonly pairing: Pairing;
  private readonly server: RemoteServer;
  private readonly push: PushStore;
  private readonly pusher: PushSender;
  private readonly waits = new WaitWatcher();
  /** The browser tabs and their windows. */
  readonly clients: RemoteClients;
  private provider: AccessProvider | null = null;
  private unsubscribe: (() => void) | null = null;
  private secret = '';
  private applied: Applied | null = null;
  /** The port the server listens on; 0 while it's off. */
  private listening = 0;
  /** The computer's name at the last apply, to tell open tabs when it changes. */
  private computer = '';
  private status: RemoteAccessStatus;
  private pairedWith: RemoteAccessState['pairedWith'];
  /** The code the Pair Device window shows, to match `pairedWith` to it. */
  private lastCode: string | null = null;
  /** apply/signOut run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly opts: RemoteAccessOptions) {
    this.dir = path.join(opts.dataDir, 'remote-access');
    this.now = opts.now ?? Date.now;
    this.devices = new DeviceStore(path.join(this.dir, 'devices.json'), this.now);
    this.pairing = new Pairing(this.now);
    this.status = { phase: 'off', provider: opts.settings().provider };
    this.push = new PushStore(path.join(this.dir, 'push.json'), this.now);
    this.pusher = new PushSender(this.push, opts.pushSend ?? webPushSend, opts.log, () =>
      this.status.url?.startsWith('https://') ? this.status.url : 'mailto:looper@localhost.localdomain',
    );
    const push = this.push;
    this.server = new RemoteServer({
      dir: this.dir,
      staticDir: opts.staticDir ?? path.join(__dirname, '../renderer'),
      devices: this.devices,
      pairing: this.pairing,
      log: opts.log,
      now: this.now,
      onPaired: (d) => {
        opts.log.info(`remote access: paired ${d.name}`);
        const code = this.lastCode;
        if (code) this.pairedWith = { code, device: { id: d.id, name: d.name } };
        this.changed();
      },
      onConnectionsChanged: () => this.changed(),
      push: {
        publicKey: () => push.vapid().publicKey,
        subscribe: (deviceId, sub) => push.subscribe(deviceId, sub),
        unsubscribe: (deviceId, endpoint) => void push.unsubscribe(deviceId, endpoint),
      },
      ...(opts.icon ? { icon: opts.icon } : {}),
      onUnpair: (id) => this.removeDevice(id),
      onRenamed: () => this.changed(),
      computerName: () => opts.settings().name.trim() || os.hostname(),
    });
    this.clients = new RemoteClients({
      ipc: opts.ipc ?? new IpcTable(),
      log: opts.log,
      version: opts.version,
      dir: this.dir,
      offerDownload: (file, name, onDone) => this.server.offerDownload(file, name, onDone),
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    });
    this.server.onConnection((c) => this.connected(c));
  }

  /** Start, stop or restart to match the settings. */
  apply(settings: RemoteAccessSettings): Promise<void> {
    const computer = settings.name.trim() || os.hostname();
    if (this.computer && computer !== this.computer) this.clients.broadcast({ t: 'computer', name: computer });
    this.computer = computer;
    return this.enqueue(async () => {
      const want: Applied | null = settings.enabled ? { provider: settings.provider, hostname: settings.hostname, port: settings.port } : null;
      if (sameConfig(want, this.applied, this.listening)) return;
      await this.stopAll();
      if (want) await this.startAll(want);
      else this.opts.log.info('remote access: turned off');
    });
  }

  /** The port the server listens on now, or else a free one: what the Settings window fills in while the port isn't set. */
  suggestPort(): Promise<number> {
    return this.listening ? Promise.resolve(this.listening) : freePort();
  }

  state(): RemoteAccessState {
    return {
      ...this.status,
      defaultName: os.hostname(),
      devices: this.devices.list().map((d) => ({
        id: d.id,
        name: d.name,
        provider: d.provider,
        pairedAt: d.pairedAt,
        ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
        connected: this.server.connectedCount(d.id),
      })),
      ...(this.pairedWith ? { pairedWith: this.pairedWith } : {}),
    };
  }

  /** A new code, replacing the one before; only while running. */
  newPairingCode(): PairingCode {
    if (this.status.phase !== 'running' || !this.status.url) throw new Error('Remote Access isn\'t on.');
    const { code, expiresAt } = this.pairing.newCode();
    this.lastCode = code;
    if (this.pairedWith) {
      this.pairedWith = undefined;
      this.changed();
    }
    return { code, expiresAt, link: `${this.status.url}/pair#${code}` };
  }

  cancelPairing(): void {
    this.pairing.cancel();
    this.lastCode = null;
    if (this.pairedWith) {
      this.pairedWith = undefined;
      this.changed();
    }
  }

  removeDevice(id: string): void {
    const d = this.devices.get(id);
    if (!d || !this.devices.remove(id)) return;
    this.push.removeDevice(id);
    this.server.closeDevice(id);
    this.clients.disposeDevice(id);
    this.opts.log.info(`remote access: removed ${d.name}`);
    this.changed();
  }

  renameDevice(id: string, name: string): void {
    if (!this.devices.rename(id, name)) throw new Error('This device is no longer paired.');
    this.changed();
  }

  /** Sign this computer out of Tailscale; while Remote Access stays on, it then asks for a new sign-in. */
  signOut(): Promise<void> {
    return this.enqueue(async () => {
      const p = this.provider;
      if (!p?.signOut) throw new Error('Remote Access isn\'t signed in to Tailscale.');
      const applied = this.applied;
      await this.stopAll();
      try {
        await p.signOut();
      } finally {
        if (applied) await this.startAll(applied);
      }
    });
  }

  /** A one-time download token for a file on this computer (GET /api/download/<token>). */
  offerDownload(filePath: string, name: string, onDone?: () => void): string {
    return this.server.offerDownload(filePath, name, onDone);
  }

  /** A desktop toast the computer shows now: every paired device not looking at Looper gets it as a push. */
  pushToast(n: { title: string; body: string; taskId?: string; runId?: string }): Promise<void> {
    const payload: PushPayload = {
      title: n.title,
      body: n.body,
      tag: `task:${n.taskId ?? '-'}:${n.runId ?? '-'}`,
      ...(n.taskId ? { open: { kind: 'task' as const, taskId: n.taskId, ...(n.runId ? { runId: n.runId } : {}) } } : {}),
    };
    return this.pushAway(payload, 'normal', TOAST_TTL_S);
  }

  /**
   * The sessions' state changed: a session that started waiting for the user
   * (a question, a finished turn) is pushed, unless `notify` is off (Looper's
   * notifications are), when it's only noted as seen.
   */
  sessionsChanged(sessions: SessionSummary[], notify: boolean): Promise<void> {
    const fresh = this.waits.next(sessions);
    if (!notify) return Promise.resolve();
    return Promise.all(fresh.map((s) => this.pushAway(waitingPayload(s), 'high', WAITING_TTL_S))).then(() => undefined);
  }

  /**
   * To the devices without a tab on screen: one that's looking gets the
   * in-page toast instead (and iOS shows every push it gets, so the server
   * decides, not the service worker).
   */
  private async pushAway(payload: PushPayload, urgency: 'normal' | 'high', ttlSeconds: number): Promise<void> {
    if (this.status.phase !== 'running') return;
    const visible = this.server.visibleDevices();
    const away = this.devices.list().map((d) => d.id).filter((id) => !visible.has(id));
    if (away.length) await this.pusher.push(away, payload, { urgency, ttlSeconds });
  }

  /** Each new connection, after its hello. */
  onConnection(cb: (c: RemoteConnection) => void): () => void {
    return this.server.onConnection(cb);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.enqueue(() => this.stopAll());
    this.clients.disposeAll();
    this.devices.save();
  }

  // ---------- internals ----------

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private changed(): void {
    if (!this.disposed) this.opts.emit(this.state());
  }

  private setStatus(s: RemoteAccessStatus): void {
    const was = this.status;
    this.status = s;
    if (s.phase !== was.phase || s.url !== was.url || s.account !== was.account) this.logStatus(s);
    this.changed();
  }

  private logStatus(s: RemoteAccessStatus): void {
    const log = this.opts.log;
    if (s.phase === 'running') log.info(`remote access: on at ${s.url}${s.account ? ` as ${s.account}` : ''}`);
    else if (s.phase === 'needs-login') log.info('remote access: sign in to Tailscale needed');
    else if (s.phase === 'error') log.error(`remote access: ${s.message ?? 'error'}`);
  }

  private async startAll(want: Applied): Promise<void> {
    this.applied = want;
    this.setStatus({ phase: 'starting', provider: want.provider });
    let port: number;
    try {
      port = await this.server.listen(want.port);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const message = e.code === 'EADDRINUSE' ? `Port ${want.port} is in use. Choose another port.` : `Can't start the server: ${e.message}`;
      this.setStatus({ phase: 'error', provider: want.provider, message });
      return;
    }
    this.listening = port;
    this.secret = crypto.randomBytes(32).toString('base64url');
    const provider = this.opts.createProvider?.(want.provider) ?? (want.provider === 'tailscale' ? new TailscaleProvider(this.opts.log) : new LocalProvider());
    this.provider = provider;
    this.server.setAccess(want.provider === 'local' ? { kind: 'local' } : { kind: 'tailscale', secret: this.secret, login: undefined });
    this.unsubscribe = provider.onStatus((s) => this.providerStatus(provider, s, port));
    provider.start({ port, secret: this.secret, hostname: want.hostname, stateDir: path.join(this.dir, want.provider) });
  }

  private providerStatus(provider: AccessProvider, s: ProviderStatus, port: number): void {
    if (provider !== this.provider) return;
    if (provider.id === 'tailscale') {
      this.server.setAccess({ kind: 'tailscale', secret: this.secret, login: s.phase === 'running' ? s.account : undefined });
    }
    if (s.phase !== 'running') this.cancelPairing();
    this.setStatus({ ...s, provider: provider.id, port });
  }

  private async stopAll(): Promise<void> {
    const provider = this.provider;
    const wasOn = this.applied !== null;
    this.provider = null;
    this.applied = null;
    this.listening = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelPairing();
    this.clients.disconnectAll();
    if (provider) await provider.stop().catch((err) => this.opts.log.error(`remote access: stopping ${provider.id} failed: ${String(err)}`));
    await this.server.close();
    if (wasOn) this.setStatus({ phase: 'off', provider: this.opts.settings().provider });
  }

  private connected(c: RemoteConnection): void {
    const log = this.opts.log;
    log.info(`remote access: ${c.device.name} connected (${c.platform})`);
    c.onClose(() => log.info(`remote access: ${c.device.name} disconnected`));
    this.clients.attach(c);
  }
}
