import { describe, expect, it } from 'vitest';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { taskSchemaDoc } from '../src/shared/schema-doc';

describe('taskSchemaDoc', () => {
  const doc = taskSchemaDoc();
  const field = (path: string) => doc.task.find((f) => f.path === path);

  it('marks author-required fields and leaves defaulted/optional ones unmarked', () => {
    expect(field('cwd')).toMatchObject({ type: 'string', required: true });
    expect(field('schedule.cron')).toMatchObject({ type: 'string', required: true });
    expect(field('agent.prompt')).toMatchObject({ type: 'string', required: true });
    expect(field('enabled')?.required).toBeUndefined();
    expect(field('folderId')?.required).toBeUndefined();
    expect(field('check')?.required).toBeUndefined();
  });

  it('carries effective defaults, with nested defaults filled in', () => {
    expect(field('agent.permissionMode')?.default).toBe('auto');
    expect(field('backoff')?.default).toEqual({ maxConsecutiveErrors: 5 });
    expect(field('notifications')?.default).toMatchObject({ end: 'warning', runStart: false });
  });

  it('lists enum values and the id pattern', () => {
    expect(field('notifications.end')?.values).toEqual(['off', 'error', 'warning', 'end', 'all']);
    expect(field('agent.mode')?.values).toEqual(['interactive', 'headless']);
    expect(field('id')?.pattern).toBeTruthy();
  });

  it('types compound fields', () => {
    expect(field('env')?.type).toBe('record<string>');
    expect(field('agent.extraArgs')?.type).toBe('string[]');
    expect(field('agent.maxRuntimeMin')?.type).toBe('number');
    expect(field('agent.sessionMaxRuns')?.type).toBe('integer');
  });

  it('surfaces the permission-mode union on the field and the per-kind lists alongside', () => {
    expect(field('agent.permissionMode')?.values).toContain('dontAsk');
    expect(field('agent.permissionMode')?.values).toContain('read-only');
    expect(doc.permissionModes['claude-code']).toContainEqual({ value: 'dontAsk', label: "Don't ask" });
    expect(doc.permissionModes['codex']).toContainEqual({ value: 'danger-full-access', label: 'Full access' });
  });

  it('covers every field the full example sets', () => {
    const paths = new Set(doc.task.map((f) => f.path));
    const leaves: string[] = [];
    const collect = (obj: Record<string, unknown>, prefix: string) => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && path !== 'env') {
          collect(value as Record<string, unknown>, path);
        } else {
          leaves.push(path);
        }
      }
    };
    collect(EXAMPLE_TASK as unknown as Record<string, unknown>, '');
    for (const leaf of leaves) expect(paths, `missing ${leaf}`).toContain(leaf);
  });
});
