import { describe, expect, it } from 'vitest';
import { envToLine, joinTokens, lineToEnv, tokenize } from '../src/shared/cmdline';

const tokens = (line: string): string[] => {
  const r = tokenize(line);
  if (!r.ok) throw new Error(r.error);
  return r.tokens;
};

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokens('--full-auto -m o3')).toEqual(['--full-auto', '-m', 'o3']);
    expect(tokens('  a   b ')).toEqual(['a', 'b']);
    expect(tokens('')).toEqual([]);
  });
  it('honours quotes', () => {
    expect(tokens('--flag "some value"')).toEqual(['--flag', 'some value']);
    expect(tokens("--flag 'some value'")).toEqual(['--flag', 'some value']);
    expect(tokens('--allowedTools "Bash(git:*)"')).toEqual(['--allowedTools', 'Bash(git:*)']);
    expect(tokens('a"b c"d')).toEqual(['ab cd']);
    expect(tokens('""')).toEqual(['']);
  });
  it('supports \\" and \\\\ inside double quotes', () => {
    expect(tokens('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(tokens('"a\\\\b"')).toEqual(['a\\b']);
  });
  it('rejects unterminated quotes', () => {
    expect(tokenize('"open')).toMatchObject({ ok: false });
    expect(tokenize("'open")).toMatchObject({ ok: false });
  });
});

describe('joinTokens round trip', () => {
  it('quotes only what needs it', () => {
    expect(joinTokens(['--flag', 'plain'])).toBe('--flag plain');
    expect(joinTokens(['a b', 'c"d', ''])).toBe('"a b" "c\\"d" ""');
  });
  it('round-trips arbitrary tokens', () => {
    for (const list of [['--x', 'a b', 'C:\\path\\to x', "it's", 'say "hi"', '']]) {
      expect(tokens(joinTokens(list))).toEqual(list);
    }
  });
});

describe('env lines', () => {
  it('parses and renders KEY=value pairs', () => {
    expect(lineToEnv('FOO=1 BAR="a b"')).toEqual({ FOO: '1', BAR: 'a b' });
    expect(envToLine({ FOO: '1', BAR: 'a b' })).toBe('FOO=1 "BAR=a b"');
    expect(lineToEnv(envToLine({ FOO: '1', BAR: 'a b' }))).toEqual({ FOO: '1', BAR: 'a b' });
    expect(lineToEnv('')).toEqual({});
  });
  it('rejects non-assignments', () => {
    expect(typeof lineToEnv('FOO')).toBe('string');
    expect(typeof lineToEnv('=x')).toBe('string');
    expect(typeof lineToEnv('"unterminated')).toBe('string');
  });
});
