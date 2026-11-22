import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A stand-in for `claude -p --input-format stream-json` that reports the
 * context as Claude Code 2.1.330 does: each reply's assistant record carries
 * its usage, and only the turn's result names the model's window (modelUsage).
 * Message n's reply waits for the test to write `release-<n>`, so the test
 * can look at the chat between the two. "COMPACT" ends in a compact_boundary
 * record as the stream writes it (compact_metadata with pre_tokens only), and
 * "COMPACT SIZED" with post_tokens too.
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
const queue = [];
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (m.type !== 'user') return;
  queue.push(m);
  if (!busy) void turn();
}).on('close', () => process.exit(0));
async function turn() {
  busy = true;
  const m = queue.shift();
  fs.appendFileSync(path.join(dir, 'received'), JSON.stringify(text(m)) + '\\n');
  const n = fs.readFileSync(path.join(dir, 'received'), 'utf8').split('\\n').filter(Boolean).length;
  out({ type: 'system', subtype: 'init', session_id: 's' + n, model: 'claude-fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  if (text(m) === 'COMPACT' || text(m) === 'COMPACT SIZED') {
    const meta = { trigger: 'manual', pre_tokens: 150000, ...(text(m) === 'COMPACT SIZED' ? { post_tokens: 30000 } : {}) };
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: meta });
    out({ type: 'result', subtype: 'success', result: '' });
  } else {
    const usage = { input_tokens: 10, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 0, output_tokens: 5 };
    out({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fake', content: [{ type: 'text', text: 'reply ' + n }], usage } });
    while (!fs.existsSync(path.join(dir, 'release-' + n))) await new Promise((r) => setTimeout(r, 20));
    out({ type: 'result', subtype: 'success', result: 'reply ' + n, modelUsage: { 'claude-fake': { contextWindow: 200000 } } });
  }
  busy = false;
  if (queue.length) void turn();
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
    await engine.stop();
    throw err;
  }
  return { engine, dir, chatId };
}

const received = (dir: string) => (existsSync(join(dir, 'received')) ? readFileSync(join(dir, 'received'), 'utf8').split('\n').filter(Boolean).length : 0);
const release = (dir: string, n: number) => writeFileSync(join(dir, `release-${n}`), '');

describe("a Claude chat's context window", { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  /** Message n: sent, its reply's usage in, its result not yet. */
  async function replying(s: { engine: Engine; dir: string }, chatId: string, text: string, n: number) {
    s.engine.sendChat(chatId, text, []);
    await until(() => received(s.dir) === n && s.engine.getChat(chatId)?.context?.tokens === 10 + 1000 * n, `reply ${n}'s usage`);
  }

  it('keeps the window through a compaction, before the next result names it again', async () => {
    const s = await setUp();
    engine = s.engine;
    await replying(s, s.chatId, 'hello', 1);
    release(s.dir, 1);
    await until(() => s.engine.getChat(s.chatId)?.context?.window === 200000, 'the first result');
    s.engine.sendChat(s.chatId, 'COMPACT', []);
    await until(() => received(s.dir) === 2 && s.engine.getChat(s.chatId)?.status === 'ready', 'the compaction');
    // Its size after the compaction comes with the next reply.
    expect(s.engine.getChat(s.chatId)?.context).toBeUndefined();
    await replying(s, s.chatId, 'go on', 3);
    expect(s.engine.getChat(s.chatId)?.context).toEqual({ tokens: 3010, window: 200000 });
    release(s.dir, 3);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready', 'the third turn');
    // The stream's compact_boundary can say the size after it.
    s.engine.sendChat(s.chatId, 'COMPACT SIZED', []);
    await until(() => received(s.dir) === 4 && s.engine.getChat(s.chatId)?.status === 'ready', 'the second compaction');
    expect(s.engine.getChat(s.chatId)?.context).toEqual({ tokens: 30000, window: 200000 });
  });

  it('gives Compact into New Chat the window of the chat it came from', async () => {
    const s = await setUp();
    engine = s.engine;
    await replying(s, s.chatId, 'hello', 1);
    release(s.dir, 1);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready' && s.engine.getChat(s.chatId)?.context?.window === 200000, 'the first result');
    const next = await s.engine.compactChat(s.chatId);
    await until(() => s.engine.getChat(next.id)?.status === 'ready', 'the compacted chat to start');
    await replying(s, next.id, 'go on', 2);
    expect(s.engine.getChat(next.id)?.context).toEqual({ tokens: 2010, window: 200000 });
    release(s.dir, 2);
  });

  it("gives Continue Compacted on a chat's run the window that run's chat had", async () => {
    const s = await setUp();
    engine = s.engine;
    await replying(s, s.chatId, 'hello', 1);
    release(s.dir, 1);
    await until(() => s.engine.getChat(s.chatId)?.status === 'ready' && s.engine.getChat(s.chatId)?.context?.window === 200000, 'the first result');
    // A compacted chat's run keeps its conversation in compacted.json, which the fake's missing transcript doesn't matter to.
    const run = await s.engine.compactChat(s.chatId);
    await until(() => s.engine.getChat(run.id)?.status === 'ready', 'the compacted chat to start');
    await replying(s, run.id, 'go on', 2);
    release(s.dir, 2);
    await until(() => s.engine.getChat(run.id)?.status === 'ready', 'its turn to end');
    await s.engine.closeChat(run.id);
    const next = await s.engine.compactRun('t1', run.id);
    await until(() => s.engine.getChat(next.id)?.status === 'ready', 'the next compacted chat to start');
    await replying(s, next.id, 'and on', 3);
    expect(s.engine.getChat(next.id)?.context).toEqual({ tokens: 3010, window: 200000 });
    release(s.dir, 3);
  });
});
