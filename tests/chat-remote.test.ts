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
 * A stand-in for `claude -p --input-format stream-json` with Remote Control:
 * it answers the `remote_control` control request as Claude Code 2.1.314 does
 * (checked live: a success response carrying `session_url`), and once the
 * test writes `app-message` it takes a message from the Claude app: replays
 * it, answers, and ends the turn.
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
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type !== 'control_request') return;
  if (m.request.subtype === 'remote_control') {
    fs.appendFileSync(path.join(dir, 'rc'), (m.request.enabled ? 'on ' + m.request.name : 'off') + '\\n');
    const response = m.request.enabled ? { session_url: 'https://claude.ai/code/session_fake1', bridge_session_id: 'cse_fake1' } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
});
const wait = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'app-message'))) return;
  clearInterval(wait);
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ type: 'user', parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: 'Sent from the app' } });
  setTimeout(() => {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'On it.' }] } });
    out({ type: 'result', subtype: 'success', result: 'On it.' });
  }, 150);
}, 20);
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('a chat on a harness that starts conversations with Remote Control', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  async function setUp(remoteControl: boolean): Promise<{ engine: Engine; dir: string; chatId: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-rc-'));
    const e = createEngine({ dataDir });
    engine = e;
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local'
          ? { ...env, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), options: { remoteControl } }] }
          : env,
      ),
      remote: { ...e.settings.remote, enabled: true },
    });
    e.saveTask(
      TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x' } }),
    );
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    return { engine: e, dir, chatId };
  }

  it("turns it on, is listed with its link, shows the app's messages, and drops it when turned off", async () => {
    const { engine: e, dir, chatId } = await setUp(true);
    await until(() => !!e.remoteState().conversations.find((c) => c.id === chatId)?.link, 'the chat to be listed');
    expect(e.remoteState().conversations.find((c) => c.id === chatId)).toMatchObject({ source: 'chat', name: 'T1', status: 'waiting', link: 'https://claude.ai/code/session_fake1' });
    writeFileSync(join(dir, 'app-message'), '');
    await until(() => e.getChat(chatId)?.status === 'working', 'the chat to work on the message');
    await until(() => e.getChat(chatId)?.status === 'ready', 'the turn to end');
    expect(e.getChat(chatId)?.rows.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'Sent from the app'],
      ['agent', 'On it.'],
    ]);
    e.updateSettings({ remote: { ...e.settings.remote, enabled: false } });
    await until(() => existsSync(join(dir, 'rc')) && /off\n$/.test(readFileSync(join(dir, 'rc'), 'utf8')), 'Remote Control to be turned off in the chat');
    expect(readFileSync(join(dir, 'rc'), 'utf8')).toBe('on T1\noff\n');
    expect(e.remoteState()).toMatchObject({ running: false });
    expect(e.remoteState().conversations.some((c) => c.id === chatId && c.status !== 'ended')).toBe(false);
  });

  it('starts without it when the harness option is off', async () => {
    const { engine: e, dir, chatId } = await setUp(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(dir, 'rc'))).toBe(false);
    expect(e.remoteState().conversations.some((c) => c.id === chatId)).toBe(false);
  });
});
