import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/engine/chat';
import { WATCH_FOOTER } from '../src/engine/task-watch';
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
      watchTargets: () => [
        { task: projectTask('t2', 'Deploy', 'manual'), own: true, folders: [] },
        { task: projectTask('t3', 'Slack replies', 'watcher'), own: true, folders: [{ id: 'f1', name: 'Inbox' }] },
        { task: projectTask('t4', 'Backups', 'manual'), own: false, folders: [], project: 'Home' },
      ],
    });
    const info = { harnessId: 'fake', harnessKind: 'claude-code' as const, title: 'x', settings: { permissionMode: '' }, watches: [{ taskId: 't2', what: 'runs' as const }] };
    const id = manager.start(task, { kind: 'reopen', runId: 'r1', info, sessionId: 's0' }).id;
    expect(manager.runWatchers('t2')).toEqual([id]);
    expect(manager.get(id)!.watchTasks).toEqual([
      { id: 't2', name: 'Deploy', events: [], own: true, folders: [] },
      { id: 't3', name: 'Slack replies', events: [], own: true, folders: [{ id: 'f1', name: 'Inbox' }] },
      { id: 't4', name: 'Backups', events: [], own: false, folders: [] },
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
        "The tasks of other projects, in the Tasks list's order (id, name, project):",
        't4  "Backups" (Home), runs started by hand',
      ].join('\n'),
    });
    // A task of another project can be watched too.
    expect(await ask('2b', 'task', 't4')).toEqual({ code: 0, text: 'Watching "Backups": the end of each run. Each one reaches you as a message while this chat is open.' });
    expect(manager.runWatchers('t4')).toEqual([id]);
    expect((await ask('2c', 'task', 'nope')).code).toBe(1);
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

  it('shows the newest rows of a long history while it reads all of it, and forks and compacts only once it has', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-chat-rows-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir), args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } });
    let readWhole!: () => void;
    const whole = new Promise<void>((done) => (readWhole = done));
    manager = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: () => undefined,
      runDir: (taskId, runId) => join(dataDir, 'runs', taskId, runId),
      readHistory: async () => {
        await whole;
        return transcriptRows();
      },
      readCompactable: async () => [],
      readNewest: async () => transcriptRows().slice(2),
      writeInfo: () => undefined,
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });
    const info = { harnessId: 'fake', harnessKind: 'claude-code' as const, title: 'earlier question', settings: { permissionMode: '' } };
    const id = manager.start(task, { kind: 'reopen', runId: 'r1', info, sessionId: 's0' }).id;
    await until(() => manager!.get(id)!.history.length === 2, 'the newest rows');
    expect(manager.get(id)!.history.map((r) => r.text)).toEqual(['another question', 'another answer']);
    // Its rows' positions aren't the history's yet, and Compact would leave the start out.
    expect(() => manager!.fork(task, id, 1)).toThrow('still being read');
    await expect(manager.compact(task, id)).rejects.toThrow('still being read');

    readWhole();
    await until(() => manager!.get(id)!.history.length === 4, 'the whole history');
    expect(manager.fork(task, id, 1).history.map((r) => r.text)).toEqual(['earlier question', 'earlier answer']);
  });
});

describe("a Codex chat's agent", () => {
  let manager: ChatManager | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
  });

  it('is told about looper-watch as developer instructions on every turn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-codex-watch-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-codex-'));
    const argsFile = join(dir, 'args');
    const codex = join(dir, 'fake-codex');
    // Only the turns (the chat also asks `codex app-server` for its skills); the rename makes the file appear whole.
    writeFileSync(codex, `#!/bin/sh\n[ "$1" = exec ] || exit 0\nprintf '%s\\0' "$@" > '${argsFile}.tmp' && mv '${argsFile}.tmp' '${argsFile}'\necho '{"type":"thread.started","thread_id":"th1"}'\necho '{"type":"turn.completed"}'\n`);
    chmodSync(codex, 0o755);
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'cx', name: 'Codex', kind: 'codex' as const, command: codex, args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'cx', mode: 'headless', prompt: 'x' } });
    manager = new ChatManager({
      dataDir,
      host,
      settings,
      log: new Logger(join(dataDir, 'engine.log'), false),
      emit: () => undefined,
      runDir: (taskId, runId) => join(dataDir, 'runs', taskId, runId),
      readHistory: async () => [],
      readCompactable: async () => [],
      writeInfo: () => undefined,
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });
    const info = { harnessId: 'cx', harnessKind: 'codex' as const, title: 'x', settings: { permissionMode: '' } };
    const id = manager.start(task, { kind: 'reopen', runId: 'r1', info, sessionId: 'th0' }).id;
    manager.send(id, 'hello', []);
    await until(() => existsSync(argsFile), 'the codex turn');
    const args = readFileSync(argsFile, 'utf8').split('\0');
    const given = args.find((a) => a.startsWith('developer_instructions='));
    expect(JSON.parse(given!.slice('developer_instructions='.length))).toBe(WATCH_FOOTER);
    expect(args.slice(args.indexOf('resume'), args.indexOf('resume') + 2)).toEqual(['resume', 'th0']);
    // A thread from elsewhere never took developer_instructions: its first message from the chat carries them, once.
    expect(args.at(-2)).toBe(`<looper_instructions>\n${WATCH_FOOTER}\n</looper_instructions>\n\nhello`);
    rmSync(argsFile);
    manager.send(id, 'again', []);
    await until(() => existsSync(argsFile), 'the second codex turn');
    expect(readFileSync(argsFile, 'utf8').split('\0').at(-2)).toBe('again');
  });
});

