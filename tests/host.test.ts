import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertWslPath, detectHost, mountPrefixFromWslPath } from '../src/engine/host';

describe('mountPrefixFromWslPath', () => {
  it('extracts the automount root from wslpath output', () => {
    expect(mountPrefixFromWslPath('/mnt/c/\n')).toBe('/mnt');
    expect(mountPrefixFromWslPath('/mnt/c')).toBe('/mnt');
    expect(mountPrefixFromWslPath('/custom/drives/c/')).toBe('/custom/drives');
  });
  it('rejects anything that is not a drive mount path', () => {
    expect(mountPrefixFromWslPath('C:\\')).toBeUndefined();
    expect(mountPrefixFromWslPath('')).toBeUndefined();
    expect(mountPrefixFromWslPath('error: no such distro')).toBeUndefined();
  });
});

describe('convertWslPath', () => {
  // wslpath resolves a link only in a path that exists, and Windows can't open the unresolved one over \\wsl.localhost:
  // a transcript the Chats list asked for before Claude Code wrote it must not keep that path.
  it.skipIf(detectHost() !== 'wsl')('converts a file behind a link again once it exists, when asked to', { timeout: 15_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-wslpath-'));
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    const file = path.join(dir, 'link', 'session.jsonl');
    const before = await convertWslPath(file, 'windows', undefined, true);
    expect(before).toMatch(/\\link\\session\.jsonl$/);
    // A conversion whose file is missing is kept 5 s, so polling doesn't start wsl.exe each time, then dropped.
    await new Promise((r) => setTimeout(r, 5_300));
    fs.writeFileSync(path.join(dir, 'real', 'session.jsonl'), '');
    expect(await convertWslPath(file, 'windows', undefined, true)).toMatch(/\\real\\session\.jsonl$/);
  });
});
