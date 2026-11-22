import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine, type EngineOptions } from '../src/engine/engine';
import type { AgentEnd, AgentHandle } from '../src/engine/steps/agent';
import type { RunContext } from '../src/engine/steps/common';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A stand-in for `claude -p --input-format stream-json`: each message ends its turn at once. */
function fakeClaude(dir: string): string {
  const js = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(
    js,
    `
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// It ends with its input, so a test that stops early leaves nothing running.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 'chat-session', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  // A message with FULL in it, unless it starts a compacted chat, ends its turn on a full context.
  const text = typeof m.message.content === 'string' ? m.message.content : m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\\n');
  if (text.includes('FULL') && !text.startsWith('<compacted-conversation>')) {
    out({ type: 'assistant', parent_tool_use_id: null, error: 'invalid_request', is_api_error_message: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] } });
    return out({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', terminal_reason: 'blocking_limit' });
  }
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } });
  out({ type: 'result', subtype: 'success', result: 'ok' });
}).on('close', () => process.exit(0));
`,
  );
  const sh = path.join(dir, 'fake-claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

/** The task's agent step: records each start, and ends as `ends` says (the first one also records its conversation). */
function fakeAgent(starts: RunContext[], ends: (AgentEnd & { doneStatus?: string })[]): NonNullable<EngineOptions['steps']>['startAgent'] {
  return async (ctx) => {
    starts.push(ctx);
    if (starts.length === 1) fs.writeFileSync(path.join(ctx.runDir, 'session.json'), JSON.stringify({ session_id: 'run-session' }));
    const end = ends.shift()!;
    const handle: AgentHandle = {
      runId: ctx.runId,
      pid: 1,
      held: false,
      question: null,
      answer: () => false,
      permission: null,
      answerPermission: () => false,
      write: () => undefined,
      resize: () => undefined,
      deliverGuidance: () => undefined,
      stopTurn: () => undefined,
      stopBackground: () => undefined,
      snapshotRepl: async () => {
        throw new Error('unused');
      },
      turnOver: false,
      stop: async () => undefined,
      finished: new Promise((r) => setTimeout(() => r(end), 10)),
    };
    return handle;
  };
}

const ended = (headline: string, doneStatus: 'success' | 'warning', body?: string) =>
  ({ reason: 'done', exitCode: 0, headline, body, durationMs: 5, wasHeld: false, doneStatus }) as AgentEnd;

describe('a run opened in a chat', { timeout: 30_000 }, () => {
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
  });

  async function setUp(ends: AgentEnd[]) {
    const data = tmp('looper-engine-');
    const dir = tmp('looper-chat-');
    const starts: RunContext[] = [];
    const e = createEngine({
      dataDir: data,
      steps: { startAgent: fakeAgent(starts, ends) },
      authStatus: async () => Promise.reject(new Error('not asked in tests')),
    });
    engines.push(e);
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual', sendRelatedEvents: true }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    const event = (id: string) => e.request('event', { taskId: 't1', event: JSON.stringify({ looper_related_id: id }) });
    await event('a');
    const rt = () => e.listRuntimes().find((r) => r.taskId === 't1')!;
    await until(() => starts.length === 1 && rt().runs.length === 0, 'the first run');
    return { e, data, starts, rt, event, runId: rt().lastRunId! };
  }

  it('is running while the chat is open, its events reach the chat, and closing writes the report', async () => {
    const { e, starts, rt, event, runId } = await setUp([ended('first', 'warning'), ended('reported', 'success', '# Report')]);
    expect(rt().lastResult).toBe('warning');
    const chatId = e.startChat('t1', runId).id;
    expect(rt().runs).toMatchObject([{ runId, state: 'running', chat: chatId, relatedId: 'a' }]);
    expect(await e.canContinueRun('t1', runId)).toMatchObject({ chat: true, terminal: false, guidance: false });
    // Continue in Chat on the run again brings the same chat.
    expect(e.startChat('t1', runId).id).toBe(chatId);

    await event('a');
    await until(() => (e.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'agent'), "the chat's turn on the event");
    expect(e.getChat(chatId)!.rows.find((r) => r.kind === 'events')!.text).toBe('{"looper_related_id":"a"}');
    expect(starts).toHaveLength(1);

    await e.closeSession(chatId);
    await until(() => rt().runs.length === 0, 'the report');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ runId, agentSession: { id: 'chat-session', resume: true }, runDir: path.join(starts[0].runDir, 'report') });
    expect(starts[1].task.agent.mode).toBe('headless');
    expect(rt()).toMatchObject({ state: 'idle', lastRunId: runId, lastResult: 'success', lastDetail: 'reported' });
    const runs = await e.listRuns('t1', 100);
    expect(runs.filter((r) => r.runId === runId).at(-1)).toMatchObject({ phase: 'result', result: 'success', body: '# Report' });
  });

  it('compacted by itself, the chat hands the run to the new chat, which gets its events and writes its report', async () => {
    const { e, starts, rt, event, runId } = await setUp([ended('first', 'warning'), ended('reported', 'success', '# Report')]);
    const compacted: string[] = [];
    e.on((ev) => {
      if (ev.type === 'chat:compacted') compacted.push(ev.to);
    });
    const chatId = e.startChat('t1', runId).id;
    const replies = (id: string) => (e.getChat(id)?.rows ?? []).filter((r) => r.kind === 'agent' && r.text === 'ok').length;
    e.sendChat(chatId, 'one more thing', []);
    await until(() => replies(chatId) === 1 && e.getChat(chatId)?.status === 'ready', 'the reply');
    e.sendChat(chatId, 'now FULL', []);
    await until(() => compacted.length === 1, 'the compaction');
    const next = compacted[0];
    await until(() => e.getChat(chatId) === undefined, 'the old chat to close');
    // The run is still open, now in the new chat: closing the old one wrote no report.
    expect(rt().runs).toMatchObject([{ runId, state: 'running', chat: next }]);
    expect(starts).toHaveLength(1);
    expect(e.startChat('t1', runId).id).toBe(next);
    await until(() => replies(next) === 1 && e.getChat(next)?.status === 'ready', 'the message sent again');
    await event('a');
    await until(() => (e.getChat(next)?.rows ?? []).some((r) => r.kind === 'events'), "the run's event in the new chat");
    await until(() => replies(next) === 2 && e.getChat(next)?.status === 'ready', 'the turn on the event');
    await e.closeSession(next);
    await until(() => rt().runs.length === 0, 'the report');
    expect(starts).toHaveLength(2);
    expect(rt()).toMatchObject({ state: 'idle', lastRunId: runId, lastResult: 'success', lastDetail: 'reported' });
  });

  it('after Compact into New Chat, the new chat holds the run, gets its events, and its close writes the report', async () => {
    const { e, starts, rt, event, runId } = await setUp([ended('first', 'warning'), ended('reported', 'success', '# Report')]);
    const chatId = e.startChat('t1', runId).id;
    const replies = (id: string) => (e.getChat(id)?.rows ?? []).filter((r) => r.kind === 'agent' && r.text === 'ok').length;
    e.sendChat(chatId, 'one more thing', []);
    await until(() => replies(chatId) === 1 && e.getChat(chatId)?.status === 'ready', 'the reply');
    const next = (await e.compactChat(chatId)).id;
    // The old chat closed without ending the run or writing its report.
    expect(e.getChat(chatId)).toBeUndefined();
    expect(rt().runs).toMatchObject([{ runId, state: 'running', chat: next }]);
    expect(starts).toHaveLength(1);
    expect(e.startChat('t1', runId).id).toBe(next);
    await event('a');
    await until(() => (e.getChat(next)?.rows ?? []).some((r) => r.kind === 'events'), "the run's event in the new chat");
    await until(() => replies(next) === 1 && e.getChat(next)?.status === 'ready', 'the turn on the event');
    await e.closeSession(next);
    await until(() => rt().runs.length === 0, 'the report');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ runId, agentSession: { id: 'chat-session', resume: true } });
    expect(rt()).toMatchObject({ state: 'idle', lastRunId: runId, lastResult: 'success', lastDetail: 'reported' });
  });

  it("at Settings → Chats' idle limit, the agent writes the report on the chat's conversation, then the chat closes", async () => {
    const { e, starts, rt, runId } = await setUp([ended('first', 'success'), ended('reported', 'success', '# Report')]);
    e.updateSettings({ chats: { ...e.settings.chats, runIdle: { enabled: true, minutes: 0.05 } } });
    const chatId = e.startChat('t1', runId).id;
    e.sendChat(chatId, 'one more thing', []);
    await until(() => (e.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'agent'), 'the reply');
    await until(() => starts.length === 2, 'the report');
    expect(starts[1]).toMatchObject({ runId, agentSession: { id: 'chat-session', resume: true } });
    await until(() => e.getChat(chatId) === undefined && rt().runs.length === 0, 'the chat to close');
    expect(rt()).toMatchObject({ state: 'idle', lastRunId: runId, lastResult: 'success', lastDetail: 'reported' });
    expect(e.sessionsState().sessions.map((s) => s.id)).not.toContain(chatId);
  });

  it('Stop keeps the chat; at the idle limit it closes, and the run ends as stopped without a report', async () => {
    const { e, starts, rt, runId } = await setUp([ended('first', 'success')]);
    const chatId = e.startChat('t1', runId).id;
    e.sendChat(chatId, 'one more thing', []);
    await until(() => (e.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'agent'), 'the reply');
    expect(await e.stopTask('t1')).toBe(true);
    expect(e.getChat(chatId)).toBeDefined();
    expect(rt().runs).toMatchObject([{ runId, report: 'stopped' }]);
    e.updateSettings({ chats: { ...e.settings.chats, runIdle: { enabled: true, minutes: 0.05 } } });
    await until(() => e.getChat(chatId) === undefined && rt().runs.length === 0, 'the chat to close');
    expect(rt()).toMatchObject({ lastRunId: runId, lastResult: 'stopped' });
    expect(starts).toHaveLength(1);
  });

  it("tells a chat its agent's watched task's run ends, and the trigger events with the event id it watches", async () => {
    const { e } = await setUp([ended('first', 'success'), ended('Deployed v2', 'success', 'All checks passed.')]);
    const t1 = e.listTasks().find((t) => t.id === 't1')!;
    e.saveTask(TaskSchema.parse({ ...t1, id: 't2', name: 'Deploy' }));
    const ops = e.addFolder('Ops');
    const nightly = e.addFolder('Nightly', ops.id);
    const home = e.saveProject({ name: 'Home', environmentId: 'local', cwd: os.tmpdir() });
    e.saveTask(TaskSchema.parse({ ...t1, id: 't3', name: 'Backups', projectId: home.id, cwd: home.cwd, folderId: nightly.id }));
    const chatId = e.startChat('t1').id;
    expect(e.getChat(chatId)!.watchTasks).toEqual([
      { id: 't1', name: 'T1', events: [], own: true, folders: [] },
      { id: 't2', name: 'Deploy', events: [], own: true, folders: [] },
      { id: 't3', name: 'Backups', events: [], own: false, folders: [{ id: ops.id, name: 'Ops' }, { id: nightly.id, name: 'Nightly' }] },
    ]);
    // The agent watches the task's runs with looper-watch, as its helper asks.
    const watchDir = path.join(e.runDir('t1', chatId), 'watch');
    fs.mkdirSync(path.join(watchDir, 'requests'), { recursive: true });
    fs.writeFileSync(path.join(watchDir, 'requests', '1.req'), 'watch\n/x\ntask\nt2\n');
    await until(() => fs.existsSync(path.join(watchDir, 'responses', '1.code')), 'the answer');
    // The user watches its events with id 42 (Watch Task Events).
    e.setChatWatch(chatId, 't2', '42', true);
    expect(e.getChat(chatId)!.watchTasks![1].events).toEqual(['42']);
    const event = ['{"looper_related_id":"42","text":"reply"}', '{"looper_related_id":"7","text":"other"}'].join('\n');
    await e.request('event', { taskId: 't2', event });
    const t2 = () => e.listRuntimes().find((r) => r.taskId === 't2');
    await until(() => !!t2()?.lastRunId && t2()!.runs.length === 0, "the watched task's run");
    await until(() => (e.getChat(chatId)?.rows ?? []).filter((r) => r.kind === 'taskEvents').length === 2, 'both messages');
    expect(e.getChat(chatId)!.rows.filter((r) => r.kind === 'taskEvents').map((r) => r.text)).toEqual([
      '## Deploy (task t2): a trigger event\n\n```\n{"looper_related_id":"42","text":"reply"}\n```',
      `## Deploy (task t2), run ${t2()!.lastRunId} ended: Success. Deployed v2\n\nFinal report:\nAll checks passed.`,
    ]);
  });

  it('closed with nothing said, the run ends as it was', async () => {
    const { e, starts, rt, runId } = await setUp([ended('first', 'success')]);
    const chatId = e.startChat('t1', runId).id;
    expect(rt().runs).toHaveLength(1);
    await e.closeSession(chatId);
    expect(rt().runs).toEqual([]);
    expect(rt()).toMatchObject({ state: 'idle', lastResult: 'success', lastDetail: 'first' });
    expect(starts).toHaveLength(1);
  });
});

