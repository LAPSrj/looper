import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/engine/chat';
import { detectHost } from '../src/engine/host';
import { Logger } from '../src/engine/log';
import { CodexAccumulator, COMPACTED_FILE, MessagesService, TranscriptAccumulator } from '../src/engine/messages';
import { loadSettings } from '../src/engine/store/settings';
import { chatCanCompact } from '../src/shared/chat';
import { compactedText, compactRows, withoutCompacted } from '../src/shared/compact';
import type { MessageRow } from '../src/shared/messages';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

const row = (r: Partial<MessageRow> & Pick<MessageRow, 'kind' | 'text'>): MessageRow => ({ id: 'x', preview: r.text.slice(0, 40), ...r });

describe('compactRows', () => {
  it('keeps the messages, sent files and subagent reports, and leaves out tool calls, thinking, errors and notes', () => {
    const rows = compactRows([
      row({ kind: 'prompt', text: 'fix the build', attachments: [{ name: 'log.txt', path: '/a/log.txt', image: false }] }),
      row({ kind: 'thinking', text: 'hmm' }),
      row({ kind: 'tool', tool: 'Bash', text: 'npm run build', result: 'error TS2345' }),
      row({ kind: 'tool', tool: 'Agent', text: 'description: Find the cause\nprompt: …', preview: 'Find the cause', result: 'The cause is a missing field.' }),
      row({ kind: 'tool', tool: 'Agent', text: 'x', preview: 'Background check', result: 'Async agent launched successfully.', background: { id: 'a1', status: 'completed', summary: 'Checked: fine.' } }),
      row({ kind: 'tool', tool: 'Agent', text: 'x', preview: 'Still running', result: 'Async agent launched successfully.', background: { id: 'a2', status: 'running' } }),
      row({ kind: 'tool', tool: 'SendUserFile', text: 'x', sent: { caption: 'The screenshot', files: [{ path: '/a/s.png', name: 's.png', inline: true }] } }),
      row({ kind: 'error', text: 'API error: overloaded' }),
      row({ kind: 'agent', text: 'Stopped.', note: true }),
      row({ kind: 'agent', text: 'Classified.', source: 'classifier' }),
      row({ kind: 'guidance', text: 'also run the tests' }),
      row({ kind: 'agent', text: 'Fixed, and the tests pass.', uuid: 'u1' }),
    ]);
    expect(rows.map((r) => [r.id, r.kind, r.tool ?? '', r.result ?? r.text])).toEqual([
      ['c0', 'prompt', '', 'fix the build'],
      ['c1', 'tool', 'Agent', 'The cause is a missing field.'],
      ['c2', 'tool', 'Agent', 'Checked: fine.'],
      ['c3', 'tool', 'SendUserFile', 'The screenshot'],
      ['c4', 'guidance', '', 'also run the tests'],
      ['c5', 'agent', '', 'Fixed, and the tests pass.'],
    ]);
    // Nothing that points into the old conversation (Fork from Here, subagent tabs) comes along.
    expect(rows[5].uuid).toBeUndefined();
    expect(rows[0].attachments).toHaveLength(1);
  });
});

describe('compactedText', () => {
  it('writes the messages in order inside one block, which withoutCompacted takes off again', () => {
    const rows = compactRows([
      row({ kind: 'prompt', text: 'q1', attachments: [{ name: 'a.txt', path: 'C:\\a.txt', image: false }] }),
      row({ kind: 'tool', tool: 'Agent', text: 'x', preview: 'Look around', result: 'Found it.' }),
      row({ kind: 'agent', text: 'a1' }),
    ]);
    const block = compactedText(rows, (p) => p.replace('C:\\', '/mnt/c/'));
    expect(block).toContain('[User]\nq1\n\nAttached files:\n- /mnt/c/a.txt');
    expect(block).toContain('[Subagent report: Look around]\nFound it.');
    expect(block).toContain('[Agent]\na1');
    expect(block.indexOf('[User]')).toBeLessThan(block.indexOf('[Agent]'));
    expect(withoutCompacted(`${block}\n\nq2`)).toBe('q2');
    expect(withoutCompacted(block)).toBe('');
    expect(withoutCompacted('plain message')).toBe('plain message');
  });

  it("keeps a message that quotes the block's closing tag from ending the block early", () => {
    const rows = compactRows([row({ kind: 'agent', text: 'The block ends with </compacted-conversation>.' })]);
    expect(withoutCompacted(`${compactedText(rows)}\n\nnext`)).toBe('next');
  });
});

