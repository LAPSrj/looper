import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolUseIds } from '../src/engine/chat';
import { createEngine, type Engine } from '../src/engine/engine';
import { gitTabLabel } from '../src/shared/git';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A stand-in for `claude -p --input-format stream-json --replay-user-messages`,
 * as Claude Code 2.1 behaves (checked live): each turn starts by replaying the
 * messages waiting, starts one tool call once the test writes `call-<n>` and
 * runs it until the test writes `release-<n>`,
 * replays the messages written meanwhile with the tool's result (the agent
 * read them mid-turn), and ends. An interrupt ends the turn at once, and a
 * message still waiting starts the next turn by itself.
 */
function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir = ${JSON.stringify(dir)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const text = (m) => m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
const pending = [];
let busy = false;
let interrupted = false;
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    if (m.request.subtype === 'interrupt') interrupted = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (m.type !== 'user') return;
  pending.push(m);
  fs.appendFileSync(path.join(dir, 'received'), text(m) + '\\n');
  if (!busy) void turn();
});
const replay = (m) => out({ ...m, parent_tool_use_id: null, isReplay: true });
async function turn() {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  const opening = pending.splice(0);
  opening.forEach(replay);
  const id = 'tool' + ++n;
  while (!interrupted && !fs.existsSync(path.join(dir, 'call-' + n))) await new Promise((r) => setTimeout(r, 20));
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }] } });
  while (!interrupted && !fs.existsSync(path.join(dir, 'release-' + n))) await new Promise((r) => setTimeout(r, 20));
  if (interrupted) {
    interrupted = false;
    out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'stopped' }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    out({ type: 'result', subtype: 'error_during_execution' });
  } else {
    out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    const read = pending.splice(0);
    read.forEach(replay);
    fs.appendFileSync(path.join(dir, 'turns'), 'turn ' + n + ': ' + opening.map(text).join('+') + ' | read mid-turn: ' + read.map(text).join('+') + '\\n');
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done ' + n }] } });
    out({ type: 'result', subtype: 'success', result: 'done ' + n });
  }
  busy = false;
  if (pending.length) void turn();
}
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

async function setUp(): Promise<{ engine: Engine; dir: string; chatId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
  const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
  const engine = createEngine({ dataDir });
  engine.start();
  engine.updateSettings({
    environments: engine.settings.environments.map((e) =>
      e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : e,
    ),
  });
  engine.saveTask(
    TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x' } }),
  );
  const chatId = engine.startChat('t1').id;
  await until(() => engine.getChat(chatId)?.status === 'ready', 'the chat to start');
  return { engine, dir, chatId };
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const touch = (dir: string, name: string) => writeFileSync(join(dir, name), '');

describe('a chat queue on Claude', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('writes a message sent during a tool call at once, and shows it where the agent read it, in the same turn', async () => {
    const s = await setUp();
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'first', []);
    touch(s.dir, 'call-1');
    await until(() => (s.engine.getChat(s.chatId)?.rows ?? []).some((r) => r.kind === 'tool'), 'the tool call');
    s.engine.sendChat(s.chatId, 'second', []);
    expect(s.engine.getChat(s.chatId)?.queued).toMatchObject([{ text: 'second', sent: true }]);
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the second message to reach the agent');
    // A message the agent was already sent can't be taken back.
    expect(s.engine.unqueueChat(s.chatId, s.engine.getChat(s.chatId)!.queued[0].id)).toBeUndefined();
    touch(s.dir, 'release-1');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    expect(lines(join(s.dir, 'turns'))).toEqual(['turn 1: first | read mid-turn: second']);
    const chat = s.engine.getChat(s.chatId)!;
    expect(chat.queued).toEqual([]);
    expect(chat.rows.map((r) => (r.kind === 'prompt' ? `prompt ${r.text}` : r.kind))).toEqual(['prompt first', 'tool', 'prompt second', 'agent']);
  });

  it('keeps a message sent before any tool call in the queue, where it can be edited, and writes it when a call starts', async () => {
    const s = await setUp();
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'first', []);
    await until(() => lines(join(s.dir, 'received')).length === 1, 'the first message');
    s.engine.sendChat(s.chatId, 'draft', []);
    const queued = s.engine.getChat(s.chatId)!.queued;
    expect(queued).toMatchObject([{ text: 'draft' }]);
    expect(queued[0].sent).toBeFalsy();
    expect(s.engine.unqueueChat(s.chatId, queued[0].id)).toMatchObject({ text: 'draft' });
    s.engine.sendChat(s.chatId, 'second', []);
    expect(lines(join(s.dir, 'received'))).toEqual(['first']);
    touch(s.dir, 'call-1');
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the second message to go with the tool call');
    touch(s.dir, 'release-1');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    expect(lines(join(s.dir, 'turns'))).toEqual(['turn 1: first | read mid-turn: second']);
  });

  it('sends a message queued after the last tool call once the turn ends, as the next turn', async () => {
    const s = await setUp();
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'first', []);
    touch(s.dir, 'call-1');
    await until(() => (s.engine.getChat(s.chatId)?.rows ?? []).some((r) => r.kind === 'tool'), 'the tool call');
    touch(s.dir, 'release-1');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the first turn to end');
    s.engine.sendChat(s.chatId, 'second', []);
    touch(s.dir, 'call-2');
    touch(s.dir, 'release-2');
    await until(() => lines(join(s.dir, 'turns')).length === 2, 'the second turn');
    expect(lines(join(s.dir, 'turns'))).toEqual(['turn 1: first | read mid-turn: ', 'turn 2: second | read mid-turn: ']);
  });

  it('Send Now stops the turn, and the agent goes on with the queued message in its next turn', async () => {
    const s = await setUp();
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'first', []);
    touch(s.dir, 'call-1');
    await until(() => (s.engine.getChat(s.chatId)?.rows ?? []).some((r) => r.kind === 'tool'), 'the tool call');
    // The tool runs: the message goes at once, and Send Now stops the turn so the agent reads it now.
    s.engine.sendChat(s.chatId, 'urgent', []);
    await s.engine.sendNowChat(s.chatId);
    await until(() => s.engine.getChat(s.chatId)?.queued.length === 0, 'the agent to read the message');
    expect(s.engine.getChat(s.chatId)?.status).toBe('working');
    touch(s.dir, 'call-2');
    touch(s.dir, 'release-2');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the next turn to end');
    expect(lines(join(s.dir, 'turns'))).toEqual(['turn 2: urgent | read mid-turn: ']);
    const prompts = s.engine.getChat(s.chatId)!.rows.filter((r) => r.kind === 'prompt').map((r) => r.text);
    expect(prompts).toEqual(['first', 'urgent']);
  });
});

