import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { TaskSchema } from '../src/shared/types';

// A deadline, not a count of tries: a turn takes ~3 s alone and several times
// that under the full suite's load, so a fixed 200 × 25 ms ran out first.
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * A stand-in for `claude -p`: each message it reads is one turn that
 * rewrites check.sh as v3, v4, … and reports it the way Claude's stream does
 * (the Write call, its result with the old content, then the turn's result).
 */
function fakeClaude(dir: string, file: string): string {
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: file } }] } };
  const result = { type: 'user', tool_use_result: { filePath: file, originalFile: 'v2\n' } };
  const script = join(dir, 'fake-claude.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'n=2',
      'while IFS= read -r line; do',
      '  n=$((n+1))',
      `  printf '%s\\n' '${JSON.stringify(call)}'`,
      `  printf 'v%s\\n' "$n" > '${file}'`,
      `  printf '%s\\n' '${JSON.stringify(result)}'`,
      `  printf '%s\\n' '{"type":"result"}'`,
      'done',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return script;
}

/** An engine with a task saved twice (check.sh "v1\n" and prompt "one", then "v2\n" and "two") and a builder on it. */
async function setUp(): Promise<{ engine: Engine; id: string; check: string; prompt: () => string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
  const cwd = mkdtempSync(join(tmpdir(), 'looper-cwd-'));
  const check = join(cwd, 'check.sh');
  const engine = createEngine({ dataDir });
  engine.start();
  engine.updateSettings({
    environments: engine.settings.environments.map((e) =>
      e.id === 'local'
        ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(cwd, check) }] }
        : e,
    ),
  });
  const base = TaskSchema.parse({
    id: 't1',
    name: 'T1',
    trigger: { mode: 'manual' },
    environmentId: 'local',
    cwd,
    check: { command: './check.sh', timeoutSec: 10 },
    agent: { harnessId: 'fake', prompt: 'one' },
  });
  writeFileSync(check, 'v1\n');
  engine.saveTask(base);
  await until(() => engine.listVersions('t1').length === 1, 'version 1');
  writeFileSync(check, 'v2\n');
  engine.saveTask({ ...base, agent: { ...base.agent, prompt: 'two' } });
  await until(() => engine.listVersions('t1').length === 2, 'version 2');
  const id = engine.startBuilder(engine.builderSetupFor('t1')).id;
  const draftFile = join(dataDir, 'builder', id, 'draft.json');
  const prompt = () => (JSON.parse(readFileSync(draftFile, 'utf8')) as { agent: { prompt: string } }).agent.prompt;
  return { engine, id, check, prompt };
}

/** Send a message and wait for the fake agent's turn to write `content` and end. */
async function turn(engine: Engine, id: string, check: string, content: string): Promise<void> {
  engine.sendBuilder(id, 'change it');
  await until(
    () => readFileSync(check, 'utf8') === content && engine.getBuilder(id)?.status === 'ready',
    `the turn that writes ${content.trim()}`,
  );
}

// Each case starts an engine and a fake agent process: 7–11 s alone, more under the full suite's load.
describe("task builder Undo/Redo, Save and Don't Save", { timeout: 60_000 }, () => {
  let engine: Engine | null = null;
  // Stopping the engine runs the real leftover sweep (two scans of every process
  // on the machine, 1.5 s apart): ~4 s alone, past the default 10 s under load.
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  }, 30_000);

  it("undoes the agent's turns one at a time, and a loaded version is one more step", async () => {
    const t = await setUp();
    engine = t.engine;
    const { id, check, prompt } = t;
    const read = () => readFileSync(check, 'utf8');
    expect(engine.getBuilder(id)?.history).toEqual({ canUndo: false, canRedo: false });

    await turn(engine, id, check, 'v3\n');
    await turn(engine, id, check, 'v4\n');
    expect(await engine.builderUnsaved(id)).toBe(true);

    // Each Undo takes back one turn; Redo puts it back.
    await engine.undoBuilder(id);
    expect(read()).toBe('v3\n');
    await engine.undoBuilder(id);
    expect([read(), engine.getBuilder(id)?.history]).toEqual(['v2\n', { canUndo: false, canRedo: true }]);
    await engine.redoBuilder(id);
    expect(read()).toBe('v3\n');

    // Loading version 1 continues from it; Undo goes back to the change before the load.
    await engine.loadBuilderVersion(id, 1);
    expect([read(), prompt()]).toEqual(['v1\n', 'one']);
    expect(engine.getBuilder(id)?.history.canRedo).toBe(false);
    await engine.undoBuilder(id);
    expect([read(), prompt()]).toEqual(['v3\n', 'two']);
    await engine.redoBuilder(id);
    expect([read(), prompt()]).toEqual(['v1\n', 'one']);

    // Saving the loaded version unchanged records a restore of it.
    await engine.saveBuilder(id);
    await until(() => engine!.listVersions('t1').length === 3, 'version 3');
    expect(engine.listVersions('t1')[2]).toMatchObject({ n: 3, source: 'restore', restoredFrom: 1 });
    expect(await engine.builderUnsaved(id)).toBe(false);
  });

  it("Don't Save after Undo, Redo and a loaded version puts back the file as it was saved", async () => {
    const t = await setUp();
    engine = t.engine;
    const { id, check } = t;
    await turn(engine, id, check, 'v3\n');
    await engine.undoBuilder(id);
    await engine.redoBuilder(id);
    await engine.loadBuilderVersion(id, 1);
    expect(readFileSync(check, 'utf8')).toBe('v1\n');
    await engine.discardBuilder(id);
    expect(readFileSync(check, 'utf8')).toBe('v2\n');
  });

  it('treats a task renamed in the editor as saved, unless the agent changed the draft meanwhile', async () => {
    const t = await setUp();
    engine = t.engine;
    const { id, prompt } = t;
    // Update… opens the editor on the draft; the user renames the task there and saves.
    const draft = engine.builderDraft(id);
    engine.saveTask({ ...draft, name: 'Renamed' }, { builderId: id });
    await until(async () => !(await engine!.builderUnsaved(id)), 'the rename to count as saved');
    expect(engine.getBuilder(id)?.draft.raw?.name).toBe('Renamed');
    expect(prompt()).toBe('two');

    // The agent rewrote the draft after the editor opened: its work is still unsaved.
    const next = engine.builderDraft(id);
    const file = join(engine.dataDir, 'builder', id, 'draft.json');
    writeFileSync(file, JSON.stringify({ ...next, agent: { ...(next.agent as object), prompt: 'agent wrote this' } }));
    engine.saveTask({ ...next, name: 'Renamed again' }, { builderId: id });
    await new Promise((r) => setTimeout(r, 300));
    expect(await engine.builderUnsaved(id)).toBe(true);
    expect(prompt()).toBe('agent wrote this');
  });

  it("saves the agent's work as its version, and Don't Save puts later changes back", async () => {
    const t = await setUp();
    engine = t.engine;
    const { id, check } = t;
    await turn(engine, id, check, 'v3\n');
    const saved = await engine.saveBuilder(id);
    expect(saved.id).toBe('t1');
    await until(() => engine!.listVersions('t1').length === 3, 'version 3');
    expect(engine.listVersions('t1')[2]).toMatchObject({ n: 3, source: 'agent', changed: [`file:${check}`] });
    expect(await engine.builderUnsaved(id)).toBe(false);

    await turn(engine, id, check, 'v4\n');
    expect(await engine.builderUnsaved(id)).toBe(true);
    await engine.discardBuilder(id);
    expect(readFileSync(check, 'utf8')).toBe('v3\n');
  });
});
