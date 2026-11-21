import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandServer } from '../src/engine/command-server';
import { EngineLock, liveHolder, lockFile, type CommandServerInfo } from '../src/engine/lock';
import type { Logger } from '../src/engine/log';
import { SettingsSchema } from '../src/shared/types';

const log = { info() {}, warn() {}, error() {} } as unknown as Logger;

function call(port: number, opts: { token?: string; method?: string; path?: string; body?: string }): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/request', headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as { result?: unknown; error?: string } }));
      },
    );
    req.on('error', reject);
    req.end(opts.body ?? '');
  });
}

describe('the command server', () => {
  const servers: CommandServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function start(handle: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    let info: CommandServerInfo = {};
    const server = new CommandServer(handle, log, (i) => (info = i));
    servers.push(server);
    await server.start();
    return info as Required<Pick<CommandServerInfo, 'port' | 'token'>>;
  }

  it("answers a command with its handler's result, and with the handler's error as the reason", async () => {
    const seen: [string, Record<string, unknown>][] = [];
    const { port, token } = await start(async (method, params) => {
      seen.push([method, params]);
      if (method === 'pause') throw new Error('No task has the id nope.');
      return [{ id: 'chat-1' }];
    });
    expect(await call(port, { token, body: JSON.stringify({ method: 'sessions', params: { all: true } }) })).toEqual({ status: 200, body: { result: [{ id: 'chat-1' }] } });
    expect(await call(port, { token, body: JSON.stringify({ method: 'pause', params: { taskId: 'nope' } }) })).toEqual({ status: 422, body: { error: 'No task has the id nope.' } });
    expect(seen).toEqual([['sessions', { all: true }], ['pause', { taskId: 'nope' }]]);
  });

  it('refuses a request without the token, another path, a bad method or params that are not an object, before the handler', async () => {
    let called = 0;
    const { port, token } = await start(async () => ++called);
    const body = JSON.stringify({ method: 'sessions' });
    expect((await call(port, { body })).status).toBe(401);
    expect((await call(port, { token: token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), body })).status).toBe(401);
    expect((await call(port, { token, method: 'GET', body: '' })).status).toBe(404);
    expect((await call(port, { token, path: '/other', body })).status).toBe(404);
    expect(await call(port, { token, body: '{' })).toEqual({ status: 400, body: { error: "The request isn't JSON." } });
    expect(await call(port, { token, body: JSON.stringify({ method: 'Bad Name' }) })).toEqual({ status: 400, body: { error: 'The request must name a command.' } });
    expect(await call(port, { token, body: JSON.stringify({ method: 'sessions', params: [1] }) })).toEqual({ status: 400, body: { error: "The command's params must be an object." } });
    expect(called).toBe(0);
  });

  it('listens on 127.0.0.1 only, and stops listening when closed', async () => {
    let port = 0;
    const s2 = new CommandServer(async () => null, log, (i) => (port = i.port!));
    servers.push(s2);
    await s2.start();
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (lan) await expect(new Promise((resolve, reject) => http.get({ host: lan, port, path: '/request' }, resolve).on('error', reject))).rejects.toThrow();
    s2.close();
    await expect(call(port, { body: '' })).rejects.toThrow();
  });
});

describe('the engine lock and the command server', () => {
  it('publishes the port and token in the lock, which only its owner can read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-lock-'));
    const lock = new EngineLock(dir, 'serve', () => {});
    lock.acquire();
    lock.setServer({ port: 1234, token: 'secret' });
    expect(liveHolder(dir)).toMatchObject({ port: 1234, token: 'secret' });
    if (process.platform !== 'win32') expect(fs.statSync(lockFile(dir)).mode & 0o777).toBe(0o600);
    lock.setServer({ port: 1234, token: 'secret', wslPort: 1235 });
    lock.setServer({ port: 1234, token: 'secret' });
    expect(liveHolder(dir)?.wslPort).toBeUndefined();
    lock.release();
  });
});

describe('settings written before the command server', () => {
  it('still load, without the inbox poll', () => {
    const s = SettingsSchema.parse({ inboxPollMs: 100 });
    expect('inboxPollMs' in s).toBe(false);
  });
});
