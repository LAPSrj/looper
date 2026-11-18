import { describe, expect, it } from 'vitest';
import { baseName, dirName } from '../src/shared/paths';

describe('baseName', () => {
  it('takes the last part of a POSIX or Windows path', () => {
    expect(baseName('/home/me/notes.md')).toBe('notes.md');
    expect(baseName('C:\\Users\\me\\notes.md')).toBe('notes.md');
    expect(baseName('a/b\\c.txt')).toBe('c.txt');
    expect(baseName('notes.md')).toBe('notes.md');
  });

  it('ignores trailing separators', () => {
    expect(baseName('/home/me/')).toBe('me');
    expect(baseName('C:\\Users\\me\\\\')).toBe('me');
  });

  it('gives a path of only separators back as it is', () => {
    expect(baseName('/')).toBe('/');
    expect(baseName('')).toBe('');
  });
});

describe('dirName', () => {
  it('drops the last part, with either separator', () => {
    expect(dirName('/home/me/notes.md')).toBe('/home/me');
    expect(dirName('C:\\Users\\me\\notes.md')).toBe('C:\\Users\\me');
    expect(dirName('src/a.ts')).toBe('src');
  });

  it('ignores trailing separators', () => {
    expect(dirName('/home/me/')).toBe('/home');
    expect(dirName('C:\\Users\\me\\')).toBe('C:\\Users');
  });

  it('is empty when there is no folder part', () => {
    expect(dirName('notes.md')).toBe('');
    expect(dirName('/notes.md')).toBe('');
    expect(dirName('')).toBe('');
  });
});
