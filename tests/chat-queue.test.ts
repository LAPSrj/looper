import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolUseIds } from '../src/engine/chat';
import { OUTPUT_PREVIEW, commandAttachment, sizeText } from '../src/shared/bash-mode';
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
fs.appendFileSync(path.join(dir, 'argv'), process.argv.slice(2).join(' ') + '\\n');
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

describe('commands the user runs from the message box ("!")', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('runs a command in the chat’s working directory, with its stdout, stderr and exit code, without a turn of the agent', async () => {
    const s = await setUp();
    engine = s.engine;
    const out = await s.engine.runChatCommand(s.chatId, 'pwd; echo oops >&2; exit 3', 'run-1');
    expect(out).toMatchObject({ id: 'run-1', input: 'pwd; echo oops >&2; exit 3', stdout: `${s.dir}\n`, stderr: 'oops\n', exitCode: 3 });
    expect(out.stopped).toBeUndefined();
    expect(out.saved).toBeUndefined();
    // Nothing went to the agent, and the conversation is as it was.
    expect(lines(join(s.dir, 'received'))).toEqual([]);
    expect(s.engine.getChat(s.chatId)).toMatchObject({ status: 'ready', rows: [], runningCommands: 0 });
  });

  it('Stop ends a command that runs, keeping what it printed', async () => {
    const s = await setUp();
    engine = s.engine;
    const began = join(s.dir, 'began');
    const running = s.engine.runChatCommand(s.chatId, `echo started; touch '${began}'; sleep 30; echo never`, 'run-1');
    await until(() => s.engine.getChat(s.chatId)?.runningCommands === 1 && existsSync(began), 'the command to start');
    await s.engine.stopChat(s.chatId);
    const out = await running;
    expect(out).toMatchObject({ stdout: 'started\n', exitCode: null, stopped: true });
    expect(s.engine.getChat(s.chatId)?.runningCommands).toBe(0);
  });

  it('Stop under one command ends that one alone, and its output comes as it runs, in batches', async () => {
    const s = await setUp();
    engine = s.engine;
    const live: { id: string; stdout: string }[] = [];
    s.engine.on((e) => {
      if (e.type === 'chat:command' && e.chatId === s.chatId) live.push({ id: e.id, stdout: e.stdout });
    });
    const began = join(s.dir, 'began');
    const one = s.engine.runChatCommand(s.chatId, `echo first; touch '${began}'; sleep 30`, 'run-1');
    const two = s.engine.runChatCommand(s.chatId, 'sleep 2; echo second', 'run-2');
    await until(() => existsSync(began) && live.some((l) => l.id === 'run-1' && l.stdout === 'first\n'), 'the first command’s output, live');
    await s.engine.stopChatCommand(s.chatId, 'run-1');
    await expect(one).resolves.toMatchObject({ stopped: true, stdout: 'first\n' });
    const second = await two;
    expect(second).toMatchObject({ exitCode: 0, stdout: 'second\n' });
    expect(second.stopped).toBeUndefined();
    // A command's name is the window's, and two can't share one.
    await expect(s.engine.runChatCommand(s.chatId, 'true', '../x')).rejects.toThrow('no usable id');
  });

  it('saves output too long to send to a file in the chat’s folder, and the agent gets its preview and the file’s path', async () => {
    const s = await setUp();
    engine = s.engine;
    const out = await s.engine.runChatCommand(s.chatId, 'seq 1 20000; echo short >&2', 'run-1');
    const full = Array.from({ length: 20000 }, (_, i) => `${i + 1}\n`).join('');
    expect(out.saved?.stdout?.bytes).toBe(Buffer.byteLength(full));
    expect(out.saved?.stderr).toBeUndefined();
    expect(out.stderr).toBe('short\n');
    // The preview is the output's start; the file holds all of it, in the chat's own folder (a local chat's path is the host's).
    expect(out.stdout).toBe(full.slice(0, OUTPUT_PREVIEW));
    const file = out.saved!.stdout!.path;
    expect(file.startsWith(s.engine.runDir('t1', s.chatId))).toBe(true);
    expect(file.endsWith('run-1-stdout.txt')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(full);
    s.engine.sendChat(s.chatId, 'look', [commandAttachment(out)]);
    await until(() => existsSync(join(s.dir, 'received')), 'the message');
    const received = readFileSync(join(s.dir, 'received'), 'utf8');
    expect(received.startsWith(
      `<bash-input>seq 1 20000; echo short >&2</bash-input>\n<bash-stdout><persisted-output>\nOutput too large (${sizeText(Buffer.byteLength(full))}). Full output saved to: ${file}\n\nPreview (first 2KB):\n1\n2\n3\n`,
    )).toBe(true);
    expect(received).toContain('\n</persisted-output></bash-stdout><bash-stderr>short</bash-stderr>\n\nlook\n');
  });

  it('sends the commands with the next message, ahead of its text, in Claude Code’s format, and shows them as its attachments', async () => {
    const s = await setUp();
    engine = s.engine;
    const one = await s.engine.runChatCommand(s.chatId, 'echo one', 'run-1');
    const two = await s.engine.runChatCommand(s.chatId, 'echo bad >&2; exit 2', 'run-2');
    const attachments = [commandAttachment(one), commandAttachment(two)];
    s.engine.sendChat(s.chatId, 'what failed?', attachments);
    await until(() => existsSync(join(s.dir, 'received')), 'the message');
    expect(readFileSync(join(s.dir, 'received'), 'utf8')).toBe(
      '<bash-input>echo one</bash-input>\n<bash-stdout>one</bash-stdout><bash-stderr></bash-stderr>\n\n' +
        '<bash-input>echo bad >&2; exit 2</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>bad\nExit code 2</bash-stderr>\n\n' +
        'what failed?\n',
    );
    const prompt = s.engine.getChat(s.chatId)!.rows.find((r) => r.kind === 'prompt')!;
    expect(prompt.text).toBe('what failed?');
    expect(prompt.attachments?.map((a) => [a.name, a.command?.exitCode])).toEqual([
      ['! echo one', 0],
      ['! echo bad >&2; exit 2', 2],
    ]);
  });

  it('sends a message of commands alone', async () => {
    const s = await setUp();
    engine = s.engine;
    const out = await s.engine.runChatCommand(s.chatId, 'echo alone', 'run-1');
    s.engine.sendChat(s.chatId, '', [commandAttachment(out)]);
    await until(() => existsSync(join(s.dir, 'received')), 'the message');
    expect(readFileSync(join(s.dir, 'received'), 'utf8')).toBe('<bash-input>echo alone</bash-input>\n<bash-stdout>alone</bash-stdout><bash-stderr></bash-stderr>\n');
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
    // A terminal and a run of the task would use the task's harness: only a chat goes on with it, or a compacted one.
    expect(e.canContinueRun('t1', chatId)).toEqual({ chat: true, terminal: false, guidance: false, compact: true });
    expect(() => e.startTerminalSession('t1', chatId)).toThrow('only Continue in Chat');
    expect(e.startChat('t1', chatId)).toMatchObject({ id: chatId, harnessId: 'other', harnessLocked: true });
  });
});

