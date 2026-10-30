import { describe, expect, it } from 'vitest';
import { commandAt, insertCommand, matchCommands, quoteText } from '../src/renderer/src/components/composer';

describe('quoteText', () => {
  it('prefixes each line with "> " and ends with an empty line', () => {
    expect(quoteText('First line\nSecond line')).toBe('> First line\n> Second line\n\n');
  });

  it('drops blank lines around the selection and keeps blank lines inside it', () => {
    expect(quoteText('\n\n  Para one\r\n\r\nPara two\n\n')).toBe('>   Para one\n>\n> Para two\n\n');
  });

  it('gives nothing for a blank selection', () => {
    expect(quoteText(' \n\t\n')).toBe('');
  });
});

describe('commandAt', () => {
  const at = (text: string, caret = text.length) => commandAt(text, caret, ['/']);

  it('finds "/" at the start of the box or of a word', () => {
    expect(at('/')).toEqual({ start: 0, query: '' });
    expect(at('/rev')).toEqual({ start: 0, query: 'rev' });
    expect(at('please /sim')).toEqual({ start: 7, query: 'sim' });
    expect(at('line one\n/pl')).toEqual({ start: 9, query: 'pl' });
    expect(at('/cowork-plugin-management:create')).toEqual({ start: 0, query: 'cowork-plugin-management:create' });
  });

  it('ignores a "/" inside a word, a path, and a word the cursor has left', () => {
    expect(at('and/or')).toBeNull();
    expect(at('/home/me')).toBeNull();
    expect(at('/review ')).toBeNull();
    expect(at('plain text')).toBeNull();
  });

  it('reads up to the cursor, not past it inside the word', () => {
    expect(at('/review then', 3)).toBeNull();
    expect(at('/rev then', 4)).toEqual({ start: 0, query: 'rev' });
  });

  it("takes Codex's $ when it's a trigger", () => {
    expect(commandAt('use $hel', 8, ['/', '$'])).toEqual({ start: 4, query: 'hel' });
    expect(commandAt('use $hel', 8, ['/'])).toBeNull();
  });
});

describe('insertCommand', () => {
  it('replaces the typed word with the command and a space, keeping the rest', () => {
    expect(insertCommand('/rev', 0, 4, '/review')).toEqual({ text: '/review ', caret: 8 });
    expect(insertCommand('first /si later', 6, 9, '/simplify')).toEqual({ text: 'first /simplify later', caret: 16 });
  });
});

describe('matchCommands', () => {
  const cmds = [{ name: 'review' }, { name: 'code-review' }, { name: 'simplify' }].map((c) => ({ ...c, description: '' }));

  it('lists the names that start with the text first, then those that contain it', () => {
    expect(matchCommands(cmds, 'rev').map((c) => c.name)).toEqual(['review', 'code-review']);
    expect(matchCommands(cmds, '').map((c) => c.name)).toEqual(['review', 'code-review', 'simplify']);
  });
});
