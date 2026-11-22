import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/engine/chat';
import { createEngine, type Engine } from '../src/engine/engine';
import { detectHost } from '../src/engine/host';
import { Logger } from '../src/engine/log';
import { loadSettings } from '../src/engine/store/settings';
import { decodeBytes as serverDecode } from '../src/main/platform/bytes';
import { encodeBytes } from '../src/renderer/src/web/session';
import { autoCompactPercent, contextPast, type ChatInfo, type ChatState } from '../src/shared/chat';
import { chatSettingEntries } from '../src/shared/chat-settings';
import type { LooperApi } from '../src/shared/api';
import { CONTEXT_FULL_RE, contextFullResend, contextFullRetry } from '../src/shared/compact';
import type { MessageRow } from '../src/shared/messages';
import { TaskSchema, type EngineEvent } from '../src/shared/types';
import { REPL_DATA_MARKER } from '../src/engine/repl-state';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// What the harnesses say when the context is full, as they said it in live runs (2026-11-21).
/** Claude Code 2.1.330 with CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=1000 and DISABLE_AUTO_COMPACT=1. */
const CLAUDE_FULL = 'Prompt is too long';
/** Codex 0.163.0 when the Responses stream fails with context_length_exceeded. */
const CODEX_FULL = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
/** Codex 0.163.0 when the Responses API answers HTTP 400 with context_length_exceeded. */
const CODEX_FULL_400 =
  '{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":"context_length_exceeded"}}';

describe('a turn that stopped on a full context', () => {
  it('is told by what Claude Code and Codex say', () => {
    for (const text of [CLAUDE_FULL, 'Prompt is too long · automatic compaction failed: it failed (no_summary)', `Error: ${CODEX_FULL}`, `Error: ${CODEX_FULL_400}`]) {
      expect(CONTEXT_FULL_RE.test(text), text).toBe(true);
    }
    for (const text of ["You've hit your session limit · resets 5:50am", 'API Error: 500 Internal server error', 'The prompt is too long to read in one go.']) {
      expect(CONTEXT_FULL_RE.test(text), text).toBe(false);
    }
  });

  const row = (kind: MessageRow['kind'], text: string, extra: Partial<MessageRow> = {}): MessageRow => ({ id: text, kind, text, preview: text, ...extra });

  it('leaves out the errors, and the messages that go again when nothing came after them', () => {
    const before = [row('prompt', 'hello'), row('agent', 'hi')];
    expect(contextFullRetry([...before, row('prompt', 'next'), row('error', CLAUDE_FULL)])).toEqual(before);
    // Codex: an error and a turn.failed line, then Looper's note on the exit code.
    const codex = [...before, row('prompt', 'next'), row('agent', `Error: ${CODEX_FULL}`), row('agent', `Error: ${CODEX_FULL}`), row('agent', 'Codex exited with code 1.', { note: true })];
    expect(contextFullRetry(codex)).toEqual(before);
    // The agent worked before the context filled up: the turn stays, its message goes again after it.
    const partial = [...before, row('prompt', 'next'), row('tool', 'ls'), row('agent', 'half way')];
    expect(contextFullRetry([...partial, row('error', CLAUDE_FULL)])).toEqual(partial);
  });

  it("sends again the turn's prompts when Looper didn't send them: typed in the terminal, or started by the agent", () => {
    const before = [row('prompt', 'hello'), row('agent', 'hi')];
    const rows = [...before, row('prompt', 'typed in the terminal'), row('error', CLAUDE_FULL)];
    const kept = contextFullRetry(rows)!;
    expect(contextFullResend(rows, kept, [])).toEqual([{ text: 'typed in the terminal', attachments: [] }]);
    // Looper sent it: it goes as it was sent, with its attachments.
    const sent = [{ text: 'typed in the terminal', attachments: [{ name: 'a.txt', path: '/a.txt', image: false }] }];
    expect(contextFullResend(rows, kept, sent)).toBe(sent);
    // The agent worked before the context filled up: nothing was cut, nothing goes again.
    const partial = [...before, row('prompt', 'next'), row('agent', 'half way'), row('error', CLAUDE_FULL)];
    expect(contextFullResend(partial, contextFullRetry(partial)!, [])).toEqual([]);
  });

  it('is only the latest turn, and only that error', () => {
    expect(contextFullRetry([row('prompt', 'a'), row('error', CLAUDE_FULL), row('prompt', 'b'), row('agent', 'fine')])).toBeNull();
    expect(contextFullRetry([row('prompt', 'a'), row('error', "You've hit your session limit · resets 5:50am")])).toBeNull();
    expect(contextFullRetry([])).toBeNull();
  });
});

