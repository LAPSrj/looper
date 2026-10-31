import { describe, expect, it } from 'vitest';
import { ClaudeStreamAccumulator } from '../src/engine/builder/stream';
import { TranscriptAccumulator, structuredOutputText, workflowTaskText, type SubagentMeta } from '../src/engine/messages';
import { backgroundOf, endingError, latestLine, subagentsOf } from '../src/engine/sessions';
import { guidanceMessage } from '../src/shared/messages';
import { messagesToMarkdown } from '../src/shared/messages-md';

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

const SKILL_TEXT = '# Workflow authoring reference\n\nWrite the script like this…';

/** A stream-json Skill sequence as claude 2.1.316 writes it: the skill's meta record comes as isSynthetic, with no sourceToolUseID. */
const skillStream = (skillText: string) => [
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'workflow-authoring' } }] } }),
  line({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: workflow-authoring' }] },
    tool_use_result: { success: true, commandName: 'workflow-authoring' },
  }),
  line({ type: 'user', parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: skillText }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Loaded it.' }] } }),
];

describe('a skill in the live stream (FB-03)', () => {
  it("attaches the skill's text to its Skill row instead of showing it as the user's message", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addPrompt('use the skill');
    for (const l of skillStream(SKILL_TEXT)) acc.addLine(l);
    expect(acc.rows.map((r) => [r.kind, r.tool])).toEqual([
      ['prompt', undefined],
      ['tool', 'Skill'],
      ['agent', undefined],
    ]);
    expect(acc.rows[1].skill).toBe(SKILL_TEXT);
  });

  it('does the same for a skill with a "Base directory" line', () => {
    const acc = new ClaudeStreamAccumulator();
    const text = 'Base directory for this skill: /p/.claude/skills/x\n\n# X';
    for (const l of skillStream(text)) acc.addLine(l);
    expect(acc.rows[0].skill).toBe(text);
    expect(acc.rows.map((r) => r.kind)).toEqual(['tool', 'agent']);
  });

  it('keeps other synthetic records out of the conversation: a compact summary, and a Stop hook block as guidance', () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } }));
    acc.addLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: `Stop hook feedback:\n${guidanceMessage('and stop after')}` } }));
    acc.addLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: 'Stop hook feedback:\nLooper: the turn ended without looper-done.' } }));
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([['guidance', 'and stop after']]);
  });

  it("doesn't take a Stop hook block after a Skill call for the skill, and still reads a synthetic task notification", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'x' } }] } }));
    acc.addLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: `Stop hook feedback:\n${guidanceMessage('wait')}` } }));
    expect(acc.rows[0].skill).toBeUndefined();
    expect(acc.rows.map((r) => r.kind)).toEqual(['tool', 'guidance']);

    const bg = new ClaudeStreamAccumulator();
    bg.addLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }] } }));
    bg.addLine(
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tb', content: 'Command running in background with ID: bx1. Output is being written to: /tmp/bx1.output' }] },
        tool_use_result: { backgroundTaskId: 'bx1' },
      }),
    );
    bg.addLine(
      line({
        type: 'user',
        isSynthetic: true,
        message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>bx1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' }] },
      }),
    );
    expect(bg.rows).toHaveLength(1);
    expect(bg.rows[0].background).toMatchObject({ id: 'bx1', status: 'completed', summary: 'done' });
  });

  it("still ignores a replayed message (Looper's own prompt row stands)", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addPrompt('hello');
    acc.addLine(line({ type: 'user', isReplay: true, message: { role: 'user', content: 'hello' } }));
    expect(acc.rows.map((r) => r.text)).toEqual(['hello']);
  });
});

describe('an API error as the assistant reply (FB-04)', () => {
  const limitText = "You've hit your 5-hour limit · resets 12:10am (America/Vancouver)";

  it('becomes an error row from a transcript record (isApiErrorMessage)', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(
      line({
        type: 'assistant',
        timestamp: '2026-10-31T07:00:00.000Z',
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: limitText }] },
      }),
    );
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([['error', limitText]]);
  });

  it('becomes an error row from a stream-json line (is_api_error_message, claude 2.1.316)', () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addPrompt('go');
    acc.addLine(
      line({
        type: 'assistant',
        error: 'rate_limit',
        is_api_error_message: true,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: limitText }] },
      }),
    );
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'go'],
      ['error', limitText],
    ]);
  });

  it('names the error when the record has no text', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', isApiErrorMessage: true, error: 'overloaded', message: { role: 'assistant', content: [] } }));
    expect(acc.rows[0]).toMatchObject({ kind: 'error', text: 'API error: overloaded' });
  });

  it('is the list line, and the turn it ended counts until the user or the agent writes again', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'user', message: { role: 'user', content: 'go' } }));
    acc.addLine(line({ type: 'assistant', timestamp: '2026-10-31T07:00:00.000Z', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: limitText }] } }));
    expect(latestLine(acc.rows)).toBe(limitText);
    expect(endingError(acc.rows)).toEqual({ text: limitText, at: Date.parse('2026-10-31T07:00:00.000Z') });
    acc.addLine(line({ type: 'user', message: { role: 'user', content: 'try again' } }));
    expect(endingError(acc.rows)).toBeUndefined();
  });

  it('is in the Markdown export', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Limit reached' }] } }));
    expect(messagesToMarkdown(acc.rows, { title: 'Chat', includeThinking: false, includeTools: false })).toContain('## Error\n\nLimit reached');
  });
});

