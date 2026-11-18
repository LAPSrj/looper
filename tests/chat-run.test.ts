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
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 'chat-session', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } });
  out({ type: 'result', subtype: 'success', result: 'ok' });
});
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
        env.id === 'local' ? { ...env, harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual', sendRelatedEvents: true }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', prompt: 'x' } }));
    const event = (id: string) => {
      fs.mkdirSync(path.join(data, 'inbox'), { recursive: true });
      fs.writeFileSync(path.join(data, 'inbox', `${Date.now()}-${id}.json`), JSON.stringify({ op: 'run', taskId: 't1', event: JSON.stringify({ looper_related_id: id }) }));
    };
    event('a');
    const rt = () => e.listRuntimes().find((r) => r.taskId === 't1')!;
    await until(() => starts.length === 1 && rt().runs.length === 0, 'the first run');
    return { e, data, starts, rt, event, runId: rt().lastRunId! };
  }

  it('is running while the chat is open, its events reach the chat, and closing writes the report', async () => {
    const { e, starts, rt, event, runId } = await setUp([ended('first', 'warning'), ended('reported', 'success', '# Report')]);
    expect(rt().lastResult).toBe('warning');
    const chatId = e.startChat('t1', runId).id;
    expect(rt().runs).toMatchObject([{ runId, state: 'running', chat: chatId, relatedId: 'a' }]);
    expect(e.canContinueRun('t1', runId)).toMatchObject({ chat: true, terminal: false, guidance: false });
    // Continue in Chat on the run again brings the same chat.
    expect(e.startChat('t1', runId).id).toBe(chatId);

    event('a');
    await until(() => (e.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'agent'), "the chat's turn on the event");
    expect(e.getChat(chatId)!.rows.find((r) => r.kind === 'prompt')!.text).toContain('{"looper_related_id":"a"}');
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
