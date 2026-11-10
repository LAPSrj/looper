import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertWslPath, detectHost, mapWslPath, mountPrefixFromWslPath } from '../src/engine/host';

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

describe('mapWslPath', () => {
  const roots = { unc: '\\\\wsl.localhost\\Ubuntu-22.04\\', mount: '/mnt' };
  it('converts to Windows as wslpath -w does', () => {
    expect(mapWslPath('/tmp/x0.png', 'windows', roots)).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\tmp\\x0.png');
    expect(mapWslPath('/', 'windows', roots)).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\');
    expect(mapWslPath('/mnt/c/Users/leand', 'windows', roots)).toBe('C:\\Users\\leand');
    expect(mapWslPath('/mnt/c', 'windows', roots)).toBe('C:\\');
    expect(mapWslPath('/mnt/cache/x', 'windows', roots)).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\cache\\x');
  });
  it('converts to WSL as wslpath -u does, for this distro only', () => {
    expect(mapWslPath('C:\\Users\\leand', 'posix', roots)).toBe('/mnt/c/Users/leand');
    expect(mapWslPath('C:\\', 'posix', roots)).toBe('/mnt/c/');
    expect(mapWslPath('\\\\wsl.localhost\\ubuntu-22.04\\home\\dev', 'posix', roots)).toBe('/home/dev');
    expect(mapWslPath('\\\\wsl$\\Ubuntu-22.04', 'posix', roots)).toBe('/');
    expect(mapWslPath('\\\\wsl.localhost\\Debian\\home', 'posix', roots)).toBeUndefined();
  });
  it('leaves to wslpath what it maps in its own way: relative paths and names Windows can’t hold', () => {
    expect(mapWslPath('src/x.ts', 'windows', roots)).toBeUndefined();
    expect(mapWslPath('/home/dev/a:b.txt', 'windows', roots)).toBeUndefined();
    expect(mapWslPath('relative\\x', 'posix', roots)).toBeUndefined();
  });
});

describe('convertWslPath', () => {
  it.skipIf(process.platform !== 'win32')('from Windows: a path that exists in-process, one behind a link resolved in WSL', { timeout: 60_000 }, async () => {
    const dir = `/tmp/looper-convert-${process.pid}`;
    execFileSync('wsl.exe', ['-e', 'sh', '-c', `mkdir -p ${dir}/real && echo x > ${dir}/real/f.txt && ln -sfn ${dir}/real ${dir}/link`]);
    try {
      const plain = await convertWslPath(`${dir}/real/f.txt`, 'windows', undefined, true);
      expect(plain).toMatch(/^\\\\wsl(\.localhost|\$)\\[^\\]+\\tmp\\looper-convert-\d+\\real\\f\.txt$/);
      expect(fs.existsSync(plain!)).toBe(true);
      // Windows can't follow the link: wslpath's answer names the folder it points at.
      expect(await convertWslPath(`${dir}/link/f.txt`, 'windows', undefined, true)).toBe(plain);
      expect(await convertWslPath(`${dir}/missing.txt`, 'windows')).toBe(plain!.replace(/real\\f\.txt$/, 'missing.txt'));
      expect(await convertWslPath('C:\\Windows', 'posix')).toMatch(/^\/.+\/c\/Windows$/);
    } finally {
      execFileSync('wsl.exe', ['-e', 'rm', '-rf', dir]);
    }
  });

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
