import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translatePath, translateToHost } from '../src/engine/target/paths';
import { BashTarget, WindowsTarget } from '../src/engine/target';
import { setDefaultWslDistro } from '../src/engine/host';

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

describe('BashTarget on the default distro (Windows host)', () => {
  it("can't name a distro file until the default distro is known, then uses its name", () => {
    const target = new BashTarget({ host: 'windows' }, undefined);
    setDefaultWslDistro(undefined);
    expect(() => target.toHostPath('/home/me/check.sh')).toThrow(/unknown WSL distro/);
    setDefaultWslDistro('Ubuntu-22.04');
    try {
      expect(target.toHostPath('/home/me/check.sh')).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\check.sh');
      // A named distro keeps its own name.
      expect(new BashTarget({ host: 'windows' }, 'Debian').toHostPath('/x')).toBe('\\\\wsl.localhost\\Debian\\x');
    } finally {
      setDefaultWslDistro(undefined);
    }
  });
});

describe('translateToHost', () => {
  it('wsl target -> windows host', () => {
    expect(translateToHost('/mnt/c/Users/me/x', { host: 'windows', targetKind: 'wsl', wslMountPrefix: '/mnt' })).toBe(
      'C:\\Users\\me\\x',
    );
    expect(
      translateToHost('/home/me/skill.md', { host: 'windows', targetKind: 'wsl', wslMountPrefix: '/mnt', targetDistro: 'Ubuntu' }),
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\skill.md');
    expect(() => translateToHost('/home/me/x', { host: 'windows', targetKind: 'wsl', wslMountPrefix: '/mnt' })).toThrow();
  });
  it('windows target -> wsl host', () => {
    expect(translateToHost('C:\\data\\x', { host: 'wsl', targetKind: 'windows', wslMountPrefix: '/mnt' })).toBe('/mnt/c/data/x');
  });
  it('same kind is identity', () => {
    expect(translateToHost('/home/me/x', { host: 'linux', targetKind: 'wsl', wslMountPrefix: '/mnt' })).toBe('/home/me/x');
    expect(translateToHost('C:\\x', { host: 'windows', targetKind: 'windows', wslMountPrefix: '/mnt' })).toBe('C:\\x');
  });
});

describe('BashTarget', () => {
  it('spawns through wsl.exe from windows', () => {
    const t = new BashTarget({ host: 'windows' }, 'Ubuntu');
    const spec = t.spawnSpec('C:\\data\\runs\\r1\\run.sh');
    expect(spec.command).toBe('wsl.exe');
    expect(spec.args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lic', "source '/mnt/c/data/runs/r1/run.sh'"]);
  });
  it('spawns bash directly on a linux host, honouring a custom shell', () => {
    const t = new BashTarget({ host: 'wsl' }, undefined, 'zsh -lc');
    const spec = t.spawnSpec('/home/me/.config/looper/runs/r1/run.sh');
    expect(spec).toEqual({ command: 'zsh', args: ['-lc', "source '/home/me/.config/looper/runs/r1/run.sh'"] });
  });
  it('honours a custom mount prefix', () => {
    const t = new BashTarget({ host: 'windows' }, 'Ubuntu', undefined, '/drives');
    expect(t.toTargetPath('C:\\data\\x')).toBe('/drives/c/data/x');
  });
  it('renders a launcher with env, PATH, helper and cd guard', () => {
    const t = new BashTarget({ host: 'wsl' }, undefined);
    const script = t.renderLauncher({
      taskId: 't',
      runId: 'r',
      cwd: "/home/me/it's here",
      env: { LOOPER_RUN: 'r', LOOPER_DONE_FILE: '/x/done' },
      binDir: '/x/bin',
      doneCommand: 'looper-done',
      doneStatuses: ['success', 'warning', 'error'],
      body: 'exec claude "$(cat \'/x/prompt.txt\')"',
    });
    expect(script).toContain("export LOOPER_RUN='r'");
    expect(script).toContain(`export PATH='/x/bin'":$PATH"`);
    expect(script).toContain("cd '/home/me/it'\\''s here' ||");
    expect(script).toContain('looper-done()');
    expect(script).toContain('success|warning|error');
    expect(script.trim().endsWith('exec claude "$(cat \'/x/prompt.txt\')"')).toBe(true);
  });
  it('quotes', () => {
    const t = new BashTarget({ host: 'wsl' }, undefined);
    expect(t.quote("a'b")).toBe("'a'\\''b'");
    expect(t.catFile('/p/x')).toBe(`"$(cat '/p/x')"`);
  });
  it.skipIf(process.platform !== 'linux')('the helpers print their usage for --help and -h and write nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-help-'));
    const t = new BashTarget({ host: 'wsl' }, undefined);
    const statuses = ['success', 'warning', 'error'];
    fs.writeFileSync(path.join(dir, 'looper-done'), t.renderDoneHelper(statuses), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'looper-complete'), t.renderTextHelper('LOOPER_DONE_FILE', 'completed'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'looper-restart'), t.renderStatusHelper('restart', 'context restart'), { mode: 0o755 });
    fs.writeFileSync(
      path.join(dir, 'launch.sh'),
      t.renderLauncher({ taskId: 't', runId: 'r', cwd: dir, env: {}, binDir: '/nonexistent', doneCommand: 'looper-done', doneStatuses: statuses, body: 'looper-done -h' }),
    );
    const done = path.join(dir, 'done');
    const run = (cmd: string): string => execFileSync('bash', ['-c', cmd], { cwd: dir, env: { ...process.env, LOOPER_DONE_FILE: done }, encoding: 'utf8' });
    const usage = 'usage: looper-done [success|warning|error] "<headline>"\n';
    expect(run('./looper-done --help')).toBe(usage);
    expect(run('./looper-done -h')).toBe(usage);
    expect(run('bash launch.sh')).toBe(usage);
    expect(run('./looper-complete --help')).toBe('usage: looper-complete "<reason>"\n');
    expect(run('./looper-restart -h')).toBe('usage: looper-restart "<reason>"\n');
    expect(fs.existsSync(done)).toBe(false);
    run('./looper-done warning "Fixed 3 flaky tests"');
    expect(fs.readFileSync(done, 'utf8')).toBe('warning\nFixed 3 flaky tests\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it.skipIf(process.platform !== 'linux')(
    'killLeftovers kills only the run marker, and KILLs what ignores TERM',
    async () => {
      const runId = `kill-test-${process.pid}`;
      const start = (marker: string, script: string): ChildProcess =>
        spawn('bash', ['-c', script], { env: { ...process.env, LOOPER_RUN: marker }, stdio: 'ignore' });
      const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode ? r() : c.once('exit', () => r())));
      const plain = start(runId, 'sleep 30');
      const stubborn = start(runId, 'trap "" TERM; sleep 30');
      const other = start(`${runId}-other`, 'sleep 30');
      await new Promise((r) => setTimeout(r, 200));
      await new BashTarget({ host: 'wsl' }, undefined).killLeftovers(runId);
      await Promise.all([exited(plain), exited(stubborn)]);
      expect(plain.signalCode).toBe('SIGTERM');
      expect(stubborn.signalCode).toBe('SIGKILL');
      expect(other.exitCode === null && other.signalCode === null).toBe(true);
      other.kill('SIGKILL');
    },
  );
});

