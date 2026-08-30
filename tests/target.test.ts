import { describe, expect, it } from 'vitest';
import { translatePath } from '../src/engine/target/paths';
import { BashTarget, WindowsTarget } from '../src/engine/target';
import { SettingsSchema } from '../src/shared/types';

const settings = SettingsSchema.parse({});

describe('translatePath', () => {
  it('windows host -> wsl target', () => {
    expect(
      translatePath('C:\\Users\\me\\AppData\\Roaming\\looper\\runs\\1', {
        host: 'windows',
        targetKind: 'wsl',
        wslMountPrefix: '/mnt',
      }),
    ).toBe('/mnt/c/Users/me/AppData/Roaming/looper/runs/1');
    expect(
      translatePath('\\\\wsl.localhost\\Ubuntu\\home\\me\\x', { host: 'windows', targetKind: 'wsl', wslMountPrefix: '/mnt' }),
    ).toBe('/home/me/x');
  });
  it('wsl host -> windows target', () => {
    expect(translatePath('/mnt/c/Users/me/x', { host: 'wsl', targetKind: 'windows', wslMountPrefix: '/mnt' })).toBe(
      'C:\\Users\\me\\x',
    );
    expect(
      translatePath('/home/me/.config/looper', { host: 'wsl', targetKind: 'windows', wslMountPrefix: '/mnt', hostDistro: 'Ubuntu' }),
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.config\\looper');
  });
  it('same kind is identity', () => {
    expect(translatePath('/home/me', { host: 'wsl', targetKind: 'wsl', wslMountPrefix: '/mnt' })).toBe('/home/me');
    expect(translatePath('C:\\x', { host: 'windows', targetKind: 'windows', wslMountPrefix: '/mnt' })).toBe('C:\\x');
  });
  it('refuses windows target from plain linux', () => {
    expect(() => translatePath('/x', { host: 'linux', targetKind: 'windows', wslMountPrefix: '/mnt' })).toThrow();
  });
});

describe('BashTarget', () => {
  it('spawns through wsl.exe from windows', () => {
    const t = new BashTarget({ host: 'windows', settings }, 'Ubuntu');
    const spec = t.spawnSpec('C:\\data\\runs\\r1\\run.sh');
    expect(spec.command).toBe('wsl.exe');
    expect(spec.args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lic', "source '/mnt/c/data/runs/r1/run.sh'"]);
  });
  it('spawns bash directly on a linux host, honouring a custom shell', () => {
    const t = new BashTarget({ host: 'wsl', settings }, undefined, 'zsh -lc');
    const spec = t.spawnSpec('/home/me/.config/looper/runs/r1/run.sh');
    expect(spec).toEqual({ command: 'zsh', args: ['-lc', "source '/home/me/.config/looper/runs/r1/run.sh'"] });
  });
  it('renders a launcher with env, PATH, helper and cd guard', () => {
    const t = new BashTarget({ host: 'wsl', settings }, undefined);
    const script = t.renderLauncher({
      taskId: 't',
      runId: 'r',
      cwd: "/home/me/it's here",
      env: { LOOPER_RUN: 'r', LOOPER_DONE_FILE: '/x/done' },
      binDir: '/x/bin',
      body: 'exec claude "$(cat \'/x/prompt.txt\')"',
    });
    expect(script).toContain("export LOOPER_RUN='r'");
    expect(script).toContain(`export PATH='/x/bin'":$PATH"`);
    expect(script).toContain("cd '/home/me/it'\\''s here' ||");
    expect(script).toContain('looper-done()');
    expect(script.trim().endsWith('exec claude "$(cat \'/x/prompt.txt\')"')).toBe(true);
  });
  it('quotes', () => {
    const t = new BashTarget({ host: 'wsl', settings }, undefined);
    expect(t.quote("a'b")).toBe("'a'\\''b'");
    expect(t.catFile('/p/x')).toBe(`"$(cat '/p/x')"`);
  });
});

describe('WindowsTarget', () => {
  it('spawns powershell with the translated path from WSL', () => {
    const t = new WindowsTarget({ host: 'wsl', settings });
    const spec = t.spawnSpec('/mnt/c/data/runs/r1/run.ps1');
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args.at(-1)).toBe('C:\\data\\runs\\r1\\run.ps1');
  });
  it('renders a launcher', () => {
    const t = new WindowsTarget({ host: 'windows', settings });
    const script = t.renderLauncher({
      taskId: 't',
      runId: 'r',
      cwd: 'C:\\repo',
      env: { LOOPER_RUN: 'r' },
      binDir: 'C:\\data\\bin',
      body: 'claude -p (Get-Content -Raw -LiteralPath \'C:\\p.txt\')',
    });
    expect(script).toContain("$env:LOOPER_RUN = 'r'");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\repo'");
    expect(script).toContain('function looper-done');
    expect(script).toContain('exit $LASTEXITCODE');
    expect(t.quote("it's")).toBe("'it''s'");
  });
});
