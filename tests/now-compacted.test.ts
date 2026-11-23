import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { MessagesService, TranscriptAccumulator } from '../src/engine/messages';
import { compactedText, compactRows, fromRun, layered, slimCall } from '../src/shared/compact';
import { SettingsSchema } from '../src/shared/types';
import { callRunning, type MessageRow } from '../src/shared/messages';
import { entryFromScript, nowEntries, nowTools } from '../src/renderer/src/components/now-entries';

const row = (r: Partial<MessageRow> & Pick<MessageRow, 'kind' | 'text'>): MessageRow => ({ id: 'x', preview: r.text.slice(0, 40), ...r });
const sent = { caption: 'The screenshot', files: [{ path: '/a/s.png', name: 's.png', inline: true }] };

describe("a compacted conversation's calls on Now", () => {
  it('keeps the mark of a file a Code Mode script sent', () => {
    const [own, script] = compactRows([
      row({ kind: 'tool', tool: 'SendUserFile', text: 'x', result: 'ok', sent }),
      row({ kind: 'tool', tool: 'SendUserFile', text: 'x', result: 'ok', sent, fromScript: true }),
    ]);
    expect(own.fromScript).toBeUndefined();
    expect(script.fromScript).toBe(true);
  });

  it("doesn't show an earlier session's calls as running: compaction keeps them without their results", () => {
    // Compacted twice: the first session's calls are an earlier layer's, slimmed.
    const first = layered(
      compactRows([
        row({ kind: 'tool', tool: 'SendUserFile', text: 'x', result: 'ok', sent, fromScript: true }),
        row({ kind: 'tool', tool: 'Bash', text: 'ls', result: 'a'.repeat(30_000) }),
        row({ kind: 'tool', tool: 'Bash', text: 'false', result: 'exit 1', resultError: true }),
      ]),
    );
    const rows = layered([...first, ...compactRows([row({ kind: 'agent', text: 'Done.' })]).map((r) => ({ ...r, id: 'n0' }))]).slice(0, 3);
    // None has its result any more: the sent file's was never kept, and an earlier session's calls are slimmed.
    expect(rows.map((r) => r.result)).toEqual([undefined, undefined, undefined]);
    expect(rows.map(callRunning)).toEqual([false, false, false]);
    expect(rows[2].resultError).toBe(true);
  });

  it('shows a call of the session that runs now as running until its result comes', () => {
    expect(callRunning(row({ kind: 'tool', tool: 'Bash', text: 'sleep 9' }))).toBe(true);
    expect(callRunning(row({ kind: 'tool', tool: 'Bash', text: 'ls', result: '' }))).toBe(false);
  });

  it("lists a compacted session's script-sent files as the script's, and the running session's only as its script's own calls", () => {
    const rec = (o: Record<string, unknown>) => JSON.stringify(o);
    const acc = new TranscriptAccumulator();
    acc.addLine(rec({ type: 'assistant', timestamp: '2026-11-20T01:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'REPL', input: { code: 'send' } }] } }));
    acc.addLine(rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '(dispatched #1)', is_error: false }] } }));
    acc.addParsed({ type: 'assistant', isVirtual: true, liveScriptCall: true, timestamp: '2026-11-20T01:00:01.000Z', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id: 'f1', name: 'SendUserFile', input: { files: ['/p/shot.png'], caption: 'Both views.' } }] } });
    acc.addParsed({ type: 'user', isVirtual: true, liveScriptCall: true, timestamp: '2026-11-20T01:00:01.100Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: '', is_error: false }] }, toolUseResult: { caption: 'Both views.', attachments: [{ path: '/p/shot.png', size: 512, isImage: true }] } });
    acc.addLine(rec({ type: 'attachment', attachment: { type: 'poll_events', envelopes: ['<event nonce="e1" kind="repl-eval" at="2026-11-20T01:00:02.000Z" eval="1" ms="5" status="settled">\n<result>done</result>\n</event>'] } }));

    // While it runs: the REPL call and its script's call; the file's own row is the conversation's.
    const live = nowEntries(nowTools(acc.rows));
    expect(live.map((e) => (e.row ? e.row.tool : `[REPL] ${acc.scriptCalls.get('r1')![e.index!].tool}`))).toEqual(['REPL', '[REPL] SendUserFile']);

    // Compacted: the REPL call keeps where its script's calls are (its run, tool_use id and calls), so Now lists them as before.
    const chat = layered(compactRows(fromRun(acc.rows, 'run-1')));
    const repl = chat.find((r) => r.tool === 'REPL')!;
    expect(repl).toMatchObject({ toolUseId: 'r1', run: 'run-1', calls: { count: 1, at: [[0, 0, 1]] }, layer: 0 });
    const entries = nowEntries(nowTools(chat));
    expect(entries.map((e) => [e.row?.tool ?? 'script call', entryFromScript(e), e.row ? callRunning(e.row) : false])).toEqual([
      ['REPL', false, false],
      ['script call', true, false],
    ]);

    // A compacted.json from before version 4 kept neither: its sent file is listed instead, as the script's.
    const old = chat.map((r) => {
      const { calls: _calls, toolUseId: _id, run: _run, ...rest } = r;
      return rest as MessageRow;
    });
    expect(nowEntries(nowTools(old)).map((e) => [e.row?.tool, entryFromScript(e)])).toEqual([
      ['REPL', false],
      ['SendUserFile', true],
    ]);
  });

  it("keeps each call's input when it's no longer than the text kept, and slims it with an earlier session's", () => {
    const [small, big] = compactRows([
      row({ kind: 'tool', tool: 'Bash', text: 'command: ls', input: { command: 'ls' }, result: 'a', toolUseId: 't1', run: 'r1' }),
      row({ kind: 'tool', tool: 'Write', text: 'file_path: /a', input: { file_path: '/a', content: 'x'.repeat(5000) }, result: 'ok', toolUseId: 't2', run: 'r1' }),
    ]);
    expect(small).toMatchObject({ input: { command: 'ls' }, toolUseId: 't1', run: 'r1' });
    expect(big.input).toBeUndefined();
    expect(slimCall({ ...small, input: { command: 'y'.repeat(400) } }).input).toBeUndefined();
    expect(slimCall(small).input).toEqual({ command: 'ls' });
  });

  it("reads a compacted call back whole from its run's transcript while it's there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-compacted-call-'));
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    const transcript = path.join(dir, 's.jsonl');
    const rec = (o: Record<string, unknown>) => JSON.stringify(o);
    fs.writeFileSync(
      transcript,
      [
        rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'cat big' } }] } }),
        rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'z'.repeat(30_000) }] } }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ session_id: 's', transcript_path: transcript }));
    const service = new MessagesService({ getTask: () => undefined, runDir: () => runDir, attachment: () => null, host: 'linux', settings: SettingsSchema.parse({}), log: new Logger() });
    // Compaction keeps the length of a result that large, not the result.
    const [kept] = compactRows(fromRun((await service.read('t1', 'r1')).rows, 'r1'));
    expect(kept).toMatchObject({ toolUseId: 'b1', run: 'r1', resultChars: 30_000 });
    expect(kept.result).toBeUndefined();
    const whole = await service.readCall('t1', 'r1', 'b1');
    expect(whole?.result).toHaveLength(30_000);
    fs.rmSync(transcript);
    expect(await new MessagesService({ getTask: () => undefined, runDir: () => runDir, attachment: () => null, host: 'linux', settings: SettingsSchema.parse({}), log: new Logger() }).readCall('t1', 'r1', 'b1')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the new session the same text whatever the screens keep: input, tool_use id, run, a script's calls and its sent files' mark", () => {
    const session = (n: number) =>
      fromRun(
        [
          row({ kind: 'prompt', text: `question ${n}` }),
          row({ kind: 'tool', tool: 'REPL', text: `code:\nconst x${n} = await tools.Read({file_path: '/a'})`, input: { code: `const x${n} = await tools.Read({file_path: '/a'})` }, result: 'done', toolUseId: `r${n}`, calls: { count: 2, failed: 1, failures: [1], files: [{ path: '/a', changed: false, index: 0 }], at: [[0, 0, 2]] } }),
          row({ kind: 'tool', tool: 'SendUserFile', text: 'x', result: 'ok', sent, toolUseId: `f${n}`, fromScript: true }),
          row({ kind: 'tool', tool: 'Bash', text: 'command: ls', input: { command: 'ls' }, result: 'a\nb', toolUseId: `b${n}` }),
          row({ kind: 'agent', text: `answer ${n}` }),
        ],
        `run-${n}`,
      );
    // Two compactions: the first session is an earlier layer (slimmed), the second the newest.
    const first = layered(compactRows(session(1)));
    const rows = layered([...first, ...compactRows(session(2)).map((r) => ({ ...r, id: `n${r.id}` }))]);
    expect(rows.filter((r) => r.run).map((r) => r.layer)).toEqual([0, 0, 0, 1, 1, 1]);
    const screensOnly = rows.map((r) => {
      const { input: _input, toolUseId: _id, run: _run, calls: _calls, fromScript: _from, ...rest } = r;
      return rest as MessageRow;
    });
    expect(screensOnly).not.toEqual(rows);
    expect(compactedText(rows)).toBe(compactedText(screensOnly));
  });

  it('decides "Running" on Now from callRunning, on the list and on the call\'s screen', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/ActivityPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain("const callState = (t: MessageRow) => (callRunning(t) ? 'Running'");
    expect(panel).toContain('const running = callRunning(row);');
    expect(panel).toContain('nowTools(rows)');
  });
});
