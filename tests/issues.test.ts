import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEngine } from '../src/engine/engine';
import { REPORT_INPUT, issueLines } from '../src/shared/issues';
import { SettingsSchema } from '../src/shared/types';

const Schema = z.object({ name: z.string().min(1), kind: z.enum(['a', 'b']), count: z.number() }).strict();
const linesOf = (value: unknown, opts?: typeof REPORT_INPUT) => {
  const r = Schema.safeParse(value, opts);
  return r.success ? '' : issueLines(r.error);
};

describe('issueLines', () => {
  it('words missing, empty and unknown fields the way the task editor does', () => {
    expect(linesOf({ name: '', extra: 1 }, REPORT_INPUT).split('\n')).toEqual([
      'name: must not be empty',
      'kind: is required',
      'count: is required',
      '(root): unknown field "extra"',
    ]);
  });

  it("keeps zod's wording for a wrong value", () => {
    expect(linesOf({ name: 'x', kind: 'c', count: 'one' }, REPORT_INPUT)).toBe(
      'kind: Invalid option: expected one of "a"|"b"\ncount: Invalid input: expected number, received string',
    );
  });

  it("without REPORT_INPUT a wrong type never reads as missing", () => {
    expect(linesOf({ name: 'x', kind: 'a', count: 'one' })).toBe('count: Invalid input: expected number, received string');
  });

  it('shows only the first max issues', () => {
    expect(issueLines(Schema.safeParse({}, REPORT_INPUT).error!, 1)).toBe('name: is required');
  });

  it("passes a record key's own message through", () => {
    const r = SettingsSchema.safeParse({ environments: [{ id: 'local', name: 'L', kind: 'local', harnesses: [{ id: 'c', name: 'C', kind: 'claude-code', command: 'claude', env: { '1BAD': 'x' } }] }] }, REPORT_INPUT);
    expect(r.success ? '' : issueLines(r.error)).toBe(
      'environments.0.harnesses.0.env.1BAD: variable names may only use letters, digits and _, and not start with a digit',
    );
  });
});

describe('updateSettings', () => {
  it('rejects a bad patch with readable lines, not zod\'s issue list', () => {
    const engine = createEngine({ dataDir: mkdtempSync(join(tmpdir(), 'looper-issues-')) });
    expect(() => engine.updateSettings({ remoteAccess: { hostname: 'Not OK' } })).toThrow(
      /^remoteAccess\.hostname: use lowercase letters, digits and hyphens$/,
    );
  });
});
