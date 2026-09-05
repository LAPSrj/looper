import { describe, expect, it } from 'vitest';
import { parseCheckOutput } from '../src/engine/steps/check';
import { toClassifyResult } from '../src/engine/steps/classify';
import type { SessionEnd } from '../src/engine/steps/session';
import { stripShellNoise } from '../src/engine/steps/common';

describe('stripShellNoise', () => {
  it('drops only the job-control warnings of a terminal-less interactive bash', () => {
    const stderr =
      'bash: cannot set terminal process group (-1): Inappropriate ioctl for device\n' +
      'bash: no job control in this shell\n' +
      'bash: bun: command not found\n' +
      'warning: something else\n';
    expect(stripShellNoise(stderr)).toBe('bash: bun: command not found\nwarning: something else\n');
    expect(stripShellNoise('')).toBe('');
  });
});

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

describe('toClassifyResult', () => {
  const end = (extra: Partial<SessionEnd>): SessionEnd => ({
    reason: 'done',
    exitCode: 0,
    durationMs: 5,
    wasHeld: false,
    ...extra,
  });

  it('headless: reads the verdict from the structured output', () => {
    const r = toClassifyResult(end({ structured: { act: true, reason: 'yes' }, costUsd: 0.01, body: '{"act":true}' }), true, 180);
    expect(r).toMatchObject({ status: 'act', reason: 'yes', costUsd: 0.01 });
  });
  it('headless: no structured output is an error', () => {
    const r = toClassifyResult(end({ body: 'free text' }), true, 180);
    expect(r.status).toBe('error');
    expect(r.error).toContain('no verdict');
  });
  it('interactive: reads the verdict from looper-classify', () => {
    const r = toClassifyResult(end({ doneStatus: 'noop', headline: 'nothing new', body: 'All quiet.' }), false, 180);
    expect(r).toMatchObject({ status: 'noop', reason: 'nothing new', body: 'All quiet.' });
  });
  it('interactive: looper-classify without act/noop is an error', () => {
    const r = toClassifyResult(end({ headline: 'done' }), false, 180);
    expect(r.status).toBe('error');
  });
  it('maps timeouts, exits and stops', () => {
    expect(toClassifyResult(end({ reason: 'max-runtime' }), true, 42).error).toContain('42 s');
    expect(toClassifyResult(end({ reason: 'exited', exitCode: 3, headline: 'Claude exited 3' }), true, 180).status).toBe('error');
    expect(toClassifyResult(end({ reason: 'stopped' }), false, 180).status).toBe('stopped');
    const limited = toClassifyResult(end({ reason: 'error', headline: 'usage limit', retryAtMs: 123 }), true, 180);
    expect(limited).toMatchObject({ status: 'error', retryAtMs: 123 });
  });
});
