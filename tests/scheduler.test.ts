import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/engine/scheduler';
import { Logger } from '../src/engine/log';
import { RunStore } from '../src/engine/store/runs';
import { StateStore } from '../src/engine/store/state';
import { TaskStore } from '../src/engine/store/tasks';
import { SettingsSchema, type ActiveRun, type EngineEvent, type Settings, type TaskInput } from '../src/shared/types';
import type { AgentEnd, AgentHandle } from '../src/engine/steps/agent';
import type { CheckResult } from '../src/engine/steps/check';
import type { ClassifyResult } from '../src/engine/steps/classify';

const baseTask: TaskInput = {
  id: 't1',
  name: 'Task one',
  trigger: { mode: 'schedule', schedule: { cron: '*/1 * * * *' } },
  environmentId: 'local',
  cwd: '/tmp',
  check: { command: 'true' },
  agent: { prompt: 'do it' },
};

interface LiveAgent {
  runId: string;
  end: (e: AgentEnd) => void;
  hold: () => void;
  /** Push output as the agent would, into that run's terminal buffer. */
  out: (data: string) => void;
}

interface Harness {
  dir: string;
  tasks: TaskStore;
  runs: RunStore;
  settings: Settings;
  sched: Scheduler;
  events: EngineEvent[];
  clock: { now: number };
  checks: CheckResult[];
  classifies: ClassifyResult[];
  agentEnds: AgentEnd[];
  agentStarted: number;
  /** ctx.agentSession of each agent start, in order. */
  agentSessions: ({ id: string; resume: boolean } | undefined)[];
  liveAgent: LiveAgent | null;
  /** Every unscripted agent, in start order; with one run it is just `liveAgent`. */
  liveAgents: LiveAgent[];
  /** When true, runCheck blocks until the cycle's stop signal aborts. */
  hangChecks: boolean;
  /** One per agent start: the reason written to the run's `complete` file, as looper-complete would. */
  completeSignals: string[];
  tickN(n: number): Promise<void>;
}

function check(status: CheckResult['status'], extra: Partial<CheckResult> = {}): CheckResult {
  return { status, exitCode: status === 'error' ? 1 : 0, durationMs: 5, stdoutTail: '', ...extra };
}

function agentEnd(reason: AgentEnd['reason'], headline?: string, body?: string): AgentEnd {
  return { reason, exitCode: 0, headline, body, durationMs: 10, wasHeld: false };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function makeHarness(taskInput: TaskInput = baseTask): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
  const settings = SettingsSchema.parse({ tickMs: 100000, staggerFirstRun: { enabled: false } });
  const tasks = new TaskStore(path.join(dir, 'tasks.json'));
  tasks.load();
  tasks.upsert(taskInput);
  const runs = new RunStore(dir);
  const state = new StateStore(path.join(dir, 'state.json'));
  const log = new Logger();
  const clock = { now: 1_000_000 };
  const h: Partial<Harness> = {
    dir,
    tasks,
    runs,
    settings,
    events: [],
    clock,
    checks: [],
    classifies: [],
    agentEnds: [],
    agentStarted: 0,
    agentSessions: [],
    liveAgent: null,
    liveAgents: [],
    hangChecks: false,
    completeSignals: [],
  };
  const sched = new Scheduler({
    dataDir: dir,
    host: 'wsl',
    settings,
    tasks,
    runs,
    state,
    log,
    now: () => clock.now,
    steps: {
      runCheck: async (ctx) => {
        if (h.hangChecks) {
          await new Promise<void>((r) => {
            if (ctx.signal?.aborted) return r();
            ctx.signal?.addEventListener('abort', () => r(), { once: true });
          });
        }
        return h.checks!.shift() ?? check('noop');
      },
      runClassify: async () => h.classifies!.shift() ?? { status: 'noop', durationMs: 1, exitCode: 0 },
      startAgent: async (ctx, cb) => {
        h.agentStarted!++;
        h.agentSessions!.push(ctx.agentSession);
        const signal = h.completeSignals!.shift();
        if (signal !== undefined) fs.writeFileSync(path.join(ctx.runDir, 'complete'), signal + '\n', 'utf8');
        const scripted = h.agentEnds!.shift();
        let resolve!: (e: AgentEnd) => void;
        const finished = new Promise<AgentEnd>((r) => (resolve = r));
        const handle: AgentHandle = {
          runId: ctx.runId,
          pid: 1,
          held: false,
          write: () => undefined,
          resize: () => undefined,
          stop: async (reason = 'stopped', headline) => resolve(agentEnd(reason, headline)),
          finished,
        };
        if (scripted) {
          setImmediate(() => resolve(scripted));
        } else {
          const live: LiveAgent = {
            runId: ctx.runId,
            end: resolve,
            hold: () => cb.onHold?.(),
            out: (data) => cb.onData(data),
          };
          h.liveAgent = live;
          h.liveAgents!.push(live);
        }
        return handle;
      },
    },
  });
  sched.on('event', (e: EngineEvent) => h.events!.push(e));
  h.sched = sched;
  h.tickN = async (n: number) => {
    for (let i = 0; i < n; i++) {
      (sched as unknown as { tick(): void }).tick();
      await flush();
    }
  };
  sched.start();
  await flush();
  return h as Harness;
}

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.sched.stop();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const notifies = () =>
  h.events.filter((e): e is Extract<EngineEvent, { type: 'notify' }> => e.type === 'notify');

const records = () =>
  h.events
    .filter((e) => e.type === 'record')
    .map(
      (e) =>
        (e as { record: { phase: string; result: string; summary?: string; body?: string; network?: boolean; slept?: boolean } })
          .record,
    );

