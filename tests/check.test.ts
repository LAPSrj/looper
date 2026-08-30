import { describe, expect, it } from 'vitest';
import { parseCheckOutput } from '../src/engine/steps/check';
import { parseClassifierOutput } from '../src/engine/steps/classify';

describe('parseCheckOutput', () => {
  it('reads the last JSON line', () => {
    const r = parseCheckOutput('noise\nmore noise\n{"act": true, "summary": "3 items", "context": {"ids":[1]}}\n');
    expect(r).toEqual({ ok: true, value: { act: true, summary: '3 items', context: { ids: [1] } } });
  });
  it('rejects missing act', () => {
    expect(parseCheckOutput('{"summary": "x"}').ok).toBe(false);
  });
  it('rejects non-JSON', () => {
    expect(parseCheckOutput('nothing to do').ok).toBe(false);
    expect(parseCheckOutput('').ok).toBe(false);
    expect(parseCheckOutput('[1,2]').ok).toBe(false);
  });
});

describe('parseClassifierOutput', () => {
  it('prefers structured_output', () => {
    const env = JSON.stringify({
      type: 'result',
      is_error: false,
      total_cost_usd: 0.01,
      result: '{"act":false,"reason":"nope"}',
      structured_output: { act: true, reason: 'yes' },
    });
    expect(parseClassifierOutput('warning line\n' + env)).toEqual({ ok: true, act: true, reason: 'yes', costUsd: 0.01 });
  });
  it('falls back to result JSON', () => {
    const env = JSON.stringify({ type: 'result', is_error: false, result: '{"act":false,"reason":"noise"}' });
    expect(parseClassifierOutput(env)).toEqual({ ok: true, act: false, reason: 'noise', costUsd: undefined });
  });
  it('surfaces errors', () => {
    expect(parseClassifierOutput(JSON.stringify({ is_error: true, result: 'boom' })).ok).toBe(false);
    expect(parseClassifierOutput('not json').ok).toBe(false);
  });
});
