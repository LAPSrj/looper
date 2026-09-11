import type { MessageRow } from './messages';

export interface MessagesMarkdownOpts {
  /** Document title (task name / run, or the subagent label). */
  title: string;
  includeThinking: boolean;
  includeTools: boolean;
  /**
   * Plain-text export: the same document with the Markdown syntax stripped —
   * no `#` headings, `**` emphasis, `` ` `` code fences, `>` quotes or `*`/`~`
   * markers. Message prose is run through {@link stripMarkdown}; tool
   * input/output stays verbatim (it is literal code, not Markdown).
   */
  plain?: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * Best-effort removal of Markdown syntax for a plain-text export: the words
 * survive, the emphasis/code/heading/quote/link markers do not. Underscores and
 * list bullets other than `*` are left alone — stripping them would corrupt
 * ordinary prose and identifiers more often than it would help.
 */
export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // ATX heading markers
        .replace(/^\s*>\s?/, ''), // blockquote markers
    )
    .join('\n')
    .replace(/^\s*[`~]{3,}.*$/gm, '') // fenced-code delimiter lines
    .replace(/`+/g, '') // inline code
    .replace(/\*+/g, '') // bold / italic / bullet asterisks
    .replace(/~+/g, '') // strikethrough
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> link text
}

function heading(level: number, label: string, ts: string | undefined, plain: boolean): string {
  const time = ts ? fmtTime(ts) : '';
  const text = `${label}${time ? ` — ${time}` : ''}`;
  return plain ? text : `${'#'.repeat(level)} ${text}`;
}

function bold(text: string, plain: boolean): string {
  return plain ? text : `**${text}**`;
}

/** A fence longer than any backtick run in the text, so the block never breaks. */
function codeBlock(text: string, plain: boolean): string {
  const trimmed = text.replace(/\n$/, '');
  if (plain) return trimmed;
  let max = 2;
  for (const m of text.matchAll(/`+/g)) if (m[0].length > max) max = m[0].length;
  const fence = '`'.repeat(max + 1);
  return `${fence}\n${trimmed}\n${fence}`;
}

function blockquote(text: string, plain: boolean): string {
  if (plain) return text;
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

function toolSection(row: MessageRow, plain: boolean): string[] {
  const parts = [heading(3, `Tool: ${row.tool ?? 'tool'}`, row.ts, plain)];
  if (row.text.trim()) parts.push(bold('Input', plain), codeBlock(row.text, plain));
  if (row.result !== undefined) {
    parts.push(bold(row.resultError ? 'Result (error)' : 'Result', plain));
    parts.push(row.result.trim() ? codeBlock(row.result, plain) : plain ? '(no output)' : '*(no output)*');
  }
  return parts;
}

/**
 * The conversation as a readable document: prompts and agent replies verbatim
 * (they are markdown already), thinking as blockquotes, tool calls as fenced
 * input/result blocks. With `plain`, the same document is emitted with every
 * Markdown marker stripped. Raw-mode rows are not meant for export.
 */
export function messagesToMarkdown(rows: readonly MessageRow[], opts: MessagesMarkdownOpts): string {
  const plain = !!opts.plain;
  const prose = (t: string): string => (plain ? stripMarkdown(t) : t);
  const parts: string[] = [plain ? opts.title : `# ${opts.title}`];
  for (const row of rows) {
    switch (row.kind) {
      case 'prompt':
        parts.push(heading(2, 'Prompt', row.ts, plain), prose(row.text));
        break;
      case 'agent':
        parts.push(heading(2, row.source === 'classifier' ? 'Classifier' : 'Agent', row.ts, plain), prose(row.text));
        break;
      case 'thinking':
        if (opts.includeThinking) parts.push(heading(3, 'Thinking', row.ts, plain), blockquote(prose(row.text), plain));
        break;
      case 'tool':
        if (opts.includeTools) parts.push(...toolSection(row, plain));
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}
