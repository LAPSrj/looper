import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A stand-in for `claude -p --input-format stream-json`: its first turn is
 * refused for the usage limit (a rejected rate_limit_event, the error row and
 * an error result, as Claude Code reports it), the next ones answer. It
 * records each message and each control request it gets.
 */
function fakeClaude(dir: string, resetsAt: number): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir = ${JSON.stringify(dir)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    fs.appendFileSync(path.join(dir, 'requests'), JSON.stringify(m.request) + '\\n');
    if (m.request.subtype === 'generate_session_title') {
      // As Claude Code 2.1.318 answers it: the handler's { title } in the response; the fake fails on a description of "fail".
      if (m.request.description === 'fail') out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'no title' } });
      else out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { title: 'Named by Claude' } } });
      return;
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    if (m.request.subtype === 'rename_session') out({ type: 'system', subtype: 'session_title_changed', title: m.request.title });
    return;
  }
  if (m.type !== 'user') return;
  fs.appendFileSync(path.join(dir, 'received'), m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('') + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  if (++turns === 1 && ${resetsAt} > 0) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: ${resetsAt} } });
    out({ type: 'assistant', parent_tool_use_id: null, is_api_error_message: true, message: { content: [{ type: 'text', text: "You've hit your session limit · resets 5:50am" }] } });
    out({ type: 'result', subtype: 'success', is_error: true });
  } else {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done' }] } });
    out({ type: 'result', subtype: 'success', result: 'done' });
  }
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

async function setUp(resetsAt: number): Promise<{ engine: Engine; dir: string; dataDir: string; chatId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
  const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
  const engine = createEngine({ dataDir });
  engine.start();
  engine.updateSettings({
    environments: engine.settings.environments.map((e) =>
      e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir, resetsAt) }] } : e,
    ),
  });
  engine.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x' } }));
  const chatId = engine.startChat('t1').id;
  await until(() => engine.getChat(chatId)?.status === 'ready', 'the chat to start');
  return { engine, dir, dataDir, chatId };
}

describe("a chat's name from Claude Code", { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('asks Claude Code to name the chat after its first turn, and keeps the name in the transcript', async () => {
    const s = await setUp(0);
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'Fix the footer', []);
    await until(() => s.engine.getChat(s.chatId)?.title === 'Named by Claude', 'the name');
    const asks = lines(join(s.dir, 'requests')).filter((l) => l.includes('generate_session_title'));
    expect(asks.map((l) => JSON.parse(l))).toEqual([{ subtype: 'generate_session_title', description: 'Fix the footer', persist: true }]);
    await until(() => s.engine.sessionsState().sessions[0]?.title === 'Named by Claude', 'the list to show the name');
    // Asked once: a second turn doesn't ask again.
    s.engine.sendChat(s.chatId, 'and the header', []);
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the second message');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    expect(lines(join(s.dir, 'requests')).filter((l) => l.includes('generate_session_title'))).toHaveLength(1);
  });

  it('keeps the first message’s title when Claude Code can’t name it', async () => {
    const s = await setUp(0);
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'fail', []);
    await until(() => lines(join(s.dir, 'requests')).some((l) => l.includes('generate_session_title')), 'the request');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    await new Promise((r) => setTimeout(r, 300));
    expect(s.engine.getChat(s.chatId)?.title).toBeUndefined();
    await until(() => s.engine.sessionsState().sessions[0]?.title === 'fail', 'the first message’s title');
  });
});

