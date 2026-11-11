import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnOffThread, type OffThreadChild } from '../../engine/exec-worker';
import type { Logger } from '../../engine/log';
import { tail } from '../../engine/store/fsutil';
import type { RemoteAccessPhase, RemoteAccessProviderId, TsnetMessage } from '../../shared/remote-access';

export interface ProviderStartOptions {
  /** The 127.0.0.1 port the server listens on. */
  port: number;
  /** Per-start secret the provider's proxy sends in PROXY_SECRET_HEADER. */
  secret: string;
  hostname: string;
  /** Where the provider keeps its own state (Tailscale's node keys). */
  stateDir: string;
}

/** A provider's part of RemoteAccessStatus. */
export interface ProviderStatus {
  phase: RemoteAccessPhase;
  url?: string;
  loginUrl?: string;
  account?: string;
  message?: string;
}

/** What makes the 127.0.0.1 server reachable from other devices. */
export interface AccessProvider {
  readonly id: RemoteAccessProviderId;
  /** Statuses follow through onStatus. */
  start(opts: ProviderStartOptions): void;
  stop(): Promise<void>;
  /** Forget the sign-in; the provider is stopped afterwards. */
  signOut?(): Promise<void>;
  onStatus(cb: (s: ProviderStatus) => void): () => void;
}

abstract class BaseProvider {
  private readonly cbs = new Set<(s: ProviderStatus) => void>();

  onStatus(cb: (s: ProviderStatus) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  protected status(s: ProviderStatus): void {
    for (const cb of this.cbs) cb(s);
  }
}

/** This computer's browser only: the server itself, at localhost. */
export class LocalProvider extends BaseProvider implements AccessProvider {
  readonly id = 'local' as const;

  start(opts: ProviderStartOptions): void {
    this.status({ phase: 'running', url: `http://localhost:${opts.port}` });
  }

  async stop(): Promise<void> {
    this.status({ phase: 'off' });
  }
}

/** The bundled helper: out/tsnet next to out/main, unpacked from the asar in the packaged app. */
export function defaultHelperPath(): string {
  const name = process.platform === 'win32' ? 'looper-tsnet.exe' : 'looper-tsnet';
  const p = path.join(__dirname, '../tsnet', name);
  return p.includes('app.asar.unpacked') ? p : p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
}

/** A run shorter than this that ends on its own counts as a quick failure. */
const QUICK_FAILURE_MS = 60_000;
const MAX_QUICK_FAILURES = 3;
const STOP_GRACE_MS = 3_000;
const LOGOUT_TIMEOUT_MS = 30_000;

/** The TsnetMessage on a stdout line, or null. */
export function parseTsnetLine(line: string): TsnetMessage | null {
  let m: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== 'object') return null;
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (k: string) => typeof m[k] === 'string';
  if (m.type === 'log') {
    return (m.level === 'info' || m.level === 'warn' || m.level === 'error') && s('message') ? (m as TsnetMessage) : null;
  }
  if (m.type !== 'status') return null;
  switch (m.state) {
    case 'starting':
    case 'logged-out':
      return m as TsnetMessage;
    case 'needs-login':
      return s('loginUrl') ? (m as TsnetMessage) : null;
    case 'running':
      return s('url') && s('dnsName') && s('login') && m.login !== '' ? (m as TsnetMessage) : null;
    case 'error':
      return s('message') ? (m as TsnetMessage) : null;
    default:
      return null;
  }
}

/**
 * Tailscale through the looper-tsnet helper: it joins the tailnet as its own
 * node and proxies HTTPS to the server. Restarted after a crash, up to
 * MAX_QUICK_FAILURES quick failures in a row.
 */
export class TailscaleProvider extends BaseProvider implements AccessProvider {
  readonly id = 'tailscale' as const;
  private child: OffThreadChild | null = null;
  private opts: ProviderStartOptions | null = null;
  private stopping = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private exited: Promise<void> = Promise.resolve();
  private lastError: string | undefined;

  constructor(
    private readonly log: Logger,
    private readonly helperPath = defaultHelperPath(),
  ) {
    super();
  }

