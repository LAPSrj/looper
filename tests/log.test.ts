import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('engine log pruning', () => {
  it('drops old entries and keeps every line logged while it rewrites the file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'looper-log-')), 'engine.log');
    fs.writeFileSync(file, '2020-01-01T00:00:00.000Z [info] old\n2099-01-01T00:00:00.000Z [info] kept\n');
    const log = new Logger(file);
    const pruning = log.pruneOlderThan(Date.parse('2026-01-01T00:00:00Z'));
    // Logged after the prune began, as the engine's start does.
    log.info('remote control started');
    expect(await pruning).toBe(1);
    log.info('after');
    log.close();
    await sleep(50);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => l.replace(/^\S+ /, ''))).toEqual(['[info] kept', '[info] remote control started', '[info] after']);
  });
});
