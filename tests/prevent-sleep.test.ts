import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/engine/engine';
import { Logger } from '../src/engine/log';
import type { OffThreadChild, spawnOffThread } from '../src/engine/exec-worker';
import { SystemAwake } from '../src/engine/power-win';
import { PreventSleep } from '../src/engine/prevent-sleep';
import { SettingsSchema, type PreventSleepState } from '../src/shared/types';

const MIN = 60_000;

function makeHarness(whileWorking = false) {
  const settings = SettingsSchema.parse({ preventSleepWhileWorking: whileWorking });
  const clock = { now: 1_000_000_000 };
  const h = {
    working: false,
    held: false,
    holds: 0,
    events: [] as PreventSleepState[],
  };
  const ctl = new PreventSleep({
    settings,
    working: () => h.working,
    keepAwake: (on) => {
      h.held = on;
      if (on) h.holds++;
    },
    emit: (state) => h.events.push(state),
    log: new Logger(),
    now: () => clock.now,
  });
  return { ctl, h, clock, last: () => h.events[h.events.length - 1] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('prevent sleep', () => {
  it('holds the blocker for the timer and lets go when it runs out', () => {
    vi.useFakeTimers();
    const { ctl, h, last, clock } = makeHarness();
    ctl.set(30);
    expect(h.held).toBe(true);
    expect(last()).toEqual({ timer: 30, until: clock.now + 30 * MIN, active: true });

    vi.advanceTimersByTime(30 * MIN);
    expect(h.held).toBe(false);
    expect(last()).toEqual({ timer: 'off', until: null, active: false });
  });

  it('stays on until turned off, and a new choice replaces the running timer', () => {
    vi.useFakeTimers();
    const { ctl, h, last } = makeHarness();
    ctl.set(30);
    ctl.set('until-off');
    vi.advanceTimersByTime(120 * MIN);
    expect(h.held).toBe(true);
    expect(last()).toEqual({ timer: 'until-off', until: null, active: true });
    expect(h.holds).toBe(1); // the blocker is taken once, not per choice

    ctl.set('off');
    expect(h.held).toBe(false);
  });

  it('keeps the computer awake while a session works, only with the setting on', () => {
    const off = makeHarness(false);
    off.h.working = true;
    off.ctl.poke();
    expect(off.h.held).toBe(false);

    const on = makeHarness(true);
    on.h.working = true;
    on.ctl.poke();
    expect(on.h.held).toBe(true);
    expect(on.last()).toEqual({ timer: 'off', until: null, active: true });

    on.h.working = false;
    on.ctl.poke();
    expect(on.h.held).toBe(false);
  });

  it('sends a state only when it changed', () => {
    const { ctl, h } = makeHarness(true);
    ctl.poke();
    ctl.poke();
    expect(h.events).toHaveLength(1);
  });

  it('releases the blocker when disposed', () => {
    const { ctl, h } = makeHarness();
    ctl.set('until-off');
    ctl.dispose();
    expect(h.held).toBe(false);
  });

  it('is unavailable without the app, and follows While a Session Is Working from the settings', () => {
    const headless = createEngine({ dataDir: mkdtempSync(join(tmpdir(), 'looper-ps-')) });
    expect(() => headless.setPreventSleep(30)).toThrow(/only available in the Looper app/);

    let held = false;
    const engine = createEngine({ dataDir: mkdtempSync(join(tmpdir(), 'looper-ps-')), keepAwake: (on) => void (held = on) });
    const events: PreventSleepState[] = [];
    engine.on((e) => {
      if (e.type === 'prevent-sleep') events.push(e.state);
    });
    engine.setPreventSleep('until-off');
    expect(held).toBe(true);
    expect(engine.preventSleepState()).toEqual({ timer: 'until-off', until: null, active: true });
    engine.setPreventSleep('off');
    expect(held).toBe(false);
    // Nothing is working: turning the setting on holds nothing yet, and it's saved.
    expect(engine.updateSettings({ preventSleepWhileWorking: true }).preventSleepWhileWorking).toBe(true);
    expect(held).toBe(false);
    expect(events.at(-1)).toEqual({ timer: 'off', until: null, active: false });
  });
});

describe('windows keep awake', () => {
  function makeAwake() {
    const children: (EventEmitter & { stdin: PassThrough; stderr: PassThrough })[] = [];
    const errors: string[] = [];
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child as unknown as OffThreadChild;
    }) as typeof spawnOffThread;
    return { awake: new SystemAwake((m) => errors.push(m), spawn), children, errors };
  }

  it('runs one helper for every holder and ends it when the last one lets go', () => {
    const { awake, children } = makeAwake();
    awake.hold('prevent-sleep', true);
    awake.hold('rest', true);
    awake.hold('prevent-sleep', true);
    expect(children).toHaveLength(1);
    awake.hold('prevent-sleep', false);
    expect(children[0].stdin.writableEnded).toBe(false);
    awake.hold('rest', false);
    expect(children[0].stdin.writableEnded).toBe(true);
    awake.hold('rest', true);
    expect(children).toHaveLength(2);
  });

  it('sets the hold again on request while it runs', () => {
    const { awake, children } = makeAwake();
    awake.reapply();
    awake.hold('prevent-sleep', true);
    const sent: string[] = [];
    children[0].stdin.on('data', (d: Buffer) => sent.push(d.toString()));
    awake.reapply();
    awake.reapply();
    expect(sent.join('')).toBe('\n\n');
  });

  it('reports a helper that ends while held, and starts another on the next hold', () => {
    const { awake, children, errors } = makeAwake();
    awake.hold('rest', false);
    expect(children).toHaveLength(0);
    awake.hold('rest', true);
    children[0].stderr.emit('data', Buffer.from('Add-Type failed'));
    children[0].emit('close', 1, null);
    expect(errors).toEqual(['keep awake: the helper ended while held (exit 1): Add-Type failed']);
    awake.hold('prevent-sleep', true);
    expect(children).toHaveLength(2);
    awake.hold('rest', false);
    awake.hold('prevent-sleep', false);
    children[1].emit('close', 0, null);
    expect(errors).toHaveLength(1);
  });
});
