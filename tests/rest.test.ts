import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { RestController, type PowerAdapter, type PowerOps } from '../src/engine/rest';
import { SettingsSchema, type RestState, type TaskRuntime } from '../src/shared/types';

const MIN = 60_000;

function runtime(partial: Partial<TaskRuntime>): TaskRuntime {
  return {
    taskId: 't1',
    state: 'idle',
    held: false,
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastDetail: null,
    consecutiveErrors: 0,
    currentRunId: null,
    pausedReason: null,
    ...partial,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

interface Harness {
  ctl: RestController;
  clock: { now: number };
  runtimes: TaskRuntime[];
  events: { state: RestState; disarmReason?: 'user-wake' }[];
  ops: { registered: number[]; suspends: number; cleared: number; failRegister: boolean };
  adapter: { blocked: boolean; suspend: () => void; resume: () => void };
  settings: ReturnType<typeof SettingsSchema.parse>;
  last(): RestState;
}

let disposeQueue: RestController[] = [];
afterEach(() => {
  for (const c of disposeQueue) c.dispose();
  disposeQueue = [];
});

function makeHarness(rest: Partial<{ minSleepMin: number; graceSec: number; disarmOnUserWake: boolean }> = {}): Harness {
  const settings = SettingsSchema.parse({ rest: { minSleepMin: 30, graceSec: 60, disarmOnUserWake: true, ...rest } });
  const clock = { now: 1_000_000_000 };
  const runtimes: TaskRuntime[] = [];
  const events: Harness['events'] = [];
  const ops = { registered: [] as number[], suspends: 0, cleared: 0, failRegister: false };
  let suspendCb: () => void = () => undefined;
  let resumeCb: () => void = () => undefined;
  const adapter = {
    blocked: false,
    suspend: () => suspendCb(),
    resume: () => resumeCb(),
  };
  const powerAdapter: PowerAdapter = {
    startBlocker: () => void (adapter.blocked = true),
    stopBlocker: () => void (adapter.blocked = false),
    onSuspend: (cb) => void (suspendCb = cb),
    onResume: (cb) => void (resumeCb = cb),
    isOnBattery: () => false,
  };
  const powerOps: PowerOps = {
    suspend: async () => void ops.suspends++,
    registerWake: async (at) => {
      if (ops.failRegister) throw new Error('registration failed');
      ops.registered.push(at);
    },
    clearWake: async () => void ops.cleared++,
  };
  const ctl = new RestController({
    settings,
    runtimes: () => runtimes,
    adapter: powerAdapter,
    ops: powerOps,
    log: new Logger(),
    emit: (state, disarmReason) => events.push({ state, disarmReason }),
    now: () => clock.now,
  });
  disposeQueue.push(ctl);
  return { ctl, clock, runtimes, events, ops, adapter, settings, last: () => events[events.length - 1].state };
}

/** Arm and run the grace countdown to the point of sleeping. */
async function armAndSleep(h: Harness): Promise<void> {
  h.ctl.arm();
  h.ctl.poke();
  h.clock.now += h.settings.rest.graceSec * 1000;
  h.ctl.poke();
  await flush();
}

describe('rest controller', () => {
  it('arms, counts down the grace period, then sleeps', async () => {
    const h = makeHarness();
    h.ctl.arm();
    expect(h.last().phase).toBe('countdown');
    expect(h.last().sleepAt).toBe(h.clock.now + 60_000);
    expect(h.adapter.blocked).toBe(true);

    h.clock.now += 59_000;
    h.ctl.poke();
    expect(h.ops.suspends).toBe(0);

    h.clock.now += 1_000;
    h.ctl.poke();
    await flush();
    expect(h.ops.suspends).toBe(1);
    expect(h.last().phase).toBe('sleeping');
    expect(h.adapter.blocked).toBe(false); // released to suspend deliberately
  });

  it('clamps the wake to the minimum sleep, counted from sleep onset', async () => {
    const h = makeHarness({ minSleepMin: 30 });
    h.runtimes.push(runtime({ nextRunAt: h.clock.now + 5 * MIN }));
    await armAndSleep(h);
    expect(h.ops.registered).toEqual([h.clock.now + 30 * MIN]);
  });

  it('wakes at the next run when it is beyond the minimum sleep', async () => {
    const h = makeHarness({ minSleepMin: 30 });
    const next = h.clock.now + 45 * MIN + 60_000;
    h.runtimes.push(runtime({ nextRunAt: next }));
    await armAndSleep(h);
    expect(h.ops.registered).toEqual([next]);
  });

  it('sleeps without a wake when nothing is scheduled', async () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ nextRunAt: null, state: 'paused' }));
    await armAndSleep(h);
    expect(h.ops.registered).toEqual([]);
    expect(h.ops.suspends).toBe(1);
    expect(h.last().wakeAt).toBeNull();
  });

  it('an active task blocks the countdown; a held one does not', () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ state: 'running' }));
    h.ctl.arm();
    expect(h.last().phase).toBe('waiting');

    h.runtimes[0] = runtime({ state: 'running', held: true });
    h.ctl.poke();
    expect(h.last().phase).toBe('countdown');
  });

  it('a run starting during the countdown resets it', () => {
    const h = makeHarness();
    h.ctl.arm();
    expect(h.last().phase).toBe('countdown');

    h.runtimes.push(runtime({ state: 'checking' }));
    h.clock.now += 30_000;
    h.ctl.poke();
    expect(h.last().phase).toBe('waiting');
    expect(h.last().sleepAt).toBeNull();

    // Quiet again: a fresh full grace period starts.
    h.runtimes.length = 0;
    h.ctl.poke();
    expect(h.last().phase).toBe('countdown');
    expect(h.last().sleepAt).toBe(h.clock.now + 60_000);
  });

  it('stays awake and retries when the wake registration fails', async () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ nextRunAt: h.clock.now + 5 * MIN }));
    h.ops.failRegister = true;
    await armAndSleep(h);
    expect(h.ops.suspends).toBe(0);
    expect(h.last().armed).toBe(true);
    expect(h.last().phase).toBe('countdown');

    h.ops.failRegister = false;
    h.clock.now += 60_000;
    h.ctl.poke();
    await flush();
    expect(h.ops.suspends).toBe(1);
  });

  it('a timer wake stays armed and re-enters the loop', async () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ nextRunAt: h.clock.now + 5 * MIN }));
    await armAndSleep(h);
    const wakeAt = h.ops.registered[0];

    h.clock.now = wakeAt + 10_000;
    h.adapter.resume();
    expect(h.last().armed).toBe(true);
    expect(h.last().phase).toBe('countdown'); // idle again: next countdown starts
    expect(h.adapter.blocked).toBe(true); // re-acquired against the unattended timeout
  });

  it('a manual wake disarms and reports it', async () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ nextRunAt: h.clock.now + 60 * MIN }));
    await armAndSleep(h);
    const wakeAt = h.ops.registered[0];

    h.clock.now = wakeAt - 20 * MIN; // long before the timer
    h.adapter.resume();
    const last = h.events[h.events.length - 1];
    expect(last.state.armed).toBe(false);
    expect(last.disarmReason).toBe('user-wake');
    expect(h.adapter.blocked).toBe(false);
  });

  it('a manual wake keeps the mode on when auto-disarm is off', async () => {
    const h = makeHarness({ disarmOnUserWake: false });
    h.runtimes.push(runtime({ nextRunAt: h.clock.now + 60 * MIN }));
    await armAndSleep(h);

    h.clock.now = h.ops.registered[0] - 20 * MIN;
    h.adapter.resume();
    expect(h.last().armed).toBe(true);
  });

  it('an external suspend followed by a resume counts as a manual wake', () => {
    const h = makeHarness();
    h.runtimes.push(runtime({ state: 'running' }));
    h.ctl.arm();
    expect(h.last().phase).toBe('waiting');

    h.adapter.suspend(); // the user slept the machine while a task ran
    expect(h.last().phase).toBe('sleeping');
    h.clock.now += 5 * MIN;
    h.adapter.resume();
    const last = h.events[h.events.length - 1];
    expect(last.state.armed).toBe(false);
    expect(last.disarmReason).toBe('user-wake');
  });

  it('disarming clears the wake task and releases the blocker', async () => {
    const h = makeHarness();
    h.ctl.arm();
    const clearedBefore = h.ops.cleared;
    h.ctl.disarm();
    await flush();
    expect(h.last().armed).toBe(false);
    expect(h.ops.cleared).toBe(clearedBefore + 1);
    expect(h.adapter.blocked).toBe(false);
  });
});
