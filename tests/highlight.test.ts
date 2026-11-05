import { describe, expect, it } from 'vitest';
import { highlightLines, knownLanguage, languageOf, snippetOpener, splitHtmlLines } from '../src/renderer/src/components/highlight';

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

  it('marks the keywords that change where the code goes', () => {
    const [html] = highlightLines(['if (a) return b; const c = 1;'], 'typescript')!;
    expect(html).toContain('<span class="hljs-keyword hljs-control">if</span>');
    expect(html).toContain('<span class="hljs-keyword hljs-control">return</span>');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });
});

describe('a snippet cut off inside a comment or a string', () => {
  it('finds the opener the snippet lacks: a closer before any opener', () => {
    expect(snippetOpener([' * the rest of a doc comment', ' */', 'export const a = 1;'], 'typescript')).toBe('/*');
    expect(snippetOpener(['/* whole */', 'const a = 1;'], 'typescript')).toBeNull();
    // A regex's `*/` in the middle of a line isn't a comment's end.
    expect(snippetOpener(['s.replace(/\\s*/g, "");'], 'javascript')).toBeNull();
    expect(snippetOpener(['  hidden text', '-->', '<p>shown</p>'], 'xml')).toBe('<!--');
    expect(snippetOpener(['  <div>${x}</div>', '`;', 'const b = 2;'], 'typescript')).toBe('`');
    expect(snippetOpener(['const b = 2;', 'const html = `', '  <div>'], 'typescript')).toBeNull();
    expect(snippetOpener(['const s = `a` + `b`;'], 'typescript')).toBeNull();
    expect(snippetOpener(['    and the end of a docstring.', '    """', '    return x'], 'python')).toBe('"""');
    expect(snippetOpener(['def f():', '    """Starts here', '    and goes on'], 'python')).toBeNull();
    expect(snippetOpener(['x = r"""', 'raw'], 'python')).toBeNull();
  });

  it('colors it behind that opener, which it then leaves out', () => {
    const html = highlightLines([' * the rest of a doc comment', ' */', 'export const a = 1;'], 'typescript')!;
    expect(html).toHaveLength(3);
    expect(html[0]).toMatch(/^<span class="hljs-comment">/);
    expect(html[1]).toMatch(/^<span class="hljs-comment">/);
    expect(html[2]).toContain('<span class="hljs-keyword hljs-control">export</span>');
    const py = highlightLines(['    end of the docstring.', '    """', '    return x'], 'python')!;
    expect(py[0]).toMatch(/^<span class="hljs-string">/);
    expect(py[2]).toContain('<span class="hljs-keyword hljs-control">return</span>');
    const tpl = highlightLines(['  <div>${x}</div>', '`;', 'const b = 2;'], 'typescript')!;
    expect(tpl[0]).toMatch(/^<span class="hljs-string">/);
    expect(tpl[2]).toContain('<span class="hljs-keyword">const</span>');
  });
});