describe('Scheduler', () => {
  it('starts idle with a next run scheduled', () => {
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.nextRunAt).toBe(h.clock.now);
  });

  it('noop check goes back to idle and reschedules to the next cron slot', async () => {
    h.checks.push(check('noop', { summary: 'quiet' }));
    await h.tickN(1);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.lastResult).toBe('noop');
    expect(rt.lastDetail).toBe('quiet');
    expect(rt.nextRunAt).toBe(1_020_000); // next whole minute after 1_000_000
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:noop']);
    expect(h.agentStarted).toBe(0);
  });

  it('act check starts the agent and records its end', async () => {
    h.checks.push(check('act', { summary: '2 items', context: { n: 2 } }));
    h.agentEnds.push(agentEnd('done', 'fixed both', 'Fixed **a** and **b**.\n\nNothing left open.'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:act', 'agent:started', 'agent:done', 'result:done']);
    expect(records().at(-1)!.summary).toBe('fixed both');
    expect(records().at(-1)!.body).toBe('Fixed **a** and **b**.\n\nNothing left open.');
    expect(h.sched.get('t1')!.lastResult).toBe('done');
    expect(h.sched.get('t1')!.lastDetail).toBe('fixed both');
    expect(h.sched.get('t1')!.state).toBe('idle');
  });

  it('never overlaps: a tick while running is ignored, stopTask ends the run', async () => {
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    expect(h.liveAgent).not.toBeNull();
    h.clock.now += 60_000;
    await h.tickN(3);
    expect(h.agentStarted).toBe(1);
    expect(h.sched.runNow('t1')).toBe(false);
    await h.sched.stopTask('t1', 'test');
    await flush();
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(records().slice(-2).map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:stopped', 'result:stopped']);
  });

  it('stopTask mid-check ends the cycle as stopped without starting the agent', async () => {
    h.hangChecks = true;
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('checking');
    expect(await h.sched.stopTask('t1', 'test')).toBe(true);
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.lastResult).toBe('stopped');
    expect(rt.lastDetail).toBe('test');
    expect(rt.consecutiveErrors).toBe(0);
    expect(h.agentStarted).toBe(0);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:stopped']);
  });

  it('stopTask on an idle task is a no-op', async () => {
    expect(await h.sched.stopTask('t1')).toBe(false);
  });

  it('classifier gate: noop stops the cycle, act proceeds', async () => {
    h.tasks.patch('t1', { classifier: { enabled: true, model: 'haiku', prompt: 'p', timeoutSec: 10 } });
    h.checks.push(check('act'), check('act'));
    h.classifies.push({ status: 'noop', reason: 'just noise', durationMs: 1, exitCode: 0 });
    h.classifies.push({ status: 'act', reason: 'real work', durationMs: 1, exitCode: 0 });
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(0);
    expect(h.sched.get('t1')!.lastResult).toBe('noop');
    expect(h.sched.get('t1')!.lastDetail).toBe('classifier: just noise');
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
  });

  it('a task without a check step goes straight to the agent', async () => {
    h.tasks.patch('t1', { check: undefined });
    h.agentEnds.push(agentEnd('done', 'ran'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:started', 'agent:done', 'result:done']);
  });

  it('a manual task (schedule off) never self-schedules but runs on demand', async () => {
    h.tasks.patch('t1', { trigger: { mode: 'manual', schedule: { cron: '*/1 * * * *' } } });
    expect(h.sched.get('t1')!.nextRunAt).toBeNull();
    h.clock.now += 120_000;
    await h.tickN(2);
    expect(h.agentStarted).toBe(0);
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done', 'ran'));
    expect(h.sched.runNow('t1')).toBe(true);
    await flush();
    expect(h.agentStarted).toBe(1);
    expect(h.sched.get('t1')!.nextRunAt).toBeNull();
  });

  it('a disabled check keeps its config but is skipped', async () => {
    h.tasks.patch('t1', { check: { enabled: false, command: 'true', timeoutSec: 60 } });
    h.agentEnds.push(agentEnd('done', 'ran'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:started', 'agent:done', 'result:done']);
    expect(h.tasks.get('t1')!.check).toMatchObject({ enabled: false, command: 'true' });
  });

  it('a disabled classifier keeps its config but is skipped', async () => {
    h.tasks.patch('t1', { classifier: { enabled: false, model: 'haiku', prompt: 'p', timeoutSec: 10 } });
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done', 'ran'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:act', 'agent:started', 'agent:done', 'result:done']);
  });

  it('the classifier still gates a task without a check step', async () => {
    h.tasks.patch('t1', { check: undefined, classifier: { enabled: true, model: 'haiku', prompt: 'p', timeoutSec: 10 } });
    h.classifies.push({ status: 'noop', reason: 'nothing new', durationMs: 1, exitCode: 0 });
    await h.tickN(1);
    expect(h.agentStarted).toBe(0);
    expect(h.sched.get('t1')!.lastDetail).toBe('classifier: nothing new');
  });

  it('auto-pauses after consecutive errors', async () => {
    h.tasks.patch('t1', { backoff: { maxConsecutiveErrors: 2 } });
    h.checks.push(check('error', { error: 'boom' }), check('error', { error: 'boom' }));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
    h.clock.now += 60_000;
    await h.tickN(1);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('paused');
    expect(rt.pausedReason).toMatch(/auto-paused/);
    h.sched.resume('t1');
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(0);
  });

  it('records the looper-done status as the run outcome; error status counts as an error', async () => {
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push({ ...agentEnd('done', 'Deployed with caveats', 'Cache config needs a look.'), doneStatus: 'warning' });
    h.agentEnds.push({ ...agentEnd('done', 'Blocked: staging DB unreachable'), doneStatus: 'error' });
    await h.tickN(1);
    expect(records().slice(-2).map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:warning', 'result:warning']);
    expect(h.sched.get('t1')!.lastResult).toBe('warning');
    expect(h.sched.get('t1')!.lastDetail).toBe('Deployed with caveats');
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(0);
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(records().slice(-2).map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:error', 'result:error']);
    expect(h.sched.get('t1')!.lastResult).toBe('error');
    expect(h.sched.get('t1')!.lastDetail).toBe('Blocked: staging DB unreachable');
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
  });

  it('a usage-limited run retries at the reset time instead of the cron slot, without auto-pausing', async () => {
    h.tasks.patch('t1', { backoff: { maxConsecutiveErrors: 1 } });
    h.checks.push(check('act'));
    const retryAt = h.clock.now + 3 * 3_600_000;
    h.agentEnds.push({
      ...agentEnd('error', 'usage limit reached · resets 5:50am'),
      retryAtMs: retryAt,
    });
    await h.tickN(1);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.nextRunAt).toBe(retryAt);
    expect(rt.consecutiveErrors).toBe(0);
    expect(rt.lastResult).toBe('error');
    expect(rt.lastDetail).toBe('usage limit reached · resets 5:50am');
    expect(records().slice(-2).map((r) => `${r.phase}:${r.result}`)).toEqual(['agent:error', 'result:error']);
  });

  it('consumes a one-off note per run the agent received, clearing it at zero', async () => {
    h.tasks.patch('t1', { note: { text: 'skip the flaky mirror', runsLeft: 2 } });
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'), agentEnd('done'));
    await h.tickN(1);
    expect(h.tasks.get('t1')!.note).toEqual({ text: 'skip the flaky mirror', runsLeft: 1 });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.tasks.get('t1')!.note).toBeUndefined();
  });

  it('an error end (spawn failure, usage limit) does not consume the note', async () => {
    h.tasks.patch('t1', { note: { text: 'hint', runsLeft: 1 } });
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('error', 'cannot start Fake'));
    await h.tickN(1);
    expect(h.tasks.get('t1')!.note).toEqual({ text: 'hint', runsLeft: 1 });
  });

  it('a run stopped by the user does not consume the note', async () => {
    h.tasks.patch('t1', { note: { text: 'hint', runsLeft: 1 } });
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    await h.sched.stopTask('t1', 'test');
    await flush();
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(h.tasks.get('t1')!.note).toEqual({ text: 'hint', runsLeft: 1 });
  });

  it('a stop during the check step does not consume the note', async () => {
    h.tasks.patch('t1', { note: { text: 'hint', runsLeft: 1 } });
    h.hangChecks = true;
    h.checks.push(check('act'));
    await h.tickN(1);
    await h.sched.stopTask('t1', 'test');
    await flush();
    expect(h.tasks.get('t1')!.note).toEqual({ text: 'hint', runsLeft: 1 });
  });

  it('a cycle that never starts the agent leaves the note untouched', async () => {
    h.tasks.patch('t1', { note: { text: 'hint', runsLeft: 1 } });
    h.checks.push(check('noop'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(0);
    expect(h.tasks.get('t1')!.note).toEqual({ text: 'hint', runsLeft: 1 });
  });

  it('pause during a run takes effect after the cycle', async () => {
    h.checks.push(check('act'));
    await h.tickN(1);
    h.sched.pause('t1');
    expect(h.sched.get('t1')!.state).toBe('running');
    h.liveAgent!.end(agentEnd('done'));
    await flush();
    expect(h.sched.get('t1')!.state).toBe('paused');
  });

  it('a throwing step is recorded and does not kill the scheduler', async () => {
    h.checks.push({ get status(): never { throw new Error('kaboom'); } } as unknown as CheckResult);
    await h.tickN(1);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.consecutiveErrors).toBe(1);
    expect(records().at(-1)).toMatchObject({ phase: 'system', result: 'error' });
  });

  it('disabling a task parks it; enabling schedules it again', async () => {
    h.tasks.patch('t1', { enabled: false });
    expect(h.sched.get('t1')!.state).toBe('disabled');
    h.tasks.patch('t1', { enabled: true });
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(h.sched.get('t1')!.nextRunAt).toBe(1_020_000);
  });

  it('evaluates the schedule in the task timezone', async () => {
    // Now 10:02 UTC; daily at 09:00 Asia/Tokyo (UTC+9) = 00:00 UTC → next slot is tomorrow 00:00 UTC.
    h.clock.now = new Date('2026-01-15T10:02:00Z').getTime();
    h.tasks.patch('t1', { trigger: { mode: 'schedule', schedule: { cron: '0 9 * * *', timezone: 'Asia/Tokyo' } } });
    expect(h.sched.get('t1')!.nextRunAt).toBe(new Date('2026-01-16T00:00:00Z').getTime());
  });

  it('cron schedules skip slots that pass while busy', async () => {
    h.tasks.patch('t1', { trigger: { mode: 'schedule', schedule: { cron: '* * * * *' } } });
    h.sched.get('t1')!.nextRunAt = h.clock.now; // force due now
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    h.clock.now += 120_000;
    await h.tickN(1);
    expect(records().some((r) => r.phase === 'skip' && r.result === 'skipped')).toBe(true);
    h.liveAgent!.end(agentEnd('done'));
    await flush();
  });

  it('defers a due run while the environment is at its concurrency limit', async () => {
    h.settings.environments[0].maxConcurrentTasks = 1;
    h.tasks.upsert({ ...baseTask, id: 't2', name: 'Task two' });
    await flush();
    h.sched.get('t2')!.nextRunAt = h.clock.now; // due together with t1
    h.checks.push(check('act'), check('act'));
    await h.tickN(1);
    // t1 took the slot; t2 waits idle and stays due.
    expect(h.agentStarted).toBe(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    expect(h.sched.get('t2')!.state).toBe('idle');
    expect(h.sched.get('t2')!.nextRunAt).toBeLessThanOrEqual(h.clock.now);
    // A manual run respects the limit too.
    expect(h.sched.runNow('t2')).toBe(false);
    expect(records().at(-1)!.summary).toMatch(/manual run ignored: environment .* limit/);
    // Capacity frees: t2 starts on the next tick.
    h.liveAgent!.end(agentEnd('done'));
    await flush();
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
  });

  it('defers a due run while the harness is at its concurrency limit', async () => {
    h.settings.environments[0].harnesses[0].maxConcurrentTasks = 1;
    h.tasks.upsert({ ...baseTask, id: 't2', name: 'Task two' });
    await flush();
    h.sched.get('t2')!.nextRunAt = h.clock.now;
    h.checks.push(check('act'), check('act'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(h.sched.get('t2')!.state).toBe('idle');
    h.liveAgent!.end(agentEnd('done'));
    await flush();
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
  });
});

describe('simultaneous runs', () => {
  beforeEach(async () => {
    await h.sched.stop();
    fs.rmSync(h.dir, { recursive: true, force: true });
    h = await makeHarness({ ...baseTask, maxConcurrentRuns: 2 });
  });

  /** Start `n` cycles from consecutive cron slots, each with an act check and a live agent. */
  async function startRuns(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      h.checks.push(check('act'));
      if (i > 0) h.clock.now += 60_000;
      await h.tickN(1);
    }
  }

  it('runs two cycles at once and skips the slot past the cap', async () => {
    await startRuns(2);
    const rt = h.sched.get('t1')!;
    expect(h.agentStarted).toBe(2);
    expect(rt.runs).toHaveLength(2);
    expect(rt.runs.map((r) => r.state)).toEqual(['running', 'running']);
    expect(rt.state).toBe('running');
    expect(rt.currentRunId).toBe(h.liveAgents[1].runId);

    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
    expect(records().at(-1)).toMatchObject({
      phase: 'skip',
      result: 'skipped',
      summary: 'scheduled run skipped: 2 run(s) already active',
    });
  });

  it('the aggregate state is the most advanced run', async () => {
    h.hangChecks = true;
    h.checks.push(check('act'));
    await h.tickN(1); // run 1 sits in the check step
    expect(h.sched.get('t1')!.state).toBe('checking');
    h.hangChecks = false;
    h.checks.push(check('act'));
    h.clock.now += 60_000;
    await h.tickN(1);
    const rt = h.sched.get('t1')!;
    expect(rt.runs.map((r) => r.state)).toEqual(['checking', 'running']);
    expect(rt.state).toBe('running');
  });

  it('Run Now starts a second cycle while one is active', async () => {
    await startRuns(1);
    h.checks.push(check('act'));
    expect(h.sched.runNow('t1')).toBe(true);
    await flush();
    expect(h.agentStarted).toBe(2);
    expect(h.sched.get('t1')!.runs).toHaveLength(2);
    // At the cap the manual run is refused with the new wording.
    expect(h.sched.runNow('t1')).toBe(false);
    expect(records().at(-1)!.summary).toBe('manual run ignored: 2 run(s) already active');
  });

  it('stopTask without a run id stops the newest and leaves the other running', async () => {
    await startRuns(2);
    const nextRunAt = h.sched.get('t1')!.nextRunAt;
    expect(await h.sched.stopTask('t1', 'test')).toBe(true);
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.runs.map((r) => r.runId)).toEqual([h.liveAgents[0].runId]);
    expect(rt.state).toBe('running');
    expect(rt.currentRunId).toBe(h.liveAgents[0].runId);
    expect(rt.lastResult).toBe('stopped');
    // Already advanced when the cycle started: an early finish must not move it.
    expect(rt.nextRunAt).toBe(nextRunAt);
  });

  it('each finish reports, and only the last one parks the task', async () => {
    await startRuns(2);
    h.liveAgents[0].end(agentEnd('done', 'first'));
    await flush();
    let rt = h.sched.get('t1')!;
    expect(rt.state).toBe('running');
    expect(rt.lastResult).toBe('done');
    expect(rt.lastDetail).toBe('first');

    h.liveAgents[1].end({ ...agentEnd('done', 'second'), doneStatus: 'warning' });
    await flush();
    rt = h.sched.get('t1')!;
    expect(rt.runs).toEqual([]);
    expect(rt.state).toBe('idle');
    expect(rt.currentRunId).toBeNull();
    expect(rt.lastResult).toBe('warning');
    expect(rt.lastDetail).toBe('second');
    expect(rt.nextRunAt).toBe(1_080_000);
  });

  it('a run is held on its own; the task is held while any run is', async () => {
    await startRuns(2);
    h.liveAgents[1].hold();
    await flush();
    let rt = h.sched.get('t1')!;
    expect(rt.runs.map((r) => r.held)).toEqual([false, true]);
    expect(rt.held).toBe(true);
    h.liveAgents[1].end(agentEnd('done'));
    await flush();
    rt = h.sched.get('t1')!;
    expect(rt.held).toBe(false);
  });

  it('an environment limit defers the second run of the same task instead of skipping it', async () => {
    h.settings.environments[0].maxConcurrentTasks = 1;
    await startRuns(1);
    h.checks.push(check('act'));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().some((r) => r.phase === 'skip')).toBe(false);
    // Still due: retried every tick until the slot frees up.
    expect(h.sched.get('t1')!.nextRunAt).toBeLessThanOrEqual(h.clock.now);

    h.liveAgents[0].end(agentEnd('done'));
    await flush();
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
  });

  it('a pause with runs in flight stops new slots and parks the task when the last run ends', async () => {
    await startRuns(1);
    h.sched.pause('t1');
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(1); // the due slot did not start a second run
    let rt = h.sched.get('t1')!;
    expect(rt.state).toBe('running');
    expect(rt.nextRunAt).toBeNull();
    h.liveAgents[0].end(agentEnd('done'));
    await flush();
    rt = h.sched.get('t1')!;
    expect(rt.state).toBe('paused');
    // A manual run lifts the pending pause instead of ignoring it.
    h.sched.resume('t1');
    await startRuns(1);
    h.sched.pause('t1');
    h.checks.push(check('act'));
    expect(h.sched.runNow('t1')).toBe(true);
    await flush();
    expect(h.sched.get('t1')!.pausedReason).toBeNull();
  });

  it('disabling with runs in flight starts nothing more and parks the task disabled', async () => {
    await startRuns(1);
    h.tasks.patch('t1', { enabled: false });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    h.liveAgents[0].end(agentEnd('done'));
    await flush();
    expect(h.sched.get('t1')!.state).toBe('disabled');
  });

  it('the run that crosses the error threshold declares the auto-pause; a sibling cannot undo it', async () => {
    h.tasks.patch('t1', { backoff: { maxConsecutiveErrors: 2 } });
    await startRuns(2);
    h.liveAgents[0].end({ ...agentEnd('done', 'first'), doneStatus: 'error' });
    await flush();
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
    h.checks.push(check('act'));
    h.clock.now += 60_000;
    await h.tickN(1); // a third run replaces the finished one
    h.liveAgents[1].end({ ...agentEnd('done', 'second'), doneStatus: 'error' });
    await flush();
    let rt = h.sched.get('t1')!;
    expect(rt.pausedReason).toMatch(/auto-paused after 2/);
    expect(rt.state).toBe('running'); // pending: a run is still in flight
    expect(notifies().filter((n) => n.kind === 'auto-paused')).toHaveLength(0); // that toast is off by default
    h.liveAgents[2].end(agentEnd('done', 'fine'));
    await flush();
    rt = h.sched.get('t1')!;
    expect(rt.consecutiveErrors).toBe(0); // the streak reset, but the declared pause stands
    expect(rt.state).toBe('paused');
  });

  it('a usage-limit wait reported while a sibling runs holds off new slots and parks the task at the reset', async () => {
    await startRuns(2);
    const retryAt = h.clock.now + 3 * 3_600_000;
    h.liveAgents[0].end({ ...agentEnd('error', 'usage limit reached · resets 5:50am'), retryAtMs: retryAt });
    await flush();
    let rt = h.sched.get('t1')!;
    expect(rt.state).toBe('running');
    expect(rt.nextRunAt).toBe(retryAt);
    h.liveAgents[1].end(agentEnd('done'));
    await flush();
    rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.nextRunAt).toBe(retryAt);
  });

  it('a slot deferred by an environment limit is still owed when the last run ends', async () => {
    h.settings.environments[0].maxConcurrentTasks = 1;
    await startRuns(1);
    h.checks.push(check('act'));
    h.clock.now += 60_000;
    await h.tickN(1); // due, deferred
    const owed = h.sched.get('t1')!.nextRunAt!;
    expect(owed).toBeLessThanOrEqual(h.clock.now);
    h.clock.now += 5_000;
    h.liveAgents[0].end(agentEnd('done'));
    await flush();
    expect(h.sched.get('t1')!.nextRunAt).toBe(owed);
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
  });

  it('an agent exit the network took down is a silent network error, whatever ended it', async () => {
    await startRuns(1);
    h.liveAgents[0].end({ ...agentEnd('exited', 'claude exited 1'), network: true });
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.lastResult).toBe('exited');
    expect(rt.lastDetail).toBe('no network: claude exited 1');
    expect(rt.consecutiveErrors).toBe(0);
    expect(notifies()).toHaveLength(0);
    expect(records().find((r) => r.phase === 'agent' && r.result === 'exited')).toMatchObject({ network: true });
  });

  it('the terminal buffer is per run and outlives the last run', async () => {
    await startRuns(2);
    h.liveAgents[0].out('one');
    h.liveAgents[1].out('two');
    expect(h.sched.getBuffer('t1')!.data).toBe('two'); // the newest run
    expect(h.sched.getBuffer('t1', h.liveAgents[0].runId)!.data).toBe('one');

    h.liveAgents[1].end(agentEnd('done'));
    await flush();
    expect(h.sched.getBuffer('t1')!.data).toBe('one'); // the run still in flight
    h.liveAgents[0].end(agentEnd('done'));
    await flush();
    expect(h.sched.getBuffer('t1')).toMatchObject({ runId: h.liveAgents[1].runId, data: 'two' });

    // A new run clears out the buffers of the finished ones.
    h.checks.push(check('act'));
    h.clock.now += 120_000;
    await h.tickN(1);
    expect(h.sched.getBuffer('t1')).toEqual({ runId: h.liveAgents[2].runId, data: '' });
    expect(h.sched.getBuffer('t1', h.liveAgents[0].runId)).toBeNull();
  });
});

