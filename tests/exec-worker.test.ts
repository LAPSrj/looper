import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execOffThread, spawnOffThread, spawnPtyOffThread, type OffThreadChild } from '../src/engine/exec-worker';

const node = process.execPath;
const PTY = createRequire(import.meta.url).resolve('node-pty');
const PTY_OPTS = { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> };

describe('spawnPtyOffThread on this system', () => {
  it('runs a program in a terminal, with its output and exit code', async () => {
    const [file, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'echo hello-pty& exit 3']] : ['/bin/sh', ['-c', 'echo hello-pty; exit 3']];
    const pty = spawnPtyOffThread(PTY, file as string, args as string[], PTY_OPTS, () => undefined);
    let out = '';
    pty.onData((d) => (out += d));
    expect(await new Promise((r) => pty.onExit(r))).toBe(3);
    expect(out).toContain('hello-pty');
    expect(await pty.spawned).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === 'win32')('spawnPtyOffThread', () => {
  it('runs a program in a terminal, with its output, pid and exit code', async () => {
    const pty = spawnPtyOffThread(PTY, '/bin/sh', ['-c', 'stty size; read line; echo "got $line"; exit 3'], PTY_OPTS, () => undefined);
    let out = '';
    pty.onData((d) => (out += d));
    const code = new Promise<number | null>((r) => pty.onExit(r));
    expect(await pty.spawned).toBeGreaterThan(0);
    pty.write('hello\r');
    expect(await code).toBe(3);
    expect(out).toContain('24 80');
    expect(out).toContain('got hello');
  });

  it('resizes the terminal', async () => {
    const pty = spawnPtyOffThread(PTY, '/bin/sh', ['-c', 'read line; stty size'], PTY_OPTS, () => undefined);
    let out = '';
    pty.onData((d) => (out += d));
    const done = new Promise((r) => pty.onExit(r));
    await pty.spawned;
    pty.resize(100, 30);
    pty.write('\r');
    await done;
    expect(out).toContain('30 100');
  });

  it('kills a terminal asked to stop before it started', async () => {
    const pty = spawnPtyOffThread(PTY, '/bin/sh', ['-c', 'sleep 10'], PTY_OPTS, () => undefined);
    pty.kill();
    const started = Date.now();
    await new Promise<void>((r) => pty.onExit(() => r()));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('execOffThread', () => {
  it('returns what the program wrote', async () => {
    const r = await execOffThread(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], {});
    expect(r).toEqual({ error: null, stdout: 'out', stderr: 'err' });
  });

  it('gives the exit code of a program that fails', async () => {
    const r = await execOffThread(node, ['-e', 'process.exit(3)'], {});
    expect(r.error?.code).toBe(3);
  });

  it("names a program that isn't there", async () => {
    const r = await execOffThread('looper-no-such-program', [], {});
    expect(r.error?.code).toBe('ENOENT');
  });

  it('kills a program past its timeout', async () => {
    const r = await execOffThread(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
    expect(r.error?.killed).toBe(true);
  });

  it('runs several at once', async () => {
    const rs = await Promise.all([1, 2, 3].map((n) => execOffThread(node, ['-e', `process.stdout.write("${n}")`], {})));
    expect(rs.map((r) => r.stdout)).toEqual(['1', '2', '3']);
  });

  it('decodes UTF-16 output', async () => {
    const r = await execOffThread(node, ['-e', 'process.stdout.write(Buffer.from("Ubuntu\\r\\n", "utf16le"))'], { encoding: 'utf16le' });
    expect(r.stdout).toBe('Ubuntu\r\n');
  });
});

/** Everything the child wrote and how it ended, once it has closed. */
function collect(child: OffThreadChild): Promise<{ out: string; err: string; code: number | null; signal: string | null; events: string[] }> {
  let out = '';
  let err = '';
  const events: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => (out += d));
  child.stderr?.on('data', (d: string) => (err += d));
  child.on('spawn', () => events.push('spawn'));
  child.on('error', (e) => events.push(`error ${e.code}`));
  child.on('exit', () => events.push('exit'));
  return new Promise((resolve) => child.on('close', (code, signal) => resolve({ out, err, code, signal, events: [...events, 'close'] })));
}

describe('spawnOffThread', () => {
  it('streams output and closes after the last of it', async () => {
    const child = spawnOffThread(node, ['-e', 'for (let i = 0; i < 2000; i++) process.stdout.write("x".repeat(499) + "\\n"); process.stderr.write("e"); process.exitCode = 2']);
    const r = await collect(child);
    expect(r.out.length).toBe(1_000_000);
    expect(r.err).toBe('e');
    expect(r.code).toBe(2);
    expect(r.events).toEqual(['spawn', 'exit', 'close']);
    expect(child.exitCode).toBe(2);
  });

  it('gives its pid once started', async () => {
    const child = spawnOffThread(node, ['-e', 'process.stdout.write(String(process.pid))']);
    const pid = await child.spawned;
    const r = await collect(child);
    expect(pid).toBe(child.pid);
    expect(r.out).toBe(String(pid));
  });

  it('takes input', async () => {
    const child = spawnOffThread(node, ['-e', 'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => process.stdout.write(s.toUpperCase()))']);
    child.stdin!.write('héllo ');
    child.stdin!.end('wörld');
    expect((await collect(child)).out).toBe('HÉLLO WÖRLD');
  });

  it("reports a program that isn't there and still closes", async () => {
    const child = spawnOffThread('looper-no-such-program', []);
    const r = await collect(child);
    expect(r.events).toContain('error ENOENT');
    expect(r.events.at(-1)).toBe('close');
    expect(await child.spawned).toBeUndefined();
  });

  it('kills a process', async () => {
    const child = spawnOffThread(node, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    await child.spawned;
    expect(child.stdout).toBeNull();
    expect(child.kill()).toBe(true);
    const r = await collect(child);
    expect(r.code === null || r.signal !== null || r.code !== 0).toBe(true);
    expect(child.kill()).toBe(false);
  });

  it('kills a process asked to stop before it started', async () => {
    const child = spawnOffThread(node, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    child.kill();
    const started = Date.now();
    await collect(child);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