describe('auto compact settings', () => {
  it('follows Settings → Chats unless the chat has its own', () => {
    expect(autoCompactPercent({}, { enabled: false, percent: 90 })).toBeUndefined();
    expect(autoCompactPercent({}, { enabled: true, percent: 80 })).toBe(80);
    expect(autoCompactPercent({ autoCompact: true }, { enabled: false, percent: 70 })).toBe(70);
    expect(autoCompactPercent({ autoCompact: false }, { enabled: true, percent: 70 })).toBeUndefined();
  });

  it('compares the context with its window, never an unknown one', () => {
    expect(contextPast({ tokens: 900, window: 1000 }, 90)).toBe(true);
    expect(contextPast({ tokens: 899, window: 1000 }, 90)).toBe(false);
    expect(contextPast({ tokens: 900_000 }, 1)).toBe(false);
    expect(contextPast(undefined, 1)).toBe(false);
  });

  it("is the Auto Compact menu's choices, which set the chat's own", async () => {
    const patches: unknown[] = [];
    const looper = { chat: { configure: async (_id: string, patch: unknown) => void patches.push(patch) }, showError: () => undefined } as unknown as LooperApi;
    const chat = {
      id: 'c1',
      status: 'ready',
      harnessId: 'h',
      harnessKind: 'claude-code',
      harnesses: [{ id: 'h', name: 'Claude Code', kind: 'claude-code' }],
      settings: { permissionMode: '' },
      autoCompactDefault: { enabled: false, percent: 85 },
      models: [],
      permissions: [],
    } as unknown as ChatState;
    const entries = chatSettingEntries(chat, looper).compact;
    expect(entries.map((e) => ('label' in e ? [e.label, e.checked] : null))).toEqual([
      ['Default (Off)', true],
      ['At 85%', false],
      ['Off', false],
    ]);
    for (const e of entries) if ('run' in e) e.run!();
    expect(patches).toEqual([{ autoCompact: undefined }, { autoCompact: true }, { autoCompact: false }]);
  });

  it("reaches Looper from a phone with Default's undefined, which JSON would drop", () => {
    const wire = JSON.parse(JSON.stringify(encodeBytes(['c1', { autoCompact: undefined, model: undefined }]))) as unknown;
    const [, patch] = serverDecode(wire) as [string, Record<string, unknown>];
    expect(Object.keys(patch).sort()).toEqual(['autoCompact', 'model']);
    expect(patch.autoCompact).toBeUndefined();
  });
});

/**
 * A stand-in for `claude -p --input-format stream-json`. A message with FULL in it ends its turn as Claude Code
 * 2.1.330 does on a full context, unless it starts with a compacted conversation (compacting made room); ALWAYS
 * FULL always does. A message with BIG in it fills 900 of the model's 1,000 tokens, any other 100.
 */
