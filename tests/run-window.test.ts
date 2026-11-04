import { describe, expect, it } from 'vitest';
import { groupRows, toolGroupLabel } from '../src/renderer/src/components/chat-groups';
import { initialRow, rowMatches, runTableRows, type StepRow } from '../src/renderer/src/run-rows';
import type { MessageRow } from '../src/shared/messages';
import type { RunRecord } from '../src/shared/types';

const msg = (id: string, kind: MessageRow['kind'], text: string, over: Partial<MessageRow> = {}): MessageRow => ({ id, kind, text, preview: text, ...over });
const step = (id: string, ts: string, phase: string, result = 'started'): StepRow => ({
  id,
  ts,
  kind: 'step',
  preview: `${phase} ${result}`,
  record: { ts, taskId: 't', runId: 'r', phase, result } as RunRecord,
});

describe('the run window’s table', () => {
  const steps = [
    step('s0', '2026-11-03T10:00:00Z', 'check', 'act'),
    step('s1', '2026-11-03T10:00:05Z', 'agent'),
    step('s2', '2026-11-03T10:03:00Z', 'guidance', 'sent'),
    step('s3', '2026-11-03T10:09:00Z', 'result', 'success'),
  ];
  const messages = [
    msg('k0', 'agent', 'act', { ts: '2026-11-03T10:00:02Z', source: 'classifier' }),
    msg('m0', 'prompt', 'Fix it', { ts: '2026-11-03T10:00:06Z' }),
    msg('m1', 'tool', 'ls', { ts: '2026-11-03T10:01:00Z', tool: 'Bash' }),
    msg('m2', 'agent', 'Done', { ts: '2026-11-03T10:08:00Z' }),
  ];

  it('lists the run’s records and one row per conversation, where each starts', () => {
    const rows = runTableRows(messages, steps, { raw: false, running: false });
    expect(rows.map((r) => r.id)).toEqual(['s0', 'conversation-classifier', 's1', 'conversation', 's2', 's3']);
    const agent = rows.find((r) => r.id === 'conversation');
    expect(agent).toMatchObject({ kind: 'conversation', preview: 'Conversation, 3 messages', ts: '2026-11-03T10:00:06Z' });
    expect(rows.find((r) => r.id === 'conversation-classifier')).toMatchObject({ source: 'classifier', preview: 'Conversation, 1 message' });
  });

  it('shows the agent’s conversation while the run goes on, after the records, before it has a message', () => {
    const rows = runTableRows([], steps.slice(0, 2), { raw: false, running: true });
    expect(rows.map((r) => r.id)).toEqual(['s0', 's1', 'conversation']);
    expect(rows[2]).toMatchObject({ preview: 'Conversation, no messages yet' });
    expect(runTableRows([], steps, { raw: false, running: false }).map((r) => r.id)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('lists each transcript record as a row of its own with Raw Messages', () => {
    const raw = [msg('x0', 'raw', '{}', { ts: '2026-11-03T10:00:06Z', tool: 'user' })];
    expect(runTableRows(raw, steps, { raw: true, running: false }).map((r) => r.id)).toEqual(['s0', 's1', 'x0', 's2', 's3']);
  });

  it('filters a conversation by its messages', () => {
    const rows = runTableRows(messages, steps, { raw: false, running: false });
    const agent = rows.find((r) => r.id === 'conversation')!;
    expect(rowMatches(agent, 'done')).toBe(true);
    expect(rowMatches(agent, 'bash')).toBe(true);
    expect(rowMatches(agent, 'nothing like it')).toBe(false);
    expect(rowMatches(rows[0], 'check')).toBe(true);
  });

  it('selects the agent’s conversation as the window opens, else the classifier’s', () => {
    expect(initialRow(runTableRows(messages, steps, { raw: false, running: false }))).toBe('conversation');
    expect(initialRow(runTableRows(messages.slice(0, 1), steps, { raw: false, running: false }))).toBe('conversation-classifier');
    expect(initialRow(runTableRows([], steps, { raw: false, running: false }))).toBeNull();
  });
});

describe('tool groups in a chat', () => {
  const tool = (id: string, failed = false) => msg(id, 'tool', 'x', { tool: 'Bash', ...(failed ? { resultError: true } : {}) });
  const thinking = (id: string) => msg(id, 'thinking', 'hmm');

  it('names the thinking with the tools: "Thinking and N tool uses", "Thinking" alone, "N tool uses" without', () => {
    expect(toolGroupLabel([thinking('a'), tool('b')])).toEqual({ text: 'Thinking and 1 tool use', failed: 0 });
    expect(toolGroupLabel([tool('a'), thinking('b'), tool('c', true), tool('d'), tool('e'), tool('f')])).toEqual({ text: 'Thinking and 5 tool uses', failed: 1 });
    expect(toolGroupLabel([thinking('a')])).toEqual({ text: 'Thinking', failed: 0 });
    expect(toolGroupLabel([tool('a'), tool('b')])).toEqual({ text: '2 tool uses', failed: 0 });
  });

  it('puts thinking in the groups unless it shows apart', () => {
    const rows = [msg('p', 'prompt', 'go'), thinking('t'), tool('a'), msg('r', 'agent', 'ok'), thinking('u')];
    expect(groupRows(rows).map((i) => (i.kind === 'tools' ? i.rows.map((r) => r.id).join('+') : i.row.id))).toEqual(['p', 't+a', 'r', 'u']);
    expect(groupRows(rows, true).map((i) => (i.kind === 'tools' ? i.rows.map((r) => r.id).join('+') : i.row.id))).toEqual(['p', 't', 'a', 'r', 'u']);
  });
});
