import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { defaultEnvironments, type Environment } from '../src/shared/types';
import { importTaskDraft, validateTask, type ValidationResult } from '../src/shared/validate';

const errorsOf = (v: ValidationResult): string => (v.ok ? '' : v.errors.join('; '));

describe('strict task schema', () => {
  it('rejects an unknown top-level field by name instead of silently dropping it', () => {
    const v = validateTask({ ...EXAMPLE_TASK, allowCompletion: true });
    expect(v.ok).toBe(false);
    expect(errorsOf(v)).toContain('unknown field "allowCompletion"');
  });

  it('rejects an unknown nested field under its section label', () => {
    const v = validateTask({ ...EXAMPLE_TASK, agent: { ...EXAMPLE_TASK.agent, permissions: 'auto' } });
    expect(v.ok).toBe(false);
    expect(errorsOf(v)).toContain('Agent: unknown field "permissions"');
  });
});

describe('permission mode validation', () => {
  const withMode = (permissionMode: string): unknown => ({
    ...EXAMPLE_TASK,
    agent: { ...EXAMPLE_TASK.agent, permissionMode },
  });

  it('rejects a value no harness kind knows, even without environments', () => {
    const v = validateTask(withMode('dont-ask'));
    expect(v.ok).toBe(false);
    expect(errorsOf(v)).toContain('Permission mode: unknown mode "dont-ask"');
  });

  it("without environments, any kind's value passes", () => {
    expect(validateTask(withMode('dontAsk')).ok).toBe(true);
    expect(validateTask(withMode('read-only')).ok).toBe(true);
    expect(validateTask(withMode('')).ok).toBe(true);
  });

  it("rejects another kind's value once the harness kind is known", () => {
    const environments = defaultEnvironments(); // one claude-code harness, id "claude"
    expect(validateTask(withMode('dontAsk'), environments).ok).toBe(true);
    const v = validateTask(withMode('read-only'), environments);
    expect(v.ok).toBe(false);
    expect(errorsOf(v)).toContain('for a Claude Code harness');
  });

  it('custom harnesses ignore the field, so any value passes', () => {
    const environments: Environment[] = [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        harnesses: [{ id: 'mytool', name: 'My tool', kind: 'custom', command: 'mytool', args: [], env: {} }],
      },
    ];
    const task = {
      ...EXAMPLE_TASK,
      classifier: undefined,
      agent: { ...EXAMPLE_TASK.agent, harnessId: 'mytool', permissionMode: 'whatever' },
    };
    expect(validateTask(task, environments).ok).toBe(true);
  });
});

describe('reference checks', () => {
  const environments = defaultEnvironments(); // one environment "local" with one harness "claude"
  const broken: [string, unknown][] = [
    ['unknown environment "other-machine"', { ...EXAMPLE_TASK, environmentId: 'other-machine' }],
    ['no harness "codex"', { ...EXAMPLE_TASK, agent: { ...EXAMPLE_TASK.agent, harnessId: 'codex' } }],
    [
      'Classifier harness: environment "Local Shell" has no harness "codex"',
      { ...EXAMPLE_TASK, classifier: { ...EXAMPLE_TASK.classifier, harnessId: 'codex' } },
    ],
  ];

  it('dangling environment / harness / classifier harness references are errors', () => {
    for (const [message, task] of broken) {
      const v = validateTask(task, environments);
      expect(v.ok).toBe(false);
      expect(errorsOf(v)).toContain(message);
    }
  });

  it('with refWarnings they downgrade to warnings — the standalone validate flow', () => {
    for (const [message, task] of broken) {
      const v = validateTask(task, environments, undefined, { refWarnings: true });
      expect(v.ok).toBe(true);
      expect(v.warnings.join('; ')).toContain(message);
    }
  });
});

describe('import heuristics (--fix / File → Import)', () => {
  const opts = { environments: defaultEnvironments(), defaultEnvironmentId: 'local' };

  it('resets a permission mode the harness kind does not know to auto, and keeps a known one', () => {
    const fixed = importTaskDraft({ ...EXAMPLE_TASK, agent: { ...EXAMPLE_TASK.agent, permissionMode: 'dont-ask' } }, opts);
    expect(fixed.agent.permissionMode).toBe('auto');
    const kept = importTaskDraft({ ...EXAMPLE_TASK, agent: { ...EXAMPLE_TASK.agent, permissionMode: 'dontAsk' } }, opts);
    expect(kept.agent.permissionMode).toBe('dontAsk');
  });
});

describe('the shipped examples', () => {
  it('EXAMPLE_TASK validates cleanly, alone and against the default environments', () => {
    expect(validateTask(EXAMPLE_TASK).ok).toBe(true);
    const v = validateTask(EXAMPLE_TASK, defaultEnvironments());
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
  });

  it('docs/examples/task.example.json validates cleanly', () => {
    const file = path.join(__dirname, '..', 'docs', 'examples', 'task.example.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(validateTask(raw).ok).toBe(true);
    const v = validateTask(raw, defaultEnvironments());
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
  });
});
