import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatManager } from '../src/engine/chat';
import { createEngine, type Engine } from '../src/engine/engine';
import { detectHost } from '../src/engine/host';
import { claudeProjectFolder, HISTORY_CACHE_FILE, HistoryService, LEDGER_FILE, runSessionRefs, SessionLedger, transcriptHistory, type ConfigDirs } from '../src/engine/history';
import { Logger } from '../src/engine/log';
import { RunStore } from '../src/engine/store/runs';
import { loadSettings } from '../src/engine/store/settings';
import type { ChatInfo } from '../src/shared/chat';
import { dateGroupOf, filterHistory, groupHistory, historySourceText, type HistoryItem } from '../src/shared/history';
import { projectSessionTask, projectTaskId } from '../src/shared/projects';
import { ProjectSchema, TaskSchema, type Project } from '../src/shared/types';

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A Claude Code transcript: its first record names the folder it started in, then the messages. */
function claudeTranscript(cwd: string, messages: [string, string][], extra: object[] = []): string {
  const records: object[] = [{ type: 'permission-mode', permissionMode: 'auto', sessionId: 'x' }];
  messages.forEach(([q, a], i) => {
    records.push({ parentUuid: null, isSidechain: false, type: 'user', cwd, sessionId: 'x', message: { role: 'user', content: q }, uuid: `u${i}`, timestamp: `2026-10-0${i + 1}T10:00:00.000Z` });
    records.push({
      parentUuid: `u${i}`,
      isSidechain: false,
      type: 'assistant',
      cwd,
      sessionId: 'x',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] },
      uuid: `a${i}`,
      timestamp: `2026-10-0${i + 1}T10:00:01.000Z`,
    });
    records.push({ type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }, timestamp: `2026-10-0${i + 1}T10:00:02.000Z` });
    records.push({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: a }] }, uuid: `b${i}`, timestamp: `2026-10-0${i + 1}T10:00:03.000Z` });
  });
  return jsonl([...records, ...extra]);
}

const codexRollout = (id: string, cwd: string, prompt: string, source: unknown = 'cli') =>
  jsonl([
    { timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd, source, originator: 'codex-tui' } },
    { timestamp: '2026-10-20T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { timestamp: '2026-10-20T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ]);