describe("a workflow agent's StructuredOutput call (WF-01)", () => {
  const call = (id: string, input: unknown) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'StructuredOutput', input }] } });
  const result = (id: string, text: string, isError = false) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] } });

  it("becomes the agent's reply, outside the tool group, with its string field as text", () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'ls' } }] } }));
    acc.addLine(result('tb', 'a.js'));
    acc.addLine(call('so1', { files: ['/w/a.js', '/w/b.js'], summary: 'The src directory holds two modules.' }));
    acc.addLine(result('so1', 'Structured output provided successfully'));
    expect(acc.rows.map((r) => r.kind)).toEqual(['tool', 'agent']);
    expect(acc.rows[1].text).toBe('The src directory holds two modules.\n\n- **files**:\n  - /w/a.js\n  - /w/b.js');
  });

  it('lists the fields when none is text, and labels several text fields', () => {
    expect(structuredOutputText({ count: 3, ok: true })).toBe('- **count**: 3\n- **ok**: true');
    expect(structuredOutputText({ title: 'T', body: 'B' })).toBe('**title**\n\nT\n\n**body**\n\nB');
    expect(structuredOutputText({ nested: { a: 1 } })).toBe('- **nested**: {"a":1}');
    expect(structuredOutputText({})).toBe('');
  });

  it('takes the reply back when the schema rejected the call, and keeps the retry', () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(call('so1', { summary: 'wrong shape' }));
    acc.addLine(result('so1', 'Schema validation failed', true));
    acc.addLine(call('so2', { files: [], summary: 'right shape' }));
    acc.addLine(result('so2', 'Structured output provided successfully'));
    expect(acc.rows.map((r) => r.text)).toEqual(['right shape']);
  });

  it('keeps an empty call as the tool row it is', () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(call('so1', {}));
    expect(acc.rows.map((r) => [r.kind, r.tool])).toEqual([['tool', 'StructuredOutput']]);
  });
});

describe("a workflow agent's first message (WF-02)", () => {
  // Characters as in a real claude 2.1.314 agent transcript: an em dash, and the task indented by two spaces.
  const framed =
    "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority. The computed task text follows:\n  This is strictly read-only.\n  \n  Summarize src in two sentences.";

  it('becomes a task row without the framing, not a user message', () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(line({ type: 'user', isSidechain: true, message: { role: 'user', content: framed } }));
    acc.addLine(line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Two modules.' }] } }));
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([
      ['task', 'This is strictly read-only.\n\nSummarize src in two sentences.'],
      ['agent', 'Two modules.'],
    ]);
    expect(messagesToMarkdown(acc.rows, { title: 'Agent', includeThinking: false, includeTools: false })).toContain('## Task\n\nThis is strictly read-only.');
  });

  it('reads a text block too, accepts a hyphen or en dash, and leaves other messages alone', () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: framed.replace('—', '-') }] } }));
    expect(acc.rows[0].kind).toBe('task');
    expect(workflowTaskText(framed.replace('—', '–'))).toBe('This is strictly read-only.\n\nSummarize src in two sentences.');
    expect(workflowTaskText('Please review the Workflow harness')).toBeNull();
    // Without the sentence that ends the framing, only the marker goes.
    expect(workflowTaskText('[Workflow harness — computed task] Do it.')).toBe('Do it.');
  });
});

describe('a subagent waiting on its own background work (ST-01)', () => {
  const meta = (agentId: string): SubagentMeta => ({ agentId, toolUseId: `tu-${agentId}`, type: 'general-purpose', description: 'Sleep 240s', background: true });

  // The notification as claude 2.1.316 writes it when a background subagent stops with its own background work still running.
  const waiting =
    '<task-notification>\n<task-id>a8c4</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/a8c4.output</output-file>\n<status>completed</status>\n<summary>Agent "Sleep 240s then count .ts files" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>This agent has not reported yet</result>\n</task-notification>';
  const finished =
    '<task-notification>\n<task-id>a8c4</task-id>\n<status>completed</status>\n<summary>Agent "Sleep 240s then count .ts files" completed</summary>\n<result>42 files</result>\n</task-notification>';

  const launch = (acc: TranscriptAccumulator) => {
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-a8c4', name: 'Agent', input: { description: 'Sleep 240s', run_in_background: true } }] } }));
    acc.addLine(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-a8c4', content: 'Async agent launched successfully.' }] },
        toolUseResult: { isAsync: true, agentId: 'a8c4', status: 'async_launched' },
      }),
    );
  };

  it('keeps showing as running until its second notification says it finished', () => {
    const acc = new TranscriptAccumulator();
    launch(acc);
    acc.addLine(line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: waiting } }));
    expect(acc.rows[0].background).toEqual({ id: 'a8c4', status: 'running' });
    expect(subagentsOf([meta('a8c4')], acc.rows).map((s) => s.status)).toEqual(['running']);
    expect(backgroundOf(acc.rows)[0].status).toBe('running');

    acc.addLine(line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: finished } }));
    expect(acc.rows[0].background).toMatchObject({ status: 'completed', summary: 'Agent "Sleep 240s then count .ts files" completed' });
    expect(subagentsOf([meta('a8c4')], acc.rows).map((s) => s.status)).toEqual(['done']);
  });

  it('reads the same notification from a stream-json user record', () => {
    const acc = new ClaudeStreamAccumulator();
    launch(acc);
    acc.addLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: waiting } }));
    expect(subagentsOf([meta('a8c4')], acc.rows).map((s) => s.status)).toEqual(['running']);
  });
});
