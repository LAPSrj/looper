import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
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

describe('Continue Run on a run stopped before its agent started', { timeout: 30_000 }, () => {
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
  });

  it('is offered for that run only, and starts the agent on its events in a new run', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-engine-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-cwd-'));
    const starts: RunContext[] = [];
    const e = createEngine({
      dataDir: data,
      steps: {
        startAgent: async (ctx) => {
          starts.push(ctx);
          // What a real agent start leaves in the run folder.
          fs.writeFileSync(path.join(ctx.runDir, 'prompt.txt'), 'x');
          const end: AgentEnd = { reason: 'done', exitCode: 0, headline: 'ok', durationMs: 5, wasHeld: false };
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
        },
      },
      authStatus: async () => Promise.reject(new Error('not asked in tests')),
    });
    engines.push(e);
    e.start();
    e.updateSettings({ environments: e.settings.environments.map((env) => (env.id === 'local' ? { ...env, shell: 'bash -c' } : env)) });
    // The check waits until the "go" file is there, so the first run is stopped in it.
    e.saveTask(
      TaskSchema.parse({
        id: 't1',
        name: 'T1',
        trigger: { mode: 'manual' },
        environmentId: 'local',
        cwd: dir,
        check: { command: `for i in $(seq 100); do [ -f go ] && break; sleep 0.1; done; echo '{"act":true,"summary":"go"}'` },
        agent: { mode: 'headless', prompt: 'x' },
      }),
    );
    const rt = () => e.listRuntimes().find((r) => r.taskId === 't1')!;
    await e.request('event', { taskId: 't1', event: '{"n":1}' });
    await until(() => rt().runs[0]?.state === 'checking', 'the check');
    const stopped = rt().runs[0].runId;
    expect((await e.canContinueRun('t1', stopped)).start).toBe(false);
    await e.stopTask('t1');
    await until(() => rt().runs.length === 0, 'the stop');
    expect(await e.canContinueRun('t1', stopped)).toEqual({ chat: false, terminal: false, guidance: false, compact: false, start: true });

    fs.writeFileSync(path.join(dir, 'go'), '');
    expect(await e.continueStoppedRun('t1', stopped)).toBe(true);
    await until(() => starts.length === 1 && rt().runs.length === 0, 'the agent');
    expect(starts[0].runId).not.toBe(stopped);
    expect(starts[0].vars.events).toBe('{"n":1}');
    expect(starts[0].vars.summary).toBe('go');
    // A run whose agent started is continued with its conversation, not this way.
    expect((await e.canContinueRun('t1', starts[0].runId)).start).toBe(false);
    await expect(e.continueStoppedRun('t1', starts[0].runId)).rejects.toThrow(/before its agent started/);
  });
});
