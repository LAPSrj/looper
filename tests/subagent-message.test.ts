import { describe, expect, it } from 'vitest';
import { groupRows } from '../src/renderer/src/components/chat-groups';
import { handbackText, type MessageRow } from '../src/shared/messages';

const row = (id: string, kind: MessageRow['kind'], text: string, over: Partial<MessageRow> = {}): MessageRow => ({ id, kind, text, preview: text, ...over });

describe('a subagent’s hand back', () => {
  const handback = row('h', 'tool', '{"message":"Done"}', { tool: 'SubagentHandback', input: { message: '## Done\n\nAll fixed.' } });

  it('reads the report from the call’s message, else its rendered input', () => {
    expect(handbackText(handback)).toBe('## Done\n\nAll fixed.');
    expect(handbackText({ ...handback, input: undefined })).toBe('{"message":"Done"}');
    expect(handbackText(row('t', 'tool', 'ls', { tool: 'Bash' }))).toBeNull();
    expect(handbackText(row('a', 'agent', 'hi'))).toBeNull();
  });

  it('is a tool call when it failed', () => {
    expect(handbackText({ ...handback, resultError: true })).toBeNull();
  });

  it('stays out of the tool groups, like a delivered file', () => {
    const rows = [row('a', 'tool', 'ls', { tool: 'Bash' }), handback, row('b', 'tool', 'ls', { tool: 'Bash' })];
    expect(groupRows(rows).map((i) => (i.kind === 'tools' ? i.rows.map((r) => r.id).join('+') : i.row.id))).toEqual(['a', 'h', 'b']);
  });
});
