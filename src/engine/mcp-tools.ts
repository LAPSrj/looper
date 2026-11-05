import { spawn } from 'node:child_process';
import type { Environment, Harness } from '../shared/types';
import type { AgentKind, McpServer, McpTool } from '../shared/agent-config';
import { DEFAULT_SHELL } from '../shared/environments';
import { envPrefix, envSide } from './discover-models';
import type { HostKind } from './host';

/*
 * The tools an MCP server offers, asked of the server itself: Looper speaks
 * the protocol's handshake (initialize, then tools/list) to it. A stdio server
 * starts in the environment, through its shell as the agent would start it
 * (crossing into WSL when it's there); an HTTP or SSE server is asked over
 * the network.
 */

const LIST_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_PAGES = 20;

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

const INITIALIZE = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'looper', version: '1' },
};

/** initialize, initialized, then every page of tools/list. */
async function handshake(call: Rpc, notify: (method: string) => Promise<void>): Promise<McpTool[]> {
  await call('initialize', INITIALIZE);
  await notify('notifications/initialized');
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call('tools/list', cursor ? { cursor } : {});
    const list = Array.isArray(result.tools) ? (result.tools as Record<string, unknown>[]) : [];
    for (const t of list) {
      if (typeof t?.name !== 'string') continue;
      tools.push({ name: t.name, ...(typeof t.description === 'string' && t.description ? { description: t.description } : {}) });
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

/** A JSON-RPC answer's result, or its error as an Error. */
function resultOf(msg: Record<string, unknown>): Record<string, unknown> {
  if (msg.error) {
    const e = msg.error as { message?: unknown };
    throw new Error(`the server answered with an error: ${typeof e.message === 'string' ? e.message : JSON.stringify(msg.error)}`);
  }
  return (msg.result ?? {}) as Record<string, unknown>;
}

// ---------- stdio ----------

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Literal text and ${VAR} / ${VAR:-default} references (Claude Code expands them in a server's command, arguments and variables). */
function refParts(s: string, expand: boolean): ({ text: string } | { name: string; fallback?: string })[] {
  if (!expand) return [{ text: s }];
  const out: ({ text: string } | { name: string; fallback?: string })[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ name: m[1], ...(m[2] !== undefined ? { fallback: m[2] } : {}) });
    at = m.index + m[0].length;
  }
  if (at < s.length || out.length === 0) out.push({ text: s.slice(at) });
  return out;
}

/** A word for an assignment (no word splitting there): quoted text and ${VAR} references. */
function posixWord(s: string, expand: boolean): string {
  return refParts(s, expand)
    .map((p) => ('text' in p ? posixQuote(p.text) : p.fallback !== undefined ? `\${${p.name}:-${posixQuote(p.fallback)}}` : `\${${p.name}}`))
    .join('');
}

/** A PowerShell expression for the text with its ${VAR} references. */
function psWord(s: string, expand: boolean): string {
  const parts = refParts(s, expand).map((p) =>
    'text' in p ? psQuote(p.text) : p.fallback !== undefined ? `$(if ($env:${p.name}) { $env:${p.name} } else { ${psQuote(p.fallback)} })` : `"$env:${p.name}"`,
  );
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`;
}

/** The shell script that starts the server in the environment, in its folder, with the harness's and the server's variables. */
export function stdioScript(side: 'posix' | 'windows', server: McpServer, harnessEnv: Record<string, string>, cwd: string | undefined, expand: boolean): string {
  const words = [server.command, ...server.args];
  if (side === 'posix') {
    const vars = Object.entries(server.env).map(([k, v]) => `export ${k}=${posixWord(v, expand)}; `);
    const assigns = words.map((w, i) => `__looper_a${i}=${posixWord(w, expand)}; `);
    return (
      (cwd ? `cd ${posixQuote(cwd)} 2>/dev/null; ` : '') +
      envPrefix(side, harnessEnv) +
      vars.join('') +
      assigns.join('') +
      `exec ${words.map((_, i) => `"$__looper_a${i}"`).join(' ')}`
    );
  }
  const vars = Object.entries(server.env).map(([k, v]) => `$env:${k} = ${psWord(v, expand)}; `);
  return (
    (cwd ? `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction SilentlyContinue; ` : '') +
    envPrefix(side, harnessEnv) +
    vars.join('') +
    `& ${words.map((w) => psWord(w, expand)).join(' ')}`
  );
}

function listStdio(env: Environment, host: HostKind, script: string, timeoutMs: number): Promise<McpTool[]> {
  const side = envSide(env, host);
  let argv: string[];
  if (side === 'windows') argv = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  else {
    const shellParts = (env.shell?.trim() || DEFAULT_SHELL).split(/\s+/);
    const prefix = env.kind === 'wsl' ? (env.distro ? ['wsl.exe', '-d', env.distro, '--'] : ['wsl.exe', '--']) : [];
    argv = [...prefix, ...shellParts, script];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>();
    let nextId = 1;
    let stderr = '';
    let buf = '';
    let settled = false;
    const finish = (err: Error | null, tools?: McpTool[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of pending.values()) p.fail(err ?? new Error('done'));
      pending.clear();
      child.stdin.end();
      // A server that doesn't leave once its input closes is stopped.
      setTimeout(() => child.kill(), 2000).unref?.();
      if (err) reject(err);
      else resolve(tools ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`the server didn't answer within ${timeoutMs / 1000}s`)), timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => finish(new Error(e.code === 'ENOENT' ? `${argv[0]} is not available on this machine` : e.message)));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    child.on('close', (code) => {
      const last = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^bash: (cannot set terminal|no job control)/.test(l))
        .pop();
      finish(new Error(last ? `the server stopped: ${last.slice(0, 300)}` : `the server stopped (exit code ${code ?? '?'}) before it answered`));
    });
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.startsWith('{')) continue; // a login shell's own output
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = typeof msg.id === 'number' ? msg.id : NaN;
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        try {
          p.ok(resultOf(msg));
        } catch (e) {
          p.fail(e as Error);
        }
      }
    });
    child.stdin.on('error', () => undefined);
    const write = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const call: Rpc = (method, params) =>
      new Promise((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        write({ id, method, ...(params ? { params } : {}) });
      });
    handshake(call, async (method) => void write({ method })).then(
      (tools) => finish(null, tools),
      (e: Error) => finish(e),
    );
  });
}

