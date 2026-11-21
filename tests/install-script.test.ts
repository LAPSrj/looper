import path from 'node:path';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs, pickInstaller, releaseDir, reportTarget } = require('../scripts/install.js') as {
  reportTarget: (run?: string) => string | undefined;
  parseArgs: (argv: string[]) => { report?: string; installer?: string; dataDir?: string; dryRun: boolean; run: boolean };
  pickInstaller: (names: string[], version: string, platform?: string) => string | undefined;
  releaseDir: (platform?: string, arch?: string) => string;
};

describe('the release install script', () => {
  it("picks this version's installer for each OS, not an older or longer version's", () => {
    const win = ['Looper Setup 1.3.4.exe', 'Looper Setup 1.3.40.exe', 'Looper Setup 1.3.41.exe', 'Looper Setup 1.3.41.exe.blockmap', 'latest.yml'];
    expect(pickInstaller(win, '1.3.41', 'win32')).toBe('Looper Setup 1.3.41.exe');
    expect(pickInstaller(win, '1.3.4', 'win32')).toBe('Looper Setup 1.3.4.exe');
    expect(pickInstaller(win, '1.3.42', 'win32')).toBeUndefined();
    expect(pickInstaller(['Looper-1.3.41-arm64-mac.zip', 'Looper-1.3.41-arm64.dmg'], '1.3.41', 'darwin')).toBe('Looper-1.3.41-arm64-mac.zip');
    expect(pickInstaller(['Looper-1.3.41.AppImage', 'looper_1.3.41_amd64.deb'], '1.3.41', 'linux')).toBe('Looper-1.3.41.AppImage');
  });

  it("finds electron-builder's folder for the OS and arch", () => {
    expect(path.basename(releaseDir('win32', 'x64'))).toBe('win-x64');
    expect(path.basename(releaseDir('darwin', 'arm64'))).toBe('mac-arm64');
    expect(path.basename(releaseDir('linux', 'x64'))).toBe('linux-x64');
  });

  it("reports to the chat it runs in, by the chat's id, unless told otherwise, and refuses an unknown option", () => {
    expect(reportTarget('chat-20261120-210505-v67s')).toBe('20261120-210505-v67s');
    expect(reportTarget('20261120-101500-abcd')).toBe('20261120-101500-abcd');
    expect(reportTarget(undefined)).toBeUndefined();
    const before = process.env.LOOPER_RUN;
    process.env.LOOPER_RUN = 'chat-1';
    try {
      expect(parseArgs([])).toMatchObject({ report: '1', dryRun: false, run: false });
      expect(parseArgs(['--report', 'chat-2', '--dry-run'])).toMatchObject({ report: 'chat-2', dryRun: true });
      expect(() => parseArgs(['--nope'])).toThrow('unknown option --nope');
      expect(() => parseArgs(['--installer'])).toThrow('--installer needs a value');
    } finally {
      if (before === undefined) delete process.env.LOOPER_RUN;
      else process.env.LOOPER_RUN = before;
    }
  });
});