describe('rolling sessions', () => {
  const continueSessions = (maxRuns: number) =>
    h.tasks.patch('t1', { agent: { ...h.tasks.get('t1')!.agent, session: 'continue', sessionMaxRuns: maxRuns } });

  it('a fresh-session task (the default) passes no conversation to the agent', async () => {
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    expect(h.agentSessions).toEqual([undefined]);
    expect(h.sched.get('t1')!.session).toBeNull();
  });

  it('starts a conversation, resumes it, and rolls to a new one after the cap', async () => {
    continueSessions(2);
    h.checks.push(check('act'), check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'), agentEnd('done'), agentEnd('done'));
    await h.tickN(1);
    const first = h.sched.get('t1')!.session;
    expect(first).not.toBeNull();
    expect(first!.runs).toBe(1);
    expect(h.agentSessions[0]).toEqual({ id: first!.id, resume: false });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[1]).toEqual({ id: first!.id, resume: true });
    expect(h.sched.get('t1')!.session).toEqual({ id: first!.id, runs: 2 });
    // The cap is used up: the third run starts a new conversation.
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[2]!.resume).toBe(false);
    expect(h.agentSessions[2]!.id).not.toBe(first!.id);
    expect(h.sched.get('t1')!.session).toEqual({ id: h.agentSessions[2]!.id, runs: 1 });
  });

  it('a cap of 1 behaves like fresh: every run starts a new conversation', async () => {
    continueSessions(1);
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'), agentEnd('done'));
    await h.tickN(1);
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[0]!.resume).toBe(false);
    expect(h.agentSessions[1]!.resume).toBe(false);
    expect(h.agentSessions[1]!.id).not.toBe(h.agentSessions[0]!.id);
  });

  it('an error end books nothing: a failed start stores no id, a failed resume keeps the count', async () => {
    continueSessions(5);
    h.checks.push(check('act'), check('act'), check('act'));
    h.agentEnds.push(agentEnd('error', 'cannot start Fake'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.session).toBeNull();
    h.agentEnds.push(agentEnd('done'), agentEnd('error', 'usage limit'));
    h.clock.now += 60_000;
    await h.tickN(1);
    const booked = h.sched.get('t1')!.session!;
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[2]).toEqual({ id: booked.id, resume: true });
    expect(h.sched.get('t1')!.session).toEqual(booked);
  });

  it('a lost conversation clears the stored id so the next run starts a new one', async () => {
    continueSessions(5);
    h.checks.push(check('act'), check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    const first = h.sched.get('t1')!.session!;
    h.agentEnds.push({ ...agentEnd('error', 'the conversation to continue no longer exists'), sessionLost: true });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[1]).toEqual({ id: first.id, resume: true });
    expect(h.sched.get('t1')!.session).toBeNull();
    h.agentEnds.push(agentEnd('done'));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[2]!.resume).toBe(false);
    expect(h.agentSessions[2]!.id).not.toBe(first.id);
  });

  it('turning the setting off clears the stored conversation', async () => {
    continueSessions(5);
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'), agentEnd('done'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.session).not.toBeNull();
    h.tasks.patch('t1', { agent: { ...h.tasks.get('t1')!.agent, session: 'fresh' } });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[1]).toBeUndefined();
    expect(h.sched.get('t1')!.session).toBeNull();
  });

  it('editing the working directory drops the conversation: it cannot move', async () => {
    continueSessions(5);
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push(agentEnd('done'), agentEnd('done'));
    await h.tickN(1);
    const first = h.sched.get('t1')!.session!;
    h.tasks.patch('t1', { cwd: '/tmp/elsewhere' });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentSessions[1]!.resume).toBe(false);
    expect(h.agentSessions[1]!.id).not.toBe(first.id);
  });
});

