import { describe, expect, it } from 'vitest';
import { blankDraft } from '../src/renderer/src/components/blank-draft';
import { EXAMPLE_TASK } from '../src/shared/example-task';

describe('blankDraft', () => {
  it('starts a new task with no guidance note and no folder', () => {
    const d = blankDraft('local');
    expect(d.note).toBeUndefined();
    expect(d.folderId).toBeUndefined();
    expect(d).not.toHaveProperty('note');
    expect(d).not.toHaveProperty('folderId');
    expect(JSON.parse(JSON.stringify(d))).not.toHaveProperty('note');
  });

  it('carries the given environment and leaves the name, directory, check command and prompt empty', () => {
    const d = blankDraft('wsl-ubuntu');
    expect(d).toMatchObject({ id: '', name: '', cwd: '', environmentId: 'wsl-ubuntu' });
    expect(d.check).toEqual({ enabled: true, command: '', timeoutSec: 60 });
    expect(d.agent.prompt).toBe('');
    expect(d.classifier).toBeUndefined();
    expect(blankDraft().environmentId).toBe('');
  });

  it("otherwise keeps the example task's defaults", () => {
    const { id, name, cwd, environmentId, folderId, note, check, classifier, agent, ...example } = EXAMPLE_TASK;
    void [id, name, cwd, environmentId, folderId, note, check, classifier];
    const d = blankDraft();
    for (const key of Object.keys(example) as (keyof typeof example)[]) expect(d[key]).toEqual(example[key]);
    expect(d.agent).toEqual({ ...agent, prompt: '' });
  });

  it('gives each draft its own objects', () => {
    const a = blankDraft();
    const b = blankDraft();
    expect(a.trigger).not.toBe(b.trigger);
    expect(a.agent).not.toBe(b.agent);
  });
});