describe('Restart Agent', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it("ends the turn in progress, starts a new process on the conversation, and the chat goes on", async () => {
    const s = await setUp();
    engine = s.engine;
    expect(s.engine.canRestartSession(s.chatId)).toBe(true);
    s.engine.sendChat(s.chatId, 'first', []);
    touch(s.dir, 'call-1');
    // Mid-turn: Claude Code has named its session and runs a tool.
    await until(() => !!s.engine.getChat(s.chatId)?.rows.some((r) => r.kind === 'tool'), 'the tool call');
    await s.engine.restartSession(s.chatId);
    const after = s.engine.getChat(s.chatId)!;
    expect(after.status).toBe('ready');
    expect(after.rows.filter((r) => r.kind === 'agent').map((r) => r.text)).toEqual(['Stopped.', 'Restarted Claude Code.']);
    // The new process counts its turns from 1 again.
    s.engine.sendChat(s.chatId, 'second', []);
    touch(s.dir, 'release-1');
    await until(() => lines(join(s.dir, 'turns')).length === 1, 'the next turn');
    expect(lines(join(s.dir, 'turns'))).toEqual(['turn 1: second | read mid-turn: ']);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    // The new process goes on with the same Claude Code session (its MCP servers and settings load again).
    const argv = lines(join(s.dir, 'argv'));
    expect(argv).toHaveLength(2);
    expect(argv[0]).not.toContain('--resume');
    expect(argv[1]).toContain('--resume s1');
  });

  it('restarts an idle chat on its conversation, and the next message goes to the new process', async () => {
    const s = await setUp();
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'first', []);
    touch(s.dir, 'call-1');
    touch(s.dir, 'release-1');
    await until(() => lines(join(s.dir, 'turns')).length === 1, 'the first turn');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    await s.engine.restartSession(s.chatId);
    // Nothing was cut short: only the restart shows.
    expect(s.engine.getChat(s.chatId)!.rows.filter((r) => r.kind === 'agent').map((r) => r.text)).toEqual(['done 1', 'Restarted Claude Code.']);
    s.engine.sendChat(s.chatId, 'second', []);
    await until(() => lines(join(s.dir, 'turns')).length === 2, 'the next turn');
    expect(lines(join(s.dir, 'turns'))[1]).toBe('turn 1: second | read mid-turn: ');
    expect(lines(join(s.dir, 'argv'))[1]).toContain('--resume s1');
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