function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 's-' + process.pid;
let n = 0;
// It ends with its input, so a test that stops early leaves nothing running.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') fs.appendFileSync(${JSON.stringify(join(dir, 'controls'))}, JSON.stringify(m.request) + '\\n');
  if (m.type !== 'user') return;
  const text = m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\\n\\n');
  fs.appendFileSync(${JSON.stringify(join(dir, 'received'))}, JSON.stringify(text) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
  if (text.includes('ALWAYS FULL') || (text.includes('FULL') && !text.startsWith('<compacted-conversation>'))) {
    out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, error: 'invalid_request', is_api_error_message: true,
      message: { model: '<synthetic>', role: 'assistant', type: 'message', stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Prompt is too long' }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', terminal_reason: 'blocking_limit', stop_reason: 'stop_sequence', num_turns: 1, modelUsage: {}, session_id: sid });
    return;
  }
  n++;
  const tokens = text.includes('BIG') ? 900 : 100;
  out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { model: 'fake', role: 'assistant', content: [{ type: 'text', text: 'reply ' + n }], usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', result: 'reply ' + n, terminal_reason: 'completed', modelUsage: { fake: { contextWindow: 1000 } }, session_id: sid });
}).on('close', () => process.exit(0));
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** A stand-in for `codex exec --json`: FULL as fakeClaude, with the events Codex 0.163.0 prints on a full context. */
function fakeCodex(dir: string): string {
  const js = join(dir, 'fake-codex.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const text = args.at(-1);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
fs.appendFileSync(${JSON.stringify(join(dir, 'received'))}, JSON.stringify(text) + '\\n');
out({ type: 'thread.started', thread_id: 'th-' + process.pid });
out({ type: 'turn.started' });
if (text.includes('FULL') && !text.startsWith('<compacted-conversation>')) {
  out({ type: 'error', message: ${JSON.stringify(CODEX_FULL)} });
  out({ type: 'turn.failed', error: { message: ${JSON.stringify(CODEX_FULL)} } });
  process.exit(1);
}
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'codex reply' } });
out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
`,
  );
  const sh = join(dir, 'fake-codex');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('a chat that compacts by itself', { timeout: 30_000 }, () => {
  let manager: ChatManager | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
  });

  function setUp(kind: 'claude-code' | 'codex', autoCompact?: { enabled: boolean; percent?: number }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-autocompact-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    if (autoCompact) settings.chats.autoCompact = { ...settings.chats.autoCompact, ...autoCompact };
    const command = kind === 'codex' ? fakeCodex(dir) : fakeClaude(dir);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'h', name: 'Fake', kind, command, args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'h', mode: 'headless', prompt: 'x' } });
    const compacted: { from: string; to: string }[] = [];
    // Each run's chat.json as the chat last saved it.
    const infos = new Map<string, ChatInfo>();
    const m = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: (e: EngineEvent) => {
        if (e.type === 'chat:compacted') compacted.push({ from: e.from, to: e.to });
      },
      runDir: (taskId, runId) => join(dataDir, 'runs', taskId, runId),
      readHistory: async () => [],
      readCompactable: async () => [],
      writeInfo: (_taskId, runId, info) => void infos.set(runId, info),
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });
    manager = m;
    const received = () => (existsSync(join(dir, 'received')) ? readFileSync(join(dir, 'received'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
    const id = m.start(task, { kind: 'new' }).id;
    /** Send, and wait for the agent to have it and the turn to end. */
    const turn = async (chatId: string, text: string, count: number) => {
      m.send(chatId, text, []);
      await until(() => received().length === count, `message ${count}`);
      await until(() => !m.get(chatId) || m.get(chatId)!.status === 'ready', 'the turn to end');
    };
    const controls = () => (existsSync(join(dir, 'controls')) ? readFileSync(join(dir, 'controls'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
    return { m, id, task, compacted, infos, received, turn, controls };
  }

  const texts = (rows: MessageRow[]) => rows.filter((r) => !r.note).map((r) => r.text);
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('moves what the chat watches and Continue When Limit Resets to the chat Compact into New Chat starts', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    s.m.setWatch(s.id, 't2', '', true);
    s.m.setAutoContinue(s.id, true);
    await s.turn(s.id, 'hello', 1);
    expect(s.infos.get(s.id)?.watches).toEqual([{ taskId: 't2', what: 'events' }]);
    const next = await s.m.compact(s.task, s.id);
    expect(s.compacted).toEqual([{ from: s.id, to: next.id }]);
    expect(s.m.eventWatchers('t2', ['an event'])).toEqual([{ chatId: next.id, lines: ['an event'] }]);
    expect(s.m.get(next.id)?.autoContinue).toBe(true);
    // The old run, opened again later, neither watches nor continues.
    const old = s.infos.get(s.id)!;
    expect(old.watches).toBeUndefined();
    expect(old.autoContinue).toBeUndefined();
  });

  it('goes on after Compact into New Chat as the same chat: its name, settings, place in the list, finished turn and message box', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'hello', 1);
    s.m.rename(s.id, 'My chat');
    await s.m.configure(s.id, { autoCompact: false, effort: 'high' });
    s.m.setDraft(s.id, { text: 'half typed', attachments: [{ name: 'a.txt', path: '/a.txt', image: false }] });
    const before = s.m.get(s.id)!;
    const next = await s.m.compact(s.task, s.id);
    const state = s.m.get(next.id)!;
    expect(state).toMatchObject({ title: 'My chat', startedAt: before.startedAt, turnEndedAt: before.turnEndedAt, settings: before.settings, harnessId: before.harnessId });
    expect(state.draft).toEqual(before.draft);
    // What addresses the old chat by its id finds the new one, until it closes too.
    expect(s.m.following(s.id)).toBe(next.id);
    expect(s.m.following(next.id)).toBe(next.id);
    // Its first message makes it a run with the user's name, which Claude Code's new session gets too.
    await s.turn(next.id, 'more', 2);
    expect(s.infos.get(next.id)).toMatchObject({ title: 'My chat', titleBy: 'user', compactedFrom: s.id });
    expect(s.controls()).toContainEqual(expect.objectContaining({ subtype: 'rename_session', title: 'My chat' }));
    // Compacted again, the first id still finds it.
    const third = await s.m.compact(s.task, next.id);
    expect(s.m.following(s.id)).toBe(third.id);
    expect(s.m.get(third.id)).toMatchObject({ title: 'My chat', startedAt: before.startedAt });
    await s.m.close(third.id);
    expect(s.m.following(s.id)).toBeUndefined();
  });

  it("stays open with a note when the new chat can't start", async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    // Nothing to compact: Compact into New Chat says why, and the chat goes on.
    await expect(s.m.compact(s.task, s.id)).rejects.toThrow('The chat has no reply to compact yet.');
    expect(s.m.get(s.id)?.status).toBe('ready');
    expect(s.m.following(s.id)).toBe(s.id);
  });

  it('keeps Mute Notifications in chat.json and moves it to the chat Compact into New Chat starts', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    s.m.setMuted(s.id, true);
    expect(s.m.get(s.id)?.muted).toBe(true);
    await s.turn(s.id, 'hello', 1);
    expect(s.infos.get(s.id)?.muted).toBe(true);
    const next = await s.m.compact(s.task, s.id);
    expect(s.m.get(next.id)?.muted).toBe(true);
    s.m.setMuted(next.id, false);
    expect(s.m.get(next.id)?.muted).toBeUndefined();
  });

  it('moves them when it compacts by itself too', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    s.m.setWatch(s.id, 't2', 'rel-1', true);
    await s.turn(s.id, 'hello', 1);
    s.m.send(s.id, 'please FULL', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    // Settings → Chats leaves Continue When Limit Resets off: the new chat keeps the old one's off, as it was.
    expect(s.m.get(next)?.autoContinue).toBe(false);
    // The message that went again made it a run: its chat.json keeps the watch as it was.
    await until(() => !!s.infos.get(next), 'the new chat to be a run');
    expect(s.infos.get(next)?.watches).toEqual([{ taskId: 't2', what: 'events', eventId: 'rel-1' }]);
    expect(s.infos.get(s.id)?.watches).toBeUndefined();
  });

  it("doesn't by default", async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'go BIG', 1);
    await settle();
    expect(s.compacted).toEqual([]);
    expect(s.m.get(s.id)?.context).toEqual({ tokens: 900, window: 1000 });
  });

  it('compacts at the end of a turn past its share of the context, keeping the message box, and not again when compacted it starts past it', async () => {
    const s = setUp('claude-code', { enabled: true });
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    // What the message box holds as the turn ends (the window reports it as it changes).
    s.m.setDraft(s.id, { text: 'half typed', attachments: [] });
    s.m.send(s.id, 'go BIG', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    expect(s.compacted[0].from).toBe(s.id);
    await until(() => !s.m.get(s.id), 'the old chat to close');
    const state = s.m.get(next)!;
    expect(state.historyLabel).toBe(`Compacted automatically from run ${s.id}`);
    expect(texts(state.history)).toEqual(['go BIG', 'reply 1']);
    expect(state.draft?.text).toBe('half typed');
    // Its first message takes the conversation; with "go BIG" in it, it is past 90% at once, and stays.
    await s.turn(next, 'more', 2);
    expect(s.received()[1]).toMatch(/^<compacted-conversation>[\s\S]*go BIG[\s\S]*more$/);
    await settle();
    expect(s.compacted).toHaveLength(1);
    expect(s.m.get(next)?.status).toBe('ready');
  });

  it("follows the chat's own setting over Settings → Chats", async () => {
    const s = setUp('claude-code', { enabled: true, percent: 50 });
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.m.configure(s.id, { autoCompact: false });
    await s.turn(s.id, 'go BIG', 1);
    await settle();
    expect(s.compacted).toEqual([]);
    await s.m.configure(s.id, { autoCompact: undefined });
    expect(s.m.get(s.id)?.settings.autoCompact).toBeUndefined();
    await s.turn(s.id, 'again BIG', 2);
    await until(() => s.compacted.length === 1, 'the compaction');
  });

  it('compacts when Claude Code stops on a full context, and sends the message again', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'hello', 1);
    s.m.send(s.id, 'please FULL', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    await until(() => s.received().length === 3, 'the message to go again');
    expect(s.received()[2]).toMatch(/^<compacted-conversation>[\s\S]*hello[\s\S]*reply 1[\s\S]*please FULL$/);
    // The failed message isn't in the compacted conversation: it went again after it.
    expect(s.received()[2].indexOf('please FULL')).toBe(s.received()[2].length - 'please FULL'.length);
    await until(() => s.m.get(next)?.status === 'ready' && s.m.get(next)!.rows.some((r) => r.text === 'reply 1'), 'the reply');
    const state = s.m.get(next)!;
    expect(state.historyLabel).toBe(`Compacted from run ${s.id} when its context was full`);
    expect(texts(state.history)).toEqual(['hello', 'reply 1']);
    expect(texts(state.rows)).toEqual(['please FULL', 'reply 1']);
    expect(s.m.get(s.id)).toBeUndefined();
  });

  it("doesn't go round when the compacted conversation is still too large", async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'hello', 1);
    s.m.send(s.id, 'ALWAYS FULL', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    await until(() => s.received().length === 3 && s.m.get(next)?.status === 'ready' && s.m.get(next)!.rows.some((r) => r.kind === 'error'), 'the second refusal');
    await settle();
    expect(s.compacted).toHaveLength(1);
    expect(s.m.get(next)!.rows.find((r) => r.kind === 'error')?.text).toBe(CLAUDE_FULL);
  });

  it('leaves a chat with nothing to compact as it is', async () => {
    const s = setUp('claude-code');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'please FULL', 1);
    await settle();
    expect(s.compacted).toEqual([]);
    expect(s.m.get(s.id)!.rows.find((r) => r.kind === 'error')?.text).toBe(CLAUDE_FULL);
  });

  it('compacts when Codex stops on a full context, and sends the message again', async () => {
    const s = setUp('codex');
    await until(() => s.m.get(s.id)?.status === 'ready', 'the chat to start');
    await s.turn(s.id, 'hello', 1);
    s.m.send(s.id, 'please FULL', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    await until(() => s.received().length === 3, 'the message to go again');
    expect(s.received()[2]).toMatch(/^<compacted-conversation>[\s\S]*hello[\s\S]*codex reply[\s\S]*please FULL$/);
    expect(s.received()[2]).not.toContain('ran out of room');
    await until(() => s.m.get(next)?.status === 'ready' && s.m.get(next)!.rows.some((r) => r.text === 'codex reply'), 'the reply');
    expect(texts(s.m.get(next)!.history)).toEqual(['hello', 'codex reply']);
  });
});


/**
 * A stand-in for interactive Claude Code with Looper's mod, as chat-interactive.test.ts has it: it takes the chat's
 * message out of the mod's inbox and runs a turn on it, writing the transcript and the mod's turn and usage records.
 * FULL and BIG as fakeClaude; the full context's record is the one Claude Code 2.1.330 wrote to its transcript.
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
process.stdout.write('fake claude is ready\\r\\n');
fs.writeFileSync(path.join(run, 'mod.json'), '{}');
fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ session_id: id, transcript_path: transcript }));
let n = 0;
const rec = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, uuid: id + '-' + ++n, timestamp: new Date().toISOString() }) + '\\n');
setInterval(() => {
  const inbox = path.join(run, 'message.json');
  if (!fs.existsSync(inbox)) return;
  const taken = inbox.replace(/\\.json$/, '-' + Date.now() + '-mod.json');
  try { fs.renameSync(inbox, taken); } catch { return; }
  const text = JSON.parse(fs.readFileSync(taken, 'utf8'));
  fs.appendFileSync(path.join(dir, 'received'), JSON.stringify(text) + '\\n');
  fs.writeFileSync(path.join(run, 'turn.json'), '{}');
  rec({ type: 'user', message: { role: 'user', content: text } });
  setTimeout(() => {
    if (text.includes('FULL') && !text.startsWith('<compacted-conversation>')) {
      rec({ type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', message: { role: 'assistant', model: '<synthetic>', type: 'message', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Prompt is too long' }] } });
      fs.writeFileSync(path.join(run, 'turn-end.json'), JSON.stringify({ reason: 'error' }));
      return;
    }
    rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'echo ' + n }] } });
    fs.writeFileSync(path.join(run, 'usage.json'), JSON.stringify({ context: { tokens: text.includes('BIG') ? 900 : 100, window: 1000 } }));
    fs.writeFileSync(path.join(run, 'turn-end.json'), '{}');
  }, 300);
}, 100);
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('an interactive chat that compacts by itself', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  async function setUp(autoCompact: boolean) {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      chats: { ...e.settings.chats, autoCompact: { enabled: autoCompact, percent: 90 } },
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeInteractiveClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    const compacted: { from: string; to: string }[] = [];
    e.on((ev) => {
      if (ev.type === 'chat:compacted') compacted.push({ from: ev.from, to: ev.to });
    });
    const received = () => (existsSync(join(dir, 'received')) ? readFileSync(join(dir, 'received'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
    const id = e.startChat('t1').id;
    await until(() => e.getChat(id)?.status === 'ready', 'the session to start');
    const replied = (chatId: string, text: string) => !!e.getChat(chatId)?.rows.some((r) => r.kind === 'agent' && r.text === text) && e.getChat(chatId)?.status === 'ready';
    return { e, id, compacted, received, replied };
  }

  it('compacts when the turn stops on a full context, and sends the message again', async () => {
    const s = await setUp(false);
    s.e.sendChat(s.id, 'hello', []);
    await until(() => s.replied(s.id, 'echo 1'), 'the first reply');
    s.e.sendChat(s.id, 'please FULL', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    const next = s.compacted[0].to;
    await until(() => s.received().length === 3, 'the message to go again');
    expect(s.received()[2]).toMatch(/^<compacted-conversation>[\s\S]*hello[\s\S]*echo 1[\s\S]*please FULL$/);
    // A new Claude Code process: its reply counts from 1 again.
    await until(() => s.replied(next, 'echo 1'), 'the reply in the new chat');
    expect(s.e.getChat(next)?.settings.mode).toBe('interactive');
    expect(s.e.getChat(s.id)).toBeUndefined();
  });

  it('compacts at the end of a turn past its share of the context, once the usage record says so', async () => {
    const s = await setUp(true);
    s.e.sendChat(s.id, 'small', []);
    await until(() => s.replied(s.id, 'echo 1'), 'the first reply');
    await new Promise((r) => setTimeout(r, 300));
    expect(s.compacted).toEqual([]);
    s.e.sendChat(s.id, 'go BIG', []);
    await until(() => s.compacted.length === 1, 'the compaction');
    expect(s.compacted[0].from).toBe(s.id);
    expect(s.e.getChat(s.compacted[0].to)?.historyLabel).toBe(`Compacted automatically from run ${s.id}`);
  });
});

describe('a compacted chat in the Chats window and the dashboard', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it("takes the old chat's place in the list and on the dashboard, what was seen of it, and the commands that name it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    const a = e.startChat('t1').id;
    const b = e.startChat('t1').id;
    const listed = () => e.sessionsState().sessions.map((s) => s.id);
    await until(() => e.getChat(a)?.status === 'ready' && e.getChat(b)?.status === 'ready' && listed().length === 2, 'the chats to start');
    e.sendChat(a, 'hello', []);
    await until(() => e.getChat(a)?.status === 'ready' && !!e.getChat(a)!.rows.some((r) => r.text === 'reply 1'), 'the reply');
    // Group Chats By None's order, the dashboard's, and Mark as Unread.
    e.reorderSessions([b, a]);
    const view = e.settings.view;
    e.updateSettings({ view: { ...view, sessions: { ...view.sessions, bigCards: [a], hiddenCards: [a], cardOrder: [b, a], focusCard: a } } });
    e.seenSession(a);
    e.markSessionUnread(a);
    await until(() => !!e.sessionsState().sessions.find((s) => s.id === a)?.waiting?.unread, 'the chat to show as unread');
    const before = e.sessionsState().sessions.find((s) => s.id === a)!;

    const next = (await e.compactChat(a)).id;
    await until(() => listed().includes(next) && !listed().includes(a), 'the new chat in the list');
    const state = e.sessionsState();
    expect(state.order).toEqual([b, next]);
    // By project, the chats are in the order they started: the new chat keeps the old one's start, so it's still first.
    expect(listed()).toEqual([next, b]);
    expect(state.sessions.find((s) => s.id === next)).toMatchObject({ title: before.title, startedAt: before.startedAt, waiting: before.waiting });
    expect(e.settings.view.sessions).toMatchObject({ bigCards: [next], hiddenCards: [next], cardOrder: [b, next], focusCard: next });
    // The command-line tool and a tapped notification find it by the old id.
    expect(e.liveSessionId(a)).toBe(next);
    expect(e.liveSessionId(b)).toBe(b);
    await e.request('mute', { id: a, on: true });
    expect(e.getChat(next)?.muted).toBe(true);
  });
});

/**
 * fakeInteractiveClaude in Code Mode: its transcript says so, each turn runs a REPL script that defines `total`,
 * `hello` and `sock`, and it answers the mod's REPL snapshot request as the mod does (the data and the index, then
 * a wake-up turn with an empty answer).
 */
function fakeCodeModeClaude(dir: string): string {
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
process.stdout.write('fake claude is ready\\r\\n');
fs.writeFileSync(path.join(run, 'mod.json'), JSON.stringify({ version: '1' }));
fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ session_id: id, transcript_path: transcript }));
let n = 0;
let snapshotId = 0;
const rec = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, uuid: id + '-' + ++n, timestamp: new Date().toISOString() }) + '\\n');
setInterval(() => {
  let control = null;
  try { control = JSON.parse(fs.readFileSync(path.join(run, 'mod-control.json'), 'utf8')); } catch {}
  const s = control?.snapshot;
  if (s && s.id !== snapshotId) {
    snapshotId = s.id;
    fs.appendFileSync(path.join(dir, 'snapshots'), JSON.stringify(fs.readFileSync(s.script, 'utf8')) + '\\n');
    fs.writeFileSync(path.join(run, 'turn.json'), '{}');
    fs.writeFileSync(s.data, JSON.stringify({ roots: [['total', 42], ['hello', { '#': 0 }], ['sock', { '#': 1 }]], nodes: [{ t: 'f', f: 0 }, { t: 'x' }] }));
    fs.writeFileSync(s.out, JSON.stringify({ version: 2, id: s.id, roots: ['total', 'hello'], functions: [{ source: 'function hello() { return "hi"; }', form: 0, path: 'hello', free: [] }], lost: [{ name: 'sock', reason: "a WeakMap, whose contents can't be read" }], changed: [], bytes: 99 }));
    setTimeout(() => fs.writeFileSync(path.join(run, 'turn-end.json'), JSON.stringify({ answer: '' })), 200);
  }
  const inbox = path.join(run, 'message.json');
  if (!fs.existsSync(inbox)) return;
  const taken = inbox.replace(/\\.json$/, '-' + Date.now() + '-mod.json');
  try { fs.renameSync(inbox, taken); } catch { return; }
  const text = JSON.parse(fs.readFileSync(taken, 'utf8'));
  fs.appendFileSync(path.join(dir, 'received'), JSON.stringify(text) + '\\n');
  fs.writeFileSync(path.join(run, 'turn.json'), '{}');
  if (n === 0) rec({ type: 'repl-mode', replMode: true });
  rec({ type: 'user', message: { role: 'user', content: text } });
  setTimeout(() => {
    const use = 'tool-' + n;
    rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: use, name: 'REPL', input: { code: 'const total = 41 + 1;\\nfunction hello() { return "hi"; }\\nconst sock = new WeakMap();' } }] } });
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: '42' }] } });
    rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'echo ' + n }] } });
    fs.writeFileSync(path.join(run, 'usage.json'), JSON.stringify({ context: { tokens: 100, window: 1000 } }));
    fs.writeFileSync(path.join(run, 'turn-end.json'), '{}');
  }, 300);
}, 100);
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('a Code Mode chat compacted', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it("gives the new session's REPL the old one's names at its first turn, and tells the agent what it starts with", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const e = (engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')) }));
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeCodeModeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'interactive', prompt: 'x' } }));
    const lines = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []);
    const replied = (chatId: string, text: string) => !!e.getChat(chatId)?.rows.some((r) => r.kind === 'agent' && r.text === text) && e.getChat(chatId)?.status === 'ready';
    const id = e.startChat('t1').id;
    await until(() => e.getChat(id)?.status === 'ready', 'the session to start');
    e.sendChat(id, 'hello', []);
    await until(() => replied(id, 'echo 4') && !!e.getChat(id)?.codeMode, 'the first reply, in Code Mode');
    await until(() => readFileSync(join(dataDir, 'engine.log'), 'utf8').includes("Looper's mod is running"), 'the mod to report');

    // A message sent while it compacts goes to the new chat.
    const compacting = e.compactChat(id);
    e.sendChat(id, 'meanwhile', []);
    const next = (await compacting).id;
    // The old session's REPL was asked for every name its scripts defined.
    expect(lines('snapshots')).toHaveLength(1);
    for (const name of ['total', 'hello', 'sock']) expect(lines('snapshots')[0]).toContain(`[${JSON.stringify(name)}, () => ${name}]`);
    const runDir = join(dataDir, 'tasks', 't1', 'runs', next);
    await until(() => existsSync(join(runDir, 'repl-prelude.js')), 'the prelude');
    const prelude = readFileSync(join(runDir, 'repl-prelude.js'), 'utf8');
    expect(prelude).toContain('__looperMake[0] = () => (function hello() { return "hi"; }');
    expect(prelude).toContain(REPL_DATA_MARKER);
    // The snapshot's data goes with it, for the mod to put in at the marker.
    await until(() => existsSync(join(runDir, 'repl-data.json')), 'the data');
    expect(JSON.parse(readFileSync(join(runDir, 'repl-data.json'), 'utf8')).roots[0]).toEqual(['total', 42]);

    // Its first session's mod runs the prelude as the REPL's first script.
    const modNames = () => {
      const mod = join(runDir, 'looper-mod');
      return (readdirSync(mod, { recursive: true }) as string[]).some((f) => statSync(join(mod, f)).isFile() && readFileSync(join(mod, f), 'utf8').includes('repl-prelude.js'));
    };
    await until(() => existsSync(join(runDir, 'looper-mod')), "the new session's mod");
    expect(modNames()).toBe(true);
    // Its first message takes the conversation, and what the REPL starts with, to the new session.
    await until(() => lines('received').length === 2, 'the first message of the new chat');
    expect(lines('received')[1]).toMatch(/\[Compaction: the REPL\]\nThis session's REPL starts with the earlier session's names total, hello as globals, restored by Looper\. These didn't come back as they were, so rebuild them if you need them: sock: a WeakMap, whose contents can't be read, made by `const sock = new WeakMap\(\);`\.\n<\/compacted-conversation>\n\nmeanwhile$/);
    await until(() => existsSync(join(runDir, 'compacted.json')), 'compacted.json');
    expect(JSON.parse(readFileSync(join(runDir, 'compacted.json'), 'utf8'))).toMatchObject({ version: 3, replNames: ['total', 'hello'] });
    // A later session of the conversation (Restart Agent) has its own REPL state: no prelude.
    await until(() => replied(next, 'echo 4'), 'the reply in the new chat');
    await e.restartSession(next);
    e.sendChat(next, 'again', []);
    await until(() => lines('received').length === 3, 'the message to the restarted session');
    expect(lines('received')[2]).toBe('again');
    expect(e.getChat(id)).toBeUndefined();
    expect(modNames()).toBe(false);
  });
});
