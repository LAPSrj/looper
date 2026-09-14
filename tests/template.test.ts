import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPlaceholder, renderTemplate } from '../src/shared/template';
import { buildPrompt, expandFileTags } from '../src/engine/steps/common';
import { BashTarget } from '../src/engine/target';
import type { Task } from '../src/shared/types';

describe('renderTemplate', () => {
  it('substitutes strings and JSON', () => {
    const out = renderTemplate('S={{summary}} C={{ context }} X={{missing}}', {
      summary: 'hi',
      context: { a: 1 },
    });
    expect(out).toBe('S=hi C={\n  "a": 1\n} X=');
  });
  it('detects placeholders', () => {
    expect(hasPlaceholder('a {{summary}} b', 'summary', 'context')).toBe(true);
    expect(hasPlaceholder('a b', 'summary', 'context')).toBe(false);
  });
});

describe('buildPrompt', () => {
  it('appends check output when the template does not reference it', () => {
    const out = buildPrompt('Do the thing.', { summary: '2 items', context: ['x', 'y'] });
    expect(out).toContain('Do the thing.');
    expect(out).toContain('## Check output');
    expect(out).toContain('Summary: 2 items');
    expect(out).toContain('"x"');
  });
  it('does not append when referenced', () => {
    const out = buildPrompt('Items: {{context}}', { summary: '2 items', context: ['x'] });
    expect(out).not.toContain('## Check output');
    expect(out).toContain('"x"');
  });

  it('referencing one of the three suppresses all appending', () => {
    const out = buildPrompt('Items: {{context}}', {
      summary: '2 items',
      context: ['x'],
      events: '{"a":1}',
    });
    expect(out).not.toContain('## Check output');
    expect(out).not.toContain('## Trigger events');
    expect(out).not.toContain('2 items');
    const out2 = buildPrompt('E: {{events}}', { events: 'x', summary: 's', context: 'c' });
    expect(out2).toBe('E: x');
  });

  it('appends trigger events when present and not referenced', () => {
    const out = buildPrompt('Do.', { events: '{"a":1}\n{"b":2}' });
    expect(out).toContain('## Trigger events');
    expect(out).toContain('{"b":2}');
  });

  it('does not append events when referenced or absent', () => {
    expect(buildPrompt('E: {{events}}', { events: 'x' })).toBe('E: x');
    expect(buildPrompt('Do.', {})).toBe('Do.');
  });
});

describe('expandFileTags', () => {
  const target = new BashTarget({ host: 'linux' }, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-filetag-'));
  const ctx = { task: { cwd: dir } as Task, target };
  fs.writeFileSync(path.join(dir, 'skill.md'), 'Follow the {{rules}}.\n');

  it('inlines the file, absolute or relative to the task cwd, verbatim', () => {
    const abs = path.join(dir, 'skill.md');
    expect(expandFileTags(`A {{file:${abs}}} B`, ctx)).toBe('A Follow the {{rules}}. B');
    expect(expandFileTags('A {{file:skill.md}} B', ctx)).toBe('A Follow the {{rules}}. B');
  });
  it('throws on a missing file or an empty path', () => {
    expect(() => expandFileTags('{{file:nope.md}}', ctx)).toThrow(/nope\.md/);
    expect(() => expandFileTags('{{file:}}', ctx)).toThrow(/no path/);
  });
  it('leaves text without file tags alone', () => {
    expect(expandFileTags('plain {{summary}}', ctx)).toBe('plain {{summary}}');
  });
});
