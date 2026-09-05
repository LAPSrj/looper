import { describe, expect, it } from 'vitest';
import { FILE_VERSION, isLooperFileName, readLooperFile, wrapLooperFile } from '../src/shared/files';

describe('isLooperFileName', () => {
  it('matches both extensions, case-insensitively, on full paths', () => {
    expect(isLooperFileName('daily-check.loopertask')).toBe(true);
    expect(isLooperFileName('C:\\Users\\x\\Desktop\\Daily.LOOPERTASK')).toBe(true);
    expect(isLooperFileName('/home/x/tpl.loopertpl')).toBe(true);
    expect(isLooperFileName('task.json')).toBe(false);
    expect(isLooperFileName('loopertask')).toBe(false);
    expect(isLooperFileName('x.loopertask.bak')).toBe(false);
  });
});

describe('wrapLooperFile / readLooperFile', () => {
  it('round-trips a task payload', () => {
    const doc = wrapLooperFile('task', '1.2.3', { id: 't1', name: 'T' });
    const r = readLooperFile(doc);
    expect(r).toEqual({ ok: true, kind: 'task', payload: { id: 't1', name: 'T' } });
  });

  it('round-trips a template payload', () => {
    const r = readLooperFile(wrapLooperFile('template', '1.2.3', { id: 'tpl' }));
    expect(r).toEqual({ ok: true, kind: 'template', payload: { id: 'tpl' } });
  });

  it('puts the envelope keys first so the file header is readable', () => {
    expect(Object.keys(wrapLooperFile('task', '0.1.0', { id: 'x' }))).toEqual(['$type', '$version', '$app', 'id']);
  });

  it('strips every $-prefixed key from the payload, known or not', () => {
    const r = readLooperFile({ $type: 'looper/task', $version: FILE_VERSION, $app: '9.9.9', $future: 1, id: 'x' });
    expect(r).toEqual({ ok: true, kind: 'task', payload: { id: 'x' } });
  });

  it('rejects non-objects and plain JSON without an envelope', () => {
    for (const input of [undefined, null, 42, 'x', [], { id: 't1', name: 'T' }]) {
      expect(readLooperFile(input)).toEqual({ ok: false, reason: 'not-looper' });
    }
  });

  it('rejects an unknown $type', () => {
    expect(readLooperFile({ $type: 'looper/settings', $version: 1 })).toEqual({ ok: false, reason: 'not-looper' });
  });

  it('rejects a malformed $version', () => {
    for (const version of [undefined, '1', 1.5, 0, -1]) {
      expect(readLooperFile({ $type: 'looper/task', $version: version })).toEqual({ ok: false, reason: 'not-looper' });
    }
  });

  it('flags a newer format version and reports the writing app version', () => {
    const r = readLooperFile({ $type: 'looper/task', $version: FILE_VERSION + 1, $app: '2.0.0', id: 'x' });
    expect(r).toEqual({ ok: false, reason: 'newer', app: '2.0.0' });
  });

  it('flags a newer format version even without $app', () => {
    const r = readLooperFile({ $type: 'looper/task', $version: FILE_VERSION + 1 });
    expect(r).toEqual({ ok: false, reason: 'newer', app: undefined });
  });
});
