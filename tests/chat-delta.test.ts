import { describe, expect, it } from 'vitest';
import type { ChatState } from '../src/shared/chat';
import { applyChatWire, ChatEncoder, keepRows } from '../src/shared/chat-delta';
import type { MessageRow } from '../src/shared/messages';

const row = (id: string, text: string, extra: Partial<MessageRow> = {}): MessageRow => ({ id, kind: 'agent', preview: text.slice(0, 20), text, ...extra });
const state = (rows: MessageRow[], history: MessageRow[] = []): ChatState => ({ id: 'c', status: 'working', history, rows }) as unknown as ChatState;
/** What a page holds: the first event applied to nothing, as a page's read of the chat would give. */
const clone = <T>(v: T): T => structuredClone(v);

describe('chat events as what changed', () => {
  it('sends every row first, then only the new and changed ones, and the page ends up with the same state', () => {
    const enc = new ChatEncoder();
    const h = [row('h0', 'earlier')];
    const first = enc.encode(state([row('a', 'one'), row('b', 'two')], h));
    expect(first.rows).toHaveLength(2);
    expect(first.history).toHaveLength(1);
    let page = applyChatWire(null, clone(first))!;
    const second = enc.encode(state([row('a', 'one'), row('b', 'two, longer'), row('c', 'three')], h));
    expect(second.history).toBeUndefined();
    expect(second.delta?.ids).toEqual(['a', 'b', 'c']);
    expect(second.delta?.changed.map((r) => r.id)).toEqual(['b', 'c']);
    const before = page.rows[0];
    page = applyChatWire(page, clone(second))!;
    expect(page.rows.map((r) => r.text)).toEqual(['one', 'two, longer', 'three']);
    expect(page.history.map((r) => r.id)).toEqual(['h0']);
    // An unchanged row stays the same object, so its row component needn't draw again.
    expect(page.rows[0]).toBe(before);
  });

  it('finds a tool result, a background status and an error flag that came later', () => {
    const enc = new ChatEncoder();
    const tool = (extra: Partial<MessageRow>) => row('t', 'command: ls', { kind: 'tool', tool: 'Bash', ...extra });
    enc.encode(state([tool({})]));
    expect(enc.encode(state([tool({ result: 'a.txt' })])).delta?.changed).toHaveLength(1);
    expect(enc.encode(state([tool({ result: 'a.txt', resultError: true })])).delta?.changed).toHaveLength(1);
    expect(enc.encode(state([tool({ result: 'a.txt', resultError: true, background: { id: 'b', status: 'completed' } })])).delta?.changed).toHaveLength(1);
    expect(enc.encode(state([tool({ result: 'a.txt', resultError: true, background: { id: 'b', status: 'completed' } })])).delta?.changed).toHaveLength(0);
  });

  it('follows rows dropped from the head, as the accumulator drops them past its limit', () => {
    const enc = new ChatEncoder();
    let page = applyChatWire(null, clone(enc.encode(state([row('a', '1'), row('b', '2'), row('c', '3')]))))!;
    page = applyChatWire(page, clone(enc.encode(state([row('b', '2'), row('c', '3'), row('d', '4')]))))!;
    expect(page.rows.map((r) => r.id)).toEqual(['b', 'c', 'd']);
  });

  it('sends the history again only when it changed', () => {
    const enc = new ChatEncoder();
    enc.encode(state([], [row('h0', 'x')]));
    expect(enc.encode(state([], [row('h0', 'x')])).history).toBeUndefined();
    expect(enc.encode(state([], [row('h0', 'x'), row('h1', 'y')])).history).toHaveLength(2);
  });

  it("can't apply an event to a state that missed one, or to no state", () => {
    const enc = new ChatEncoder();
    const page = applyChatWire(null, clone(enc.encode(state([row('a', '1')]))))!;
    enc.encode(state([row('a', '1'), row('b', '2')]));
    const third = enc.encode(state([row('a', '1'), row('b', '2'), row('c', '3')]));
    expect(applyChatWire(page, clone(third))).toBeNull();
    expect(applyChatWire(null, clone(third))).toBeNull();
    // A read of the chat (its state with the encoder's seq) is a state the next event applies to.
    const read = { ...state([row('a', '1'), row('b', '2'), row('c', '3')]), seq: enc.seq, epoch: enc.epoch };
    const next = applyChatWire(read, clone(enc.encode(state([row('a', '1'), row('b', '2'), row('c', '3!')]))));
    expect(next?.rows.map((r) => r.text)).toEqual(['1', '2', '3!']);
  });

  it('leaves out the large fields that are as before, and the page keeps its own', () => {
    const enc = new ChatEncoder();
    const withCommands = (commands: string[], rows: MessageRow[]) => ({ ...state(rows), commands: commands.map((name) => ({ name, description: 'd' })) }) as unknown as ChatState;
    let page = applyChatWire(null, clone(enc.encode(withCommands(['a', 'b'], [row('r', '1')]))))!;
    const same = enc.encode(withCommands(['a', 'b'], [row('r', '12')]));
    expect(same.commands).toBeUndefined();
    expect(same.kept).toContain('commands');
    page = applyChatWire(page, clone(same))!;
    expect(page.commands.map((c) => c.name)).toEqual(['a', 'b']);
    expect(page.rows[0].text).toBe('12');
    const changed = enc.encode(withCommands(['a', 'b', 'c'], [row('r', '12')]));
    expect(changed.kept ?? []).not.toContain('commands');
    expect(applyChatWire(page, clone(changed))!.commands).toHaveLength(3);
  });

  it("doesn't apply a reopened chat's events to the state of its earlier opening", () => {
    const old = new ChatEncoder();
    const page = applyChatWire(null, clone(old.encode(state([row('a', 'old')]))))!;
    const reopened = new ChatEncoder();
    reopened.encode(state([row('x', 'new')]));
    // Its second event has the seq the page's state would take next, from another encoder.
    expect(applyChatWire(page, clone(reopened.encode(state([row('x', 'new'), row('y', 'more')]))))).toBeNull();
  });

  it("finds a command's output filled into the prompt's attachment", () => {
    const enc = new ChatEncoder();
    const att = (output: string) => ({ kind: 'command', name: 'ls', command: 'ls', output }) as never;
    enc.encode(state([row('p', 'hi', { kind: 'prompt', attachments: [att('')] })]));
    expect(enc.encode(state([row('p', 'hi', { kind: 'prompt', attachments: [att('a.txt b.txt')] })])).delta?.changed).toHaveLength(1);
  });
});

describe('keepRows', () => {
  it('keeps the rows that did not change as the same objects, and the whole array when none did', () => {
    const prev = [row('a', 'one'), row('b', 'two')];
    expect(keepRows(prev, clone(prev))).toBe(prev);
    const next = keepRows(prev, [...clone(prev.slice(0, 1)), row('b', 'two, longer'), row('c', 'three')]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next.map((r) => r.text)).toEqual(['one', 'two, longer', 'three']);
    // A row that went away makes a new array of the ones kept.
    const fewer = keepRows(prev, clone(prev.slice(0, 1)));
    expect(fewer).toHaveLength(1);
    expect(fewer[0]).toBe(prev[0]);
  });
});
