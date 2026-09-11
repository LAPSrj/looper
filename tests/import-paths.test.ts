import { describe, expect, it } from 'vitest';
import { adjustImportedTaskPaths, type ImportPathDeps } from '../src/main/import-paths';
import { SettingsSchema, type Settings } from '../src/shared/types';

/** Local-posix settings; existing = the host paths that "exist". */
function localSetup(existing: string[]): { settings: Settings; deps: ImportPathDeps } {
  const settings = SettingsSchema.parse({
    environments: [{ id: 'local', name: 'Local Shell', kind: 'local', harnesses: [{ id: 'claude', name: 'Claude', command: 'claude' }] }],
    defaultEnvironmentId: 'local',
  });
  const deps: ImportPathDeps = {
    exists: (p) => existing.includes(p),
    convert: () => Promise.resolve(undefined),
  };
  return { settings, deps };
}

const FILE = '/shared/tasks/bugherd.loopertask';

const base = { id: 'bugherd', environmentId: 'local', cwd: '/home/me/work', check: { command: 'bash ./check.sh' } };

describe('adjustImportedTaskPaths', () => {
  it('keeps a working directory that exists', async () => {
    const { settings, deps } = localSetup(['/home/me/work']);
    const out = await adjustImportedTaskPaths({ ...base }, FILE, settings, 'linux', deps);
    expect(out.cwd).toBe('/home/me/work');
  });

  it("replaces a missing working directory with the file's folder", async () => {
    const { settings, deps } = localSetup([]);
    const out = await adjustImportedTaskPaths({ ...base }, FILE, settings, 'linux', deps);
    expect(out.cwd).toBe('/shared/tasks');
  });

  it("fills a blank or non-absolute working directory with the file's folder", async () => {
    const { settings, deps } = localSetup([]);
    expect((await adjustImportedTaskPaths({ ...base, cwd: '' }, FILE, settings, 'linux', deps)).cwd).toBe('/shared/tasks');
    expect((await adjustImportedTaskPaths({ ...base, cwd: 42 }, FILE, settings, 'linux', deps)).cwd).toBe('/shared/tasks');
    expect((await adjustImportedTaskPaths({ ...base, cwd: 'rel/dir' }, FILE, settings, 'linux', deps)).cwd).toBe('/shared/tasks');
  });

  it('re-points a missing check-command path at the same name next to the file', async () => {
    const { settings, deps } = localSetup(['/shared/tasks/check.sh']);
    const payload = { ...base, check: { command: 'bash /old/place/check.sh --fast', timeoutSec: 30 } };
    const out = await adjustImportedTaskPaths(payload, FILE, settings, 'linux', deps);
    expect(out.check).toEqual({ command: 'bash /shared/tasks/check.sh --fast', timeoutSec: 30 });
  });

  it('keeps a check-command path that exists', async () => {
    const { settings, deps } = localSetup(['/old/place/check.sh', '/shared/tasks/check.sh']);
    const payload = { ...base, check: { command: 'bash /old/place/check.sh' } };
    const out = await adjustImportedTaskPaths(payload, FILE, settings, 'linux', deps);
    expect((out.check as { command: string }).command).toBe('bash /old/place/check.sh');
  });

  it('keeps a missing path whose file name is not next to the .loopertask', async () => {
    const { settings, deps } = localSetup([]);
    const payload = { ...base, check: { command: 'bash /old/place/check.sh' } };
    const out = await adjustImportedTaskPaths(payload, FILE, settings, 'linux', deps);
    expect((out.check as { command: string }).command).toBe('bash /old/place/check.sh');
  });

  it('leaves relative command paths alone', async () => {
    const { settings, deps } = localSetup(['/shared/tasks/check.sh']);
    const out = await adjustImportedTaskPaths({ ...base }, FILE, settings, 'linux', deps);
    expect((out.check as { command: string }).command).toBe('bash ./check.sh');
  });

  it('preserves the quoting context of a replaced path', async () => {
    const { settings, deps } = localSetup(['/shared/tasks/check.sh']);
    const payload = { ...base, check: { command: 'bash "/old place/check.sh" --fast' } };
    const out = await adjustImportedTaskPaths(payload, FILE, settings, 'linux', deps);
    expect((out.check as { command: string }).command).toBe('bash "/shared/tasks/check.sh" --fast');
  });

  it('quotes an unquoted replacement that gains spaces', async () => {
    const { settings, deps } = localSetup(['/my shared/check.sh']);
    const payload = { ...base, check: { command: 'bash /old/check.sh' } };
    const out = await adjustImportedTaskPaths(payload, '/my shared/task.loopertask', settings, 'linux', deps);
    expect((out.check as { command: string }).command).toBe('bash "/my shared/check.sh"');
  });

  it('translates through a WSL bridge on a Windows host', async () => {
    const settings = SettingsSchema.parse({
      environments: [
        { id: 'wsl', name: 'WSL', kind: 'wsl', distro: 'Ubuntu', harnesses: [{ id: 'claude', name: 'Claude', command: 'claude' }] },
      ],
      defaultEnvironmentId: 'wsl',
    });
    const existing = ['C:\\shared\\check.sh'];
    const deps: ImportPathDeps = {
      exists: (p) => existing.includes(p),
      convert: (p, to) => {
        if (to === 'posix') return Promise.resolve('/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/'));
        const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
        return Promise.resolve(m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, '\\')}`);
      },
    };
    const payload = { ...base, environmentId: 'wsl', cwd: '/home/other/repo', check: { command: 'bash /home/other/repo/check.sh' } };
    const out = await adjustImportedTaskPaths(payload, 'C:\\shared\\bugherd.loopertask', settings, 'windows', deps);
    expect(out.cwd).toBe('/mnt/c/shared');
    expect((out.check as { command: string }).command).toBe('bash /mnt/c/shared/check.sh');
  });

  it('changes nothing when path translation is unavailable', async () => {
    const settings = SettingsSchema.parse({
      environments: [
        { id: 'wsl', name: 'WSL', kind: 'wsl', harnesses: [{ id: 'claude', name: 'Claude', command: 'claude' }] },
      ],
      defaultEnvironmentId: 'wsl',
    });
    const deps: ImportPathDeps = { exists: () => false, convert: () => Promise.resolve(undefined) };
    const payload = { ...base, environmentId: 'wsl', cwd: '/home/other/repo' };
    const out = await adjustImportedTaskPaths(payload, 'C:\\shared\\bugherd.loopertask', settings, 'windows', deps);
    expect(out).toEqual(payload);
  });

  it('falls back to the default environment for an unknown one', async () => {
    const { settings, deps } = localSetup([]);
    const out = await adjustImportedTaskPaths({ ...base, environmentId: 'mars' }, FILE, settings, 'linux', deps);
    expect(out.cwd).toBe('/shared/tasks');
  });

  it('survives a payload without a check step', async () => {
    const { settings, deps } = localSetup([]);
    const out = await adjustImportedTaskPaths({ ...base, check: undefined }, FILE, settings, 'linux', deps);
    expect(out.check).toBeUndefined();
  });
});
