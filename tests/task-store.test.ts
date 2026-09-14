import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/engine/store/tasks';

function taskInput(id: string, folderId?: string) {
  return {
    id,
    name: id,
    trigger: { mode: 'schedule' as const, schedule: { cron: '*/10 * * * *' } },
    environmentId: 'local',
    cwd: '/tmp',
    agent: { prompt: 'go' },
    ...(folderId ? { folderId } : {}),
  };
}

function newStore() {
  const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
  const store = new TaskStore(file);
  store.load();
  return { store, file };
}

describe('TaskStore layout', () => {
  it('appends new folders and root tasks in creation order', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    const f = store.addFolder('F');
    store.upsert(taskInput('b'));
    expect(store.listLayout()['']).toEqual(['a', `folder:${f.id}`, 'b']);
  });

  it('persists an explicit layout across reload', () => {
    const { store, file } = newStore();
    store.upsert(taskInput('a'));
    store.upsert(taskInput('b'));
    const f = store.addFolder('F');
    store.reorder(['a', 'b'], undefined, { '': ['b', `folder:${f.id}`, 'a'] });
    const again = new TaskStore(file);
    again.load();
    expect(again.listLayout()['']).toEqual(['b', `folder:${f.id}`, 'a']);
  });

  it('drops stale and foreign layout entries and keeps every real one', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    const f = store.addFolder('F');
    store.reorder(['a'], undefined, { '': ['ghost', 'folder:nope', 'a', 'a'], gone: ['x'] });
    const layout = store.listLayout();
    expect(layout['']).toEqual(['a', `folder:${f.id}`]);
    expect(layout.gone).toBeUndefined();
  });

  it('moving a task into a folder moves its entry to that container, and back out re-adds it', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    const f = store.addFolder('F');
    store.patch('a', { folderId: f.id });
    expect(store.listLayout()['']).toEqual([`folder:${f.id}`]);
    expect(store.listLayout()[f.id]).toEqual(['a']);
    store.patch('a', { folderId: undefined });
    expect(store.listLayout()['']).toEqual([`folder:${f.id}`, 'a']);
    expect(store.listLayout()[f.id]).toEqual([]);
  });

  it('removing a task removes its layout entry', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    store.upsert(taskInput('b'));
    store.remove('a');
    expect(store.listLayout()['']).toEqual(['b']);
  });
});

describe('TaskStore nested folders', () => {
  it('creates a subfolder and lists it under its parent', () => {
    const { store } = newStore();
    const f = store.addFolder('F');
    const g = store.addFolder('G', f.id);
    const layout = store.listLayout();
    expect(layout['']).toEqual([`folder:${f.id}`]);
    expect(layout[f.id]).toEqual([`folder:${g.id}`]);
    expect(store.listFolders().find((x) => x.id === g.id)?.parentId).toBe(f.id);
  });

  it('rejects a subfolder under an unknown parent', () => {
    const { store } = newStore();
    expect(() => store.addFolder('G', 'nope')).toThrow(/unknown folder/);
  });

  it('re-nests a folder via reorder parents and rejects cycles', () => {
    const { store } = newStore();
    const f = store.addFolder('F');
    const g = store.addFolder('G', f.id);
    // Nesting F under its own child G would close a cycle: ignored.
    store.reorder([], undefined, undefined, { [f.id]: g.id });
    expect(store.listFolders().find((x) => x.id === f.id)?.parentId).toBeUndefined();
    // Moving G to the top level works.
    store.reorder([], undefined, undefined, { [g.id]: null });
    expect(store.listLayout()['']).toEqual([`folder:${f.id}`, `folder:${g.id}`]);
  });

  it('deleting a folder moves its tasks and subfolders up to its parent', () => {
    const { store } = newStore();
    const f = store.addFolder('F');
    const g = store.addFolder('G', f.id);
    const h = store.addFolder('H', g.id);
    store.upsert(taskInput('a', g.id));
    store.removeFolder(g.id);
    expect(store.listFolders().find((x) => x.id === h.id)?.parentId).toBe(f.id);
    expect(store.get('a')?.folderId).toBe(f.id);
    expect(store.listLayout()[f.id]).toEqual([`folder:${h.id}`, 'a']);
  });

  it('loads a v1 store file by migrating each task up, and saves it back as the current version', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'old',
            name: 'Old',
            schedule: { enabled: true, cron: '*/10 * * * *' },
            environmentId: 'local',
            cwd: '/tmp',
            agent: { prompt: 'go' },
          },
        ],
      }),
    );
    const store = new TaskStore(file);
    store.load();
    expect(store.get('old')!.trigger).toMatchObject({ mode: 'schedule', schedule: { cron: '*/10 * * * *' } });
    store.upsert(taskInput('fresh'));
    const written = JSON.parse(readFileSync(file, 'utf8')) as { version: number };
    expect(written.version).toBe(2);
  });

  it('refuses a store file written by a newer Looper instead of loading nothing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
    writeFileSync(file, JSON.stringify({ version: 99, tasks: [] }));
    const store = new TaskStore(file);
    expect(() => store.load()).toThrow(/newer Looper/);
  });

  it('cyclic or unknown parents in a hand-edited file land at the top level', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        folders: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' },
          { id: 'c', name: 'C', parentId: 'ghost' },
        ],
        tasks: [],
      }),
    );
    const store = new TaskStore(file);
    store.load();
    expect(store.listLayout()['']).toEqual(['folder:a', 'folder:b', 'folder:c']);
  });
});