describe('notifications', () => {
  it('default level (error or warning): errors and warnings notify, success does not', async () => {
    h.checks.push(check('act'), check('act'), check('act'));
    h.agentEnds.push({ ...agentEnd('done', 'blocked'), doneStatus: 'error' });
    h.agentEnds.push({ ...agentEnd('done', 'read the report'), doneStatus: 'warning' });
    h.agentEnds.push({ ...agentEnd('done', 'all good'), doneStatus: 'success' });
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual(['end:Error: Blocked']);
    expect(notifies()[0].title).toBe('Task one');
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies().at(-1)!.body).toBe('Warning: Read the report');
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies()).toHaveLength(2);
  });

  it("level 'all' includes no-action ends; level 'end' excludes them", async () => {
    h.tasks.patch('t1', { notifications: { end: 'all' } });
    h.checks.push(check('noop', { summary: 'quiet' }));
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual(['end:No action: Quiet']);
    h.tasks.patch('t1', { notifications: { end: 'end' } });
    h.checks.push(check('noop', { summary: 'quiet' }));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies()).toHaveLength(1);
  });

  it('run-start and agent-start both fire on a gated task; an ungated task sends only agent-start', async () => {
    h.tasks.patch('t1', { notifications: { runStart: true, agentStart: true, end: 'off' } });
    h.checks.push(check('act', { summary: '2 items' }));
    h.agentEnds.push(agentEnd('done', 'ok'));
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual([
      'run-start:Run started',
      'agent-start:Agent started: 2 items',
    ]);
    h.tasks.patch('t1', { check: undefined });
    h.agentEnds.push(agentEnd('done', 'ok'));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies().slice(2).map((n) => n.kind)).toEqual(['agent-start']);
  });

  it('an auto-pause replaces the end notification when on, and falls through to it when off', async () => {
    h.tasks.patch('t1', { backoff: { maxConsecutiveErrors: 1 }, notifications: { end: 'error', autoPaused: true } });
    h.checks.push(check('error', { error: 'boom' }));
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual([
      'auto-paused:Auto-paused after 1 consecutive errors',
    ]);
    h.sched.resume('t1');
    h.tasks.patch('t1', { notifications: { end: 'error', autoPaused: false } });
    h.checks.push(check('error', { error: 'boom' }));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies().at(-1)!.kind).toBe('end');
    expect(notifies().at(-1)!.body).toBe('Error: Check error: boom');
  });

  it('a usage-limit wait replaces the end notification when on, and falls through to it when off', async () => {
    h.tasks.patch('t1', { notifications: { end: 'error', usageLimit: true } });
    h.checks.push(check('act'), check('act'));
    h.agentEnds.push({ ...agentEnd('error', 'usage limit reached · resets 5:50am'), retryAtMs: h.clock.now + 3_600_000 });
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual([
      'usage-limit:Usage limit reached · resets 5:50am',
    ]);
    h.tasks.patch('t1', { notifications: { end: 'error', usageLimit: false } });
    h.agentEnds.push({ ...agentEnd('error', 'usage limit reached · resets 5:50am'), retryAtMs: h.clock.now + 7_200_000 });
    h.sched.get('t1')!.nextRunAt = h.clock.now; // skip the limit wait
    await h.tickN(1);
    expect(notifies().at(-1)!.kind).toBe('end');
  });

  it('a network error stays silent, records itself, and never touches the error streak', async () => {
    h.checks.push(check('error', { error: 'curl: (6) Could not resolve host', network: true }));
    await h.tickN(1);
    expect(notifies()).toHaveLength(0);
    const rec = records().at(-1)!;
    expect(rec).toMatchObject({ phase: 'check', result: 'error', network: true });
    const rt = h.sched.get('t1')!;
    expect(rt.consecutiveErrors).toBe(0);
    expect(rt.lastDetail).toMatch(/^no network: check error:/);
  });

  it('a network error notifies when the task asked for those', async () => {
    h.tasks.patch('t1', { notifications: { end: 'error', networkErrors: true } });
    h.checks.push(check('error', { error: 'offline', network: true }));
    await h.tickN(1);
    expect(notifies().map((n) => n.kind)).toEqual(['end']);
    expect(notifies()[0].body).toMatch(/^Error: No network:/);
  });

  it('an ordinary check error still notifies and counts', async () => {
    h.checks.push(check('error', { error: 'boom' }));
    await h.tickN(1);
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual(['end:Error: Check error: boom']);
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
    expect(records().at(-1)!.network).toBeUndefined();
  });

  it('a classifier or agent network error is silent too', async () => {
    h.tasks.patch('t1', { classifier: { enabled: true, model: 'haiku', prompt: 'p', timeoutSec: 10 } });
    h.checks.push(check('act'), check('act'));
    h.classifies.push({ status: 'error', error: 'ENOTFOUND', network: true, durationMs: 1, exitCode: 1 });
    await h.tickN(1);
    expect(notifies()).toHaveLength(0);
    expect(h.sched.get('t1')!.lastDetail).toMatch(/^no network: classifier error:/);

    h.classifies.push({ status: 'act', reason: 'go', durationMs: 1, exitCode: 0 });
    h.agentEnds.push({ ...agentEnd('error', "can't reach the API server"), network: true });
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(notifies()).toHaveLength(0);
    expect(h.sched.get('t1')!.lastDetail).toBe("no network: can't reach the API server");
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(0);
  });

  it('a network error neither counts nor resets a streak of real errors', async () => {
    h.tasks.patch('t1', { backoff: { maxConsecutiveErrors: 5 } });
    h.checks.push(check('error', { error: 'boom' }), check('error', { error: 'boom' }));
    await h.tickN(1);
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(2);
    h.checks.push(check('error', { error: 'offline', network: true }));
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(2);
  });

  it('a hold notifies when on', async () => {
    h.tasks.patch('t1', { notifications: { end: 'off', held: true } });
    h.checks.push(check('act'));
    await h.tickN(1);
    h.liveAgent!.hold();
    await flush();
    expect(notifies().map((n) => `${n.kind}:${n.body}`)).toEqual(['held:The agent is waiting for your input']);
    h.liveAgent!.end(agentEnd('done'));
    await flush();
    expect(notifies()).toHaveLength(1);
  });
});

