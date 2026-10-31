import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../engine/log';
import {
  REMOTE_ACCESS_SOURCES,
  type PairingCode,
  type PushPayload,
  type PwaIconName,
  type RemoteAccessPhase,
  type RemoteAccessProviderId,
  type RemoteAccessSourceStatus,
  type RemoteAccessState,
  type RemoteAccessStatus,
} from '../../shared/remote-access';
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
  /** The home-screen app's launch screens, as PNG by pixel size. */
  startup?: (width: number, height: number, dark: boolean) => Buffer | null;
  /** Tests swap in their own push service. */
  pushSend?: PushSend;
  /**
   * The settings' port was 0 and the server picked this one: save it, so the
   * address devices use (http://localhost:<port>) stays the same after a
   * restart or an update.
   */
  savePort?: (port: number) => void;
}

/** How long a push service keeps a message for a device that's off. */
const TOAST_TTL_S = 60 * 60;
const WAITING_TTL_S = 15 * 60;

/** What runs: the chosen sources (in REMOTE_ACCESS_SOURCES order), Tailscale's machine name and the port. */
interface Applied {
  sources: RemoteAccessProviderId[];
  hostname: string;
  port: number;
}

/** A started source: its provider and its last status. */
interface Running {
  provider: AccessProvider;
  status: ProviderStatus;
  unsubscribe: () => void;
}

/** What `settings` asks to run, or null for off (turned off, or no source chosen). */
export function wanted(settings: RemoteAccessSettings): Applied | null {
  if (!settings.enabled) return null;
  const sources = REMOTE_ACCESS_SOURCES.filter((s) => settings.sources.includes(s));
  return sources.length ? { sources, hostname: settings.hostname, port: settings.port } : null;
}

/** The whole status from the sources' (see RemoteAccessStatus.phase). */
function overallPhase(sources: RemoteAccessSourceStatus[], listening: boolean): RemoteAccessPhase {
  const phases = new Set(sources.map((s) => s.phase));
  if (phases.has('running')) return 'running';
  if (phases.has('needs-login')) return 'needs-login';
  if (!listening || phases.has('starting') || phases.has('off')) return 'starting';
  return 'error';
}

