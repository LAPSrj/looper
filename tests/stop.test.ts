import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine, type EngineOptions } from '../src/engine/engine';
import type { AgentEnd, AgentHandle } from '../src/engine/steps/agent';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A stand-in for `claude -p --input-format stream-json` that logs each control request it gets, and ends a turn on an interrupt. */
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
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    fs.appendFileSync(path.join(dir, 'controls'), JSON.stringify(m.request) + '\\n');
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    if (m.request.subtype === 'interrupt') out({ type: 'result', subtype: 'error_during_execution' });
    return;
  }
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  // The turn goes on until an interrupt: a tool call that never returns.
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 99' } }] } });
}).on('close', () => process.exit(0));
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

const controls = (dir: string) => (existsSync(join(dir, 'controls')) ? readFileSync(join(dir, 'controls'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { subtype: string; [k: string]: unknown }) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Stop', { timeout: 30_000 }, () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  function setUp(steps?: EngineOptions['steps']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-stop-'));
    const e = createEngine({ dataDir, steps, authStatus: async () => Promise.reject(new Error('not asked in tests')) });
    engine = e;
    e.start();
    e.updateSettings({
      environments: e.settings.environments.map((env) =>
        env.id === 'local' ? { ...env, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : env,
      ),
    });
    e.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    return { e, dir };
  }

  it("a headless chat's Stop ends the turn with the interrupt, which spares the background work, and keeps the agent for the next message", async () => {
    const { e, dir } = setUp();
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    // Claude Code 2.1.330 reads perTaskStopAffordance at initialize: Stop then leaves background subagents and workflows alone (checked live).
    await until(() => controls(dir).length > 0, 'the initialize request');
    expect(controls(dir)[0]).toEqual({ subtype: 'initialize', perTaskStopAffordance: true });

    e.sendChat(chatId, 'go', []);
    await until(() => (e.getChat(chatId)?.rows ?? []).some((r) => r.kind === 'tool'), 'the tool call');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await e.stopSession(chatId);
    await until(() => e.getChat(chatId)?.status === 'ready', 'the turn to end');
    expect(controls(dir).map((c) => c.subtype)).toContain('interrupt');
    // No stop_task for any background task, and the process stays.
    expect(controls(dir).map((c) => c.subtype)).not.toContain('stop_task');
    expect(alive(pid)).toBe(true);
  });

  it("Stop on a headless chat's background task, a subagent too, sends stop_task with its id", async () => {
    const { e, dir } = setUp();
    const chatId = e.startChat('t1').id;
    await until(() => e.getChat(chatId)?.status === 'ready', 'the chat to start');
    await e.stopBackground(chatId, 'a3b67f0cc9e495e48');
    await until(() => controls(dir).some((c) => c.subtype === 'stop_task'), 'the stop_task request');
    expect(controls(dir).find((c) => c.subtype === 'stop_task')).toEqual({ subtype: 'stop_task', task_id: 'a3b67f0cc9e495e48' });
  });

  it('Stop on a task run ends the whole run, not only its turn', async () => {
    const calls: string[] = [];
    let end!: (e: AgentEnd) => void;
    const startAgent: NonNullable<EngineOptions['steps']>['startAgent'] = async (ctx) => {
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
        stopTurn: () => void calls.push('stopTurn'),
        stopBackground: () => undefined,
        snapshotRepl: async () => {
          throw new Error('unused');
        },
        turnOver: false,
        stop: async (reason) => {
          calls.push(`stop ${reason}`);
          end({ reason: 'stopped', exitCode: 0, headline: 'stopped', durationMs: 5, wasHeld: false } as AgentEnd);
        },
        finished: new Promise<AgentEnd>((r) => (end = r)),
      };
      return handle;
    };
    const { e } = setUp({ startAgent });
    expect(e.runNow('t1')).toBe(true);
    await until(() => e.listRuntimes().some((r) => r.taskId === 't1' && r.runs.length === 1), 'the run');
    const runId = e.listRuntimes().find((r) => r.taskId === 't1')!.runs[0].runId;
    await e.stopSession(runId);
    expect(calls).toEqual(['stop stopped']);
    await until(() => e.listRuntimes().find((r) => r.taskId === 't1')!.runs.length === 0, 'the run to end');
  });
});
