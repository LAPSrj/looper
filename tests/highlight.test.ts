import { describe, expect, it } from 'vitest';
import { highlightLines, knownLanguage, languageOf, splitHtmlLines } from '../src/renderer/src/components/highlight';

describe('code highlighting', () => {
  it('picks the language by the file extension, on either path form', () => {
    expect(languageOf('/home/me/app/src/main.tsx')).toBe('typescript');
    expect(languageOf('C:\\repo\\scripts\\build.PS1')).toBe('powershell');
    expect(languageOf('/x/readme')).toBeUndefined();
    expect(languageOf('/x/notes.unknownext')).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
    expect(knownLanguage('json')).toBe('json');
    expect(knownLanguage('cobol')).toBeUndefined();
  });

  it('closes and reopens a token that spans lines, so each line is whole HTML', () => {
    expect(splitHtmlLines('a <span class="c">/* x\ny */</span> b\nc')).toEqual(['a <span class="c">/* x</span>', '<span class="c">y */</span> b', 'c']);
    expect(splitHtmlLines('<span class="a"><span class="b">1\n2</span>3</span>')).toEqual([
      '<span class="a"><span class="b">1</span></span>',
      '<span class="a"><span class="b">2</span>3</span>',
    ]);
  });

  it('gives one HTML line per line, the text escaped, and nothing for an unknown language', () => {
    const lines = ['const a = "<b>";', '/* one', 'two */', ''];
    const html = highlightLines(lines, 'typescript')!;
    expect(html).toHaveLength(4);
    expect(html[0]).toContain('hljs-keyword');
    expect(html[0]).toContain('&lt;b&gt;');
    expect(html[2]).toMatch(/^<span class="hljs-comment">two \*\/<\/span>$/);
    expect(highlightLines(lines, undefined)).toBeNull();
    expect(highlightLines(lines, 'cobol')).toBeNull();
  });
});
