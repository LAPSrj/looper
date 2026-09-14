import { describe, expect, it } from 'vitest';
import { hasPlaceholder, renderTemplate } from '../src/shared/template';
import { buildPrompt } from '../src/engine/steps/common';

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
