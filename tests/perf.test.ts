import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { FrameMeter, IDLE_MS } from '../src/renderer/src/perf-meter';
import { perfLine, type PerfEntry } from '../src/shared/perf';

/** Frames every `step` ms from `from` to `to`; returns the time of the last. */
function frames(m: FrameMeter, from: number, to: number, step: number): number {
  let t = from;
  for (; t <= to; t += step) m.frame(t);
  return t - step;
}

function meter(freezesFromFrames = true) {
  const sent: PerfEntry[] = [];
  return { m: new FrameMeter({ freezesFromFrames, report: (e) => sent.push(e) }), sent };
}

describe('FrameMeter', () => {
  it('reports a freeze with the input before it and the renders during it', () => {
    const { m, sent } = meter();
    m.input(1000, 'tap "Web app"', 'sessions "Chats"');
    let t = frames(m, 1010, 1400, 16);
    m.span('Chat rows', t + 5, t + 800, 760);
    m.span('Markdown', t + 10, t + 800, 300);
    m.span('Markdown', t + 10, t + 800, 250);
    m.span('Table', t - 3000, t - 2990, 9);
    m.input(t + 2, 'tap "Open"', 'sessions "Chats"');
    m.frame(t + 820);
    expect(sent[0]).toEqual({
      kind: 'freeze',
      ms: 820,
      screen: 'sessions "Chats"',
      input: 'tap "Open" at +2 ms',
      renders: ['Chat rows 760 ms', 'Markdown 550 ms ×2'],
    });
    // The freeze ended the activity too (no input for 818 ms), with its 50 dropped frames.
    expect(sent[1]).toMatchObject({ kind: 'frames', dropped: 50 });
  });

  it('leaves freezes to the long-animation-frame reports when it has them', () => {
    const { m, sent } = meter(false);
    m.touch(0);
    m.frame(16);
    m.frame(400);
    expect(sent).toEqual([]);
    m.longFrame(16, 380, ['DIV.onclick Xe 370 ms']);
    expect(sent).toEqual([{ kind: 'freeze', ms: 380, screen: '', scripts: ['DIV.onclick Xe 370 ms'] }]);
  });

  it('counts dropped frames at the measured interval and logs the activity once it is quiet', () => {
    const { m, sent } = meter(false);
    m.input(0, 'scroll', 'main "Looper"');
    // 120 Hz: 8.3 ms frames, with every twentieth one taking three intervals.
    let t = 0;
    for (let i = 1; i <= 200; i++) {
      t += i % 20 === 0 ? 25 : 8.3;
      if (i % 20 === 0) m.input(t, 'scroll', 'main "Looper"');
      expect(m.frame(t)).toBe(true);
    }
    const end = t;
    while (m.frame((t += 8.3))) {
      /* until IDLE_MS passes */
    }
    expect(t - end).toBeGreaterThan(IDLE_MS - 200);
    expect(sent).toHaveLength(1);
    const e = sent[0];
    expect(e).toMatchObject({ kind: 'frames', screen: 'main "Looper"', input: 'scroll', dropped: 20 });
    expect(e.frameMs).toBeCloseTo(8.3, 1);
    expect(e.worstMs).toBe(25);
  });

  it("doesn't log an activity that dropped under 5% of its frames, and stops asking for frames", () => {
    const { m, sent } = meter();
    let t = 0;
    for (let i = 1; i <= 100; i++) {
      m.touch(t);
      expect(m.frame((t += i === 50 ? 33 : 16.7))).toBe(true);
    }
    let after = 0;
    while (m.frame((t += 16.7))) after++;
    expect(after * 16.7).toBeLessThan(IDLE_MS + 20);
    expect(sent).toEqual([]);
    expect(m.frame(t + 16.7)).toBe(false);
  });

  it('sends one freeze a second and counts the rest on the next', () => {
    const { m, sent } = meter();
    m.touch(0);
    let t = 0;
    for (let i = 0; i < 4; i++) {
      m.touch(t);
      m.frame((t += 100));
    }
    m.touch(t + 1000);
    m.frame((t += 1200));
    expect(sent.map((e) => [e.ms, e.skipped])).toEqual([
      [100, undefined],
      [1200, 3],
    ]);
  });

  it('sends the worst of the freezes held back, once the second has passed', () => {
    const { m, sent } = meter();
    let t = 0;
    const step = (gap: number) => {
      m.touch(t);
      m.frame((t += gap));
    };
    step(16);
    step(100);
    step(300);
    step(16);
    step(150);
    expect(sent.map((e) => e.ms)).toEqual([100]);
    while (t < 1200) step(16);
    expect(sent.map((e) => [e.kind, e.ms, e.skipped])).toEqual([
      ['freeze', 100, undefined],
      ['freeze', 300, 1],
    ]);
  });

  it('sends a held freeze when the activity ends before the second has passed', () => {
    const { m, sent } = meter();
    let t = 0;
    m.touch(t);
    m.frame((t += 16));
    m.frame((t += 100));
    m.frame((t += 200));
    while (m.frame((t += 16))) {
      /* until quiet */
    }
    expect(sent.filter((e) => e.kind === 'freeze').map((e) => e.ms)).toEqual([100, 200]);
  });

  it('skips a long gap the thread was free through, and reports only the blocked part of one', () => {
    const { m, sent } = meter();
    let t = 0;
    m.touch(t);
    m.frame((t += 16));
    // The browser held frames back for 2.7 s while timers kept running.
    for (let i = 0; i < 270; i++) m.beat((t += 10));
    m.touch(t);
    m.frame((t += 5));
    expect(sent).toEqual([]);
    // 30 ms free, then 300 ms blocked.
    m.beat((t += 10));
    m.beat((t += 10));
    m.beat((t += 10));
    m.touch(t);
    m.frame((t += 300));
    expect(sent.map((e) => [e.kind, e.ms])).toEqual([['freeze', 300]]);
  });

  it("doesn't count the time a hidden page had no frames", () => {
    const { m, sent } = meter();
    m.touch(0);
    m.frame(16);
    m.reset(20);
    expect(m.frame(60_000)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('perfLine', () => {
  it('formats a freeze and a frames entry', () => {
    expect(perfLine({ kind: 'freeze', ms: 820.4, screen: 'sessions "Chats"', input: 'tap "Open" at +2 ms', renders: ['Chat rows 760 ms'], skipped: 2 })).toBe(
      'freeze 820 ms | screen sessions "Chats" | input tap "Open" at +2 ms | renders Chat rows 760 ms | 2 more left out',
    );
    expect(perfLine({ kind: 'frames', ms: 12_400, screen: 'main', frames: 200, dropped: 40, frameMs: 8.33, worstMs: 25, input: 'scroll' })).toBe(
      'frames 12.4 s: 40 of 200 dropped (20%) at 8.3 ms, worst 25 ms | screen main | input scroll',
    );
  });

  it('refuses what a page could send that is not an entry, and keeps a line one line', () => {
    expect(perfLine(null)).toBeNull();
    expect(perfLine({ kind: 'other', ms: 1, screen: '' })).toBeNull();
    expect(perfLine({ kind: 'freeze', ms: -1, screen: '' })).toBeNull();
    expect(perfLine({ kind: 'freeze', ms: 60, screen: 'a\nb', renders: ['x\ny', 3, ...Array(10).fill('z')] })).toBe(
      'freeze 60 ms | screen a b | renders x y, z, z, z, z',
    );
    expect(perfLine({ kind: 'freeze', ms: 60, screen: 'x'.repeat(500) })!.length).toBeLessThan(150);
  });
});

describe('Logger.rotateOver', () => {
  it('moves a file over the limit to .1 and keeps logging to a new one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-perf-'));
    const file = path.join(dir, 'perf.log');
    const log = new Logger(file);
    log.info('x'.repeat(200));
    expect(await log.rotateOver(1000)).toBe(false);
    expect(await log.rotateOver(100)).toBe(true);
    log.info('after');
    log.close();
    for (let i = 0; i < 100 && !/after\n$/.test(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('x'.repeat(200));
    expect(fs.readFileSync(file, 'utf8')).toMatch(/\[info\] after\n$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
