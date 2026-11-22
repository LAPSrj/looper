import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toolUseIds } from '../src/engine/chat';
import { guidanceText } from '../src/shared/messages';
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
// It ends with its input, so a test that stops early leaves nothing running.
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
}).on('close', () => process.exit(0));
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

async function setUp(): Promise<{ engine: Engine; dir: string; dataDir: string; chatId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
  const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
  // The fake logs every start: the login check's `claude auth status` would be one.
  const engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) });
  engine.start();
  engine.updateSettings({
    environments: engine.settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : e,
    ),
  });
  engine.saveTask(
    TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }),
  );
  const chatId = engine.startChat('t1').id;
  try {
    await until(() => engine.getChat(chatId)?.status === 'ready', 'the chat to start');
  } catch (err) {
    // The test never gets the engine to stop.
    await engine.stop();
    throw err;
  }
  return { engine, dir, dataDir, chatId };
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

  it("holds a subagent's messages for the chat's subagent hook, which hands them over once", async () => {
    const s = await setUp();
    engine = s.engine;
    const files = readdirSync(s.dataDir, { recursive: true, encoding: 'utf8' });
    const hook = files.find((f) => f.endsWith('looper-subagent-hook'));
    expect(hook).toBeDefined();
    s.engine.messageSubagent(s.chatId, 'a1b2', 'check the tests');
    s.engine.messageSubagent(s.chatId, 'a1b2', 'and the docs');
    s.engine.messageSubagent(s.chatId, '../x', 'nowhere');
    expect(s.engine.getChat(s.chatId)?.subagentMessages).toEqual({ a1b2: 'check the tests\n\nand the docs' });
    const call = JSON.stringify({ session_id: 's1', agent_id: 'a1b2', tool_name: 'Read', tool_input: {} });
    const r = spawnSync('bash', [join(s.dataDir, hook!), 'post'], { input: call, encoding: 'utf8' });
    expect(guidanceText(JSON.parse(r.stdout).hookSpecificOutput.additionalContext)).toBe('check the tests\n\nand the docs');
    await until(() => s.engine.getChat(s.chatId)?.subagentMessages === undefined, 'the message to leave the waiting list');
    // Taken back before the subagent reads it: the text comes back, and the hook finds nothing.
    s.engine.messageSubagent(s.chatId, 'a1b2', 'never mind');
    expect(s.engine.unmessageSubagent(s.chatId, 'a1b2')).toBe('never mind');
    expect(s.engine.unmessageSubagent(s.chatId, 'a1b2')).toBeUndefined();
    expect(spawnSync('bash', [join(s.dataDir, hook!), 'post'], { input: call, encoding: 'utf8' }).stdout).toBe('');
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
  beforeAll(async () => {
    // The engine turns a command's terminal into text in the terminal worker, which runs from a bundle.
    const file = join(mkdtempSync(join(tmpdir(), 'looper-worker-')), 'terminal-worker.js');
    const esbuild = await import('esbuild');
    esbuild.buildSync({ entryPoints: [join(process.cwd(), 'src/engine/terminal-worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: file });
    process.env.LOOPER_TERMINAL_WORKER = file;
  }, 60_000);
  afterAll(() => {
    delete process.env.LOOPER_TERMINAL_WORKER;
  });
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('runs a command in the chat’s working directory in a terminal, with its output and exit code, without a turn of the agent', async () => {
    const s = await setUp();
    engine = s.engine;
    const out = await s.engine.runChatCommand(s.chatId, 'pwd; echo oops >&2; exit 3', 'run-1');
    // A terminal shows stdout and stderr together, as they came.
    expect(out).toMatchObject({ id: 'run-1', input: 'pwd; echo oops >&2; exit 3', stdout: `${s.dir}\noops\n`, stderr: '', exitCode: 3 });
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
    const live = new Map<string, string>();
    s.engine.on((e) => {
      if (e.type === 'chat:command' && e.chatId === s.chatId) live.set(e.id, (live.get(e.id) ?? '') + e.data);
    });
    const began = join(s.dir, 'began');
    const one = s.engine.runChatCommand(s.chatId, `echo first; touch '${began}'; sleep 30`, 'run-1');
    const two = s.engine.runChatCommand(s.chatId, 'sleep 2; echo second', 'run-2');
    await until(() => existsSync(began) && !!live.get('run-1')?.includes('first\r\n'), 'the first command’s output, live');
    // A window that opens it now gets the same terminal output.
    expect(s.engine.commandScreen(s.chatId, 'run-1')).toContain('first\r\n');
    await s.engine.stopChatCommand(s.chatId, 'run-1');
    await expect(one).resolves.toMatchObject({ stopped: true, stdout: 'first\n' });
    const second = await two;
    expect(second).toMatchObject({ exitCode: 0, stdout: 'second\n' });
    expect(second.stopped).toBeUndefined();
    // A command's name is the window's, and two can't share one.
    await expect(s.engine.runChatCommand(s.chatId, 'true', '../x')).rejects.toThrow('no usable id');
    expect(s.engine.commandScreen(s.chatId, 'run-1')).toBeNull();
  });

  it('takes what the user types: a hidden password, an answer read from the terminal as sudo and ssh read theirs, and the size it shows at', async () => {
    const s = await setUp();
    engine = s.engine;
    const screen = () => s.engine.commandScreen(s.chatId, 'run-1') ?? '';
    const running = s.engine.runChatCommand(
      s.chatId,
      `read -s -p 'Password: ' pw; echo; echo "got $pw"; read -p 'Go on? ' yn < /dev/tty; echo "answer $yn"; read -s; stty size`,
      'run-1',
    );
    await until(() => screen().includes('Password: '), 'the password prompt');
    s.engine.writeCommand(s.chatId, 'run-1', 'secret\r');
    await until(() => screen().includes('Go on? '), 'the question');
    s.engine.writeCommand(s.chatId, 'run-1', 'yes\r');
    await until(() => screen().includes('answer yes'), 'the answer');
    s.engine.resizeCommand(s.chatId, 'run-1', 50, 7);
    s.engine.writeCommand(s.chatId, 'run-1', '\r');
    const out = await running;
    // The password wasn't shown as it was typed; the answer was.
    expect(out).toMatchObject({ stdout: 'Password:\ngot secret\nGo on? yes\nanswer yes\n7 50\n', exitCode: 0 });
  });

  it('saves output too long to send to a file in the chat’s folder, and the agent gets its preview and the file’s path', async () => {
    const s = await setUp();
    engine = s.engine;
    const out = await s.engine.runChatCommand(s.chatId, 'seq 1 20000; echo short >&2', 'run-1');
    const full = Array.from({ length: 20000 }, (_, i) => `${i + 1}\n`).join('') + 'short\n';
    expect(out.saved?.stdout?.bytes).toBe(Buffer.byteLength(full));
    expect(out.saved?.stderr).toBeUndefined();
    expect(out.stderr).toBe('');
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
    expect(received).toContain('\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>\n\nlook\n');
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
        '<bash-input>echo bad >&2; exit 2</bash-input>\n<bash-stdout>bad</bash-stdout><bash-stderr>Exit code 2</bash-stderr>\n\n' +
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

  /** A chat on harness `own`, with `other` of the same kind (each with its own config folder) and a Codex harness beside it. */
  async function twoHarnesses(): Promise<{ e: Engine; dataDir: string; ownDir: string; otherDir: string; ownConfig: string; otherConfig: string; chatId: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const ownDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const ownConfig = mkdtempSync(join(tmpdir(), 'looper-claude-'));
    const otherConfig = mkdtempSync(join(tmpdir(), 'looper-claude-'));
    const e = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) });
    engine = e;
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local'
          ? {
              ...env,
              shell: 'bash -c',
              harnesses: [
                { id: 'own', name: 'Own', kind: 'claude-code' as const, command: fakeClaude(ownDir), env: { CLAUDE_CONFIG_DIR: ownConfig } },
                { id: 'other', name: 'Other', kind: 'claude-code' as const, command: fakeClaude(otherDir), env: { CLAUDE_CONFIG_DIR: otherConfig } },
                { id: 'codex', name: 'Codex', kind: 'codex' as const, command: 'codex' },
              ],
            }
          : env,
      ),
    });
    e.saveTask(
      TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: ownDir, agent: { harnessId: 'own', mode: 'headless', prompt: 'x' } }),
    );
    const chatId = e.startChat('t1').id;
    return { e, dataDir, ownDir, otherDir, ownConfig, otherConfig, chatId };
  }

  /** The first message's turn on the fake in `dir`, to its end. */
  async function firstTurn(e: Engine, chatId: string, dir: string): Promise<void> {
    e.sendChat(chatId, 'hello', []);
    touch(dir, 'call-1');
    touch(dir, 'release-1');
    await until(() => e.getChat(chatId)?.status === 'ready' && lines(join(dir, 'turns')).length === 1, 'the turn to end');
  }

  it('moves to any harness until the first message, then only to one of its kind, and opens again on it', async () => {
    const { e, dataDir, ownDir, otherDir, chatId } = await twoHarnesses();
    expect(e.getChat(chatId)).toMatchObject({
      harnessId: 'own',
      harnessLocked: false,
      harnesses: [
        { id: 'own', kind: 'claude-code' },
        { id: 'other', kind: 'claude-code' },
        { id: 'codex', kind: 'codex' },
      ],
    });

    await e.setChatHarness(chatId, 'other');
    await until(() => e.getChat(chatId)?.harnessId === 'other' && e.getChat(chatId)?.status === 'ready', 'the chat on the other harness');
    await firstTurn(e, chatId, otherDir);
    expect(lines(join(otherDir, 'received'))).toEqual(['hello']);
    expect(lines(join(ownDir, 'received'))).toEqual([]);

    expect(e.getChat(chatId)?.harnessLocked).toBe(true);
    await expect(e.setChatHarness(chatId, 'codex')).rejects.toThrow('goes on only with a Claude Code harness');
    const runDir = join(dataDir, 'tasks', 't1', 'runs', chatId);
    expect(JSON.parse(readFileSync(join(runDir, 'chat.json'), 'utf8'))).toMatchObject({ harnessId: 'other', harnessKind: 'claude-code' });

    // The fake doesn't run hooks: the session record stands in for its SessionStart hook.
    writeFileSync(join(runDir, 'session.json'), JSON.stringify({ session_id: 's1' }));
    await e.closeChat(chatId);
    // A terminal and a run of the task would use the task's harness: only a chat goes on with it, or a compacted one.
    expect(await e.canContinueRun('t1', chatId)).toEqual({ chat: true, terminal: false, guidance: false, compact: true, start: false });
    expect(() => e.startTerminalSession('t1', chatId)).toThrow('only Continue in Chat');
    expect(e.startChat('t1', chatId)).toMatchObject({ id: chatId, harnessId: 'other', harnessLocked: true });
  });

  it('goes on with the conversation on another harness of its kind, from the next message, with its transcript copied to that harness’s folder', async () => {
    const { e, dataDir, ownDir, otherDir, ownConfig, otherConfig, chatId } = await twoHarnesses();
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    await firstTurn(e, chatId, ownDir);
    // Claude Code's transcript of session s1 (the fake writes none), and a subagent's beside it.
    mkdirSync(join(ownConfig, 'projects', '-w', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(ownConfig, 'projects', '-w', 's1.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(ownConfig, 'projects', '-w', 's1', 'subagents', 'agent-a.jsonl'), '{"type":"user"}\n');

    await e.setChatHarness(chatId, 'other');
    expect(e.getChat(chatId)).toMatchObject({ harnessId: 'other', harnessLocked: true, status: 'ready' });
    expect(readFileSync(join(otherConfig, 'projects', '-w', 's1.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(existsSync(join(otherConfig, 'projects', '-w', 's1', 'subagents', 'agent-a.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, 'tasks', 't1', 'runs', chatId, 'chat.json'), 'utf8'))).toMatchObject({ harnessId: 'other' });
    // Nothing starts until the next message, which resumes the conversation there.
    expect(lines(join(otherDir, 'argv'))).toEqual([]);
    e.sendChat(chatId, 'second', []);
    touch(otherDir, 'call-1');
    touch(otherDir, 'release-1');
    await until(() => lines(join(otherDir, 'turns')).length === 1, 'the turn on the other harness');
    expect(lines(join(otherDir, 'received'))).toEqual(['second']);
    expect(lines(join(otherDir, 'argv'))[0]).toContain('--resume s1');
    expect(lines(join(ownDir, 'received'))).toEqual(['hello']);
  });

  it('moves once the turn ends while the agent works, and the message sent meanwhile goes to the new harness', async () => {
    const { e, ownDir, otherDir, chatId } = await twoHarnesses();
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    await firstTurn(e, chatId, ownDir);
    e.sendChat(chatId, 'long', []);
    touch(ownDir, 'call-2');
    await until(() => e.getChat(chatId)?.rows.filter((r) => r.kind === 'tool').length === 2, 'the tool call');
    await e.setChatHarness(chatId, 'other');
    // It shows the harness it moves to; the agent's turn goes on.
    expect(e.getChat(chatId)).toMatchObject({ harnessId: 'other', harnessName: 'Other', status: 'working' });
    e.sendChat(chatId, 'after', []);
    touch(ownDir, 'release-2');
    await until(() => lines(join(otherDir, 'received')).length === 1, 'the message on the other harness');
    expect(lines(join(otherDir, 'received'))).toEqual(['after']);
    expect(lines(join(otherDir, 'argv'))[0]).toContain('--resume s1');
    // The old agent never read it.
    expect(lines(join(ownDir, 'turns'))).toEqual(['turn 1: hello | read mid-turn: ', 'turn 2: long | read mid-turn: ']);
  });

  it('gives a message sent while the transcript copy fails to the chat\'s own harness', async () => {
    const { e, ownDir, otherDir, ownConfig, chatId } = await twoHarnesses();
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    await firstTurn(e, chatId, ownDir);
    mkdirSync(join(ownConfig, 'projects', '-w'), { recursive: true });
    writeFileSync(join(ownConfig, 'projects', '-w', 's1.jsonl'), '{"type":"user"}\n');
    // The other harness's folder is under a regular file, so the copy fails.
    const blocker = join(ownDir, 'blocker');
    writeFileSync(blocker, 'x');
    e.updateSettings({ environments: e.settings.environments.map((env) => env.id === 'local' ? { ...env, harnesses: env.harnesses.map((h) => h.id === 'other' ? { ...h, env: { CLAUDE_CONFIG_DIR: join(blocker, 'cfg') } } : h) } : env) });
    const moving = e.setChatHarness(chatId, 'other');
    expect(e.sendChat(chatId, 'during', [])).toBe(true);
    await expect(moving).rejects.toThrow(/ENOTDIR/);
    await until(() => lines(join(ownDir, 'received')).length === 2, 'the message on its own harness');
    expect(lines(join(ownDir, 'received'))).toEqual(['hello', 'during']);
    expect(lines(join(otherDir, 'received'))).toEqual([]);
    expect(e.getChat(chatId)?.harnessId).toBe('own');
  });

  it('keeps a message sent while the chat moves to another harness, and gives it to the new one', async () => {
    const { e, ownDir, otherDir, chatId } = await twoHarnesses();
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    const moving = e.setChatHarness(chatId, 'other');
    expect(e.sendChat(chatId, 'during', [])).toBe(true);
    await moving;
    await until(() => lines(join(otherDir, 'received')).length === 1, 'the message on the other harness');
    expect(lines(join(otherDir, 'received'))).toEqual(['during']);
    expect(lines(join(ownDir, 'received'))).toEqual([]);
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

describe('Continue in Terminal on an open chat', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('goes on once the harness has recorded the conversation, and the closed chat continues as a run does', async () => {
    const s = await setUp();
    engine = s.engine;
    const e = s.engine;
    expect(e.chatTerminalBlocker(s.chatId)).toBe('No conversation was recorded for this run.');
    e.sendChat(s.chatId, 'hello', []);
    touch(s.dir, 'call-1');
    touch(s.dir, 'release-1');
    await until(() => e.getChat(s.chatId)?.status === 'ready' && lines(join(s.dir, 'turns')).length === 1, 'the turn to end');
    // The fake doesn't run hooks: the session record stands in for its SessionStart hook.
    writeFileSync(join(s.dataDir, 'tasks', 't1', 'runs', s.chatId, 'session.json'), JSON.stringify({ session_id: 's1' }));
    expect(e.chatTerminalBlocker(s.chatId)).toBeNull();
    await e.closeSession(s.chatId);
    expect(await e.canContinueRun('t1', s.chatId)).toMatchObject({ terminal: true });
    expect(e.chatTerminalBlocker(s.chatId)).toBe('This chat is no longer open.');
  });

  it("says why when the chat runs on another harness than the task's", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const ownDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) });
    engine.start();
    engine.updateSettings({
      environments: engine.settings.environments.map((env) =>
        env.id === 'local'
          ? {
              ...env, shell: 'bash -c',
              harnesses: [
                { id: 'own', name: 'Own', kind: 'claude-code' as const, command: fakeClaude(ownDir) },
                { id: 'other', name: 'Other', kind: 'claude-code' as const, command: fakeClaude(otherDir) },
              ],
            }
          : env,
      ),
    });
    engine.saveTask(
      TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: ownDir, agent: { harnessId: 'own', mode: 'headless', prompt: 'x' } }),
    );
    const e = engine;
    const chatId = e.startChat('t1').id;
    await e.setChatHarness(chatId, 'other');
    await until(() => e.getChat(chatId)?.harnessId === 'other' && e.getChat(chatId)?.status === 'ready', 'the chat on the other harness');
    e.sendChat(chatId, 'hello', []);
    touch(otherDir, 'call-1');
    touch(otherDir, 'release-1');
    await until(() => e.getChat(chatId)?.status === 'ready' && lines(join(otherDir, 'turns')).length === 1, 'the turn to end');
    writeFileSync(join(dataDir, 'tasks', 't1', 'runs', chatId, 'session.json'), JSON.stringify({ session_id: 's1' }));
    expect(e.chatTerminalBlocker(chatId)).toBe('This chat runs on Other, and a terminal opens on Own, the harness of T1.');
  });
});