describe('TaskStore completion', () => {
  const stamp = () => new Date().toISOString();

  it('a completed task is never enabled and keeps the stamp of its first completion', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    const done = store.patch('a', { completedAt: stamp(), completedReason: 'finished' });
    expect(done.enabled).toBe(false);
    expect(done.completedAt).toBeTruthy();
    // A later save carrying a fresh stamp must not restart the retention clock.
    const again = store.patch('a', { completedAt: stamp(), name: 'renamed' });
    expect(again.completedAt).toBe(done.completedAt);
  });

  it('completing files the task in the global completed-tasks folder, once', () => {
    let completedFolder: string | undefined;
    const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
    const store = new TaskStore(file, undefined, undefined, () => completedFolder);
    store.load();
    store.upsert(taskInput('a'));
    completedFolder = store.addFolder('Done').id;
    expect(store.patch('a', { completedAt: stamp() }).folderId).toBe(completedFolder);
    // Reopening leaves the task filed where the completion put it.
    store.patch('a', { completedAt: undefined });
    expect(store.get('a')!.folderId).toBe(completedFolder);
  });

  it('an unknown or unset completed-tasks folder leaves the task where it is', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'looper-store-')), 'tasks.json');
    const store = new TaskStore(file, undefined, undefined, () => 'ghost');
    store.load();
    store.upsert(taskInput('a'));
    expect(store.patch('a', { completedAt: stamp() }).folderId).toBeUndefined();

    const { store: plain } = newStore();
    plain.upsert(taskInput('b'));
    expect(plain.patch('b', { completedAt: stamp() }).folderId).toBeUndefined();
  });

  it('reopening clears the reason and switches off an end date that has passed, keeping a future one', () => {
    const { store } = newStore();
    store.upsert(taskInput('a'));
    const cron = '*/10 * * * *';
    const past = new Date(Date.now() - 60_000).toISOString();
    store.patch('a', { trigger: { mode: 'schedule', schedule: { cron }, stopOn: { enabled: true, at: past } } });
    store.patch('a', { completedAt: stamp(), completedReason: 'stopped running' });
    const reopened = store.patch('a', { completedAt: undefined, enabled: true });
    expect(reopened.completedReason).toBeUndefined();
    // The date stays for editing, switched off so the next tick cannot re-complete the task.
    expect(reopened.trigger.stopOn).toEqual({ enabled: false, at: past });

    const future = new Date(Date.now() + 60_000).toISOString();
    store.patch('a', { trigger: { mode: 'schedule', schedule: { cron }, stopOn: { enabled: true, at: future } } });
    store.patch('a', { completedAt: stamp() });
    expect(store.patch('a', { completedAt: undefined }).trigger.stopOn).toEqual({ enabled: true, at: future });
  });
});
