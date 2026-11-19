import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForInbox } from '../src/cli/inbox-wait';
import { createEngine, type Engine } from '../src/engine/engine';
import { Inbox } from '../src/engine/inbox';
import type { Logger } from '../src/engine/log';
import type { InboxChat, Task } from '../src/shared/types';

const log = { info() {}, warn() {}, error() {} } as unknown as Logger;

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A headless Claude Code that logs its arguments and each message, and answers every one. */
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
fs.appendFileSync(path.join(dir, 'argv'), process.argv.slice(2).join(' ') + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (m.type !== 'user') return;
  fs.appendFileSync(path.join(dir, 'received'), m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('') + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hello' }] } });
  out({ type: 'result', subtype: 'success', result: 'hello' });
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('the inbox chat command', () => {
  const setup = (onChat?: (cmd: InboxChat) => string) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'looper-inbox-')), 'inbox');
    const inbox = new Inbox(dir, 20, { onTask: (input) => input as Task, onCommand: () => {}, ...(onChat ? { onChat } : {}) }, log);
    inbox.start();
    const drop = (body: object) => {
      const file = join(dir, `chat-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(body), 'utf8');
      return file;
    };
    return { inbox, drop };
  };

  it("hands the CLI the handler's result", async () => {
    const seen: InboxChat[] = [];
    const { inbox, drop } = setup((cmd) => {
      seen.push(cmd);
      return 'chat-1\nStarted a chat in Work.';
    });
    const outcome = await waitForInbox(drop({ op: 'chat', folder: '/w', text: 'hi', title: 'T', open: true }), 2000, 10);
    inbox.stop();
    expect(outcome).toEqual({ status: 'processed', result: 'chat-1\nStarted a chat in Work.' });
    expect(seen).toEqual([{ op: 'chat', folder: '/w', text: 'hi', title: 'T', open: true }]);
  });

  it('rejects a chat without a message or with a wrong field, and the reason reaches the CLI', async () => {
    const { inbox, drop } = setup(() => 'never');
    const empty = await waitForInbox(drop({ op: 'chat', folder: '/w', text: '  ' }), 2000, 10);
    const open = await waitForInbox(drop({ op: 'chat', folder: '/w', text: 'hi', open: 'yes' }), 2000, 10);
    inbox.stop();
    expect(empty).toEqual({ status: 'rejected', reason: 'invalid chat command: text must be the first message' });
    expect(open.status).toBe('rejected');
  });

  it("rejects the handler's error with its message", async () => {
    const { inbox, drop } = setup(() => {
      throw new Error("/nope isn't a folder.");
    });
    const outcome = await waitForInbox(drop({ op: 'chat', folder: '/nope', text: 'hi' }), 2000, 10);
    inbox.stop();
    expect(outcome).toEqual({ status: 'rejected', reason: "/nope isn't a folder." });
  });
});

describe('looper chat in the engine', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  let dataDir = '';
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts a chat in the folder's project with the message, its title and model, listed, and shown only with open", async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const shown: string[] = [];
    engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')), showChat: (id) => shown.push(id) });
    engine.start();
    engine.updateSettings({
      environments: engine.settings.environments.map((e) =>
        e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : e,
      ),
    });
    engine.saveProject({ name: 'Work', environmentId: 'local', harnessId: 'fake', cwd: dir, mode: 'headless' });

    const drop = (body: InboxChat) => {
      const file = join(engine!.inboxDir(), `chat-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(body), 'utf8');
      return file;
    };
    const first = await waitForInbox(drop({ op: 'chat', folder: dir, text: 'look at the build', title: 'Build check', model: 'opus' }), 10_000);
    expect(first.status).toBe('processed');
    const [id, line] = (first.status === 'processed' ? first.result : '')!.split('\n');
    expect(line).toBe(`Started a chat in Work (${dir}).`);
    expect(engine.sessionKind(id)).toBe('chat');
    await until(() => existsSync(join(dir, 'received')), 'the agent to get the message');
    expect(readFileSync(join(dir, 'received'), 'utf8')).toBe('look at the build\n');
    expect(readFileSync(join(dir, 'argv'), 'utf8')).toMatch(/--model opus/);
    await until(() => engine!.getChat(id)?.title === 'Build check', 'the title');
    expect(shown).toEqual([]);

    const second = await waitForInbox(drop({ op: 'chat', folder: dir, text: 'and the tests', open: true }), 10_000);
    const secondId = (second.status === 'processed' ? second.result : '')!.split('\n')[0];
    expect(shown).toEqual([secondId]);
    expect(secondId).not.toBe(id);

    const missing = await waitForInbox(drop({ op: 'chat', folder: join(dir, 'missing'), text: 'hi' }), 10_000);
    expect(missing).toEqual({ status: 'rejected', reason: `${join(dir, 'missing')} isn't a folder.` });
  });
});
