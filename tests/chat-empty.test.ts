import { describe, expect, it } from 'vitest';
import { chatIsEmpty } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';

const row = (kind: MessageRow['kind']): MessageRow => ({ id: kind, kind, preview: '', text: '' });

describe('chatIsEmpty', () => {
  it('is true before anything is said', () => {
    expect(chatIsEmpty({ history: [], rows: [], queued: [] })).toBe(true);
    expect(chatIsEmpty({ history: [], rows: [row('thinking'), row('tool')], queued: [] })).toBe(true);
  });

  it('is false once there is a user or agent message, in the rows or the history', () => {
    expect(chatIsEmpty({ history: [], rows: [row('prompt')], queued: [] })).toBe(false);
    expect(chatIsEmpty({ history: [], rows: [row('agent')], queued: [] })).toBe(false);
    expect(chatIsEmpty({ history: [row('prompt')], rows: [], queued: [] })).toBe(false);
  });

  it('is false with a message queued', () => {
    expect(chatIsEmpty({ history: [], rows: [], queued: [{ id: 'q', text: 'hi', attachments: [] }] })).toBe(false);
  });
});
