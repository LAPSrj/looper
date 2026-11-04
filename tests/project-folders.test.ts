import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/engine/store/projects';
import { groupProjects } from '../src/shared/projects';
import { EnvironmentSchema, type Environment } from '../src/shared/types';

const envs: Environment[] = [
  EnvironmentSchema.parse({ id: 'wsl', name: 'WSL', kind: 'wsl', harnesses: [{ id: 'claude', name: 'Claude Code', kind: 'claude-code', command: 'claude' }] }),
];

function store(file = join(mkdtempSync(join(tmpdir(), 'looper-project-folders-')), 'projects.json')) {
  const s = new ProjectStore(file, () => envs, 'linux');
  s.load();
  for (const id of ['a', 'b', 'c', 'd']) s.upsert({ id, name: id.toUpperCase(), environmentId: 'wsl', cwd: `/w/${id}` });
  return { s, file };
}

const ids = (s: ProjectStore) => s.list().map((p) => p.id);

describe('project folders', () => {
  it('files projects in nested folders with the layout drag and drop sends, as the task list does', () => {
    const { s, file } = store();
    const clients = s.addFolder('  Clients ');
    const acme = s.addFolder('Acme', clients.id);
    expect(clients.name).toBe('Clients');
    expect(() => s.addFolder(' ')).toThrow('empty');
    // New folders append to their container, after its projects.
    expect(s.listLayout()['']).toEqual(['a', 'b', 'c', 'd', `folder:${clients.id}`]);
    s.reorder(ids(s), { b: acme.id }, { '': ['a', `folder:${clients.id}`, 'c', 'd'], [clients.id]: [`folder:${acme.id}`], [acme.id]: ['b'] });
    expect(s.get('b')?.folderId).toBe(acme.id);
    expect(s.listLayout()).toEqual({ '': ['a', `folder:${clients.id}`, 'c', 'd'], [clients.id]: [`folder:${acme.id}`], [acme.id]: ['b'] });
    // A folder can't go inside its own subtree.
    s.reorder(ids(s), undefined, undefined, { [clients.id]: acme.id });
    expect(s.listFolders().find((f) => f.id === clients.id)?.parentId).toBeUndefined();

    const again = new ProjectStore(file, () => envs, 'linux');
    again.load();
    expect(again.listLayout()).toEqual(s.listLayout());
    expect(again.get('b')?.folderId).toBe(acme.id);
  });

  it('keeps a project in its folder when an editor saves it, and moves a deleted folder’s contents up', () => {
    const { s, file } = store();
    const clients = s.addFolder('Clients');
    const acme = s.addFolder('Acme', clients.id);
    s.reorder(ids(s), { b: acme.id });
    // An editor opened before the move sends the project without its folder.
    s.upsert({ ...s.get('b'), folderId: undefined, name: 'Bee' });
    expect(s.get('b')).toMatchObject({ name: 'Bee', folderId: acme.id });
    s.renameFolder(acme.id, 'Acme Inc');
    s.removeFolder(acme.id);
    expect(s.get('b')?.folderId).toBe(clients.id);
    expect(s.listLayout()[clients.id]).toEqual(['b']);
    s.removeFolder(clients.id);
    expect(s.get('b')?.folderId).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8')).folders).toEqual([]);
  });

  it('gives a phone the projects in no folder first, then each folder by its path; grouping hides the folders', () => {
    const { s } = store();
    const z = s.addFolder('Zed');
    const inner = s.addFolder('Inner', z.id);
    s.reorder(ids(s), { c: inner.id });
    const groups = groupProjects(s.list(), 'none', envs, s.listFolders());
    expect(groups.map((g) => [g.title, g.projects.map((p) => p.id)])).toEqual([
      ['', ['a', 'b', 'd']],
      ['Zed', []],
      ['Zed / Inner', ['c']],
    ]);
    expect(groupProjects(s.list(), 'harness', envs, s.listFolders()).map((g) => g.title)).toEqual(['Claude Code']);
  });
});