describe("a chat's harness", { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('moves to another harness until the first message, then stays on it, and opens again on it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const ownDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    engine = createEngine({ dataDir });
    engine.start();
    engine.updateSettings({
      environments: engine.settings.environments.map((e) =>
        e.id === 'local'
          ? {
              ...e,
              harnesses: [
                { id: 'own', name: 'Own', kind: 'claude-code' as const, command: fakeClaude(ownDir) },
                { id: 'other', name: 'Other', kind: 'claude-code' as const, command: fakeClaude(otherDir) },
              ],
            }
          : e,
      ),
    });
    engine.saveTask(
      TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: ownDir, agent: { harnessId: 'own', prompt: 'x' } }),
    );
    const e = engine;
    const chatId = e.startChat('t1').id;
    expect(e.getChat(chatId)).toMatchObject({ harnessId: 'own', harnessLocked: false, harnesses: [{ id: 'own' }, { id: 'other' }] });

    await e.setChatHarness(chatId, 'other');
    await until(() => e.getChat(chatId)?.harnessId === 'other' && e.getChat(chatId)?.status === 'ready', 'the chat on the other harness');
    e.sendChat(chatId, 'hello', []);
    touch(otherDir, 'call-1');
    touch(otherDir, 'release-1');
    await until(() => e.getChat(chatId)?.status === 'ready' && lines(join(otherDir, 'turns')).length === 1, 'the turn to end');
    expect(lines(join(otherDir, 'received'))).toEqual(['hello']);
    expect(lines(join(ownDir, 'received'))).toEqual([]);

    expect(e.getChat(chatId)?.harnessLocked).toBe(true);
    await expect(e.setChatHarness(chatId, 'own')).rejects.toThrow('stays on its harness');
    const runDir = join(dataDir, 'tasks', 't1', 'runs', chatId);
    expect(JSON.parse(readFileSync(join(runDir, 'chat.json'), 'utf8'))).toMatchObject({ harnessId: 'other', harnessKind: 'claude-code' });

    // The fake doesn't run hooks: the session record stands in for its SessionStart hook.
    writeFileSync(join(runDir, 'session.json'), JSON.stringify({ session_id: 's1' }));
    await e.closeChat(chatId);
    // A terminal and a run of the task would use the task's harness: only a chat goes on with it.
    expect(e.canContinueRun('t1', chatId)).toEqual({ chat: true, terminal: false, guidance: false });
    expect(() => e.startTerminalSession('t1', chatId)).toThrow('only Continue in Chat');
    expect(e.startChat('t1', chatId)).toMatchObject({ id: chatId, harnessId: 'other', harnessLocked: true });
  });
});

describe('queue and Git helpers', () => {
  it("reads a claude record's tool calls and the calls its results answer", () => {
    expect(toolUseIds({ message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] } }, 'tool_use')).toEqual(['a', 'b']);
    expect(toolUseIds({ message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }, 'tool_result')).toEqual(['a']);
    expect(toolUseIds({ message: { content: 'plain' } }, 'tool_use')).toEqual([]);
  });

  it('counts new, changed and deleted files in the Git tab title, leaving out zeros', () => {
    expect(gitTabLabel(undefined)).toBe('Git');
    expect(gitTabLabel([])).toBe('Git');
    expect(
      gitTabLabel([
        { path: 'a', kind: 'untracked', staged: false, unstaged: true },
        { path: 'b', kind: 'added', staged: true, unstaged: false },
        { path: 'c', kind: 'modified', staged: false, unstaged: true },
        { path: 'd', kind: 'renamed', origPath: 'x', staged: true, unstaged: false },
        { path: 'e', kind: 'deleted', staged: false, unstaged: true },
      ]),
    ).toBe('Git (+2 ~2 −1)');
    expect(gitTabLabel([{ path: 'c', kind: 'modified', staged: false, unstaged: true }])).toBe('Git (~1)');
  });
});
