import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { CleanLog } from '../src/engine/cleanlog';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanlog-'));
  return path.join(dir, 'output.txt');
}

function flush(ms = 600): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('CleanLog', () => {
  const files: string[] = [];

  function make(cols = 80, rows = 24): { log: CleanLog; file: string } {
    const file = tmpFile();
    files.push(file);
    return { log: new CleanLog(file, cols, rows), file };
  }

  afterEach(() => {
    for (const f of files) {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* ok */ }
    }
    files.length = 0;
  });

  it('writes normal forward output', async () => {
    const { log, file } = make();
    log.write('hello\r\nworld\r\n');
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(text).not.toContain('[rewrite');
  });

  it('detects carriage-return line overwrite', async () => {
    const { log, file } = make();
    log.write('progress: 0%');
    await flush();
    log.write('\rprogress: 100%');
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[rewrite');
    expect(text).toContain('progress: 100%');
  });

  it('detects cursor-up overwrite', async () => {
    const { log, file } = make();
    log.write('line1\r\nline2\r\nline3\r\n');
    await flush();
    // Move up 2 lines and overwrite line2
    log.write('\x1b[2Achanged2\r\n');
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[rewrite');
    expect(text).toContain('changed2');
  });

  it('handles screen clear with fewer lines after', async () => {
    const { log, file } = make();
    log.write('line1\r\nline2\r\nline3\r\n');
    await flush();
    log.write('\x1b[2J\x1b[Hafter\r\n');
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[clear]');
    expect(text).toContain('after');
  });

  it('treats full-content replacement as rewrite when line count matches', async () => {
    const { log, file } = make();
    log.write('before\r\n');
    await flush();
    log.write('\x1b[2J\x1b[Hafter\r\n');
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[rewrite');
    expect(text).toContain('after');
  });

  it('debounces rapid writes into a single drain', async () => {
    const { log, file } = make();
    for (let i = 0; i < 20; i++) {
      log.write(`\rprogress: ${i * 5}%`);
    }
    await flush();
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('progress: 95%');
    const rewriteCount = (text.match(/\[rewrite/g) || []).length;
    expect(rewriteCount).toBeLessThanOrEqual(1);
  });

  it('flushes pending writes on close', async () => {
    const { log, file } = make();
    log.write('final\r\n');
    await log.close();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('final');
  });
});