function write(file: string, text: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('the History window helpers', () => {
  it("names Claude Code's transcript folder after the working directory", () => {
    expect(claudeProjectFolder('/home/leandro/repos/looper')).toBe('-home-leandro-repos-looper');
    expect(claudeProjectFolder('/home/leandro/liaison/.tmp/')).toBe('-home-leandro-liaison--tmp');
    expect(claudeProjectFolder('C:\\Users\\leand\\repos\\looper')).toBe('C--Users-leand-repos-looper');
  });

  it('groups by Today, Yesterday, This Week, then month', () => {
    const now = new Date(2026, 10, 5, 15, 0).getTime(); // a Thursday
    const month = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}`;
    expect(dateGroupOf(new Date(2026, 10, 5, 1).getTime(), now, month).title).toBe('Today');
    expect(dateGroupOf(new Date(2026, 10, 4, 23).getTime(), now, month).title).toBe('Yesterday');
    expect(dateGroupOf(new Date(2026, 10, 2, 9).getTime(), now, month).title).toBe('This Week');
    expect(dateGroupOf(new Date(2026, 10, 1, 9).getTime(), now, month).title).toBe('2026-11');
    expect(dateGroupOf(new Date(2026, 8, 30).getTime(), now, month).title).toBe('2026-9');
  });

  it('filters by project, task runs, title or a message search, and groups by project in their order', () => {
    const item = (id: string, projectId: string, source: HistoryItem['source'], title: string, lastActive: number): HistoryItem => ({ id, projectId, source, title, lastActive, harnessKind: 'claude-code', taskId: projectTaskId(projectId) });
    const items = [item('a', 'p1', 'chat', 'Fix the build', 3), item('b', 'p2', 'run', 'Nightly check', 2), item('c', 'p1', 'codex', 'Write docs', 1)];
    const f = { projectId: '', showRuns: true, title: '', found: null };
    expect(filterHistory(items, f).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(filterHistory(items, { ...f, showRuns: false }).map((i) => i.id)).toEqual(['a', 'c']);
    expect(filterHistory(items, { ...f, projectId: 'p1', title: 'DOCS' }).map((i) => i.id)).toEqual(['c']);
    expect(filterHistory(items, { ...f, title: 'zzz', found: new Set(['b']) }).map((i) => i.id)).toEqual(['b']);
    const groups = groupHistory(items, 'project', [{ id: 'p2', name: 'Two' }, { id: 'p1', name: 'One' }], 0);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ['Two', ['b']],
      ['One', ['a', 'c']],
    ]);
    expect(historySourceText({ source: 'run', taskName: 'Nightly' })).toBe('Task run · Nightly');
    expect(historySourceText({ source: 'remote' })).toBe('Remote Control');
  });

  it("finds every session a run folder names, the classifier's apart", () => {
    const dir = mkdtempSync(join(tmpdir(), 'looper-run-refs-'));
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ session_id: 's-agent' }));
    writeFileSync(join(dir, 'stop.json'), JSON.stringify({ session_id: 's-agent' }));
    writeFileSync(join(dir, 'session1-stop.json'), JSON.stringify({ transcript_path: '/x/s-ended.jsonl' }));
    writeFileSync(join(dir, 'classify-session.json'), JSON.stringify({ session_id: 's-classifier' }));
    writeFileSync(join(dir, 'codex-session.json'), JSON.stringify({ thread_id: 't-codex' }));
    writeFileSync(join(dir, 'chat.json'), JSON.stringify({ title: 'not a session' }));
    expect(runSessionRefs(dir).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 's-agent', classifier: false },
      { sessionId: 's-classifier', classifier: true },
      { sessionId: 's-ended', classifier: false },
      { sessionId: 't-codex', classifier: false },
    ]);
  });
});

describe('the History scanner', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), 'looper-history-'));
    const dataDir = join(root, 'data');
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    mkdirSync(dataDir, { recursive: true });
    const settings = loadSettings(dataDir, detectHost());
    const projects: Project[] = [
      ProjectSchema.parse({ id: 'looper', name: 'Looper', environmentId: 'local', cwd: '/w/looper' }),
      ProjectSchema.parse({ id: 'ab', name: 'A-B', environmentId: 'local', cwd: '/w/a-b' }),
    ];
    const runs = new RunStore(dataDir);
    const ledger = new SessionLedger(join(dataDir, LEDGER_FILE));
    const nightly = TaskSchema.parse({ id: 'nightly', name: 'Nightly', projectId: 'looper', trigger: { mode: 'manual' }, environmentId: 'local', cwd: '/w/looper', agent: { prompt: 'x' } });
    const findTask = (id: string) => (id === 'nightly' ? nightly : id === projectTaskId('looper') ? projectSessionTask(projects[0], settings) : undefined);
    let probes = 0;
    const service = new HistoryService({
      dataDir,
      host: detectHost(),
      settings,
      log: new Logger(),
      projects: () => projects,
      runTaskIds: () => runs.listTaskIds(),
      findTask,
      summaries: (taskId) => runs.summaries(taskId),
      runDir: (taskId, runId) => runs.runDir(taskId, runId),
      readChatInfo: (taskId, runId) => runs.readChatInfo(taskId, runId),
      readTerminalInfo: (taskId, runId) => runs.readTerminalInfo(taskId, runId),
      remoteRuns: () => new Set(),
      readRun: async () => [],
      compactableRun: async () => [],
      runSubagents: async () => [],
      subagentsAt: async () => [],
      ledger,
      configDirs: async (): Promise<ConfigDirs> => {
        probes += 1;
        return { claude: [claude], codex: [codex] };
      },
    });
    const folder = (cwd: string) => join(claude, 'projects', claudeProjectFolder(cwd));
    return { dataDir, claude, codex, runs, ledger, service, folder, probes: () => probes };
  }

  it("lists a project's own folder only: its title, else its first message, and Codex threads started there", async () => {
    const { codex, service, folder } = setup();
    write(join(folder('/w/looper'), 'titled.jsonl'), claudeTranscript('/w/looper', [['fix the build', 'fixed']], [{ type: 'ai-title', aiTitle: 'Fixing the build', sessionId: 'titled' }]));
    write(join(folder('/w/looper'), 'plain.jsonl'), claudeTranscript('/w/looper', [['add a History window\nwith three panes', 'added']]));
    write(join(folder('/w/looper'), 'renamed.jsonl'), claudeTranscript('/w/looper', [['q', 'a']], [{ type: 'ai-title', aiTitle: 'AI' }, { type: 'custom-title', customTitle: 'My name' }]));
    write(join(folder('/w/looper'), 'empty.jsonl'), jsonl([{ type: 'permission-mode', permissionMode: 'auto' }]));
    // A session started in a subfolder has a folder of its own, which isn't read.
    write(join(folder('/w/looper/docs'), 'sub.jsonl'), claudeTranscript('/w/looper/docs', [['docs only', 'ok']]));
    // "/w/a/b" and the project "/w/a-b" share a folder name: only the exact folder counts.
    write(join(folder('/w/a-b'), 'collide.jsonl'), claudeTranscript('/w/a/b', [['elsewhere', 'ok']]));
    write(join(folder('/w/a-b'), 'mine.jsonl'), claudeTranscript('/w/a-b', [['in a-b', 'ok']]));
    // A folder no project has isn't read either.
    write(join(folder('/w/other'), 'other.jsonl'), claudeTranscript('/w/other', [['other', 'ok']]));
    write(join(codex, 'sessions', '2026', '10', '20', 'rollout-2026-10-20T10-00-00-c0dex-1.jsonl'), codexRollout('c0dex-1', '/w/looper', 'codex question'));
    write(join(codex, 'sessions', '2026', '10', '20', 'rollout-2026-10-20T11-00-00-c0dex-2.jsonl'), codexRollout('c0dex-2', '/w/elsewhere', 'not here'));
    write(join(codex, 'sessions', '2026', '10', '20', 'rollout-2026-10-20T12-00-00-c0dex-3.jsonl'), codexRollout('c0dex-3', '/w/looper', 'a review', { subagent: { other: 'guardian' } }));

    const items = await service.list(true);
    const got = items.map((i) => [i.projectId, i.source, i.sessionId, i.title]).sort((a, b) => String(a[2]).localeCompare(String(b[2])));
    expect(got).toEqual([
      ['looper', 'codex', 'c0dex-1', 'codex question'],
      ['ab', 'claude-code', 'mine', 'in a-b'],
      ['looper', 'claude-code', 'plain', 'add a History window'],
      ['looper', 'claude-code', 'renamed', 'My name'],
      ['looper', 'claude-code', 'titled', 'Fixing the build'],
    ]);
    expect(items.find((i) => i.sessionId === 'plain')?.lastActive).toBe(Date.parse('2026-10-01T10:00:03.000Z'));
  });

  it("leaves out Looper's own sessions: a live run folder's, and the ledger's, which says what a pruned run was", async () => {
    const { runs, ledger, service, folder } = setup();
    // A task run whose folder is still there: listed once, as the task run.
    runs.append({ ts: '2026-10-10T10:00:00.000Z', taskId: 'nightly', runId: '20261010-100000-aaaa', phase: 'result', result: 'success', summary: 'All green' });
    write(join(runs.runDir('nightly', '20261010-100000-aaaa'), 'session.json'), JSON.stringify({ session_id: 'live-run' }));
    write(join(folder('/w/looper'), 'live-run.jsonl'), claudeTranscript('/w/looper', [['run prompt', 'done']]));
    // A task run whose folder retention took: the ledger still says it's the task's run.
    ledger.add({ sessionId: 'pruned-run', kind: 'run', taskId: 'nightly', taskName: 'Nightly' });
    write(join(folder('/w/looper'), 'pruned-run.jsonl'), claudeTranscript('/w/looper', [['old run', 'done']]));
    // A task builder's and a classifier's sessions aren't conversations of the project's.
    ledger.add({ sessionId: 'builder', kind: 'builder', taskId: '' });
    write(join(folder('/w/looper'), 'builder.jsonl'), claudeTranscript('/w/looper', [['build a task', 'ok']]));
    ledger.add({ sessionId: 'classifier', kind: 'classifier', taskId: 'nightly' });
    write(join(folder('/w/looper'), 'classifier.jsonl'), claudeTranscript('/w/looper', [['classify', 'act']]));
    // A chat that went on with a conversation from outside: chat.json says which, so it shows once, as the chat.
    runs.append({ ts: '2026-10-11T10:00:00.000Z', taskId: projectTaskId('looper'), runId: '20261011-100000-bbbb', phase: 'chat', result: 'chat', summary: 'Resumed' });
    const info: ChatInfo = { harnessKind: 'claude-code', title: 'Resumed', settings: { permissionMode: '' }, resumedSession: 'resumed' };
    runs.writeChatInfo(projectTaskId('looper'), '20261011-100000-bbbb', info);
    writeFileSync(join(runs.runDir(projectTaskId('looper'), '20261011-100000-bbbb'), 'session.json'), JSON.stringify({ session_id: 'resumed' }));
    write(join(folder('/w/looper'), 'resumed.jsonl'), claudeTranscript('/w/looper', [['outside first', 'ok']]));

    const items = await service.list(true);
    const got = items.map((i) => [i.source, i.sessionId ?? '', i.title, i.taskName ?? '', i.runId ?? '']).sort((a, b) => a[1].localeCompare(b[1]));
    expect(got).toEqual([
      ['run', 'live-run', 'All green', 'Nightly', '20261010-100000-aaaa'],
      ['run', 'pruned-run', 'old run', 'Nightly', ''],
      ['chat', 'resumed', 'Resumed', '', '20261011-100000-bbbb'],
    ]);
  });

  it('keeps each transcript by path, size and modified time, shows the cached ones at once, and asks for the folders once', async () => {
    const { dataDir, service, folder, probes } = setup();
    const file = write(join(folder('/w/looper'), 'one.jsonl'), claudeTranscript('/w/looper', [['first title', 'ok']]));
    // A whole second, which setting it again gives back exactly.
    const stamp = Math.floor(Date.now() / 1000) - 60;
    utimesSync(file, stamp, stamp);
    expect((await service.list(true)).map((i) => i.title)).toEqual(['first title']);
    const cache = JSON.parse(readFileSync(join(dataDir, HISTORY_CACHE_FILE), 'utf8')) as Record<string, { size: number; mtimeMs: number; meta: { title: string } }>;
    const st = statSync(file);
    expect(cache[file]).toMatchObject({ size: st.size, mtimeMs: st.mtimeMs, meta: { title: 'first title' } });

    // Same size and modified time: the cached title stands, the file isn't read again.
    const sameSize = claudeTranscript('/w/looper', [['other title', 'ok']]);
    expect(sameSize.length).toBe(st.size);
    writeFileSync(file, sameSize);
    utimesSync(file, stamp, stamp);
    expect((await service.list(true)).map((i) => i.title)).toEqual(['first title']);

    // A changed file is read again.
    writeFileSync(file, claudeTranscript('/w/looper', [['a longer, newer title', 'ok']]));
    expect((await service.list(true)).map((i) => i.title)).toEqual(['a longer, newer title']);

    // The cached list comes without reading any folder, even in a new service (a new start of Looper).
    rmSync(file);
    const again = new HistoryService({ ...(service as unknown as { d: ConstructorParameters<typeof HistoryService>[0] }).d });
    expect((await again.list(false)).map((i) => i.title)).toEqual(['a longer, newer title']);
    expect((await again.list(true)).map((i) => i.title)).toEqual([]);
    // Once per environment in each service.
    expect(probes()).toBe(2);
  });
});

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A stand-in for `claude -p --input-format stream-json` that records its arguments and each message, and resumes the session it's given. */
function fakeClaude(dir: string): { command: string; args: string; received: string } {
  const args = join(dir, 'args.jsonl');
  const received = join(dir, 'received.jsonl');
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(args)}, JSON.stringify(argv) + '\\n');
const at = argv.indexOf('--resume');
const session = at >= 0 ? argv[at + 1] : 's' + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type !== 'user') return;
  fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify(m.message.content) + '\\n');
  n++;
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake' });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'reply ' + n }] } });
  out({ type: 'result', subtype: 'success', result: 'reply ' + n });
});
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return { command: sh, args, received };
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : []);

describe.skipIf(process.platform === 'win32')('continuing a conversation from outside Looper', { timeout: 30_000 }, () => {
  let manager: ChatManager | null = null;
  let engine: Engine | null = null;
  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
    await engine?.stop();
    engine = null;
  });

  it("resumes the session in a chat, shows the transcript as its history, and records in chat.json what it went on with", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-resume-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-resume-cwd-'));
    const fake = fakeClaude(dir);
    const host = detectHost();
    const settings = loadSettings(dataDir, host);
    settings.environments = settings.environments.map((e) =>
      e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fake.command, args: [], env: {} }] } : e,
    );
    const task = TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x', model: 'opus' } });
    const transcript = write(join(dir, 'outside.jsonl'), claudeTranscript(dir, [['old question', 'old answer']]));
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
      readTranscript: transcriptHistory,
      writeInfo: (_t, _r, info) => void infos.push(info),
      appendRecord: () => undefined,
      taskVersion: () => undefined,
      onLimits: () => undefined,
    });

    // A Codex conversation can't go on in Claude Code.
    expect(() => manager!.start(task, { kind: 'resume', sessionId: 'thread-1', harnessKind: 'codex', transcript })).toThrow(
      'This conversation ran on Codex, and the project uses Claude Code.',
    );

    const chat = manager.start(task, { kind: 'resume', sessionId: 'outside-1', harnessKind: 'claude-code', transcript });
    expect(chat.harnessLocked).toBe(true);
    expect(chat.historyLabel).toBe('Earlier in Claude Code');
    await until(() => (manager!.get(chat.id)?.history.length ?? 0) > 0, 'the history');
    expect(manager.get(chat.id)!.history.filter((r) => r.kind !== 'tool').map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'old question'],
      ['agent', 'old answer'],
    ]);
    await until(() => lines(fake.args).length > 0, 'claude to start');
    const argv = lines(fake.args)[0] as string[];
    expect(argv[argv.indexOf('--resume') + 1]).toBe('outside-1');
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');

    expect(manager.findOpen(task.id, '', 'outside-1')?.id).toBe(chat.id);
    manager.send(chat.id, 'go on', []);
    await until(() => (manager!.get(chat.id)?.rows ?? []).some((r) => r.kind === 'agent'), 'the reply');
    expect(infos.at(-1)).toMatchObject({ harnessKind: 'claude-code', title: 'go on', resumedSession: 'outside-1' });
  });

  it('Continue in Chat and Continue Compacted on a conversation from outside, through the engine and its History list', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-history-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-history-cwd-'));
    const claudeDir = join(dataDir, 'claude-config');
    const fake = fakeClaude(dir);
    engine = createEngine({ dataDir, historyDirs: async () => ({ claude: [claudeDir], codex: [] }) });
    engine.start();
    engine.updateSettings({
      environments: engine.settings.environments.map((e) =>
        e.id === 'local' ? { ...e, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fake.command }] } : e,
      ),
    });
    const project = engine.saveProject({ name: 'Work', environmentId: 'local', cwd: dir, harnessId: 'fake' });
    const file = write(join(claudeDir, 'projects', claudeProjectFolder(dir), 'outside-2.jsonl'), claudeTranscript(dir, [['plan the release', 'here is the plan']], [{ type: 'ai-title', aiTitle: 'Release plan' }]));
    utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    const [item] = await engine.historyList(true);
    expect(item).toMatchObject({ source: 'claude-code', projectId: project.id, title: 'Release plan', sessionId: 'outside-2' });
    expect(engine.historyCommands(item.id)).toMatchObject({ chat: true, terminal: true, compact: true, sessionId: 'outside-2', outside: true });
    expect((await engine.historyRead(item.id))!.rows.filter((r) => r.kind !== 'tool').map((r) => r.text)).toEqual(['plan the release', 'here is the plan']);

    // Continue Compacted: a new chat that starts from the messages only, whatever the harness.
    const compacted = await engine.compactHistory(item.id);
    expect(compacted.historyLabel).toBe('Compacted from "Release plan"');
    expect(compacted.history.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', 'plan the release'],
      ['agent', 'here is the plan'],
    ]);
    expect(compacted.harnessLocked).toBe(false);
    await until(() => engine!.getChat(compacted.id)?.status === 'ready', 'the compacted chat');
    engine.sendChat(compacted.id, 'shorter please', []);
    await until(() => lines(fake.received).length === 1, 'the compacted message');
    const sent = lines(fake.received)[0] as { text: string }[];
    expect(sent[0].text).toContain('[User]\nplan the release');
    expect(sent[1].text).toBe('shorter please');
    await until(() => !!engine!.getChat(compacted.id)?.rows.some((r) => r.kind === 'agent'), 'the compacted reply');
    const compactedInfo = JSON.parse(readFileSync(join(engine.runDir(projectTaskId(project.id), compacted.id), 'chat.json'), 'utf8')) as ChatInfo;
    expect(compactedInfo.compactedFrom).toBe('outside-2');
    await engine.closeChat(compacted.id);

    // Continue in Chat: the chat resumes the session itself; asking again brings the same chat.
    const chat = engine.continueHistoryInChat(item.id);
    expect(engine.continueHistoryInChat(item.id).id).toBe(chat.id);
    expect(engine.historyCommands(item.id)).toMatchObject({ chat: true, terminal: false, outside: false });
    await until(() => lines(fake.args).some((a) => (a as string[]).includes('outside-2')), 'claude to resume');
    engine.sendChat(chat.id, 'next step', []);
    await until(() => !!engine!.getChat(chat.id)?.rows.some((r) => r.kind === 'agent'), 'the reply');
    const dirOf = engine.runDir(projectTaskId(project.id), chat.id);
    expect((JSON.parse(readFileSync(join(dirOf, 'chat.json'), 'utf8')) as ChatInfo).resumedSession).toBe('outside-2');
    // The ledger has it too, so it stays Looper's chat once retention takes the run folder.
    expect(readFileSync(join(dataDir, LEDGER_FILE), 'utf8')).toContain('"sessionId":"outside-2","kind":"chat"');

    // The chat is a run of the project now: the History list shows the conversation once, as the chat.
    writeFileSync(join(dirOf, 'session.json'), JSON.stringify({ session_id: 'outside-2', transcript_path: file }));
    const after = await engine.historyList(true);
    expect(after.filter((i) => i.sessionId === 'outside-2').map((i) => [i.source, i.runId])).toEqual([['chat', chat.id]]);
  });
});
