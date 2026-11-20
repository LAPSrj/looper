import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/engine/chat';
import { detectHost } from '../src/engine/host';
import { Logger } from '../src/engine/log';
import { TranscriptAccumulator } from '../src/engine/messages';
import { loadSettings } from '../src/engine/store/settings';
import type { MessageRow } from '../src/shared/messages';
import type { ChatInfo } from '../src/shared/chat';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A stand-in for `claude -p --input-format stream-json`: each message gets a tool call and a reply. */
function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let n = 0;
// It ends with its input, so a test that stops early leaves nothing running.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type !== 'user') return;
  n++;
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't' + n, name: 'Bash', input: { command: 'ls' } }] } });
  out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't' + n, content: 'ok' }] } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'reply ' + n }] } });
  out({ type: 'result', subtype: 'success', result: 'reply ' + n });
}).on('close', () => process.exit(0));
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** An earlier conversation as the transcript reader folds it into rows (it numbers them from 0). */
function transcriptRows(): MessageRow[] {
  const acc = new TranscriptAccumulator();
  const user = (text: string) => ({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } });
  const agent = (text: string) => ({ type: 'assistant', uuid: `a-${text}`, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  for (const rec of [user('earlier question'), agent('earlier answer'), user('another question'), agent('another answer')]) acc.addLine(JSON.stringify(rec));
  return acc.rows;
}

describe('a chat that watches tasks', { timeout: 30_000 }, () => {
  let manager: ChatManager | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
  });

  it("keeps what it watches across a reopen, answers its agent's looper-watch, and picks the trigger events it watches", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-chat-watch-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } });
    const projectTask = (id: string, name: string, mode: 'manual' | 'watcher') => TaskSchema.parse({ id, name, trigger: { mode }, environmentId: 'local', cwd: dir, agent: { prompt: 'x' } });
    const infos: ChatInfo[] = [];
    manager = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: () => undefined,
      runDir: (taskId, runId) => join(dataDir, 'runs', taskId, runId),
      readHistory: async () => [],
      readCompactable: async () => [],
      writeInfo: (_t, _r, info) => void infos.push(info),
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
      projectTasks: () => [projectTask('t2', 'Deploy', 'manual'), projectTask('t3', 'Slack replies', 'watcher')],
    });
    const info = { harnessId: 'fake', harnessKind: 'claude-code' as const, title: 'x', settings: { permissionMode: '' }, watches: [{ taskId: 't2', what: 'runs' as const }] };
    const id = manager.start(task, { kind: 'reopen', runId: 'r1', info, sessionId: 's0' }).id;
    expect(manager.runWatchers('t2')).toEqual([id]);
    expect(manager.get(id)!.watchTasks).toEqual([
      { id: 't2', name: 'Deploy', events: [] },
      { id: 't3', name: 'Slack replies', events: [] },
    ]);

    // Watch Task Events with an event id: only the events with that related id.
    manager.setWatch(id, 't3', ' 42 ', true);
    manager.setWatch(id, 't3', '9', true);
    manager.setWatch(id, 't3', '9', false);
    expect(manager.get(id)!.watchTasks![1].events).toEqual(['42']);
    expect(infos.at(-1)!.watches).toEqual([{ taskId: 't2', what: 'runs' }, { taskId: 't3', what: 'events', eventId: '42' }]);
    const lines = ['{"looper_related_id":"42","text":"reply"}', '{"looper_related_id":"7"}', 'not json'];
    expect(manager.eventWatchers('t3', lines)).toEqual([{ chatId: id, lines: [lines[0]] }]);
    manager.setWatch(id, 't3', '42', false);
    expect(manager.eventWatchers('t3', lines)).toEqual([]);

    // The agent's looper-watch, as its helper asks: the op, the caller's folder, then one line per argument.
    const ask = async (rid: string, ...args: string[]) => {
      const watchDir = join(dataDir, 'runs', 't1', id, 'watch');
      mkdirSync(join(watchDir, 'requests'), { recursive: true });
      writeFileSync(join(watchDir, 'requests', `${rid}.req`), ['watch', dir, ...args, ''].join('\n'));
      await until(() => existsSync(join(watchDir, 'responses', `${rid}.code`)), 'the answer');
      return { code: Number(readFileSync(join(watchDir, 'responses', `${rid}.code`), 'utf8')), text: readFileSync(join(watchDir, 'responses', `${rid}.out`), 'utf8').trim() };
    };
    expect(await ask('1', 'events', 't3')).toEqual({ code: 0, text: 'Watching "Slack replies": all trigger events. Each one reaches you as a message while this chat is open.' });
    expect(manager.eventWatchers('t3', lines)).toEqual([{ chatId: id, lines }]);
    expect(await ask('2', 'tasks')).toEqual({
      code: 0,
      text: [
        "The tasks of this chat's project, in the Tasks list's order (id, name):",
        't2  "Deploy", runs started by hand; watching the end of each run',
        't3  "Slack replies", runs by its watcher; watching all trigger events',
      ].join('\n'),
    });
    expect(await ask('3', 'stop', 't2')).toEqual({ code: 0, text: 'Stopped watching "Deploy".' });
    expect(manager.runWatchers('t2')).toEqual([]);
    expect((await ask('4', 'task', 't9')).code).toBe(1);
    expect((await ask('5', 'watch', 't2')).code).toBe(2);
  });
});

describe('a chat opened again', { timeout: 30_000 }, () => {
  let manager: ChatManager | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
  });

  it("gives its history rows and its live rows ids that never repeat, so the Sessions window's keys don't either", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-chat-rows-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } });
    manager = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: () => undefined,
      runDir: (taskId, runId) => join(dataDir, 'runs', taskId, runId),
      readHistory: async () => transcriptRows(),
      readCompactable: async () => [],
      writeInfo: () => undefined,
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });
    const info = { harnessId: 'fake', harnessKind: 'claude-code' as const, title: 'earlier question', settings: { permissionMode: '' } };
    const id = manager.start(task, { kind: 'reopen', runId: 'r1', info, sessionId: 's0' }).id;
    await until(() => manager!.get(id)?.status === 'ready' && manager!.get(id)!.history.length > 0, 'the chat to open with its history');
    expect(manager.get(id)!.history).toHaveLength(4);

    manager.send(id, 'new question', []);
    await until(() => (manager!.get(id)?.rows ?? []).some((r) => r.kind === 'agent'), 'the live reply');
    const { history, rows } = manager.get(id)!;
    expect(rows.map((r) => r.kind)).toEqual(['prompt', 'tool', 'agent']);

    // The Sessions window lists [...history, ...rows] under one set of keys.
    const ids = [...history, ...rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