describe('a run Run Options put on another harness', { timeout: 30_000 }, () => {
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
  });

  it('goes on in a chat on that harness, not in a terminal or with guidance, and its report is written there too', async () => {
    const data = tmp('looper-engine-');
    const dir = tmp('looper-chat-');
    const starts: RunContext[] = [];
    const e = createEngine({
      dataDir: data,
      steps: { startAgent: fakeAgent(starts, [ended('first', 'warning'), ended('reported', 'success', '# Report')]) },
      authStatus: async () => Promise.reject(new Error('not asked in tests')),
    });
    engines.push(e);
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local'
          ? {
              ...env,
              shell: 'bash -c',
              harnesses: [
                { id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) },
                { id: 'other', name: 'Other', kind: 'claude-code' as const, command: fakeClaude(dir) },
              ],
            }
          : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    const rt = () => e.listRuntimes().find((r) => r.taskId === 't1')!;
    expect(e.runNow('t1', { harnessId: 'other' })).toBe(true);
    await until(() => starts.length === 1 && rt().runs.length === 0, 'the run');
    expect(starts[0].task.agent.harnessId).toBe('other');
    const runId = rt().lastRunId!;
    expect(await e.canContinueRun('t1', runId)).toEqual({ chat: true, terminal: false, guidance: false, compact: true, start: false });
    const chat = e.startChat('t1', runId);
    expect(chat.harnessId).toBe('other');
    // A message reached its agent, so closing the chat writes the run's report.
    await until(() => e.getChat(chat.id)?.status === 'ready', 'the chat to start');
    e.sendChat(chat.id, 'go on', []);
    await until(() => (e.getChat(chat.id)?.rows ?? []).some((r) => r.kind === 'agent'), "the chat's turn");
    await e.closeSession(chat.id);
    await until(() => rt().runs.length === 0 && starts.length === 2, 'the report');
    expect(starts[1].task.agent.harnessId).toBe('other');
  });
});
