import { describe, expect, it } from 'vitest';
import { DEFINITION_VERSION, migrateDefinition } from '../src/shared/migrate';
import { validateTask } from '../src/shared/validate';

const v1Task = {
  id: 't1',
  name: 'T',
  schedule: { enabled: true, cron: '*/10 * * * *', timezone: 'UTC', stopOn: { enabled: false, at: '2027-01-01T00:00:00Z' } },
  environmentId: 'local',
  cwd: '/tmp',
  agent: { prompt: 'go' },
};

describe('migrateDefinition', () => {
  it('is the identity at the current version', () => {
    const def = { id: 'x', trigger: { mode: 'manual' } };
    expect(migrateDefinition(def, DEFINITION_VERSION)).toBe(def);
  });

  it('v1 -> v2 moves schedule into a schedule-mode trigger', () => {
    const out = migrateDefinition(v1Task, 1);
    expect(out.schedule).toBeUndefined();
    expect(out.trigger).toEqual({
      mode: 'schedule',
      schedule: { cron: '*/10 * * * *', timezone: 'UTC' },
      stopOn: { enabled: false, at: '2027-01-01T00:00:00Z' },
    });
  });

  it('v1 -> v2 maps a disabled schedule to the manual mode, keeping the config', () => {
    const out = migrateDefinition({ ...v1Task, schedule: { enabled: false, cron: '0 3 * * *' } }, 1);
    expect(out.trigger).toEqual({ mode: 'manual', schedule: { cron: '0 3 * * *' } });
  });

  it('a migrated v1 task passes current validation', () => {
    const v = validateTask(migrateDefinition(v1Task, 1));
    expect(v.ok).toBe(true);
  });

  it('refuses versions this build has no path from', () => {
    expect(() => migrateDefinition({}, DEFINITION_VERSION + 1)).toThrow(/unknown definition format/);
    expect(() => migrateDefinition({}, 0)).toThrow(/unknown definition format/);
    expect(() => migrateDefinition({}, 1.5)).toThrow(/unknown definition format/);
  });
});