describe('system sleep', () => {
  it('onSuspend stops a mid-check run silently and owes a re-run a grace later', async () => {
    h.tasks.patch('t1', { notifications: { end: 'all' } });
    h.hangChecks = true;
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('checking');
    h.sched.onSuspend();
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.lastResult).toBe('stopped');
    expect(rt.lastDetail).toBe('computer went to sleep');
    expect(rt.nextRunAt).toBe(h.clock.now + 20_000);
    expect(h.agentStarted).toBe(0);
    expect(notifies()).toHaveLength(0);
  });

  it('onSuspend ends a running agent the same way', async () => {
    h.tasks.patch('t1', { notifications: { end: 'all' } });
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    h.sched.onSuspend();
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.lastResult).toBe('stopped');
    expect(rt.nextRunAt).toBe(h.clock.now + 20_000);
    expect(notifies()).toHaveLength(0);
  });

  it('onSuspend leaves a held run alone', async () => {
    h.checks.push(check('act'));
    await h.tickN(1);
    h.liveAgent!.hold();
    await flush();
    h.sched.onSuspend();
    await flush();
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('running');
    expect(rt.held).toBe(true);
  });

  it('a sleep-stopped run neither counts toward nor resets the error streak', async () => {
    h.checks.push(check('error', { error: 'boom' }));
    await h.tickN(1);
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
    h.hangChecks = true;
    h.checks.push(check('act'));
    h.clock.now += 60_000;
    await h.tickN(1);
    h.sched.onSuspend();
    await flush();
    expect(h.sched.get('t1')!.consecutiveErrors).toBe(1);
  });

  it('a check error that provably spanned a sleep is silent, never counts, and re-arms the task', async () => {
    h.checks.push(check('error', { error: 'check exited 1', slept: true }));
    await h.tickN(1);
    expect(notifies()).toHaveLength(0);
    expect(records().at(-1)).toMatchObject({ phase: 'check', result: 'error', slept: true });
    const rt = h.sched.get('t1')!;
    expect(rt.consecutiveErrors).toBe(0);
    expect(rt.lastDetail).toMatch(/^slept through the run: check error:/);
    expect(rt.nextRunAt).toBe(h.clock.now + 20_000);
  });

  it('a sleep-spanning error notifies when the task asked for network errors', async () => {
    h.tasks.patch('t1', { notifications: { end: 'error', networkErrors: true } });
    h.checks.push(check('error', { error: 'boom', slept: true }));
    await h.tickN(1);
    expect(notifies().map((n) => n.kind)).toEqual(['end']);
    expect(notifies()[0].body).toMatch(/^Error: Slept through the run:/);
  });

  it('onResume defers due work past the grace and leaves future slots alone', async () => {
    const rt = h.sched.get('t1')!;
    rt.nextRunAt = h.clock.now - 5_000; // came due while asleep
    h.sched.onResume();
    expect(rt.nextRunAt).toBe(h.clock.now + 20_000);
    rt.nextRunAt = h.clock.now + 120_000;
    h.sched.onResume();
    expect(rt.nextRunAt).toBe(h.clock.now + 120_000);
  });
});