// ---------- HTTP and SSE ----------

/** The server events of a text/event-stream body, as they arrive: each event's name and data. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let end = buf.indexOf('\n\n');
      while (end >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        end = buf.indexOf('\n\n');
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
    void body.cancel().catch(() => undefined);
  }
}

function httpError(status: number): Error {
  if (status === 401 || status === 403) return new Error('the server wants a sign-in (OAuth or a token), which Looper does not have');
  return new Error(`the server answered with HTTP status ${status}`);
}

/** Streamable HTTP: each message is a POST; the answer is JSON, or an event stream that carries it. */
async function listHttp(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<McpTool[]> {
  let session: string | undefined;
  let nextId = 1;
  const post = async (msg: Record<string, unknown>): Promise<Response> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
        ...(nextId > 2 ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
      signal,
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (!res.ok) throw httpError(res.status);
    return res;
  };
  const call: Rpc = async (method, params) => {
    const id = nextId++;
    const res = await post({ id, method, ...(params ? { params } : {}) });
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
      for await (const ev of sseEvents(res.body)) {
        try {
          const msg = JSON.parse(ev.data) as Record<string, unknown>;
          if (msg.id === id) return resultOf(msg);
        } catch {
          /* not one of ours */
        }
      }
      throw new Error('the server closed its answer without a result');
    }
    return resultOf((await res.json()) as Record<string, unknown>);
  };
  const notify = async (method: string) => {
    const res = await post({ method });
    await res.body?.cancel().catch(() => undefined);
  };
  return handshake(call, notify);
}

/** The older HTTP+SSE transport: a GET event stream names the URL to POST to, and carries the answers. */
async function listSse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<McpTool[]> {
  const res = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw httpError(res.status);
  const events = sseEvents(res.body);
  let endpoint: string | undefined;
  const waiting = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  const gotEndpoint = new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        for await (const ev of events) {
          if (ev.event === 'endpoint') {
            endpoint = new URL(ev.data.trim(), url).toString();
            resolve();
            continue;
          }
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(ev.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const w = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
          if (!w) continue;
          waiting.delete(msg.id as number);
          try {
            w.ok(resultOf(msg));
          } catch (e) {
            w.fail(e as Error);
          }
        }
        throw new Error('the server closed its event stream');
      } catch (e) {
        reject(e as Error);
        for (const w of waiting.values()) w.fail(e as Error);
      }
    })();
  });
  await gotEndpoint;
  let nextId = 1;
  const post = async (msg: Record<string, unknown>) => {
    const r = await fetch(endpoint!, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...msg }), signal });
    if (!r.ok) throw httpError(r.status);
    await r.body?.cancel().catch(() => undefined);
  };
  const call: Rpc = (method, params) =>
    new Promise((ok, fail) => {
      const id = nextId++;
      waiting.set(id, { ok, fail });
      post({ id, method, ...(params ? { params } : {}) }).catch(fail);
    });
  return handshake(call, (method) => post({ method }));
}

/**
 * The tools the server offers. `cwd`: the folder a stdio server starts in (the project's, or the home folder).
 * Throws with a short reason when the server can't be asked.
 */
export async function listMcpTools(
  env: Environment,
  harness: Harness,
  host: HostKind,
  kind: AgentKind,
  server: McpServer,
  cwd: string | undefined,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<McpTool[]> {
  if (server.transport === 'stdio') {
    if (!server.command.trim()) throw new Error('the server has no command');
    return listStdio(env, host, stdioScript(envSide(env, host), server, harness.env, cwd, kind === 'claude-code'), timeoutMs);
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return server.transport === 'sse' ? await listSse(server.url, server.headers, abort.signal) : await listHttp(server.url, server.headers, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) throw new Error(`the server didn't answer within ${timeoutMs / 1000}s`);
    const err = e as Error & { cause?: { code?: string } };
    if (err.message === 'fetch failed') throw new Error(`can't reach ${server.url}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