describe('WindowsTarget', () => {
  it('spawns powershell with the translated path from WSL', () => {
    const t = new WindowsTarget({ host: 'wsl' });
    const spec = t.spawnSpec('/mnt/c/data/runs/r1/run.ps1');
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args.at(-1)).toBe('C:\\data\\runs\\r1\\run.ps1');
  });
  it('renders a launcher', () => {
    const t = new WindowsTarget({ host: 'windows' });
    const script = t.renderLauncher({
      taskId: 't',
      runId: 'r',
      cwd: 'C:\\repo',
      env: { LOOPER_RUN: 'r' },
      binDir: 'C:\\data\\bin',
      doneCommand: 'looper-done',
      doneStatuses: ['success', 'warning', 'error'],
      body: 'claude -p (Get-Content -Raw -LiteralPath \'C:\\p.txt\')',
    });
    expect(script).toContain("$env:LOOPER_RUN = 'r'");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\repo'");
    expect(script).toContain('function looper-done');
    expect(script).toContain("@('success','warning','error')");
    expect(script).toContain('exit $LASTEXITCODE');
    expect(script).toContain(`if ($msg -and @('--help','-h') -contains $msg[0]) { Write-Output 'usage: looper-done [success|warning|error] "<headline>"'`);
    expect(t.quote("it's")).toBe("'it''s'");
  });
  it('gives each .cmd helper a usage for --help and -h that ends before its write', () => {
    const t = new WindowsTarget({ host: 'windows' });
    for (const script of [t.renderDoneHelper(['success', 'warning', 'error']), t.renderTextHelper('LOOPER_COMPLETE_FILE', 'completed'), t.renderStatusHelper('restart', 'context restart')]) {
      const lines = script.split('\r\n');
      expect(lines.slice(2, 4)).toEqual(['if /i "%~1"=="--help" goto looper_usage', 'if /i "%~1"=="-h" goto looper_usage']);
      expect(lines.slice(-5, -1)[0]).toBe('exit /b 0');
      expect(lines.indexOf(':looper_usage')).toBeGreaterThan(lines.findLastIndex((l) => l.includes('> "%')));
    }
    expect(t.renderDoneHelper(['success', 'warning', 'error'])).toContain('echo usage: %~n0 [success^|warning^|error] "<headline>"');
  });
});
