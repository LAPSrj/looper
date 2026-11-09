import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/src/components/markdown-render';

const html = (text: string, breaks = true) =>
  renderToStaticMarkup(
    createElement(
      'div',
      null,
      ...renderMarkdown(text, breaks, {
        link: (href, title, children, key) => createElement('a', { key, href, title }, ...children),
        image: (src, alt, title, key) => createElement('img', { key, src, alt, title }),
      }),
    ),
  ).replace(/^<div>|<\/div>$/g, '');

describe('Markdown as React elements', () => {
  it('draws GitHub-flavored Markdown as react-markdown with remark-gfm did', () => {
    expect(html('**b** *e* `c` ~~d~~')).toBe('<p><strong>b</strong> <em>e</em> <code>c</code> <del>d</del></p>');
    expect(html('# H\n\n> q')).toBe('<h1>H</h1><blockquote><p>q</p></blockquote>');
    expect(html('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(html('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    expect(html('```ts\nx\n```')).toBe('<pre><code class="language-ts">x\n</code></pre>');
    expect(html('| a | b |\n|:--|--:|\n| 1 | 2 |')).toBe(
      '<div class="md-table"><table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table></div>',
    );
    expect(html('- [ ] t\n- [x] d')).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled="" readOnly=""/> t</li><li class="task-list-item"><input type="checkbox" disabled="" readOnly="" checked=""/> d</li></ul>',
    );
  });

  it('breaks lines only when asked', () => {
    expect(html('a\nb')).toBe('<p>a<br/>b</p>');
    expect(html('a\nb', false)).toBe('<p>a\nb</p>');
  });

  it('links addresses as GitHub does, and never a script', () => {
    expect(html('see https://x.org/a and www.x.org and me@x.org, not x.org')).toBe(
      '<p>see <a href="https://x.org/a">https://x.org/a</a> and <a href="http://www.x.org">www.x.org</a> and <a href="mailto:me@x.org">me@x.org</a>, not x.org</p>',
    );
    expect(html('[t](javascript:alert(1))')).toBe('<p>[t](javascript:alert(1))</p>');
    // Windows opens any registered scheme from a click: only the web and e-mail leave Looper.
    expect(html('[t](search-ms:query=x)')).toBe('<p>[t](search-ms:query=x)</p>');
    expect(html('[t](ms-msdt:/id)')).toBe('<p>[t](ms-msdt:/id)</p>');
    expect(html('[t](docs/page.md#x)')).toBe('<p><a href="docs/page.md#x">t</a></p>');
    expect(html('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('gives each message footnote ids of its own', () => {
    const a = html('x[^1]\n\n[^1]: n');
    const b = html('x[^1]\n\n[^1]: n');
    const id = (s: string) => /id="([^"]+)"/.exec(s)?.[1];
    expect(a).toContain('class="footnotes"');
    expect(id(a)).not.toBe(id(b));
  });
});
