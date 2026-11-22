import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeOutput, wholeUtf8, type OutputShown } from '../src/shared/output-tail';
import { readOutputFrom } from '../src/engine/output-read';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpFile = (content: string | Buffer): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-output-'));
  dirs.push(dir);
  const f = path.join(dir, 'out.txt');
  fs.writeFileSync(f, content);
  return f;
};

describe('readOutputFrom', () => {
  it('reads the whole of a short file first, then only what it adds', async () => {
    const f = tmpFile('one\ntwo\n');
    const first = await readOutputFrom(f, undefined);
    expect(first).toEqual({ end: 8, from: 0, text: 'one\ntwo\n' });
    fs.appendFileSync(f, 'three\n');
    expect(await readOutputFrom(f, first.end)).toEqual({
      end: 14,
      from: 8,
      text: 'three\n',
    });
  });

  it('reads nothing while the file stays the same size', async () => {
    const f = tmpFile('quiet\n');
    expect(await readOutputFrom(f, 6)).toEqual({ end: 6, from: 6 });
  });

  it('starts a tail at its first whole line', async () => {
    const f = tmpFile('aaaa\nbbbb\ncccc\n');
    expect(await readOutputFrom(f, undefined, 12)).toEqual({
      end: 15,
      from: 5,
      text: 'bbbb\ncccc\n',
    });
  });

  it('reads the tail again when the file grew by more than one read or was written again', async () => {
    const f = tmpFile('x'.repeat(10) + '\nend\n');
    expect(await readOutputFrom(f, 0, 8)).toEqual({
      end: 15,
      from: 11,
      text: 'end\n',
    });
    expect(await readOutputFrom(f, 100, 8)).toEqual({
      end: 15,
      from: 11,
      text: 'end\n',
    });
  });

  it('leaves a character cut by the end of the file for the next read', async () => {
    const euro = Buffer.from('€'); // three bytes
    const f = tmpFile(Buffer.concat([Buffer.from('a'), euro.subarray(0, 2)]));
    const first = await readOutputFrom(f, undefined);
    expect(first).toEqual({ end: 1, from: 0, text: 'a' });
    fs.appendFileSync(f, euro.subarray(2));
    expect(await readOutputFrom(f, first.end)).toEqual({
      end: 4,
      from: 1,
      text: '€',
    });
  });
});

describe('wholeUtf8', () => {
  it('counts the bytes of whole characters', () => {
    const bytes = Buffer.from('a€😀');
    expect(wholeUtf8(bytes)).toBe(bytes.length);
    expect(wholeUtf8(bytes.subarray(0, bytes.length - 1))).toBe(4);
    expect(wholeUtf8(bytes.subarray(0, 3))).toBe(1);
    expect(wholeUtf8(Buffer.alloc(0))).toBe(0);
  });
});

describe('mergeOutput', () => {
  const kept = (text: string, end: number, cut = false): OutputShown => ({
    text,
    end,
    cut,
  });

  it('adds what follows on and keeps the same object when nothing changed', () => {
    const a = mergeOutput(null, { end: 4, from: 0, text: 'one\n' });
    expect(a).toEqual(kept('one\n', 4));
    expect(mergeOutput(a, { end: 4, from: 4 })).toBe(a);
    expect(mergeOutput(a, { end: 4, from: 4, text: '' })).toBe(a);
    expect(mergeOutput(a, { end: 8, from: 4, text: 'two\n' })).toEqual(kept('one\ntwo\n', 8));
  });

  it('replaces what it had with a tail, and marks a tail that starts past the beginning as cut', () => {
    const a = kept('old\n', 4);
    expect(mergeOutput(a, { end: 900, from: 880, text: 'new\n' })).toEqual(kept('new\n', 900, true));
    expect(mergeOutput(a, { end: 3, from: 0, text: 'abc' })).toEqual(kept('abc', 3));
  });

  it('drops the oldest whole lines past the limit', () => {
    const a = kept('1111\n2222\n', 10);
    expect(mergeOutput(a, { end: 15, from: 10, text: '3333\n' }, 10)).toEqual(kept('3333\n', 15, true));
  });
});