describe('startup overdue filtering', () => {
  it('non-overdue tasks wait for their next cron slot instead of running immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
    const settings = SettingsSchema.parse({ tickMs: 100000, staggerFirstRun: { enabled: false } });
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    tasks.upsert({ ...baseTask, trigger: { mode: 'schedule', schedule: { cron: '*/5 * * * *' } } });
    const state = new StateStore(path.join(dir, 'state.json'));
    // Last run at 10:01, now is 10:02 — the next */5 slot (10:05) hasn't passed.
    const now = new Date('2026-01-15T10:02:00Z').getTime();
    state.save({
      t1: {
        taskId: 't1',
        state: 'idle',
        held: false,
        runs: [],
        nextRunAt: null,
        lastRunAt: new Date('2026-01-15T10:01:00Z').getTime(),
        lastResult: 'success',
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: null,
        pausedReason: null,
        watcher: null,
        session: null,
      },
    });
    state.flush();
    const runs = new RunStore(dir);
    const sched = new Scheduler({
      dataDir: dir,
      host: 'wsl',
      settings,
      tasks,
      runs,
      state: new StateStore(path.join(dir, 'state.json')),
      log: new Logger(),
      now: () => now,
    });
    sched.start();
    const rt = sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.nextRunAt).toBe(new Date('2026-01-15T10:05:00Z').getTime());
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overdue tasks run on startup with the stagger delay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
    const settings = SettingsSchema.parse({ tickMs: 100000, staggerFirstRun: { enabled: false } });
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    tasks.upsert({ ...baseTask, trigger: { mode: 'schedule', schedule: { cron: '*/5 * * * *' } } });
    const state = new StateStore(path.join(dir, 'state.json'));
    // Last run 10 minutes ago — the 5-minute cron has fired since.
    const now = new Date('2026-01-15T10:10:00Z').getTime();
    state.save({
      t1: {
        taskId: 't1',
        state: 'idle',
        held: false,
        runs: [],
        nextRunAt: null,
        lastRunAt: now - 10 * 60_000,
        lastResult: 'success',
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: null,
        pausedReason: null,
        watcher: null,
        session: null,
      },
    });
    state.flush();
    const runs = new RunStore(dir);
    const sched = new Scheduler({
      dataDir: dir,
      host: 'wsl',
      settings,
      tasks,
      runs,
      state: new StateStore(path.join(dir, 'state.json')),
      log: new Logger(),
      now: () => now,
    });
    sched.start();
    const rt = sched.get('t1')!;
    expect(rt.state).toBe('idle');
    expect(rt.nextRunAt).toBe(now);
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('interrupted runs', () => {
  /** Start a scheduler over a snapshot whose runs were in flight when looper died. */
  async function restartWith(runs: ActiveRun[]): Promise<{ dir: string; store: RunStore; sched: Scheduler }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    tasks.upsert({ ...baseTask, maxConcurrentRuns: runs.length || 1 });
    const state = new StateStore(path.join(dir, 'state.json'));
    state.save({
      t1: {
        taskId: 't1',
        state: 'running',
        held: false,
        runs,
        nextRunAt: null,
        lastRunAt: 1,
        lastResult: null,
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: runs.at(-1)?.runId ?? null,
        pausedReason: null,
        watcher: null,
        session: null,
      },
    });
    state.flush();
    const store = new RunStore(dir);
    const sched = new Scheduler({
      dataDir: dir,
      host: 'wsl',
      settings: SettingsSchema.parse({}),
      tasks,
      runs: store,
      state,
      log: new Logger(),
    });
    sched.start();
    return { dir, store, sched };
  }

  const inFlight = (runId: string, state: ActiveRun['state'] = 'running'): ActiveRun => ({
    runId,
    state,
    held: false,
    startedAt: 1,
    trigger: 'timer',
  });

  it('are recorded on startup', async () => {
    const { dir, store, sched } = await restartWith([inFlight('old-run')]);
    expect(store.list('t1').at(-1)).toMatchObject({ runId: 'old-run', phase: 'system', result: 'interrupted' });
    expect(sched.get('t1')!.state).toBe('idle');
    expect(sched.get('t1')!.runs).toEqual([]);
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every run of a snapshot is recorded, not just the newest', async () => {
    const { dir, store, sched } = await restartWith([inFlight('run-a', 'checking'), inFlight('run-b')]);
    const interrupted = store.list('t1').filter((r) => r.result === 'interrupted');
    expect(interrupted.map((r) => r.runId)).toEqual(['run-a', 'run-b']);
    expect(interrupted.map((r) => r.summary)).toEqual([
      'looper restarted while checking',
      'looper restarted while running',
    ]);
    expect(sched.get('t1')!.runs).toEqual([]);
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a snapshot without runs is simply no active runs', async () => {
    const { dir, store, sched } = await restartWith([]);
    expect(store.list('t1').filter((r) => r.result === 'interrupted')).toEqual([]);
    expect(sched.get('t1')!.state).toBe('idle');
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('watcher trigger', () => {
  // The pool spawns a real (quiet) process; the event path is driven directly.
  const watcherTask = () =>
    h.tasks.patch('t1', { trigger: { mode: 'watcher', watcher: { command: 'sleep 60', debounceSec: 0 } } });
  const inject = (lines: string[]) =>
    (h.sched as unknown as { onWatcherEvents(id: string, l: string[]): void }).onWatcherEvents('t1', lines);

  it('a watcher task has no next slot and runs when a batch arrives', async () => {
    watcherTask();
    expect(h.sched.get('t1')!.nextRunAt).toBeNull();
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done', 'handled'));
    inject(['{"n":1}', '{"n":2}']);
    await flush();
    expect(h.agentStarted).toBe(1);
    const recs = records();
    expect(recs[0]).toMatchObject({ phase: 'watcher', result: 'act', summary: '2 event(s)' });
    // The unreferenced events are appended to the agent prompt.
    const started = recs.find((r) => r.phase === 'agent' && r.result === 'started')!;
    expect(started.body).toContain('## Trigger events');
    expect(started.body).toContain('{"n":2}');
    // The batch lands in the run dir for LOOPER_EVENTS_FILE.
    const runId = records().find((r) => r.phase === 'watcher')!;
    expect(runId).toBeTruthy();
  });

  it('events at the concurrency cap coalesce into one follow-up run', async () => {
    watcherTask();
    h.checks.push(check('act'));
    inject(['a']);
    await flush();
    expect(h.sched.get('t1')!.state).toBe('running');
    inject(['b']);
    inject(['c']);
    await h.tickN(1);
    expect(h.agentStarted).toBe(1); // coalesced, never queued
    h.checks.push(check('act'));
    h.liveAgent!.end(agentEnd('done'));
    await flush();
    await h.tickN(1);
    expect(h.agentStarted).toBe(2);
    expect(records().filter((r) => r.phase === 'watcher').map((r) => r.summary)).toEqual([
      '1 event(s)',
      '2 event(s)',
    ]);
    h.liveAgent!.end(agentEnd('done'));
    await flush();
  });

  it('events on a paused or disabled task are dropped, not held', async () => {
    watcherTask();
    h.sched.pause('t1');
    inject(['x']);
    await h.tickN(2);
    expect(h.agentStarted).toBe(0);
    h.sched.resume('t1');
    await h.tickN(2);
    expect(h.agentStarted).toBe(0); // the stale batch did not fire on resume
  });

  it('events outside the active hours are held and coalesce into one run when the window opens', async () => {
    // Clock starts at epoch 1_000_000 = Thu 1970-01-01 00:16 UTC — outside 7-22.
    h.tasks.patch('t1', {
      trigger: {
        mode: 'watcher',
        watcher: { command: 'sleep 60', debounceSec: 0, runOnStart: false, activeHours: { from: 7, to: 22 }, timezone: 'UTC' },
      },
    });
    inject(['a']);
    await h.tickN(2);
    expect(h.agentStarted).toBe(0);
    inject(['b']);
    await h.tickN(1);
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done'));
    h.clock.now = 30_000_000; // Thu 08:20 UTC — window open
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().find((r) => r.phase === 'watcher')!.summary).toBe('2 event(s)');
  });

  it('events on a disallowed weekday wait for an allowed one', async () => {
    h.tasks.patch('t1', {
      // Epoch day 0 is a Thursday; only Friday (5) is allowed.
      trigger: { mode: 'watcher', watcher: { command: 'sleep 60', debounceSec: 0, runOnStart: false, days: [5], timezone: 'UTC' } },
    });
    inject(['x']);
    await h.tickN(2);
    expect(h.agentStarted).toBe(0);
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done'));
    h.clock.now = 1_000_000 + 24 * 3_600_000; // Friday, same time of day
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
  });
});

describe('watcher runOnStart', () => {
  const watcherInput = (extra: object = {}): TaskInput => ({
    ...baseTask,
    trigger: { mode: 'watcher', watcher: { command: 'sleep 60', debounceSec: 0, runOnStart: true, ...extra } },
  });
  const remake = async (input: TaskInput) => {
    await h.sched.stop();
    fs.rmSync(h.dir, { recursive: true, force: true });
    h = await makeHarness(input);
  };

  it('fires one catch-up run through the check when watching starts, and only one', async () => {
    await remake(watcherInput());
    h.checks.push(check('noop', { summary: 'nothing missed' }));
    await h.tickN(1);
    expect(records().filter((r) => r.phase === 'watcher')).toEqual([
      expect.objectContaining({ result: 'act', summary: 'catch-up: watching started' }),
    ]);
    expect(records().at(-1)).toMatchObject({ phase: 'check', result: 'noop' });
    await h.tickN(3);
    expect(records().filter((r) => r.phase === 'watcher')).toHaveLength(1);
  });

  it('waits for the run window before catching up', async () => {
    await remake(watcherInput({ activeHours: { from: 7, to: 22 }, timezone: 'UTC' }));
    await h.tickN(2);
    expect(records()).toHaveLength(0); // 00:16 UTC: held
    h.checks.push(check('noop'));
    h.clock.now = 30_000_000; // 08:20 UTC
    await h.tickN(1);
    expect(records().find((r) => r.phase === 'watcher')!.summary).toBe('catch-up: watching started');
  });

  it('the watcher process itself follows the run window', async () => {
    await remake(watcherInput({ activeHours: { from: 7, to: 22 }, timezone: 'UTC' }));
    await h.tickN(1);
    expect(h.sched.get('t1')!.watcher).toBeNull(); // 00:16 UTC: window closed, nothing watches
    h.checks.push(check('noop'));
    h.clock.now = 30_000_000; // 08:20 UTC
    await h.tickN(1);
    expect(h.sched.get('t1')!.watcher).toBe('watching');
    h.clock.now = 84_000_000; // 23:20 UTC
    await h.tickN(1);
    // The window-close kill is awaited off the tick; give it a moment.
    for (let i = 0; i < 500 && h.sched.get('t1')!.watcher !== null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.sched.get('t1')!.watcher).toBeNull();
  });

  it('a pause lifted by resume owes a fresh catch-up', async () => {
    await remake(watcherInput());
    h.checks.push(check('noop'));
    await h.tickN(1);
    expect(records().filter((r) => r.phase === 'watcher')).toHaveLength(1);
    h.sched.pause('t1');
    h.sched.resume('t1');
    h.checks.push(check('noop'));
    await h.tickN(1);
    expect(records().filter((r) => r.phase === 'watcher')).toHaveLength(2);
  });
});

describe('task completion', () => {
  const allowComplete = () => h.tasks.patch('t1', { completion: { allowed: true } });

  it('the agent completing the task parks it and records why', async () => {
    allowComplete();
    h.checks.push(check('act'));
    h.completeSignals.push('the migration is finished');
    h.agentEnds.push(agentEnd('done', 'migrated'));
    await h.tickN(1);
    const task = h.tasks.get('t1')!;
    expect(task.completedAt).toBeTruthy();
    expect(task.completedReason).toBe('the migration is finished');
    expect(task.enabled).toBe(false);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('completed');
    expect(rt.nextRunAt).toBeNull();
    expect(records().map((r) => `${r.phase}:${r.result}`)).toContain('system:done');
    expect(records().at(-1)!.summary).toBe('Task completed: the migration is finished');
    // And it stays parked: later slots start nothing.
    h.clock.now += 10 * 60_000;
    await h.tickN(3);
    expect(h.agentStarted).toBe(1);
  });

  it('a task that does not allow it records the ignored signal and keeps running', async () => {
    h.checks.push(check('act'));
    h.completeSignals.push('all done forever');
    h.agentEnds.push(agentEnd('done', 'ok'));
    await h.tickN(1);
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(records().some((r) => r.summary?.startsWith('completion signal ignored: this task'))).toBe(true);
  });

  it('a stopped run never completes the task', async () => {
    allowComplete();
    h.checks.push(check('act'));
    h.completeSignals.push('done forever');
    await h.tickN(1);
    await h.sched.stopTask('t1', 'test');
    await flush();
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();
    expect(records().some((r) => r.summary === 'completion signal ignored: the run was stopped')).toBe(true);
  });

  it('the schedule end date completes the task, even while it is paused', async () => {
    h.tasks.patch('t1', {
      trigger: { mode: 'schedule', schedule: { cron: '*/1 * * * *' }, stopOn: { enabled: true, at: new Date(h.clock.now - 1000).toISOString() } },
    });
    h.sched.pause('t1');
    await h.tickN(1);
    const task = h.tasks.get('t1')!;
    expect(task.completedAt).toBeTruthy();
    expect(task.completedReason).toMatch(/^stopped running on /);
    expect(h.sched.get('t1')!.state).toBe('completed');
    expect(h.agentStarted).toBe(0);
  });

  it('the end date is ignored on a manual task, and before it is reached', async () => {
    h.tasks.patch('t1', {
      trigger: { mode: 'manual', schedule: { cron: '*/1 * * * *' }, stopOn: { enabled: true, at: new Date(h.clock.now - 1000).toISOString() } },
    });
    await h.tickN(1);
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();

    h.tasks.patch('t1', {
      trigger: { mode: 'schedule', schedule: { cron: '*/1 * * * *' }, stopOn: { enabled: true, at: new Date(h.clock.now + 60_000).toISOString() } },
    });
    h.checks.push(check('noop'));
    await h.tickN(1);
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();
    expect(h.tasks.get('t1')!.trigger.stopOn).toBeTruthy();
  });

  it('an end date that is switched off keeps its value and never stops the task', async () => {
    const at = new Date(h.clock.now - 1000).toISOString();
    h.tasks.patch('t1', { trigger: { mode: 'schedule', schedule: { cron: '*/1 * * * *' }, stopOn: { enabled: false, at } } });
    h.checks.push(check('noop'));
    await h.tickN(1);
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();
    expect(h.tasks.get('t1')!.trigger.stopOn).toEqual({ enabled: false, at });
  });

  it('reopening enables the task again and switches off the passed end date', async () => {
    h.tasks.patch('t1', {
      trigger: { mode: 'schedule', schedule: { cron: '*/1 * * * *' }, stopOn: { enabled: true, at: new Date(h.clock.now - 1000).toISOString() } },
    });
    await h.tickN(1);
    expect(h.tasks.get('t1')!.completedAt).toBeTruthy();
    h.sched.reopenTask('t1');
    const task = h.tasks.get('t1')!;
    expect(task.completedAt).toBeUndefined();
    expect(task.completedReason).toBeUndefined();
    expect(task.trigger.stopOn?.enabled).toBe(false);
    expect(task.enabled).toBe(true);
    expect(h.sched.get('t1')!.state).toBe('idle');
  });

  it('a task that does not allow completion refuses to be completed', () => {
    h.sched.completeTask('t1', 'by hand');
    expect(h.tasks.get('t1')!.completedAt).toBeUndefined();
    expect(h.sched.get('t1')!.state).toBe('idle');
  });

  it('a manual run of a completed task runs once and goes back to completed', async () => {
    allowComplete();
    h.sched.completeTask('t1', 'by hand');
    h.checks.push(check('act'));
    h.agentEnds.push(agentEnd('done', 'one more time'));
    expect(h.sched.runNow('t1')).toBe(true);
    await flush();
    expect(h.agentStarted).toBe(1);
    const rt = h.sched.get('t1')!;
    expect(rt.state).toBe('completed');
    expect(rt.nextRunAt).toBeNull();
  });

  it('sends one completion toast instead of the cycle end toast', async () => {
    h.tasks.patch('t1', {
      completion: { allowed: true },
      notifications: { end: 'all', completed: true },
    });
    h.checks.push(check('act'));
    h.completeSignals.push('nothing left to watch');
    h.agentEnds.push(agentEnd('done', 'watched'));
    await h.tickN(1);
    expect(notifies().map((n) => n.kind)).toEqual(['completed']);
    expect(notifies()[0].body).toBe('Completed: Nothing left to watch');
  });

  it('a completion outside a cycle toasts on its own', async () => {
    h.tasks.patch('t1', { completion: { allowed: true }, notifications: { completed: true } });
    h.sched.completeTask('t1', 'by hand');
    expect(notifies().map((n) => n.kind)).toEqual(['completed']);
  });

  it('completing ends the rolling conversation', async () => {
    h.tasks.patch('t1', { agent: { prompt: 'do it', session: 'continue' }, completion: { allowed: true } });
    h.checks.push(check('act'));
    h.completeSignals.push('finished');
    h.agentEnds.push(agentEnd('done', 'ok'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.session).toBeNull();
  });
});
