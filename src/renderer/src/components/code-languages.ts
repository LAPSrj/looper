import { baseName } from '../../../shared/paths';

/** The bundled highlighter's language for each file extension; kept apart from highlight.ts so knowing a file is code doesn't load highlight.js. */
export const LANGUAGE_BY_EXT = {
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
} as const;

export type CodeLanguage = (typeof LANGUAGE_BY_EXT)[keyof typeof LANGUAGE_BY_EXT];

/** The language to color a file in, by its extension; undefined leaves it plain. */
export function languageOf(file: string | undefined): CodeLanguage | undefined {
  const name = file ? baseName(file).toLowerCase() : '';
  if (name === 'dockerfile' || name === 'makefile') return undefined;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? undefined : (LANGUAGE_BY_EXT as Record<string, CodeLanguage>)[name.slice(dot + 1)];
}
