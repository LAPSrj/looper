import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/*
 * Syntax highlighting for the code the agent reads and changes. Only these
 * languages are bundled, and this module loads on first use (useHighlight), so
 * windows that never show code don't carry it.
 */

const LANGUAGES = { bash, cpp, csharp, css, go, ini, java, javascript, json, markdown, php, powershell, python, rust, scss, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, keyof typeof LANGUAGES> = {
  sh: 'bash', bash: 'bash', zsh: 'bash',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  java: 'java',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', looperaddon: 'json', loopertask: 'json', loopertpl: 'json',
  md: 'markdown', markdown: 'markdown',
  php: 'php',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  py: 'python', pyw: 'python',
  rs: 'rust',
  scss: 'scss', sass: 'scss', less: 'scss',
  sql: 'sql',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', vue: 'xml',
  yml: 'yaml', yaml: 'yaml',
};

/** The language to color a file in, by its extension; undefined leaves it plain. */
export function languageOf(file: string | undefined): string | undefined {
  const name = file?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name === 'makefile') return undefined;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? undefined : BY_EXT[name.slice(dot + 1)];
}

/** Any language name a caller gives (an addon's `language`), if one of the bundled ones knows it. */
export function knownLanguage(name: string | undefined): string | undefined {
  return name && hljs.getLanguage(name) ? name : undefined;
}

/**
 * Highlighted HTML split into lines. A token that spans lines (a block
 * comment, a template string) has its spans closed at each line's end and
 * opened again on the next, so every line is complete HTML on its own.
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  const re = /<span[^>]*>|<\/span>|\n/g;
  let at = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    line += html.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0] === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (m[0] === '</span>') {
      open.pop();
      line += m[0];
    } else {
      open.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(at));
  return lines;
}

/** Past this much text, code shows plain: coloring it would hold the window up. */
const MAX_CHARS = 200_000;

const BLOCK_COMMENTS = new Set(['cpp', 'csharp', 'css', 'go', 'java', 'javascript', 'php', 'rust', 'scss', 'sql', 'typescript']);
const HTML_COMMENTS = new Set(['xml', 'markdown']);
const TEMPLATES = new Set(['javascript', 'typescript']);

/** What ends the code before a string delimiter that opens a string: `x = """`, `f(\``, `return \``. */
const OPENS_AFTER = /(?:[=(,[{:?+]|=>|\breturn|\byield)$/;

/** Where `delim` first stands unescaped: its line and column; null when it doesn't. */
function firstAt(lines: string[], delim: string): { line: number; col: number } | null {
  for (let line = 0; line < lines.length; line++) {
    for (let col = lines[line].indexOf(delim); col !== -1; col = lines[line].indexOf(delim, col + 1)) {
      if (lines[line][col - 1] !== '\\') return { line, col };
    }
  }
  return null;
}

/** How often `delim` stands unescaped in the text. */
function countOf(text: string, delim: string): number {
  let n = 0;
  for (let i = text.indexOf(delim); i !== -1; i = text.indexOf(delim, i + delim.length)) if (text[i - 1] !== '\\') n++;
  return n;
}

/**
 * Whether the first of an odd number of string delimiters (a backtick, a
 * triple quote) closes a string the snippet starts inside, rather than opening
 * one it ends inside: it does unless the code before it (on its line, or the
 * line above when it starts its line) is where a string starts. `prefixes`:
 * the letters that may stand right before an opener (Python's r"""…""").
 */
function closesFirst(lines: string[], delim: string, prefixes?: RegExp): boolean {
  const at = firstAt(lines, delim);
  if (!at) return false;
  const before = lines[at.line].slice(0, at.col).replace(prefixes ?? /$^/, '').trimEnd();
  if (before) return !OPENS_AFTER.test(before);
  let above = '';
  for (let i = at.line - 1; i >= 0 && !above; i--) above = lines[i].trimEnd();
  // The snippet starts with it: it closes when code goes on after it (`;), not text (a docstring's first line).
  if (!above) return /^\s*[;),.\]}]/.test(lines[at.line].slice(at.col + delim.length));
  return !OPENS_AFTER.test(above);
}

/**
 * A line to color a snippet behind, when the snippet starts inside a token
 * whose opener is cut off (a Read with an offset): a block comment, an HTML
 * comment, a template literal, a Python triple-quoted string. Null when
 * nothing shows it does: its first closer comes before any opener.
 */
export function snippetOpener(lines: string[], language: string): string | null {
  const text = lines.join('\n');
  if (BLOCK_COMMENTS.has(language)) {
    const close = text.indexOf('*/');
    const open = text.indexOf('/*');
    // A comment's end ends its line; `*/` inside a line is more likely a regex (/\s*/).
    if (close !== -1 && (open === -1 || close < open) && /^\*\/\s*(?:\n|$)/.test(text.slice(close))) return '/*';
  }
  if (HTML_COMMENTS.has(language)) {
    const close = text.indexOf('-->');
    const open = text.indexOf('<!--');
    if (close !== -1 && (open === -1 || close < open)) return '<!--';
  }
  if (TEMPLATES.has(language) && countOf(text, '`') % 2 === 1 && closesFirst(lines, '`')) return '`';
  if (language === 'python') {
    for (const q of ['"""', "'''"]) {
      if (countOf(text, q) % 2 === 1) {
        const other = q === '"""' ? "'''" : '"""';
        const mine = firstAt(lines, q);
        const theirs = firstAt(lines, other);
        // The quote that comes first is the one the snippet may start inside.
        if (theirs && mine && (theirs.line < mine.line || (theirs.line === mine.line && theirs.col < mine.col))) continue;
        if (closesFirst(lines, q, /\b[rRbBuUfF]{1,2}$/)) return q;
      }
    }
  }
  return null;
}

/** Keywords that change where the code goes, which the editor colors apart from the rest (as VS Code does). */
const CONTROL_KEYWORDS = new Set(
  'if else elif for while do switch case default break continue return throw try catch except finally raise import export from as await yield goto with pass'.split(' '),
);

/** The control keywords' spans get the `hljs-control` class too. */
const markControl = (html: string): string =>
  html.replace(/<span class="hljs-keyword">(\w+)<\/span>/g, (m, word: string) => (CONTROL_KEYWORDS.has(word) ? `<span class="hljs-keyword hljs-control">${word}</span>` : m));

/**
 * Each line as highlighted HTML (the text escaped), colored as one block;
 * null when the language is unknown or the text too long. A snippet that
 * starts inside a comment or a string is colored behind its opener
 * (snippetOpener), which is then left out.
 */
export function highlightLines(lines: string[], language: string | undefined): string[] | null {
  if (!language || !hljs.getLanguage(language)) return null;
  const text = lines.join('\n');
  if (text.length > MAX_CHARS) return null;
  const opener = snippetOpener(lines, language);
  const html = markControl(hljs.highlight(opener === null ? text : `${opener}\n${text}`, { language, ignoreIllegals: true }).value);
  const out = splitHtmlLines(html).slice(opener === null ? 0 : 1);
  return out.length === lines.length ? out : null;
}