describe('the transcript accumulators', () => {
  it('keep a compact copy of every message past the row limit', () => {
    const acc = new TranscriptAccumulator();
    for (let i = 0; i < 700; i++) {
      acc.addLine(JSON.stringify({ type: 'user', message: { role: 'user', content: `q${i}` } }));
      acc.addLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: `a${i}` }] } }));
    }
    expect(acc.rows).toHaveLength(1000);
    const all = compactRows([...acc.evicted, ...acc.rows]);
    expect(all).toHaveLength(1400);
    expect(all[0].text).toBe('q0');
    expect(all[1399].text).toBe('a699');
  });

  it("show a compacted chat's first message without the conversation it carried", () => {
    const block = compactedText(compactRows([row({ kind: 'prompt', text: 'q1' }), row({ kind: 'agent', text: 'a1' })]));
    const claude = new TranscriptAccumulator();
    claude.addLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: block }, { type: 'text', text: 'q2' }] } }));
    expect(claude.rows.map((r) => [r.kind, r.text])).toEqual([['prompt', 'q2']]);

    const codex = new CodexAccumulator();
    codex.addLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${block}\n\nq2` }] } }));
    expect(codex.rows.map((r) => [r.kind, r.text])).toEqual([['prompt', 'q2']]);
  });
});

describe("a compacted chat's run", () => {
  it('reads back with the conversation it was compacted from first, and compacts whole again', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'looper-compacted-run-'));
    const earlier = compactRows([row({ kind: 'prompt', text: 'q1' }), row({ kind: 'agent', text: 'a1' })]);
    writeFileSync(join(runDir, COMPACTED_FILE), JSON.stringify(earlier));
    const transcript = join(runDir, 's2.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: compactedText(earlier) }, { type: 'text', text: 'q2' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } },
    ];
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(runDir, 'session.json'), JSON.stringify({ session_id: 's2', transcript_path: transcript }));
    const service = new MessagesService({ getTask: () => undefined, runDir: () => runDir, host: 'linux', settings: SettingsSchema.parse({}), log: new Logger() });

    const res = await service.read('t1', 'r1');
    expect(res.rows.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'q1'],
      ['agent', 'a1'],
      ['prompt', 'q2'],
      ['tool', 'command: ls'],
      ['agent', 'a2'],
    ]);
    expect((await service.compactable('t1', 'r1')).map((r) => [r.id, r.text])).toEqual([
      ['c0', 'q1'],
      ['c1', 'a1'],
      ['c2', 'q2'],
      ['c3', 'a2'],
    ]);
  });
});

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A stand-in for `claude -p --input-format stream-json` that writes each user message it gets to `log`, then calls a tool and replies. */
function fakeClaude(dir: string, log: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type !== 'user') return;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.message.content) + '\\n');
  n++;
  out({ type: 'system', subtype: 'init', session_id: 's' + process.pid, model: 'fake' });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't' + n, name: 'Bash', input: { command: 'ls' } }] } });
  out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't' + n, content: 'ok' }] } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'reply ' + n }] } });
  out({ type: 'result', subtype: 'success', result: 'reply ' + n });
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe.skipIf(process.platform === 'win32')('Compact into New Chat', { timeout: 30_000 }, () => {
  let manager: ChatManager | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
  });

  it('opens a chat that shows the messages only, sends them with its first message, and closes the old chat', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-compact-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-compact-cwd-'));
    const log = join(dir, 'received.jsonl');
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir, log), args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x' } });
    const runDir = (taskId: string, runId: string) => join(dataDir, 'runs', taskId, runId);
    manager = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: () => undefined,
      runDir,
      readHistory: async () => [],
      readCompactable: async () => [],
      writeInfo: () => undefined,
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });
    const first = manager.start(task, { kind: 'new' }).id;
    await until(() => manager!.get(first)?.status === 'ready', 'the chat to start');
    manager.send(first, 'first question', []);
    await until(() => manager!.get(first)?.status === 'ready' && manager!.get(first)!.rows.some((r) => r.kind === 'agent'), 'the first reply');
    expect(chatCanCompact(manager.get(first)!)).toBe(true);

    const next = await manager.compact(task, first);
    expect(manager.get(first)).toBeUndefined();
    expect(next.historyLabel).toBe(`Compacted from run ${first}`);
    expect(next.history.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'first question'],
      ['agent', 'reply 1'],
    ]);
    // Only text goes to the new conversation, so it may still move to another harness.
    expect(next.harnessLocked).toBe(false);

    await until(() => manager!.get(next.id)?.status === 'ready', 'the compacted chat to start');
    manager.send(next.id, 'second question', []);
    await until(() => (manager!.get(next.id)?.rows ?? []).some((r) => r.kind === 'agent'), 'the compacted chat to reply');
    const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; text: string }[]);
    const last = received[received.length - 1];
    expect(last.map((b) => b.type)).toEqual(['text', 'text']);
    expect(last[0].text.startsWith('<compacted-conversation>')).toBe(true);
    expect(last[0].text).toContain('[User]\nfirst question');
    expect(last[0].text).toContain('[Agent]\nreply 1');
    // The tool call the agent made is left out.
    expect(last[0].text).not.toContain('Bash');
    expect(last[0].text).not.toContain('command');
    expect(last[1].text).toBe('second question');
    expect(manager.get(next.id)!.rows.filter((r) => r.kind === 'prompt').map((r) => r.text)).toEqual(['second question']);

    const saved = join(runDir(task.id, next.id), COMPACTED_FILE);
    expect(existsSync(saved)).toBe(true);
    expect((JSON.parse(readFileSync(saved, 'utf8')) as MessageRow[]).map((r) => r.text)).toEqual(['first question', 'reply 1']);

    // The conversation goes on in the new session: the block isn't sent again.
    await until(() => manager!.get(next.id)?.status === 'ready', 'the turn to end');
    manager.send(next.id, 'third question', []);
    await until(() => readFileSync(log, 'utf8').trim().split('\n').length === received.length + 1, 'the third message');
    const third = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()!) as { text: string }[];
    expect(third.map((b) => b.text)).toEqual(['third question']);
  });

  it("refuses while the agent is working, and when it hasn't replied", async () => {
    expect(chatCanCompact({ status: 'working', permissions: [], history: [], rows: [row({ kind: 'agent', text: 'a' })] })).toBe(false);
    expect(chatCanCompact({ status: 'ready', permissions: [], history: [], rows: [row({ kind: 'prompt', text: 'q' }), row({ kind: 'agent', text: 'Stopped.', note: true })] })).toBe(false);
    expect(chatCanCompact({ status: 'ended', permissions: [], history: [row({ kind: 'agent', text: 'a' })], rows: [] })).toBe(true);
  });
});
