import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine, type EngineOptions } from '../src/engine/engine';
import type { SessionProc } from '../src/engine/steps/session';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * A stand-in for `claude -p --input-format stream-json`: each start appends its
 * arguments to `spawns`; a message ends its turn at once, except "hang", whose
 * turn runs until the process is ended.
 */
function fakeClaude(dir: string): string {
  const js = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(dir, 'spawns'), process.argv.slice(2).join(' ') + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const text = (m) => m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  if (text(m) === 'hang') {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 99' } }] } });
    return;
  }
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done' }] } });
  out({ type: 'result', subtype: 'success', result: 'done' });
});
`,
  );
  const sh = path.join(dir, 'fake-claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

/** The terminal sessions' pty, driven by the test. */
function fakePtys() {
  const procs: { proc: SessionProc; print: (d: string) => void; written: string[]; state: { killed: boolean; size: number[] } }[] = [];
  const spawn: NonNullable<EngineOptions['spawnTerminal']> = () => {
    let out: (d: string) => void = () => {};
    const written: string[] = [];
    const state = { killed: false, size: [0, 0] };
    const proc: SessionProc = {
      pid: 0,
      spawned: Promise.resolve(0),
      onStdout: (cb) => (out = cb),
      onStderr: () => {},
      onExit: () => {},
      write: (d) => written.push(d),
      resize: (c, r) => (state.size = [c, r]),
      kill: () => (state.killed = true),
    };
    procs.push({ proc, print: (d) => out(d), written, state });
    return proc;
  };
  return { procs, spawn };
}

describe('conversations across a restart of Looper', { timeout: 30_000 }, () => {
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
  });

  const dataDir = () => tmp('looper-engine-');
  const open = (dir: string, opts: Partial<EngineOptions> = {}): Engine => {
    // The fake logs every start: the login check's `claude auth status` would be one.
    const e = createEngine({ dataDir: dir, authStatus: async () => Promise.reject(new Error('not asked in tests')), ...opts });
    engines.push(e);
    e.start();
    return e;
  };
  const stop = async (e: Engine) => {
    engines.splice(engines.indexOf(e), 1);
    await e.stop();
  };
  const setUp = (e: Engine, cwd: string, command: string) => {
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
  };

  it('keeps a chat with its settings, draft and history, and starts its agent only with the next message', async () => {
    const data = dataDir();
    const dir = tmp('looper-chat-');
    const spawns = path.join(dir, 'spawns');
    const e1 = open(data);
    setUp(e1, dir, fakeClaude(dir));
    const chatId = e1.startChat('t1').id;
    await until(() => e1.getChat(chatId)?.status === 'ready', 'the chat to start');
    e1.sendChat(chatId, 'hello', []);
    await until(() => e1.getChat(chatId)?.status === 'ready' && (e1.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'agent'), 'the turn');
    await e1.configureChat(chatId, { permissionMode: 'plan' });
    e1.setChatDraft(chatId, 'not sent yet', []);
    // The fake runs no hooks: its SessionStart payload and transcript, as Claude Code writes them.
    const runDir = path.join(data, 'tasks', 't1', 'runs', chatId);
    const transcript = path.join(dir, 's1.jsonl');
    fs.writeFileSync(
      transcript,
      [
        { type: 'user', uuid: 'u1', timestamp: '2026-10-30T10:00:00Z', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: '2026-10-30T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ session_id: 's1', transcript_path: transcript }));
    const startedAt = e1.getChat(chatId)!.startedAt;
    // Saved as it changed, before any quit.
    const savedList = (): number => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).conversations ?? []).length;
      } catch {
        return 0; // not written yet
      }
    };
    await until(() => savedList() === 1, 'the list in state.json');
    await stop(e1);
    expect(lines(spawns)).toHaveLength(1);

    const e2 = open(data);
    const chat = e2.getChat(chatId);
    expect(chat).toMatchObject({ id: chatId, harnessId: 'fake', status: 'ready', startedAt, settings: { permissionMode: 'plan' }, draft: { text: 'not sent yet', attachments: [] } });
    expect(e2.sessionsState().sessions.map((s) => [s.id, s.kind, s.status])).toEqual([[chatId, 'chat', 'ready']]);
    await until(() => (e2.getChat(chatId)?.history ?? []).some((r) => r.kind === 'prompt' && r.text === 'hello'), 'the history');
    await sleep(300);
    expect(lines(spawns)).toHaveLength(1);

    e2.sendChat(chatId, 'again', []);
    await until(() => lines(spawns).length === 2, 'the agent to start');
    // As the fake got them, unquoted by the launcher's shell.
    expect(lines(spawns)[1]).toContain('--resume s1');
    expect(lines(spawns)[1]).toContain('--permission-mode plan');
    await until(() => e2.getChat(chatId)?.status === 'ready', 'the turn');
  });

  it("shows a turn quitting cut short as stopped, and puts a queued message back in the message box", async () => {
    const data = dataDir();
    const dir = tmp('looper-chat-');
    const e1 = open(data);
    setUp(e1, dir, fakeClaude(dir));
    const chatId = e1.startChat('t1').id;
    await until(() => e1.getChat(chatId)?.status === 'ready', 'the chat to start');
    e1.sendChat(chatId, 'hang', []);
    await until(() => e1.getChat(chatId)?.status === 'working', 'the turn to start');
    e1.sendChat(chatId, 'later', []);
    e1.setChatDraft(chatId, 'typed', []);
    await stop(e1);

    const e2 = open(data);
    const chat = e2.getChat(chatId)!;
    expect(chat.status).toBe('ready');
    expect(chat.rows.map((r) => r.text)).toEqual(['Stopped.']);
    expect(chat.queued).toEqual([]);
    expect(chat.draft).toEqual({ text: 'later\n\ntyped', attachments: [] });
  });

  it('keeps a chat nothing was sent in, as it opened', async () => {
    const data = dataDir();
    const dir = tmp('looper-chat-');
    const e1 = open(data);
    setUp(e1, dir, fakeClaude(dir));
    const chatId = e1.startChat('t1').id;
    e1.setChatDraft(chatId, 'first words', []);
    await stop(e1);

    const e2 = open(data);
    expect(e2.getChat(chatId)).toMatchObject({ status: 'ready', harnessLocked: false, draft: { text: 'first words' } });
    expect(e2.sessionsState().sessions.map((s) => s.title)).toEqual(['New chat']);
  });

  it('Close Conversation removes a chat for good', async () => {
    const data = dataDir();
    const dir = tmp('looper-chat-');
    const e1 = open(data);
    setUp(e1, dir, fakeClaude(dir));
    const chatId = e1.startChat('t1').id;
    await until(() => e1.getChat(chatId)?.status === 'ready', 'the chat to start');
    await stop(e1);

    const e2 = open(data);
    expect(e2.getChat(chatId)).toBeDefined();
    await e2.closeSession(chatId);
    await stop(e2);

    const e3 = open(data);
    expect(e3.getChat(chatId)).toBeUndefined();
    expect(e3.sessionsState().sessions).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).conversations).toEqual([]);
    // A chat nobody wrote in leaves nothing behind.
    expect(fs.existsSync(path.join(data, 'tasks', 't1', 'runs', chatId))).toBe(false);
  });

  it('keeps a terminal session with its output, and resumes its conversation at the first key', async () => {
    const data = dataDir();
    const dir = tmp('looper-term-');
    const p1 = fakePtys();
    const e1 = open(data, { spawnTerminal: p1.spawn });
    setUp(e1, dir, 'claude');
    const id = e1.startTerminalSession('t1');
    expect(p1.procs).toHaveLength(1);
    p1.procs[0].print('hello from claude');
    // The launcher's hooks, as Claude Code's first turn writes them.
    const runDir = path.join(data, 'tasks', 't1', 'runs', id);
    fs.writeFileSync(path.join(runDir, 'session.json'), JSON.stringify({ session_id: 's1' }));
    fs.writeFileSync(path.join(runDir, 'stop.json'), JSON.stringify({ session_id: 's1' }));
    await until(() => fs.existsSync(path.join(runDir, 'terminal.json')), 'the first turn to make it a run');
    const startedAt = e1.sessionsState().sessions[0].startedAt;
    await stop(e1);
    expect(p1.procs[0].state.killed).toBe(true);

    const p2 = fakePtys();
    const e2 = open(data, { spawnTerminal: p2.spawn });
    expect(e2.sessionsState().sessions).toMatchObject([{ id, kind: 'terminal', status: 'ready', stopped: true, startedAt }]);
    expect(e2.terminalSessionOutput(id)).toEqual({ data: 'hello from claude', ended: false, stopped: true });
    expect(e2.runningTerminalSessions()).toBe(0);
    // Stop and Send to Chats don't start it.
    await e2.stopSession(id);
    e2.sendToSessions([id], 'hi');
    expect(p2.procs).toHaveLength(0);

    e2.resizeTerminalSession(id, 100, 30);
    e2.writeTerminalSession(id, 'x');
    expect(p2.procs).toHaveLength(1);
    expect(p2.procs[0].written).toEqual([]);
    expect(p2.procs[0].state.size).toEqual([100, 30]);
    expect(fs.readFileSync(path.join(runDir, 'terminal.sh'), 'utf8')).toContain("--resume 's1'");
    expect(e2.terminalSessionOutput(id)).toEqual({ data: 'hello from claude', ended: false });
    expect(e2.sessionsState().sessions).toMatchObject([{ id, startedAt, status: 'ready' }]);
    e2.writeTerminalSession(id, 'y');
    expect(p2.procs[0].written).toEqual(['y']);
  });

  it('Close Conversation removes a terminal session for good', async () => {
    const data = dataDir();
    const dir = tmp('looper-term-');
    const e1 = open(data, { spawnTerminal: fakePtys().spawn });
    setUp(e1, dir, 'claude');
    const id = e1.startTerminalSession('t1');
    await stop(e1);

    const p2 = fakePtys();
    const e2 = open(data, { spawnTerminal: p2.spawn });
    expect(e2.sessionsState().sessions.map((s) => s.id)).toEqual([id]);
    await e2.closeSession(id);
    await stop(e2);
    expect(p2.procs).toHaveLength(0);

    const e3 = open(data, { spawnTerminal: fakePtys().spawn });
    expect(e3.sessionsState().sessions).toEqual([]);
    // It never had a turn: nothing is left of it.
    expect(fs.existsSync(path.join(data, 'tasks', 't1', 'runs', id))).toBe(false);
  });

  it("runs an addon's command in a terminal session of the project, or of a folder, listed by its title and kept only while open", async () => {
    const data = dataDir();
    const dir = tmp('looper-cmd-');
    const p1 = fakePtys();
    const e1 = open(data, { spawnTerminal: p1.spawn });
    const project = e1.saveProject({ name: 'App', cwd: dir, environmentId: 'local', permissionMode: 'auto' });
    const id = e1.startCommandTerminal({ projectId: project.id }, ['git', 'push'], 'git push');
    expect(p1.procs).toHaveLength(1);
    const runDir = path.join(data, 'tasks', `@project-${project.id}`, 'runs', id);
    await until(() => e1.sessionsState().sessions.some((s) => s.id === id), 'the session to be listed');
    expect(e1.sessionsState().sessions.find((s) => s.id === id)).toMatchObject({ kind: 'terminal', title: 'git push', harnessName: 'Terminal', projectId: project.id });
    // A folder that is the project's runs as the project.
    const same = e1.startCommandTerminal({ environmentId: 'local', cwd: dir }, ['git', 'pull'], 'Pull');
    await until(() => e1.sessionsState().sessions.some((s) => s.id === same), 'the second session');
    expect(e1.sessionsState().sessions.find((s) => s.id === same)).toMatchObject({ title: 'Pull', projectId: project.id });
    expect(() => e1.startCommandTerminal({ environmentId: 'nope', cwd: dir }, ['x'], 'x')).toThrow('There\'s no environment "nope".');
    expect(fs.readdirSync(runDir)).toContain('command.sh');
    await e1.closeSession(id);
    expect(fs.existsSync(runDir)).toBe(false);
    await stop(e1);

    const e2 = open(data, { spawnTerminal: fakePtys().spawn });
    expect(e2.sessionsState().sessions).toEqual([]);
  });
});
