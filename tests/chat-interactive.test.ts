import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 800; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A stand-in for interactive Claude Code with Looper's mod: it prints to its
 * terminal, writes what the SessionStart hook and the mod would (session.json,
 * mod.json), and once the test writes `go`, takes the chat's message out of
 * the mod's inbox, as the mod does, and runs a turn on it: the message and a
 * reply in the transcript, with the mod's turn records and usage around them.
 */
function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const run = process.env.LOOPER_RUN_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'argv'), JSON.stringify(args) + '\\n');
if (args.includes('-p')) {
  // As Claude Code 2.1.327 refuses to resume a Code Mode session headless.
  process.stderr.write('Failed to resume session: This session was started in Code Mode (experimental), which isn\\'t available because for now it only works in the interactive terminal, so it can\\'t be resumed here.\\n');
  setTimeout(() => process.exit(1), 300);
} else {
const id = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
const transcript = path.join(dir, id + '.jsonl');
process.stdout.write('fake claude is ready\\r\\n');
if (args.includes('--remote-control')) {
  // Claude Code prints its claude.ai address once Remote Control connects, styled, and here split across two writes.
  const link = 'https://claude.ai/code/session_' + process.pid;
  setTimeout(() => process.stdout.write('Remote Control: \\x1b[4m' + link.slice(0, 30)), 150);
  setTimeout(() => process.stdout.write(link.slice(30) + '\\x1b[24m\\r\\n'), 250);
}
fs.writeFileSync(path.join(run, 'mod.json'), '{}');
fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ session_id: id, transcript_path: transcript }));
let n = 0;
// With slow-transcript, a row goes at once where the mod hands it over, and to the transcript later, as Claude Code writes it.
const slow = fs.existsSync(path.join(dir, 'slow-transcript'));
const rec = (o) => {
  const line = JSON.stringify({ ...o, uuid: 'u' + ++n, timestamp: new Date().toISOString() });
  if (!slow) return fs.appendFileSync(transcript, line + '\\n');
  if (o.type === 'user' || o.type === 'assistant') {
    fs.mkdirSync(path.join(run, 'live'), { recursive: true });
    fs.writeFileSync(path.join(run, 'live', '1-' + String(n).padStart(9, '0') + '.json'), line);
  }
  setTimeout(() => fs.appendFileSync(transcript, line + '\\n'), 1500);
};
setInterval(() => {
  const inbox = path.join(run, 'message.json');
  if (!fs.existsSync(path.join(dir, 'go')) || !fs.existsSync(inbox)) return;
  const taken = inbox.replace(/\\.json$/, '-' + Date.now() + '-mod.json');
  try { fs.renameSync(inbox, taken); } catch { return; }
  const text = JSON.parse(fs.readFileSync(taken, 'utf8'));
  fs.writeFileSync(path.join(run, 'turn.json'), '{}');
  rec({ type: 'repl-mode', replMode: true });
  rec({ type: 'user', message: { role: 'user', content: text } });
  setTimeout(() => {
    rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'echo: ' + text }] } });
    fs.writeFileSync(path.join(run, 'usage.json'), JSON.stringify({ context: { tokens: 1234, window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2030-01-01T00:00:00.000Z' }] }));
    fs.writeFileSync(path.join(run, 'turn-end.json'), '{}');
  }, 400);
}, 100);
}
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

const lines = (file: string): string[][] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

