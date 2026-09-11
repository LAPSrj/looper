import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../src/shared/messages';
import { messagesToMarkdown, stripMarkdown } from '../src/shared/messages-md';

const row = (r: Partial<MessageRow> & { kind: MessageRow['kind'] }): MessageRow => ({
  id: '0',
  preview: '',
  text: '',
  ...r,
});

const opts = { title: 'My Task – run-1', includeThinking: true, includeTools: true };

describe('messagesToMarkdown', () => {
  it('renders prompt, agent, thinking and tool rows under the title', () => {
    const md = messagesToMarkdown(
      [
        row({ kind: 'prompt', ts: '2026-09-03T10:00:00.000Z', text: 'Do the thing.' }),
        row({ kind: 'thinking', text: 'hmm\n\nlet me see' }),
        row({ kind: 'agent', text: 'On it.' }),
        row({ kind: 'tool', tool: 'Bash', text: 'command: npm test', result: 'ok' }),
      ],
      opts,
    );
    expect(md).toContain('# My Task – run-1');
    expect(md).toContain('## Prompt — ');
    expect(md).toContain('Do the thing.');
    expect(md).toContain('> hmm\n>\n> let me see');
    expect(md).toContain('## Agent');
    expect(md).toContain('### Tool: Bash');
    expect(md).toContain('**Input**\n\n```\ncommand: npm test\n```');
    expect(md).toContain('**Result**\n\n```\nok\n```');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('labels classifier replies and error results', () => {
    const md = messagesToMarkdown(
      [
        row({ kind: 'agent', source: 'classifier', text: 'act' }),
        row({ kind: 'tool', tool: 'Bash', text: 'command: false', result: 'boom', resultError: true }),
      ],
      opts,
    );
    expect(md).toContain('## Classifier');
    expect(md).toContain('**Result (error)**');
  });

  it('omits thinking and tool usage when the options say so', () => {
    const md = messagesToMarkdown(
      [
        row({ kind: 'prompt', text: 'hi' }),
        row({ kind: 'thinking', text: 'secret' }),
        row({ kind: 'tool', tool: 'Bash', text: 'command: ls', result: 'files' }),
      ],
      { ...opts, includeThinking: false, includeTools: false },
    );
    expect(md).toContain('hi');
    expect(md).not.toContain('secret');
    expect(md).not.toContain('Bash');
  });

  it('grows the fence past backtick runs in the content', () => {
    const md = messagesToMarkdown([row({ kind: 'tool', tool: 'Read', text: 'x', result: 'a\n```md\nnested\n```\nb' })], opts);
    expect(md).toContain('````\na\n```md\nnested\n```\nb\n````');
  });

  it('marks a tool with an empty result and skips one still pending', () => {
    const md = messagesToMarkdown(
      [
        row({ kind: 'tool', tool: 'Bash', text: 'command: true', result: '' }),
        row({ kind: 'tool', tool: 'Bash', text: 'command: sleep' }),
      ],
      opts,
    );
    expect(md).toContain('*(no output)*');
    expect(md.match(/\*\*Result/g)).toHaveLength(1);
  });

  it('strips Markdown from prose in plain mode, but keeps tool text verbatim', () => {
    const md = messagesToMarkdown(
      [
        row({ kind: 'prompt', ts: '2026-09-03T10:00:00.000Z', text: 'Fix the **bold** and `code` and ~~old~~ bits.' }),
        row({ kind: 'thinking', text: '# plan\n> quote\nsee [docs](http://x)' }),
        row({ kind: 'agent', text: 'Done.' }),
        row({ kind: 'tool', tool: 'Bash', text: 'command: rm *.tmp', result: '' }),
      ],
      { ...opts, plain: true },
    );
    // Prose has its markers removed…
    expect(md).toContain('Fix the bold and code and old bits.');
    expect(md).toContain('see docs');
    // …and the structural wrappers are gone: no headings, bold labels, fences, quotes.
    expect(md).not.toMatch(/^#/m);
    expect(md).not.toContain('**');
    expect(md).not.toContain('```');
    expect(md).not.toMatch(/^> /m);
    expect(md).toContain('Prompt — ');
    // Tool input stays literal — the shell glob must not be mangled.
    expect(md).toContain('command: rm *.tmp');
    // The (no output) placeholder loses its emphasis.
    expect(md).toContain('(no output)');
    expect(md).not.toContain('*(no output)*');
  });

  it('stripMarkdown removes emphasis/code/heading/quote/link markers, leaving the words', () => {
    expect(stripMarkdown('**a** _b_ `c` ~~d~~')).toBe('a _b_ c d');
    expect(stripMarkdown('# Title')).toBe('Title');
    expect(stripMarkdown('> quoted')).toBe('quoted');
    expect(stripMarkdown('[label](http://url)')).toBe('label');
  });
});