  start(opts: ProviderStartOptions): void {
    this.opts = opts;
    this.stopping = false;
    this.failures = 0;
    this.launch();
  }

  private launch(): void {
    const opts = this.opts;
    if (!opts || this.stopping) return;
    if (!fs.existsSync(this.helperPath)) {
      this.status({ phase: 'error', message: `Looper's Tailscale helper is missing (${this.helperPath}). Reinstall Looper.` });
      return;
    }
    this.status({ phase: 'starting' });
    this.lastError = undefined;
    const args = ['--dir', opts.stateDir, '--hostname', opts.hostname, '--target', `http://127.0.0.1:${opts.port}`];
    let child: OffThreadChild;
    try {
      child = spawnOffThread(this.helperPath, args, {
        env: { ...process.env, LOOPER_PROXY_SECRET: opts.secret },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.status({ phase: 'error', message: `Can't start the Tailscale helper: ${(err as Error).message}` });
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    let lastStderr = '';
    child.stdin?.on('error', () => undefined);
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      if (!line.trim()) return;
      lastStderr = line.trim();
      this.log.debug(`remote access: tailscale helper: ${line.slice(0, 2000)}`);
    });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    this.exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (done) return;
        done = true;
        if (this.child === child) this.child = null;
        resolve();
        if (this.stopping) return;
        const how = spawnError ? spawnError.message : signal ? `signal ${signal}` : `exit code ${code}`;
        this.log.warn(`remote access: tailscale helper stopped (${how})`);
        this.failures = Date.now() - startedAt < QUICK_FAILURE_MS ? this.failures + 1 : 1;
        if (this.failures >= MAX_QUICK_FAILURES) {
          this.status({ phase: 'error', message: this.lastError ?? (lastStderr || `The Tailscale helper stopped (${how}).`) });
          return;
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.launch();
        }, 1000 * this.failures);
      };
      child.on('error', (err) => finish(null, null, err));
      child.on('exit', (code, signal) => finish(code, signal));
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    const m = parseTsnetLine(line);
    if (!m) {
      this.log.warn(`remote access: tailscale helper: ${line.slice(0, 500)}`);
      return;
    }
    if (m.type === 'log') {
      this.log.log(m.level, `remote access: tailscale: ${m.message}`);
      return;
    }
    if (m.state === 'starting') this.status({ phase: 'starting' });
    else if (m.state === 'needs-login') this.status({ phase: 'needs-login', loginUrl: m.loginUrl });
    else if (m.state === 'running') {
      this.failures = 0;
      this.status({ phase: 'running', url: m.url.replace(/\/+$/, ''), account: m.login });
    } else if (m.state === 'error') {
      this.lastError = m.message;
      this.status({ phase: 'error', message: m.message });
    }
  }

  /** End its stdin (it exits by itself), then kill it after STOP_GRACE_MS. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (child) {
      child.stdin?.end();
      const kill = setTimeout(() => child.kill(), STOP_GRACE_MS);
      await this.exited;
      clearTimeout(kill);
    }
    this.status({ phase: 'off' });
  }

  async signOut(): Promise<void> {
    await this.stop();
    const stateDir = this.opts?.stateDir;
    if (!stateDir) return;
    if (!fs.existsSync(this.helperPath)) throw new Error(`Looper's Tailscale helper is missing (${this.helperPath}).`);
    await new Promise<void>((resolve, reject) => {
      const child = spawnOffThread(this.helperPath, ['logout', '--dir', stateDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      const collect = (d: Buffer) => (out = tail(out + d.toString('utf8'), 4000));
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);
      const timer = setTimeout(() => child.kill(), LOGOUT_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Can't sign out of Tailscale: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          this.log.info('remote access: signed out of Tailscale');
          resolve();
          return;
        }
        const error = out
          .split('\n')
          .map(parseTsnetLine)
          .find((m): m is Extract<TsnetMessage, { state: 'error' }> => m?.type === 'status' && m.state === 'error');
        reject(new Error(error?.message ?? `Can't sign out of Tailscale (exit code ${code}).`));
      });
    });
  }
}