describe('an interactive chat on Claude Code', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('runs Claude Code in a terminal, hands its messages to the mod, and shows the conversation from the transcript', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env,shell: 'bash -c',  harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    // The task's session type, which its chats follow.
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    const chatId = e.startChat('t1').id;
    expect(e.getChat(chatId)?.settings.mode).toBe('interactive');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the session to start');

    const argv = lines(join(dir, 'argv'))[0];
    expect(argv).toContain('--plugin-dir');
    expect(argv).toContain('--session-id');
    expect(argv).not.toContain('-p');
    expect(argv.slice(argv.indexOf('--disallowedTools'), argv.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', 'AskUserQuestion']);
    expect(e.terminalSessionOutput(chatId)?.data).toContain('fake claude is ready');
    // Nothing said yet: the chat can still move to another harness.
    expect(e.getChat(chatId)?.harnessLocked).toBe(false);

    // The message waits in the mod's inbox, and Cancel takes it back before the mod has it.
    e.sendChat(chatId, 'first thought', []);
    const runDir = e.runDir('t1', chatId);
    await until(() => existsSync(join(runDir, 'message.json')), 'the message in the inbox');
    const first = e.getChat(chatId)!.queued[0];
    expect(e.unqueueChat(chatId, first.id)?.text).toBe('first thought');
    expect(existsSync(join(runDir, 'message.json'))).toBe(false);

    e.sendChat(chatId, 'hello there', []);
    await until(() => existsSync(join(runDir, 'message.json')), 'the message in the inbox');
    expect(JSON.parse(readFileSync(join(runDir, 'message.json'), 'utf8'))).toBe('hello there');
    writeFileSync(join(dir, 'go'), '');
    await until(() => !!e.getChat(chatId)?.rows.some((r) => r.kind === 'agent' && r.text === 'echo: hello there'), 'the reply');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the turn to end');
    // The chat reads the mod's usage record after the turn's end, in the same pass.
    await until(() => !!e.getChat(chatId)?.context, "the session's usage");

    const chat = e.getChat(chatId)!;
    expect(chat.rows.filter((r) => r.kind === 'prompt').map((r) => r.text)).toEqual(['hello there']);
    expect(chat.queued).toEqual([]);
    expect(chat.title).toBeUndefined();
    expect(chat.harnessLocked).toBe(true);
    expect(chat.context).toEqual({ tokens: 1234, window: 200000 });
    expect(chat.activeModel).toBe('claude-fake');
    expect(e.sessionsState().limits['local/fake']?.fiveHour?.used).toBe(0.5);
    const info = JSON.parse(readFileSync(join(runDir, 'chat.json'), 'utf8'));
    expect(info).toMatchObject({ title: 'hello there', settings: { mode: 'interactive' }, codeMode: true });
    expect(e.sessionsState().sessions.find((s) => s.id === chatId)?.title).toBe('hello there');
    // Claude Code goes on with a Code Mode conversation only in a terminal.
    expect(chat.codeMode).toBe(true);
    await expect(e.configureChat(chatId, { mode: 'headless' })).rejects.toThrow(/Code Mode/);
    expect(e.getChat(chatId)?.settings.mode).toBe('interactive');
  });

  it('shows the rows the mod hands over before the transcript has them, and each row once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env,shell: 'bash -c',  harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    writeFileSync(join(dir, 'slow-transcript'), '');
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the session to start');
    e.sendChat(chatId, 'hello there', []);
    await until(() => existsSync(join(e.runDir('t1', chatId), 'message.json')), 'the message in the inbox');
    writeFileSync(join(dir, 'go'), '');
    await until(() => !!e.getChat(chatId)?.rows.some((r) => r.kind === 'agent' && r.text === 'echo: hello there'), 'the reply');
    const transcript = () => {
      const id = JSON.parse(readFileSync(join(e.runDir('t1', chatId), 'session.json'), 'utf8')).session_id;
      return existsSync(join(dir, id + '.jsonl')) ? readFileSync(join(dir, id + '.jsonl'), 'utf8') : '';
    };
    expect(transcript()).not.toContain('echo: hello there');
    await until(() => transcript().includes('echo: hello there'), 'the transcript to have the reply');
    // A read or two of the transcript after it caught up.
    await new Promise((r) => setTimeout(r, 1000));
    const rows = e.getChat(chatId)!.rows;
    expect(rows.filter((r) => r.kind === 'prompt' || r.kind === 'agent').map((r) => r.text)).toEqual(['hello there', 'echo: hello there']);
    expect(e.getChat(chatId)?.activeModel).toBe('claude-fake');
  });

  it('goes back to its terminal when Claude Code refuses to go on with a Code Mode conversation headless, sending what it refused', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env,shell: 'bash -c',  harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    writeFileSync(join(dir, 'go'), '');
    const chatId = e.startChat('t1').id;
    e.sendChat(chatId, 'go on', []);
    await until(() => !!e.getChat(chatId)?.rows.some((r) => r.kind === 'agent' && r.text === 'echo: go on'), 'the reply in the terminal');
    const chat = e.getChat(chatId)!;
    expect(chat.settings.mode).toBe('interactive');
    expect(chat.status).not.toBe('ended');
    // The refused message shows once, where the terminal session took it in.
    expect(chat.rows.filter((r) => r.kind === 'prompt').map((r) => r.text)).toEqual(['go on']);
    expect(chat.rows.some((r) => r.note && r.text.includes('only in a terminal'))).toBe(true);
  });

  it('starts with Remote Control on a harness that starts conversations with it, and starts again without it once Remote Control is off', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local'
          ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), options: { remoteControl: true } }] }
          : env,
      ),
      remote: { ...e.settings.remote, enabled: true },
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'My task', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the session to start');
    const argv = lines(join(dir, 'argv'))[0];
    expect(argv.slice(argv.indexOf('--remote-control'), argv.indexOf('--remote-control') + 2)).toEqual(['--remote-control', 'My task']);

    // Listed with Remote Control's conversations under the address its terminal printed.
    const listed = () => e.remoteState().conversations.find((c) => c.id === chatId);
    await until(() => !!listed()?.link, 'the chat listed with its link');
    expect(listed()).toMatchObject({ source: 'chat', name: 'My task', link: expect.stringMatching(/^https:\/\/claude\.ai\/code\/session_\d+$/) });
    // Each message and finished turn are recorded for that list, as a headless chat's are.
    const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain('prompt.json');
    expect(JSON.stringify(settings.hooks.Stop)).toContain('stop.json');

    // Claude Code can't drop Remote Control while it runs: it starts again on the conversation without it.
    e.updateSettings({ remote: { ...e.settings.remote, enabled: false } });
    await until(() => lines(join(dir, 'argv')).length === 2 && e.getChat(chatId)?.status === 'ready', 'the session to start again');
    expect(lines(join(dir, 'argv'))[1]).not.toContain('--remote-control');
    expect(listed()).toBeUndefined();
  });

  it('runs headless when the task is headless', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { mode: 'headless', prompt: 'x' } }));
    const chat = e.startChat('t1');
    expect(chat.settings.mode).toBe('headless');
    await e.closeChat(chat.id);
  });
});
