import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTE, SECOND, createTickers, nextDelay, tickFor } from '../src/renderer/src/now-ticker';

describe('nextDelay', () => {
  it('waits for the next multiple of the interval on the clock', () => {
    expect(nextDelay(0, SECOND)).toBe(1000);
    expect(nextDelay(1250, SECOND)).toBe(750);
    expect(nextDelay(MINUTE * 5 + 15_000, MINUTE)).toBe(45_000);
    expect(nextDelay(MINUTE * 5, MINUTE)).toBe(MINUTE);
  });
});

describe('tickFor', () => {
  it('ticks each second below an hour and each minute from an hour on, ahead or behind', () => {
    expect(tickFor(30_000)).toBe(SECOND);
    expect(tickFor(3_599_999)).toBe(SECOND);
    expect(tickFor(3_600_000)).toBe(MINUTE);
    expect(tickFor(-120_000)).toBe(SECOND);
    expect(tickFor(-7_200_000)).toBe(MINUTE);
  });
});

describe('createTickers', () => {
  let visible = true;
  const make = () =>
    createTickers({
      now: () => Date.now(),
      visible: () => visible,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

  beforeEach(() => {
    visible = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00.400Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ticks on the clock, not from the moment of subscribing', () => {
    const tickers = make();
    const seen: number[] = [];
    tickers.subscribe(SECOND, (n) => seen.push(n % MINUTE));
    vi.advanceTimersByTime(599);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([1000]);
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([1000, 2000, 3000]);
  });

  it('ticks a minute interval on the minute', () => {
    const tickers = make();
    const seen: number[] = [];
    tickers.subscribe(MINUTE, (n) => seen.push(n));
    vi.advanceTimersByTime(59_599);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
    expect(seen[0] % MINUTE).toBe(0);
    vi.advanceTimersByTime(MINUTE);
    expect(seen).toHaveLength(2);
  });

  it('shares one timer between listeners of an interval and stops it with the last one', () => {
    const tickers = make();
    const a = vi.fn();
    const b = vi.fn();
    const offA = tickers.subscribe(SECOND, a);
    const offB = tickers.subscribe(SECOND, b);
    expect(tickers.active()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    expect(tickers.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips ticks while the page is hidden and keeps its schedule', () => {
    const tickers = make();
    const fn = vi.fn();
    tickers.subscribe(SECOND, fn);
    visible = false;
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    visible = true;
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resume gives the listeners the time at once, only while visible', () => {
    const tickers = make();
    const fn = vi.fn();
    tickers.subscribe(MINUTE, fn);
    visible = false;
    tickers.resume();
    expect(fn).not.toHaveBeenCalled();
    visible = true;
    tickers.resume();
    expect(fn).toHaveBeenCalledWith(Date.now());
  });

  it('starts a fresh timer when an interval comes back after its last listener left', () => {
    const tickers = make();
    tickers.subscribe(SECOND, vi.fn())();
    const fn = vi.fn();
    tickers.subscribe(SECOND, fn);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
