import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { CommandServerInfo } from './lock';
import type { Logger } from './log';
import { errMsg } from './log';

/** A command's params can hold a whole task or a message, never files. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Windows' addresses on its WSL adapter, which exists while WSL runs in NAT
 * mode: WSL reaches Windows there (its default gateway), not on 127.0.0.1.
 * The adapter's address changes each time WSL starts.
 */
export function wslAdapterAddresses(): string[] {
  if (process.platform !== 'win32') return [];
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => /^vEthernet \(WSL/i.test(name))
    .flatMap(([, addrs]) => (addrs ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address));
}

type Handle = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * The server `looper` sends its commands to: one JSON request, one JSON answer.
 * It listens on 127.0.0.1, and on Windows also on the WSL adapter's address.
 * Every request carries the token from the engine lock, which only this user
 * can read, so nothing else on the computer can command Looper.
 */
export class CommandServer {
  readonly token = crypto.randomBytes(32).toString('hex');
  private readonly servers = new Map<string, http.Server>();
  private port = 0;
  private wslPort: number | undefined;
  private closed = false;

  constructor(
    private readonly handle: Handle,
    private readonly log: Logger,
    private readonly onChange: (info: CommandServerInfo) => void,
  ) {}

  async start(): Promise<void> {
    this.port = await this.listen('127.0.0.1', 0);
    await this.followWsl();
    this.publish();
  }

  /** Listen on the WSL adapter's address as it comes, goes and changes. */
  async followWsl(): Promise<void> {
    if (this.closed || !this.port) return;
    const want = new Set(wslAdapterAddresses());
    let changed = false;
    for (const [address, server] of this.servers) {
      if (address === '127.0.0.1' || want.has(address)) continue;
      server.close();
      this.servers.delete(address);
      changed = true;
    }
    for (const address of want) {
      if (this.servers.has(address)) continue;
      try {
        // The same port as on 127.0.0.1 when it's free there too.
        this.wslPort = await this.listen(address, this.port).catch(() => this.listen(address, 0));
        changed = true;
      } catch (e) {
        this.log.warn(`command server: cannot listen on ${address}: ${errMsg(e)}`);
      }
    }
    if (!want.size && this.wslPort !== undefined) {
      this.wslPort = undefined;
      changed = true;
    }
    if (changed && !this.closed) this.publish();
  }

  close(): void {
    this.closed = true;
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
  }

  private publish(): void {
    this.onChange({ port: this.port, token: this.token, ...(this.wslPort !== undefined ? { wslPort: this.wslPort } : {}) });
  }

  private listen(address: string, port: number): Promise<number> {
    const server = http.createServer((req, res) => void this.serve(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => {
        server.off('error', reject);
        server.on('error', (e) => this.log.error(`command server on ${address}: ${errMsg(e)}`));
        this.servers.set(address, server);
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${this.token}`);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/request') return answer(404, { error: 'Looper takes only POST /request here.' });
    if (!this.authorized(req)) return answer(401, { error: "The request didn't carry Looper's token." });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) return answer(413, { error: 'The request is too large.' });
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return answer(400, { error: "The request isn't JSON." });
    }
    const { method, params = {} } = (body ?? {}) as { method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !/^[a-z][a-z-]*$/.test(method)) return answer(400, { error: 'The request must name a command.' });
    if (!params || typeof params !== 'object' || Array.isArray(params)) return answer(400, { error: "The command's params must be an object." });
    try {
      const result = await this.handle(method, params as Record<string, unknown>);
      this.log.info(`command: ${method}`);
      answer(200, { result: result ?? null });
    } catch (e) {
      answer(422, { error: errMsg(e) });
    }
  }
}
