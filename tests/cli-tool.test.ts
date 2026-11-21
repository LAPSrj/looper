import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliScript, installCli } from '../src/engine/cli-tool';

describe('the data dir copy of the command-line tool', () => {
  it('copies the tool\'s scripts, again only when one changed', async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-cli-src-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-cli-data-'));
    fs.writeFileSync(path.join(source, 'cli.js'), 'one');
    fs.writeFileSync(path.join(source, 'terminal-worker.js'), 'worker');
    fs.writeFileSync(path.join(source, 'notes.txt'), 'not a script');
    expect(await installCli(source, data)).toBe(2);
    expect(fs.readFileSync(cliScript(data), 'utf8')).toBe('one');
    expect(fs.readdirSync(path.dirname(cliScript(data))).sort()).toEqual(['cli.js', 'terminal-worker.js']);
    expect(await installCli(source, data)).toBe(0);
    fs.writeFileSync(path.join(source, 'cli.js'), 'two');
    expect(await installCli(source, data)).toBe(1);
    expect(fs.readFileSync(cliScript(data), 'utf8')).toBe('two');
    // `looper serve` run from the copy has nothing to copy.
    expect(await installCli(path.dirname(cliScript(data)), data)).toBe(0);
  });
});
