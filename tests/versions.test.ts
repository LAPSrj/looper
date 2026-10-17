import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { VersionStore } from '../src/engine/store/versions';
import { TaskSchema, type Task } from '../src/shared/types';
import { changeLabels, changedFields, definitionFields, definitionOf, diffDefinitions, lineDiff } from '../src/shared/versions';

function task(over: Record<string, unknown> = {}): Task {
  return TaskSchema.parse({
    id: 't1',
    name: 'T1',
    trigger: { mode: 'manual' },
    environmentId: 'local',
    cwd: '/tmp',
    agent: { prompt: 'go' },
    ...over,
  });
}

const buf = (s: string) => Buffer.from(s);

describe('lineDiff', () => {
  it('marks removed and added lines around the common ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'x' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
  });
});

describe('definition diffs', () => {
  it('ignores the status fields', () => {
    const a = task();
    const b = { ...a, enabled: false, folderId: 'f', note: { text: 'x', runsLeft: 1 }, updatedAt: 'now' };
    expect(changedFields(definitionOf(a), definitionOf(b))).toEqual([]);
    expect(diffDefinitions(a, b)).toEqual([]);
  });

  it('reports leaf paths with both values', () => {
    const a = task();
    const b = task({ agent: { prompt: 'stop' }, check: { command: './c.sh' } });
    const diff = diffDefinitions(definitionOf(a), definitionOf(b));
    expect(diff.find((d) => d.path === 'agent.prompt')).toEqual({ path: 'agent.prompt', a: 'go', b: 'stop' });
    expect(diff.find((d) => d.path === 'check')).toMatchObject({ path: 'check', b: { command: './c.sh' } });
  });

  it('lists a definition field by field, leaves only, without the status fields', () => {
    const fields = definitionFields({ ...task(), enabled: false, env: { A: '1' }, tags: ['x'] });
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('agent.prompt');
    expect(paths).toContain('env.A');
    expect(paths).not.toContain('enabled');
    expect(fields.find((f) => f.path === 'tags')?.value).toEqual(['x']);
  });

  it('labels changes the way the editor names fields, files by name', () => {
    expect(changeLabels(['agent.prompt', 'notifications.end', 'notifications.held', 'file:/w/check.sh'])).toEqual([
      'Agent prompt',
      'Notifications',
      'check.sh',
    ]);
  });
});

describe('VersionStore', () => {
  const newStore = () => new VersionStore(mkdtempSync(join(tmpdir(), 'looper-versions-')));

  it('records a created task as version 1 and skips a save that changes nothing', () => {
    const store = newStore();
    const first = store.record(task(), { source: 'user', files: [{ path: '/w/c.sh', content: buf('x') }] });
    expect(first).toMatchObject({ n: 1, changed: [] });
    expect(store.record({ ...task(), enabled: false }, { source: 'looper', previous: task() })).toBeNull();
    expect(store.list('t1').map((v) => v.n)).toEqual([1]);
  });

  it('keeps the state before the first recorded change as an earlier version', () => {
    const store = newStore();
    const v = store.record(task({ agent: { prompt: 'new' } }), { source: 'user', previous: task() });
    expect(v).toMatchObject({ n: 2, changed: ['agent.prompt'] });
    expect(store.list('t1').map((x) => [x.n, x.source])).toEqual([
      [1, 'earlier'],
      [2, 'user'],
    ]);
    expect(store.get('t1', 1)?.task.agent.prompt).toBe('go');
  });

  it('adds a version when only a file changed, and stores each content once', () => {
    const store = newStore();
    store.record(task(), { source: 'user', files: [{ path: '/w/check.sh', content: buf('v1') }] });
    expect(store.record(task(), { source: 'user', files: [{ path: '/w/check.sh', content: buf('v1') }] })).toBeNull();
    const v = store.record(task(), { source: 'agent', files: [{ path: '/w/check.sh', content: buf('v2') }] });
    expect(v?.changed).toEqual(['file:/w/check.sh']);
    expect(store.readBlob('t1', v!.files![0].blob!)?.toString()).toBe('v2');
  });

  it('answers what a file held at a version, using the before-state for versions that never saw it', () => {
    const store = newStore();
    store.record(task(), { source: 'user' });
    store.record(task({ agent: { prompt: 'b' } }), {
      source: 'agent',
      files: [{ path: '/w/check.sh', content: buf('new') }, { path: '/w/added.sh', content: buf('x') }],
      before: [{ path: '/w/check.sh', content: buf('old') }, { path: '/w/added.sh', content: null }],
    });
    const at1 = store.fileStateAt('t1', 1, '/w/check.sh');
    expect(store.readBlob('t1', at1!.blob!)?.toString()).toBe('old');
    expect(store.fileStateAt('t1', 1, '/w/added.sh')).toEqual({ path: '/w/added.sh', blob: null });
    expect(store.readBlob('t1', store.fileStateAt('t1', 2, '/w/check.sh')!.blob!)?.toString()).toBe('new');
    expect(store.knownFiles('t1')).toEqual(['/w/check.sh', '/w/added.sh']);
  });

  it('deletes the whole history', () => {
    const store = newStore();
    store.record(task(), { source: 'user', files: [{ path: '/w/a', content: buf('a') }] });
    store.remove('t1');
    expect(store.list('t1')).toEqual([]);
    expect(store.current('t1')).toBeUndefined();
  });
});

