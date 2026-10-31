import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { FOLDER_TASK_PREFIX, folderEnvironment, projectTaskId } from '../src/shared/projects';
import { dashboardOrder, placeCard, type SessionSummary } from '../src/shared/sessions';
import { EnvironmentSchema } from '../src/shared/types';

const harness = { id: 'claude', name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} };
const env = (id: string, kind: 'local' | 'wsl', distro?: string) => EnvironmentSchema.parse({ id, name: id, kind, ...(distro ? { distro } : {}), harnesses: [harness] });

describe('the environment a picked folder opens in', () => {
  const environments = [env('local', 'local'), env('ubuntu', 'wsl', 'Ubuntu'), env('wsl', 'wsl')];

  it("opens a WSL folder in its distro's environment, else one on the default distro", () => {
    const settings = { environments, defaultEnvironmentId: 'local' };
    expect(folderEnvironment('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', settings, true)?.id).toBe('ubuntu');
    expect(folderEnvironment('\\\\wsl$\\ubuntu\\home\\me', settings, true)?.id).toBe('ubuntu');
    expect(folderEnvironment('\\\\wsl.localhost\\Debian\\home\\me', settings, true)?.id).toBe('wsl');
    expect(folderEnvironment('\\\\wsl.localhost\\Debian\\home', { environments: [env('local', 'local')], defaultEnvironmentId: 'local' }, true)).toBeUndefined();
  });

  it('opens any other folder in the default environment', () => {
    expect(folderEnvironment('C:\\code\\app', { environments, defaultEnvironmentId: 'ubuntu' }, true)?.id).toBe('ubuntu');
    expect(folderEnvironment('/home/me/app', { environments, defaultEnvironmentId: 'local' }, false)?.id).toBe('local');
    // A UNC path means WSL only on a Windows host.
    expect(folderEnvironment('\\\\wsl$\\Ubuntu\\x', { environments, defaultEnvironmentId: 'local' }, false)?.id).toBe('local');
  });
});

describe('a session in another folder', () => {
  let engine: Engine | null = null;
  let dataDir = '';
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs as the folder's own stand-in, with a new project's defaults there, and a project's when one holds the folder", () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-folder-'));
    const folder = join(dataDir, 'work');
    mkdirSync(folder);
    engine = createEngine({ dataDir });
    engine.start();

    const id = engine.folderTaskId(`${folder}/`);
    expect(id.startsWith(FOLDER_TASK_PREFIX)).toBe(true);
    expect(engine.folderTaskId(folder)).toBe(id);
    const task = engine.findSessionTask(id);
    expect([task?.id, task?.name, task?.cwd, task?.environmentId, task?.agent.permissionMode]).toEqual([id, folder, folder, 'local', 'auto']);
    expect(task?.agent.harnessId).toBe(engine.settings.environments.find((e) => e.id === 'local')?.harnesses[0]?.id);

    // Read back after a restart.
    const again = createEngine({ dataDir });
    expect(again.findSessionTask(id)?.cwd).toBe(folder);

    const project = engine.saveProject({ name: 'Work', environmentId: 'local', cwd: folder });
    expect(engine.folderTaskId(folder)).toBe(projectTaskId(project.id));
  });

  it("refuses a folder that isn't there", () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-folder-'));
    engine = createEngine({ dataDir });
    expect(() => engine!.folderTaskId(join(dataDir, 'missing'))).toThrow("isn't a folder");
  });
});

describe("the dashboard's card order", () => {
  const s = (id: string, waitingSince?: number) =>
    ({ id, ...(waitingSince !== undefined ? { waiting: { reason: 'permission', text: 'Asks', since: waitingSince } } : {}) }) as SessionSummary;
  const ids = (list: SessionSummary[]) => list.map((x) => x.id);

  it('keeps the dragged order, the others after it in the list order', () => {
    const list = [s('a'), s('b'), s('c'), s('d')];
    expect(ids(dashboardOrder(list, [], false))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(dashboardOrder(list, ['c', 'gone', 'a'], false))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('puts the waiting ones first, the longest waiting first, with Waiting Chats First', () => {
    const list = [s('a'), s('b', 20), s('c'), s('d', 10)];
    expect(ids(dashboardOrder(list, [], true))).toEqual(['d', 'b', 'a', 'c']);
    expect(ids(dashboardOrder(list, ['c', 'a'], true))).toEqual(['d', 'b', 'c', 'a']);
    expect(ids(dashboardOrder(list, [], false))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops a card before or after another', () => {
    expect(placeCard(['a', 'b', 'c', 'd'], 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(placeCard(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(placeCard(['a', 'b'], 'a', 'gone', true)).toEqual(['a', 'b']);
  });
});
