import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalHost } from '../src/engine/terminal-host';

const PERMISSION_PROMPT =
  '\x1b[39mDo you want\x1b[14Gto\x1b[17Gcreate\x1b[24G\x1b[1mhello.txt\x1b[22m?\x1b[1C\x1b[1B\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1. \x1b[38;5;153mYes' +
  '\x1b[1B\x1b[22m\x1b[38;5;246m3. \x1b[39mNo\x1b[1C\x1b[2B\x1b[38;5;246mEsc to cancel · Tab to amend\x1b[39m';

let dir: string;
let workerFile: string;
let brokenWorker: string;

function until(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-host-'));
  workerFile = path.join(dir, 'terminal-worker.js');
  const esbuild = await import('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(process.cwd(), 'src/engine/terminal-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: workerFile,
  });
  brokenWorker = path.join(dir, 'broken-worker.js');
  fs.writeFileSync(brokenWorker, 'throw new Error("worker load failed");\n', 'utf8');
}, 60_000);

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
});

describe('TerminalHost', () => {
  it('writes the clean log through the worker', async () => {
    const file = path.join(dir, 'round-trip.txt');
    const host = new TerminalHost({ file, cols: 80, rows: 24, screen: false, workerFile });
    host.write('hello\r\nworld\r\n');
    await host.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('hello');
    expect(text).toContain('world');
  });

  it('reports what is on screen when the screen model is enabled', async () => {
    const file = path.join(dir, 'screen.txt');
    const host = new TerminalHost({ file, cols: 120, rows: 32, screen: true, workerFile });
    expect(host.screenContains(/Esc\s+to\s+cancel/i)).toBe(false);
    host.write('\x1b[H' + PERMISSION_PROMPT);
    expect(await until(() => host.screenContains(/Esc\s+to\s+cancel/i))).toBe(true);
    await host.close();
  });

  it('survives a worker that fails to load', async () => {
    const errors: Error[] = [];
    const host = new TerminalHost({
      file: path.join(dir, 'dead.txt'),
      cols: 80,
      rows: 24,
      screen: true,
      workerFile: brokenWorker,
      onError: (e) => errors.push(e),
    });
    expect(await until(() => errors.length > 0)).toBe(true);
    host.write('ignored');
    host.resize(100, 40);
    expect(host.screenContains(/anything/)).toBe(false);
    await host.close();
    expect(errors).toHaveLength(1);
  });
});