describe('engine version history', () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  /** Versions are recorded off the save's call stack; wait for the count. */
  async function versionsOf(e: Engine, id: string, count: number) {
    for (let i = 0; i < 100; i++) {
      const list = e.listVersions(id);
      if (list.length >= count) return list;
      await new Promise((r) => setTimeout(r, 20));
    }
    return e.listVersions(id);
  }

  it('versions the scripts a task runs and restores them with the definition', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const cwd = mkdtempSync(join(tmpdir(), 'looper-cwd-'));
    writeFileSync(join(cwd, 'check.sh'), 'echo one\n');
    engine = createEngine({ dataDir });
    engine.start();
    const base = { ...task(), cwd, check: { command: './check.sh', timeoutSec: 10 } };
    engine.saveTask(base);
    const v1 = await versionsOf(engine, 't1', 1);
    expect(v1.map((v) => [v.n, v.source, v.files])).toEqual([[1, 'user', [`${cwd}/check.sh`]]]);

    writeFileSync(join(cwd, 'check.sh'), 'echo two\n');
    engine.saveTask({ ...base, agent: { ...base.agent, prompt: 'changed' }, enabled: false });
    const v2 = await versionsOf(engine, 't1', 2);
    expect(v2[1].changed).toEqual(['agent.prompt', `file:${cwd}/check.sh`]);

    const restored = await engine.restoreVersion('t1', 1);
    expect(restored.agent.prompt).toBe('go');
    // A status field keeps its current value.
    expect(restored.enabled).toBe(false);
    expect(readFileSync(join(cwd, 'check.sh'), 'utf8')).toBe('echo one\n');
    const v3 = await versionsOf(engine, 't1', 3);
    expect(v3[2]).toMatchObject({ n: 3, source: 'restore', restoredFrom: 1 });

    const detail = await engine.versionDetail('t1', 2, true);
    expect(detail.diff?.map((d) => d.path)).toEqual(['agent.prompt']);
    expect(detail.files[0]).toMatchObject({ content: 'echo two\n', matchesDisk: false });
    // Files compare with the newest version (the restore of version 1), not with the disk.
    expect(detail.fileDiff).toEqual([{ path: `${cwd}/check.sh`, a: 'echo two\n', b: 'echo one\n' }]);
    expect((await engine.versionDetail('t1', 1, true)).fileDiff).toEqual([]);
    expect(detail.isCurrent).toBe(false);
  });

  it('adds no version for a status change, even on a task saved before history existed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const cwd = mkdtempSync(join(tmpdir(), 'looper-cwd-'));
    writeFileSync(join(cwd, 'check.sh'), 'echo one\n');
    // A tasks.json written before version history: the task has no versions yet.
    writeFileSync(
      join(dataDir, 'tasks.json'),
      JSON.stringify({ version: 2, tasks: [{ ...task(), cwd, check: { command: './check.sh', timeoutSec: 10 } }] }),
    );
    engine = createEngine({ dataDir });
    engine.start();
    const stored = engine.getTask('t1')!;
    engine.saveTask({ ...stored, enabled: false });
    engine.saveTask({ ...stored, enabled: true, folderId: undefined });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.listVersions('t1')).toEqual([]);
    // A real change records the earlier state with the script as it was, and doesn't call the script changed.
    engine.saveTask({ ...stored, agent: { ...stored.agent, prompt: 'new' } });
    const list = await versionsOf(engine, 't1', 2);
    expect(list.map((v) => [v.n, v.source, v.changed])).toEqual([
      [1, 'earlier', []],
      [2, 'user', ['agent.prompt']],
    ]);
    expect(list[0].files).toEqual([`${cwd}/check.sh`]);
  });

  it('refuses to restore a version whose environment is gone, without touching files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    engine = createEngine({ dataDir });
    engine.start();
    engine.saveTask(task());
    await versionsOf(engine, 't1', 1);
    engine.updateSettings({
      environments: [...engine.settings.environments, { id: 'other', name: 'Other', kind: 'local', harnesses: [{ id: 'c', name: 'C', kind: 'claude-code', command: 'claude' }] }],
    });
    engine.saveTask({ ...task(), environmentId: 'other' });
    await versionsOf(engine, 't1', 2);
    engine.updateSettings({ environments: engine.settings.environments.filter((e) => e.id !== 'local'), defaultEnvironmentId: 'other' });
    await expect(engine.restoreVersion('t1', 1)).rejects.toThrow(/can't be restored/);
  });
});
