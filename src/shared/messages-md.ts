import type { MessageRow } from './messages';

export interface MessagesMarkdownOpts {
  /** Document title (task name / run, or the subagent label). */
  title: string;
  includeThinking: boolean;
  includeTools: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function heading(level: number, label: string, ts?: string): string {
  const time = ts ? fmtTime(ts) : '';
  return `${'#'.repeat(level)} ${label}${time ? ` — ${time}` : ''}`;
}

/** A fence longer than any backtick run in the text, so the block never breaks. */
function codeBlock(text: string): string {
  let max = 2;
  for (const m of text.matchAll(/`+/g)) if (m[0].length > max) max = m[0].length;
  const fence = '`'.repeat(max + 1);
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

function toolSection(row: MessageRow): string[] {
  const parts = [heading(3, `Tool: ${row.tool ?? 'tool'}`, row.ts)];
  if (row.text.trim()) parts.push('**Input**', codeBlock(row.text));
  if (row.result !== undefined) {
    parts.push(row.resultError ? '**Result (error)**' : '**Result**');
    parts.push(row.result.trim() ? codeBlock(row.result) : '*(no output)*');
  }
  return parts;
}

/**
 * The conversation as a readable Markdown document: prompts and agent replies
 * verbatim (they are markdown already), thinking as blockquotes, tool calls as
 * fenced input/result blocks. Raw-mode rows are not meant for export.
 */
export function messagesToMarkdown(rows: readonly MessageRow[], opts: MessagesMarkdownOpts): string {
  const parts: string[] = [`# ${opts.title}`];
  for (const row of rows) {
    switch (row.kind) {
      case 'prompt':
        parts.push(heading(2, 'Prompt', row.ts), row.text);
        break;
      case 'agent':
        parts.push(heading(2, row.source === 'classifier' ? 'Classifier' : 'Agent', row.ts), row.text);
        break;
      case 'thinking':
        if (opts.includeThinking) parts.push(heading(3, 'Thinking', row.ts), blockquote(row.text));
        break;
      case 'tool':
        if (opts.includeTools) parts.push(...toolSection(row));
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}