/**
 * Remote Access: the server, its sources (each started and stopped on its
 * own), paired devices and the pairing code. `apply` follows the settings;
 * everything else comes from the desktop windows.
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
  private readonly running = new Map<RemoteAccessProviderId, Running>();
  /** Set Up's Tailscale sign-in, while Tailscale isn't a running source. */
  private signIn: (Running & { hostname: string }) | null = null;
  /** The Tailscale helper's per-server-start proxy secret. */
  private secret = '';
  private applied: Applied | null = null;
  /** Why the server itself couldn't start (while applied). */
  private serverError: string | undefined;
  /** The port the server listens on; 0 while it's off. */
  private listening = 0;
  /** The computer's name at the last apply, to tell open tabs when it changes. */
  private computer = '';
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
    this.pairing = new Pairing(this.now, () => this.changed());
    this.push = new PushStore(path.join(this.dir, 'push.json'), this.now);
    this.pusher = new PushSender(this.push, opts.pushSend ?? webPushSend, opts.log, () => {
      const url = this.runningUrl('tailscale');
      return url?.startsWith('https://') ? url : 'mailto:looper@localhost.localdomain';
    });
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
      ...(opts.startup ? { startup: opts.startup } : {}),
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

  /**
   * Match the settings: the server starts with the first source and stops
   * with the last; a source added or removed starts or stops alone; a new
   * port restarts everything, a new machine name restarts Tailscale.
   */
  apply(settings: RemoteAccessSettings): Promise<void> {
    const computer = settings.name.trim() || os.hostname();
    if (this.computer && computer !== this.computer) this.clients.broadcast({ t: 'computer', name: computer });
    this.computer = computer;
    return this.enqueue(async () => {
      const want = wanted(settings);
      const was = this.applied;
      if (!want) {
        if (!was) return;
        await this.stopAll();
        this.opts.log.info('remote access: turned off');
        return;
      }
      // A wanted port that is the one already listened on counts as unchanged (saving the port 0 picked).
      const samePort = !!was && (want.port === was.port || (this.listening > 0 && want.port === this.listening));
      const sameSources = !!was && want.sources.join() === was.sources.join();
      if (samePort && sameSources && was.hostname === want.hostname) return;
      if (!was || !samePort || this.serverError) {
        await this.stopAll();
        if (!(await this.startServer(want))) return;
      } else {
        for (const id of [...this.running.keys()]) {
          if (!want.sources.includes(id) || (id === 'tailscale' && was.hostname !== want.hostname)) await this.stopSource(id);
        }
        this.applied = want;
      }
      for (const id of want.sources) if (!this.running.has(id)) await this.startSource(id);
      this.changed();
    });
  }

  /** The port the server listens on now, or else a free one: what the Settings window fills in while the port isn't set. */
  suggestPort(): Promise<number> {
    return this.listening ? Promise.resolve(this.listening) : freePort();
  }

  status(): RemoteAccessStatus {
    const a = this.applied;
    if (!a) return { phase: 'off', sources: [] };
    if (this.serverError) return { phase: 'error', sources: [], message: this.serverError };
    const sources: RemoteAccessSourceStatus[] = a.sources.map((id) => ({ ...(this.running.get(id)?.status ?? { phase: 'starting' }), id }));
    return {
      phase: overallPhase(sources, this.listening > 0),
      sources,
      ...(this.listening ? { port: this.listening } : {}),
    };
  }

  state(): RemoteAccessState {
    const lockedCode = this.pairing.lockedCode();
    return {
      ...this.status(),
      ...(this.signIn ? { setup: { ...this.signIn.status, id: 'tailscale' as const } } : {}),
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
      ...(lockedCode ? { lockedCode } : {}),
    };
  }

  /**
   * A new code, replacing the one before; only while a source runs. It pairs
   * through any running source: the Pair Device window links it to each
   * running source's address (`<url>/pair#<code>`) from the state.
   */
  newPairingCode(): PairingCode {
    if (!REMOTE_ACCESS_SOURCES.some((source) => this.runningUrl(source))) throw new Error('Remote Access isn\'t on.');
    const wasLocked = this.pairing.lockedCode() !== null;
    const { code, expiresAt } = this.pairing.newCode();
    this.lastCode = code;
    if (this.pairedWith || wasLocked) {
      this.pairedWith = undefined;
      this.changed();
    }
    return { code, expiresAt };
  }

  cancelPairing(): void {
    const wasLocked = this.pairing.lockedCode() !== null;
    this.pairing.cancel();
    this.lastCode = null;
    if (this.pairedWith || wasLocked) {
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

  /** Sign this computer out of Tailscale; while Tailscale stays a source, it then asks for a new sign-in. The other sources keep running. */
  signOut(): Promise<void> {
    return this.enqueue(async () => {
      const p = this.running.get('tailscale')?.provider;
      if (!p?.signOut) throw new Error('Remote Access isn\'t signed in to Tailscale.');
      await this.stopSource('tailscale');
      try {
        await p.signOut();
      } finally {
        if (this.applied?.sources.includes('tailscale') && this.listening) await this.startSource('tailscale');
        this.changed();
      }
    });
  }

  /**
   * Set Up's sign-in: while Tailscale isn't a running source, its helper runs
   * alone (state.setup) with nothing behind it, so the computer can sign in
   * before Remote Access is turned on. While Tailscale runs, its own status
   * shows the sign-in instead.
   */
  beginSignIn(hostname: string): Promise<void> {
    return this.enqueue(async () => {
      // The same sign-in already under way is kept; one that failed starts again (Set Up's Try Again).
      const source = this.running.get('tailscale');
      if (source) {
        if (source.status.phase === 'error') {
          await this.stopSource('tailscale');
          await this.startSource('tailscale');
          this.changed();
        }
        return;
      }
      if (this.signIn && this.signIn.hostname === hostname && this.signIn.status.phase !== 'error') return;
      await this.stopSignIn();
      const provider = this.createProvider('tailscale');
      const entry: Running & { hostname: string } = { provider, hostname, status: { phase: 'starting' }, unsubscribe: () => undefined };
      this.signIn = entry;
      entry.unsubscribe = provider.onStatus((s) => {
        if (this.signIn !== entry) return;
        entry.status = s;
        this.changed();
      });
      // Nothing listens at the target: once signed in, the helper has no server to pass requests to.
      const port = await freePort();
      provider.start({ port, secret: crypto.randomBytes(32).toString('base64url'), hostname, stateDir: path.join(this.dir, 'tailscale') });
      this.changed();
    });
  }

  /** Stop Set Up's sign-in helper (Set Up closed, or it's done). */
  endSignIn(): Promise<void> {
    return this.enqueue(() => this.stopSignIn());
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
    if (!this.anyRunning()) return;
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
    await this.enqueue(async () => {
      await this.stopSignIn();
      await this.stopAll();
    });
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

  /** A running source's address. */
  private runningUrl(id: RemoteAccessProviderId): string | undefined {
    const s = this.running.get(id)?.status;
    return s?.phase === 'running' ? s.url : undefined;
  }

  private anyRunning(): boolean {
    return [...this.running.values()].some((r) => r.status.phase === 'running');
  }

  private createProvider(id: RemoteAccessProviderId): AccessProvider {
    return this.opts.createProvider?.(id) ?? (id === 'tailscale' ? new TailscaleProvider(this.opts.log) : new LocalProvider());
  }

  /** Listen for `want`; false (and the error in the status) when the server can't start. */
  private async startServer(want: Applied): Promise<boolean> {
    this.applied = want;
    this.serverError = undefined;
    this.changed();
    let port: number;
    try {
      port = await this.server.listen(want.port);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      this.serverError = e.code === 'EADDRINUSE' ? `Port ${want.port} is in use. Choose another port.` : `Can't start the server: ${e.message}`;
      this.opts.log.error(`remote access: ${this.serverError}`);
      this.changed();
      return false;
    }
    this.listening = port;
    this.secret = crypto.randomBytes(32).toString('base64url');
    if (want.port === 0) this.opts.savePort?.(port);
    return true;
  }

  private async startSource(id: RemoteAccessProviderId): Promise<void> {
    const a = this.applied;
    if (!a || !this.listening) return;
    // One helper per Tailscale state folder: Set Up's gives way.
    if (id === 'tailscale') {
      await this.stopSignIn();
      this.server.setTailscaleAccess({ secret: this.secret, login: undefined });
    }
    const provider = this.createProvider(id);
    const entry: Running = { provider, status: { phase: 'starting' }, unsubscribe: () => undefined };
    this.running.set(id, entry);
    entry.unsubscribe = provider.onStatus((s) => this.sourceStatus(id, entry, s));
    provider.start({ port: this.listening, secret: this.secret, hostname: a.hostname, stateDir: path.join(this.dir, id) });
  }

  private sourceStatus(id: RemoteAccessProviderId, entry: Running, s: ProviderStatus): void {
    if (this.running.get(id) !== entry) return;
    const was = entry.status;
    entry.status = s;
    if (id === 'tailscale') this.server.setTailscaleAccess({ secret: this.secret, login: s.phase === 'running' ? s.account : undefined });
    else this.server.setLocalAccess(s.phase === 'running');
    if (!this.anyRunning()) this.cancelPairing();
    if (s.phase !== was.phase || s.url !== was.url || s.account !== was.account) this.logSource(id, s);
    this.changed();
  }

  private logSource(id: RemoteAccessProviderId, s: ProviderStatus): void {
    const log = this.opts.log;
    if (s.phase === 'running') log.info(`remote access: ${id} on at ${s.url}${s.account ? ` as ${s.account}` : ''}`);
    else if (s.phase === 'needs-login') log.info('remote access: sign in to Tailscale needed');
    else if (s.phase === 'error') log.error(`remote access: ${id}: ${s.message ?? 'error'}`);
  }

  /** Stop one source; the devices paired through it lose their connections, the others keep theirs. */
  private async stopSource(id: RemoteAccessProviderId): Promise<void> {
    const entry = this.running.get(id);
    if (!entry) return;
    this.running.delete(id);
    entry.unsubscribe();
    if (id === 'tailscale') this.server.setTailscaleAccess(null);
    else this.server.setLocalAccess(false);
    for (const d of this.devices.list()) if (d.provider === id) this.server.closeDevice(d.id);
    if (!this.anyRunning()) this.cancelPairing();
    await entry.provider.stop().catch((err) => this.opts.log.error(`remote access: stopping ${id} failed: ${String(err)}`));
  }

  private async stopSignIn(): Promise<void> {
    const entry = this.signIn;
    if (!entry) return;
    this.signIn = null;
    entry.unsubscribe();
    await entry.provider.stop().catch((err) => this.opts.log.error(`remote access: stopping the sign-in failed: ${String(err)}`));
    this.changed();
  }

  private async stopAll(): Promise<void> {
    const wasOn = this.applied !== null;
    const entries = [...this.running];
    this.running.clear();
    this.applied = null;
    this.serverError = undefined;
    this.listening = 0;
    for (const [, e] of entries) e.unsubscribe();
    this.cancelPairing();
    this.clients.disconnectAll();
    await Promise.all(
      entries.map(([id, e]) => e.provider.stop().catch((err) => this.opts.log.error(`remote access: stopping ${id} failed: ${String(err)}`))),
    );
    await this.server.close();
    if (wasOn) this.changed();
  }

  private connected(c: RemoteConnection): void {
    const log = this.opts.log;
    log.info(`remote access: ${c.device.name} connected (${c.platform})`);
    c.onClose(() => log.info(`remote access: ${c.device.name} disconnected`));
    this.clients.attach(c);
  }
}