describe('a chat out of its usage limit', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    await engine?.stop();
    engine = null;
  });

  it('records the limit, and with Continue When Limit Resets sends "Continue." just after the reset', async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const s = await setUp(resetsAt);
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'go', []);
    await until(() => !!s.engine.getChat(s.chatId)?.limit, 'the limit');
    expect(s.engine.getChat(s.chatId)?.limit?.resetsAt).toBe(resetsAt * 1000);
    await until(() => !!s.engine.sessionsState().sessions[0]?.limit, 'the list to show the limit');
    expect(s.engine.sessionsState().sessions[0].limit).toEqual({ resetsAt: resetsAt * 1000 });

    // A fake clock from here: the continue waits for the reset plus the margin.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
    s.engine.setChatAutoContinue(s.chatId, true);
    vi.advanceTimersByTime(60_000);
    expect(lines(join(s.dir, 'received'))).toEqual(['go']);
    vi.advanceTimersByTime(125_000);
    vi.useRealTimers();
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the continue message');
    expect(lines(join(s.dir, 'received'))).toEqual(['go', 'Continue.']);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    const chat = s.engine.getChat(s.chatId)!;
    expect(chat.limit).toBeUndefined();
    expect(chat.rows.filter((r) => r.kind === 'prompt').map((r) => r.text)).toEqual(['go', 'Continue.']);
    const info = JSON.parse(readFileSync(join(s.dataDir, 'tasks', 't1', 'runs', s.chatId, 'chat.json'), 'utf8'));
    expect(info.autoContinue).toBe(true);
  });

  it('with the cache rule, leaves a chat whose cache has expired waiting, until Continue Anyway', async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const s = await setUp(resetsAt);
    engine = s.engine;
    s.engine.updateSettings({ chats: { ...s.engine.settings.chats, skipExpiredContinue: { enabled: true, aboveTokens: 0 } } });
    s.engine.sendChat(s.chatId, 'go', []);
    await until(() => !!s.engine.getChat(s.chatId)?.limit, 'the limit');
    // A transcript whose last reply's five-minute cache is long gone.
    const transcript = join(s.dir, 'transcript.jsonl');
    const usage = { input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 10 } };
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { usage } })}\n`);
    writeFileSync(join(s.dataDir, 'tasks', 't1', 'runs', s.chatId, 'session.json'), JSON.stringify({ transcript_path: transcript }));
    await until(() => s.engine.sessionsState().sessions[0]?.cacheUntil !== undefined, 'the cache time');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
    s.engine.setChatAutoContinue(s.chatId, true);
    vi.advanceTimersByTime(185_000);
    expect(lines(join(s.dir, 'received'))).toEqual(['go']);
    expect(s.engine.getChat(s.chatId)?.limit).toBeDefined();

    s.engine.setChatContinueAnyway(s.chatId);
    expect(s.engine.getChat(s.chatId)?.continueAnyway).toBe(true);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the continue message');
    expect(lines(join(s.dir, 'received'))).toEqual(['go', 'Continue.']);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    expect(s.engine.getChat(s.chatId)?.limit).toBeUndefined();
    expect(s.engine.getChat(s.chatId)?.continueAnyway).toBeUndefined();
  });

  it("drops the pending continue when the user writes first, and renames the session in Claude Code", async () => {
    const s = await setUp(Math.ceil(Date.now() / 1000) + 120);
    engine = s.engine;
    s.engine.sendChat(s.chatId, 'go', []);
    await until(() => !!s.engine.getChat(s.chatId)?.limit, 'the limit');
    s.engine.setChatAutoContinue(s.chatId, true);
    s.engine.sendChat(s.chatId, 'mine', []);
    await until(() => lines(join(s.dir, 'received')).length === 2, 'the user message');
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the turn to end');
    expect(s.engine.getChat(s.chatId)?.limit).toBeUndefined();

    await s.engine.renameSession(s.chatId, 'Footer work');
    await until(() => lines(join(s.dir, 'requests')).some((l) => l.includes('rename_session')), 'the rename request');
    expect(JSON.parse(lines(join(s.dir, 'requests')).find((l) => l.includes('rename_session'))!)).toMatchObject({ title: 'Footer work', source: 'host' });
    await until(() => s.engine.sessionsState().sessions[0]?.title === 'Footer work', 'the list to show the name');
    // A harness name never replaces the user's, and an empty name goes back to the first message's.
    await s.engine.renameSession(s.chatId, '');
    await until(() => s.engine.sessionsState().sessions[0]?.title === 'go', 'the automatic title');
  });
});
