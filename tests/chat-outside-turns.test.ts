import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for ' + what);
};

const PEER_TEXT =
  'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks-1000/41.sock" from-name="sender-eb" from-mode="prompting">\nPlease reply with only the word PING.\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.';

/**
 * A stand-in for `claude -p --input-format stream-json --replay-user-messages` that starts turns by itself, with the
 * records Claude Code 2.1.330 printed for each (captured live, haiku): an idle process prints only its SessionStart hook's
 * records; another session's message comes inside a command_lifecycle, with a fresh init and a synthetic replay of the
 * message; a background command's end prints task_notification, then an init and the turn. Each turn's reply waits for
 * the test's `go` file, so the test sees the chat while the turn runs.
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
const at = (name) => path.join(dir, name);
const init = () => out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
out({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' });
out({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart' });
let n = 0;
// The reply, once the test lets the turn go on.
const reply = (text, origin, after = () => {}) => {
  const go = 'go' + ++n;
  const wait = setInterval(() => {
    if (!fs.existsSync(at(go))) return;
    clearInterval(wait);
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', result: text, ...(origin ? { origin } : {}) });
    after();
  }, 20);
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type !== 'user') return;
  init();
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  reply('Hi.');
}).on('close', () => process.exit(0));
const watch = (name, run) => {
  const t = setInterval(() => {
    if (!fs.existsSync(at(name))) return;
    clearInterval(t);
    run();
  }, 20);
};
watch('peer', () => {
  const origin = { kind: 'peer', from: 'uds:/tmp/cc-socks-1000/41.sock', name: 'sender-eb', fromMode: 'prompting' };
  out({ type: 'command_lifecycle', command_uuid: 'c1', state: 'started' });
  init();
  out({ type: 'user', message: { role: 'user', content: ${JSON.stringify(PEER_TEXT)} }, parent_tool_use_id: null, isReplay: true, isSynthetic: true, origin });
  reply('PING', origin, () => out({ type: 'command_lifecycle', command_uuid: 'c1', state: 'completed' }));
});
watch('task-done', () => {
  out({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', output_file: '', summary: 'Background command "sleep 20" completed (exit code 0)' });
  init();
  reply('FINISHED', { kind: 'task-notification' });
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('a headless chat whose Claude Code starts a turn by itself', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  async function setUp(): Promise<{ e: Engine; dir: string; chatId: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-outside-'));
    const e = createEngine({ dataDir });
    engine = e;
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), options: {} }] } : env,
      ),
    });
    e.saveTask(
      TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }),
    );
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    return { e, dir, chatId };
  }

  const listed = (e: Engine, id: string) => e.sessionsState().sessions.find((s) => s.id === id);

  it("works on another session's message until its turn ends, and shows the message", async () => {
    const { e, dir, chatId } = await setUp();
    // The idle process's hook records start nothing.
    await new Promise((r) => setTimeout(r, 300));
    expect(e.getChat(chatId)?.status).toBe('ready');
    writeFileSync(join(dir, 'peer'), '');
    await until(() => e.getChat(chatId)?.status === 'working', 'the chat to work on the message');
    expect(listed(e, chatId)?.status).toBe('working');
    writeFileSync(join(dir, 'go1'), '');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the turn to end');
    expect(listed(e, chatId)).toMatchObject({ status: 'ready', waiting: { reason: 'turn' } });
    expect(e.getChat(chatId)?.rows.map((r) => [r.kind, r.text, r.from])).toEqual([
      ['peer', 'Please reply with only the word PING.', 'sender-eb'],
      ['agent', 'PING', undefined],
    ]);
  });

  it("works when a background task's end starts a turn, after one of Looper's own", async () => {
    const { e, dir, chatId } = await setUp();
    e.sendChat(chatId, 'Start it.', []);
    await until(() => e.getChat(chatId)?.status === 'working', 'the first turn');
    writeFileSync(join(dir, 'go1'), '');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the first turn to end');
    writeFileSync(join(dir, 'task-done'), '');
    await until(() => e.getChat(chatId)?.status === 'working', 'the chat to work on the notification');
    writeFileSync(join(dir, 'go2'), '');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the second turn to end');
    expect(e.getChat(chatId)?.rows.filter((r) => r.kind !== 'tool').map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'Start it.'],
      ['agent', 'Hi.'],
      ['agent', 'FINISHED'],
    ]);
  });
});

/**
 * A stand-in for interactive Claude Code with Looper's mod, for a turn it starts by itself: once the test writes
 * `peer`, the mod's turn record and the transcript's record of another session's message (isMeta, origin peer, as
 * Claude Code 2.1.330 wrote it), and once it writes `go`, the reply and the mod's turn end.
 */
function fakeInteractiveClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const run = process.env.LOOPER_RUN_DIR;
const args = process.argv.slice(2);
const id = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
const transcript = path.join(dir, id + '.jsonl');
let n = 0;
const rec = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, uuid: 'u' + ++n, timestamp: new Date().toISOString() }) + '\\n');
process.stdout.write('fake claude is ready\\r\\n');
fs.writeFileSync(path.join(run, 'mod.json'), '{}');
fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ session_id: id, transcript_path: transcript }));
// It runs until the chat ends it, as Claude Code does between turns.
setInterval(() => {}, 1000);
const wait = (name, then) => {
  const t = setInterval(() => {
    if (!fs.existsSync(path.join(dir, name))) return;
    clearInterval(t);
    then();
  }, 50);
};
wait('peer', () => {
  fs.writeFileSync(path.join(run, 'turn.json'), '{}');
  rec({ type: 'user', isMeta: true, origin: { kind: 'peer', name: 'sender-eb' }, message: { role: 'user', content: ${JSON.stringify(PEER_TEXT)} } });
  wait('go', () => {
    rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'PONG' }] } });
    fs.writeFileSync(path.join(run, 'turn-end.json'), '{}');
  });
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('an interactive chat whose Claude Code starts a turn by itself', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it("works from the mod's turn start to its end, and shows another session's message", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-outside-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeInteractiveClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the session to start');
    writeFileSync(join(dir, 'peer'), '');
    await until(() => e.getChat(chatId)?.status === 'working', 'the chat to work on the message');
    expect(e.sessionsState().sessions.find((s) => s.id === chatId)?.status).toBe('working');
    writeFileSync(join(dir, 'go'), '');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the turn to end');
    expect(e.sessionsState().sessions.find((s) => s.id === chatId)).toMatchObject({ status: 'ready', waiting: { reason: 'turn' } });
    await until(() => (e.getChat(chatId)?.rows.length ?? 0) >= 2, 'the conversation');
    expect(e.getChat(chatId)?.rows.map((r) => [r.kind, r.text, r.from])).toEqual([
      ['peer', 'Please reply with only the word PING.', 'sender-eb'],
      ['agent', 'PONG', undefined],
    ]);
  });
});
