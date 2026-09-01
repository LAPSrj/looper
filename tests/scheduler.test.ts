import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/engine/scheduler';
import { Logger } from '../src/engine/log';
import { RunStore } from '../src/engine/store/runs';
import { StateStore } from '../src/engine/store/state';
import { TaskStore } from '../src/engine/store/tasks';
import { SettingsSchema, type EngineEvent, type TaskInput } from '../src/shared/types';
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
  sched: Scheduler;
  events: EngineEvent[];
  clock: { now: number };
  checks: CheckResult[];
  classifies: ClassifyResult[];
  agentEnds: AgentEnd[];
  agentStarted: number;
  liveAgent: { end: (e: AgentEnd) => void } | null;
  tickN(n: number): Promise<void>;
}

function check(status: CheckResult['status'], extra: Partial<CheckResult> = {}): CheckResult {
  return { status, exitCode: status === 'error' ? 1 : 0, durationMs: 5, stdoutTail: '', ...extra };
}

function agentEnd(reason: AgentEnd['reason'], message?: string): AgentEnd {
  return { reason, exitCode: 0, message, durationMs: 10, wasHeld: false };
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
    events: [],
    clock,
    checks: [],
    classifies: [],
    agentEnds: [],
    agentStarted: 0,
    liveAgent: null,
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
      runCheck: async () => h.checks!.shift() ?? check('noop'),
      runClassify: async () => h.classifies!.shift() ?? { status: 'noop', durationMs: 1, exitCode: 0 },
      startAgent: async (ctx) => {
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
          stop: async (reason = 'stopped', message) => resolve(agentEnd(reason, message)),
          finished,
        };
        if (scripted) setImmediate(() => resolve(scripted));
        else h.liveAgent = { end: resolve };
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

const records = () => h.events.filter((e) => e.type === 'record').map((e) => (e as { record: { phase: string; result: string } }).record);

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
    expect(rt.lastResult).toBe('quiet');
    expect(rt.nextRunAt).toBe(1_020_000); // next whole minute after 1_000_000
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:noop']);
    expect(h.agentStarted).toBe(0);
  });

  it('act check starts the agent and records its end', async () => {
    h.checks.push(check('act', { summary: '2 items', context: { n: 2 } }));
    h.agentEnds.push(agentEnd('done', 'fixed both'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
    expect(records().map((r) => `${r.phase}:${r.result}`)).toEqual(['check:act', 'agent:started', 'agent:done']);
    expect(h.sched.get('t1')!.lastResult).toBe('done: fixed both');
    expect(h.sched.get('t1')!.state).toBe('idle');
  });

  it('never overlaps: a tick while running is ignored, stopAgent ends the run', async () => {
    h.checks.push(check('act'));
    await h.tickN(1);
    expect(h.sched.get('t1')!.state).toBe('running');
    expect(h.liveAgent).not.toBeNull();
    h.clock.now += 60_000;
    await h.tickN(3);
    expect(h.agentStarted).toBe(1);
    expect(h.sched.runNow('t1')).toBe(false);
    await h.sched.stopAgent('t1', 'test');
    await flush();
    expect(h.sched.get('t1')!.state).toBe('idle');
    expect(records().at(-1)).toMatchObject({ phase: 'agent', result: 'stopped' });
  });

  it('classifier gate: noop stops the cycle, act proceeds', async () => {
    h.tasks.patch('t1', { classifier: { model: 'haiku', prompt: 'p', timeoutSec: 10 } });
    h.checks.push(check('act'), check('act'));
    h.classifies.push({ status: 'noop', reason: 'just noise', durationMs: 1, exitCode: 0 });
    h.classifies.push({ status: 'act', reason: 'real work', durationMs: 1, exitCode: 0 });
    h.agentEnds.push(agentEnd('done'));
    await h.tickN(1);
    expect(h.agentStarted).toBe(0);
    expect(h.sched.get('t1')!.lastResult).toBe('classifier: just noise');
    h.clock.now += 60_000;
    await h.tickN(1);
    expect(h.agentStarted).toBe(1);
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

  it('cron schedules skip slots that pass while busy', async () => {
    h.tasks.patch('t1', { schedule: { cron: '* * * * *' } });
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
        lastResult: 'ok',
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
        lastResult: 'ok',
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
