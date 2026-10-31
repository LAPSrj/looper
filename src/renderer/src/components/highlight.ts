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

/** Each line as highlighted HTML (the text escaped), colored as one block; null when the language is unknown or the text too long. */
export function highlightLines(lines: string[], language: string | undefined): string[] | null {
  if (!language || !hljs.getLanguage(language)) return null;
  const text = lines.join('\n');
  if (text.length > MAX_CHARS) return null;
  const out = splitHtmlLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  return out.length === lines.length ? out : null;
}
