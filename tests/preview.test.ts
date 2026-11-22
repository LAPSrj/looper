import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { inPreviewPage, type FrameLike } from '../src/main/preview-frames';
import { columnName, parseDelimited, PREVIEW_BLOCKED, PREVIEW_SANDBOX, previewFrameCsp, previewHtmlDocument, sniffDelimiter } from '../src/shared/preview';

const BOM = String.fromCharCode(0xfeff);

describe('parseDelimited', () => {
  it('splits rows and fields', () => {
    expect(parseDelimited('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseDelimited('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('a\rb')).toEqual([['a'], ['b']]);
  });

  it('reads quoted fields with delimiters, line breaks and doubled quotes', () => {
    expect(parseDelimited('"x, y","line 1\nline 2","say ""hi"""\n')).toEqual([['x, y', 'line 1\nline 2', 'say "hi"']]);
  });

  it('keeps empty fields, a trailing delimiter and a quote inside an unquoted field', () => {
    expect(parseDelimited('a,,b,\n')).toEqual([['a', '', 'b', '']]);
    expect(parseDelimited('a,')).toEqual([['a', '']]);
    expect(parseDelimited('5" screen,x')).toEqual([['5" screen', 'x']]);
    expect(parseDelimited('\n\na')).toEqual([[''], [''], ['a']]);
  });

  it('skips a byte-order mark and reads an unclosed quote to the end', () => {
    expect(parseDelimited(BOM + 'a,b')).toEqual([['a', 'b']]);
    expect(parseDelimited('"open\nstill')).toEqual([['open\nstill']]);
    expect(parseDelimited('')).toEqual([]);
  });

  it('takes the delimiter it is given', () => {
    expect(parseDelimited('a\tb;c\n', '\t')).toEqual([['a', 'b;c']]);
    expect(parseDelimited('a;"b;c"', ';')).toEqual([['a', 'b;c']]);
  });
});

describe('sniffDelimiter', () => {
  it('uses a tab for .tsv, and the commonest of comma and semicolon on the first line', () => {
    expect(sniffDelimiter('x.TSV', 'a,b,c')).toBe('\t');
    expect(sniffDelimiter('x.csv', 'a,b,c')).toBe(',');
    expect(sniffDelimiter('x.csv', 'a;b;c\n1,5;2,5;3')).toBe(';');
    expect(sniffDelimiter('x.csv', '"a;b;c",d')).toBe(',');
    expect(sniffDelimiter('x.csv', '')).toBe(',');
  });
});

describe('columnName', () => {
  it('names columns as a spreadsheet does', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('previewHtmlDocument', () => {
  it('makes links open outside the frame, first in the document, after its doctype', () => {
    const head = previewHtmlDocument('');
    expect(head.startsWith('<base target="_blank"><script>')).toBe(true);
    expect(previewHtmlDocument('<html><head lang="x"><title>t</title></head></html>')).toBe(head + '<html><head lang="x"><title>t</title></head></html>');
    expect(previewHtmlDocument('<!DOCTYPE html>\n<html><head>')).toBe('<!DOCTYPE html>' + head + '\n<html><head>');
    expect(previewHtmlDocument('<p>hi</p>')).toBe(head + '<p>hi</p>');
  });

  it('keeps a link to a place in the page in the page, which the base target would send to a new window', () => {
    const head = previewHtmlDocument('');
    expect(head).toContain("h.charAt(0)!=='#'");
    expect(head).toContain('location.hash=h');
  });

  it('reports blocked loads from the internet to the viewer only when asked to', () => {
    const doc = previewHtmlDocument('<head></head><img src="https://x/y.png">', { reportBlocked: true });
    expect(doc.indexOf('securitypolicyviolation')).toBeLessThan(doc.indexOf('<head>'));
    expect(doc).toContain(PREVIEW_BLOCKED);
    expect(previewHtmlDocument('<p>x</p>')).not.toContain('securitypolicyviolation');
  });
});

describe('a link clicked in a previewed page', () => {
  const frame = (url: string, parent: FrameLike | null = null): FrameLike => ({ url, parent });
  const win = frame('file:///C:/Looper/resources/app.asar/out/renderer/index.html');
  const page = frame('looper-preview://0123abcd/', win);

  it('opens from the page and from frames inside it at any depth, of any origin', () => {
    expect(inPreviewPage(page)).toBe(true);
    const srcdoc = frame('about:srcdoc', page);
    expect(inPreviewPage(srcdoc)).toBe(true);
    expect(inPreviewPage(frame('about:srcdoc', srcdoc))).toBe(true);
    expect(inPreviewPage(frame('data:text/html,x', page))).toBe(true);
    expect(inPreviewPage(frame('https://example.com/embed', frame('blob:null/1', page)))).toBe(true);
  });

  it("doesn't open from Looper's own windows, other frames or a remote call", () => {
    expect(inPreviewPage(win)).toBe(false);
    expect(inPreviewPage(frame('https://example.com/', win))).toBe(false);
    expect(inPreviewPage(null)).toBe(false);
    expect(inPreviewPage(undefined)).toBe(false);
  });

  it("gives frames nothing of Looper's: the preload exposes window.looper only in a window's own frame", () => {
    const preload = fs.readFileSync('src/preload/index.ts', 'utf8');
    const exposes = preload.split('\n').filter((l) => l.includes('exposeInMainWorld'));
    expect(exposes).toEqual(["if (process.isMainFrame) contextBridge.exposeInMainWorld('looper', createLooperApi(transport));"]);
  });
});

describe('previewFrameCsp', () => {
  const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.slice(d.indexOf(' ') + 1)]));

  it('always sandboxes the page with scripts on and no shared origin; on the computer it opens nothing itself', () => {
    for (const remote of [true, false]) {
      const d = directives(previewFrameCsp(remote));
      expect(d.sandbox).toBe(PREVIEW_SANDBOX);
      expect(d.sandbox).toBe('allow-scripts');
      // A device's browser opens a popup only on a tap.
      expect(directives(previewFrameCsp(remote, true)).sandbox).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
      expect(d.sandbox).not.toContain('allow-same-origin');
      expect(d['script-src']).toContain("'unsafe-inline'");
      expect(d['form-action']).toBe("'none'");
    }
  });

  it('lets a page load from the internet only when remote loads are allowed', () => {
    const allow = directives(previewFrameCsp(true));
    const deny = directives(previewFrameCsp(false));
    for (const k of ['script-src', 'img-src', 'style-src', 'font-src', 'media-src', 'connect-src', 'frame-src']) {
      expect(allow[k].split(' '), k).toContain('*');
      expect(deny[k].split(' '), k).not.toContain('*');
      expect(deny[k], k).not.toMatch(/https?:/);
    }
    expect(deny['default-src']).toBe("'none'");
    expect(deny['connect-src']).toBe("'none'");
  });
});
