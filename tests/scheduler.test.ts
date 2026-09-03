import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/engine/scheduler';
import { Logger } from '../src/engine/log';
import { RunStore } from '../src/engine/store/runs';
import { StateStore } from '../src/engine/store/state';
import { TaskStore } from '../src/engine/store/tasks';
import { SettingsSchema, type EngineEvent, type Settings, type TaskInput } from '../src/shared/types';
import type { AgentEnd, AgentHandle } from '../src/engine/steps/agent';
import type { CheckResult } from '../src/engine/steps/check';
import type { ClassifyResult } from '../src/engine/steps/classify';

const baseTask: TaskInput = {
  id: 't1',
  name: 'Task one',
  schedule: { cron: '*/1 * * * *' },
  environmentId: 'local',
  cwd: '/tmp',
  check: { command: 'true' },
  agent: { prompt: 'do it' },
};

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
  liveAgent: { end: (e: AgentEnd) => void; hold: () => void } | null;
  /** When true, runCheck blocks until the cycle's stop signal aborts. */
  hangChecks: boolean;
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
    liveAgent: null,
    hangChecks: false,
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
        if (scripted) setImmediate(() => resolve(scripted));
        else h.liveAgent = { end: resolve, hold: () => cb.onHold?.() };
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

const records = () =>
  h.events
    .filter((e) => e.type === 'record')
    .map((e) => (e as { record: { phase: string; result: string; summary?: string; body?: string } }).record);

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
    h.tasks.patch('t1', { schedule: { enabled: false, cron: '*/1 * * * *' } });
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
    h.tasks.patch('t1', { schedule: { enabled: true, cron: '0 9 * * *', timezone: 'Asia/Tokyo' } });
    expect(h.sched.get('t1')!.nextRunAt).toBe(new Date('2026-01-16T00:00:00Z').getTime());
  });

  it('cron schedules skip slots that pass while busy', async () => {
    h.tasks.patch('t1', { schedule: { enabled: true, cron: '* * * * *' } });
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

describe('notifications', () => {
  const notifies = () =>
    h.events.filter((e): e is Extract<EngineEvent, { type: 'notify' }> => e.type === 'notify');

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

describe('startup overdue filtering', () => {
  it('non-overdue tasks wait for their next cron slot instead of running immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
    const settings = SettingsSchema.parse({ tickMs: 100000, staggerFirstRun: { enabled: false } });
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    tasks.upsert({ ...baseTask, schedule: { cron: '*/5 * * * *' } });
    const state = new StateStore(path.join(dir, 'state.json'));
    // Last run at 10:01, now is 10:02 — the next */5 slot (10:05) hasn't passed.
    const now = new Date('2026-01-15T10:02:00Z').getTime();
    state.save({
      t1: {
        taskId: 't1',
        state: 'idle',
        held: false,
        nextRunAt: null,
        lastRunAt: new Date('2026-01-15T10:01:00Z').getTime(),
        lastResult: 'success',
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: null,
        pausedReason: null,
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
    tasks.upsert({ ...baseTask, schedule: { cron: '*/5 * * * *' } });
    const state = new StateStore(path.join(dir, 'state.json'));
    // Last run 10 minutes ago — the 5-minute cron has fired since.
    const now = new Date('2026-01-15T10:10:00Z').getTime();
    state.save({
      t1: {
        taskId: 't1',
        state: 'idle',
        held: false,
        nextRunAt: null,
        lastRunAt: now - 10 * 60_000,
        lastResult: 'success',
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: null,
        pausedReason: null,
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
  it('are recorded on startup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-test-'));
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    tasks.upsert(baseTask);
    const state = new StateStore(path.join(dir, 'state.json'));
    state.save({
      t1: {
        taskId: 't1',
        state: 'running',
        held: false,
        nextRunAt: null,
        lastRunAt: 1,
        lastResult: null,
        lastDetail: null,
        consecutiveErrors: 0,
        currentRunId: 'old-run',
        pausedReason: null,
      },
    });
    state.flush();
    const runs = new RunStore(dir);
    const sched = new Scheduler({
      dataDir: dir,
      host: 'wsl',
      settings: SettingsSchema.parse({}),
      tasks,
      runs,
      state,
      log: new Logger(),
    });
    sched.start();
    expect(runs.list('t1').at(-1)).toMatchObject({ runId: 'old-run', phase: 'system', result: 'interrupted' });
    expect(sched.get('t1')!.state).toBe('idle');
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
