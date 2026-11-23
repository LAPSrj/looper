import { describe, expect, it } from 'vitest';
import { TranscriptAccumulator } from '../src/engine/messages';
import type { MessageRow } from '../src/shared/messages';
import { entryKey, nowEntries, type NowEntry } from '../src/renderer/src/components/now-entries';

const tool = (id: string, tool = 'Bash', calls?: MessageRow['calls']): MessageRow => ({
  id,
  kind: 'tool',
  tool,
  preview: id,
  text: '',
  toolUseId: `t-${id}`,
  ...(calls ? { calls } : {}),
});
/** Each entry as Now's list names it: an agent's call by its row id, a script's call by its REPL call and place. */
const names = (entries: NowEntry[]) => entries.map((e) => (e.row ? e.row.id : `${e.repl.id}#${e.index}`));

describe("Now's entries", () => {
  it("lists every call a script made as an entry of its own after its REPL call, counted with the agent's own", () => {
    const tools = [tool('1'), tool('2', 'REPL', { count: 3, failed: 0, at: [[0, 0, 3]] }), tool('3')];
    const entries = nowEntries(tools);
    expect(names(entries)).toEqual(['1', '2', '2#0', '2#1', '2#2', '3']);
    // "n of m" and Previous and Next count every entry.
    expect(entries).toHaveLength(6);
  });

  it("puts a script's call after the agent's calls that started before it, where it ran", () => {
    // Script 2 ran on while the agent made call 3: its second call came after it.
    const tools = [tool('1'), tool('2', 'REPL', { count: 2, failed: 0, at: [[0, 0, 1], [1, 1, 1]] }), tool('3'), tool('4')];
    expect(names(nowEntries(tools))).toEqual(['1', '2', '2#0', '3', '2#1', '4']);
  });

  it('orders the calls of scripts that ran at once as they were made', () => {
    // Scripts 1 and 2 run together after the agent's call 2: their calls alternate.
    const tools = [
      tool('1', 'REPL', { count: 3, failed: 0, at: [[0, 0, 1], [1, 2, 1], [1, 4, 1]] }),
      tool('2', 'REPL', { count: 2, failed: 0, at: [[0, 1, 1], [0, 3, 1]] }),
    ];
    expect(names(nowEntries(tools))).toEqual(['1', '1#0', '2', '2#0', '1#1', '2#1', '1#2']);
  });

  it('keeps a script call that came last as the last entry, which Follow the Latest shows', () => {
    const tools = [tool('1', 'REPL', { count: 2, failed: 0, running: 1, at: [[1, 0, 1], [1, 2, 1]] }), tool('2', 'REPL', { count: 1, failed: 0, at: [[0, 1, 1]] })];
    const entries = nowEntries(tools);
    expect(names(entries).at(-1)).toBe('1#1');
  });

  it('puts calls without a place right after their REPL call, and never past the last call', () => {
    const tools = [tool('1', 'REPL', { count: 2, failed: 0 }), tool('2', 'REPL', { count: 1, failed: 0, at: [[5, 0, 1]] })];
    expect(names(nowEntries(tools))).toEqual(['1', '1#0', '1#1', '2', '2#0']);
  });

  it('gives every entry a key of its own', () => {
    const entries = nowEntries([tool('1', 'REPL', { count: 2, failed: 0, at: [[0, 0, 2]] }), tool('2')]);
    expect(new Set(entries.map(entryKey)).size).toBe(entries.length);
  });

  it("follows a conversation's scripts as the engine reads them: live calls where they ran, a call moved to the script that made it, and a script whose calls only the transcript has", () => {
    const rec = (o: Record<string, unknown>) => JSON.stringify(o);
    const at = (s: number, ms = 0) => `2026-11-20T01:00:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;
    const repl = (id: string, s: number) => rec({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'REPL', input: { code: id } }] } });
    const result = (id: string, content: string) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
    // As Looper's mod hands a script's call over when it starts.
    const live = (id: string, s: number) => ({ type: 'assistant', isVirtual: true, liveScriptCall: true, timestamp: at(s), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: id } }] } });
    // As Claude Code writes them once the script has ended.
    const copy = (id: string, ts: string) => rec({ type: 'assistant', isVirtual: true, timestamp: ts, message: { id: `v-${id}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: id } }] } });
    const settled = (n: number, ts: string) => rec({ type: 'attachment', attachment: { type: 'poll_events', envelopes: [`<event nonce="e${n}" kind="repl-eval" at="${ts}" eval="${n}" ms="5" status="settled">\n<result>done</result>\n</event>`] } });

    const acc = new TranscriptAccumulator();
    acc.addLine(repl('r1', 0));
    acc.addLine(result('r1', '(dispatched #1)'));
    acc.addParsed(live('a', 1));
    // The agent starts a second script while the first runs on.
    acc.addLine(repl('r2', 2));
    acc.addLine(result('r2', '(dispatched #2)'));
    // The mod puts the next call under the newest script; the transcript's copy says the first made it.
    acc.addParsed(live('b', 3));
    acc.addParsed(live('c', 4));
    acc.addLine(settled(1, at(5)));
    acc.addLine(copy('a', at(5, 4)));
    acc.addLine(copy('b', at(5, 4)));
    // A third script whose calls the mod didn't hand over: only the transcript's copies, written after it ended.
    acc.addLine(repl('r3', 6));
    acc.addLine(result('r3', '(dispatched #3)'));
    acc.addLine(settled(3, at(8)));
    acc.addLine(copy('d', at(8, 4)));

    const byId = (id: string) => acc.rows.find((r) => r.toolUseId === id)!;
    expect([byId('r1').calls?.at, byId('r2').calls?.at, byId('r3').calls?.at]).toEqual([[[0, 0, 1], [1, 1, 1]], [[0, 2, 1]], [[0, 3, 1]]]);
    const tools = acc.rows.filter((r) => r.kind === 'tool' && !r.fromScript);
    const entries = nowEntries(tools);
    const label = (e: NowEntry) => (e.row ? e.row.toolUseId : acc.scriptCalls.get(e.repl.toolUseId!)![e.index!].toolUseId);
    expect(entries.map(label)).toEqual(['r1', 'a', 'r2', 'b', 'c', 'r3', 'd']);
  });
});
