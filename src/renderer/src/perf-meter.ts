// Relative imports: the unit tests (node tsconfig) load this file, and it has no `@shared` alias.
import { FREEZE_MS, type PerfEntry } from '../../shared/perf';

/** Activity ends after this long with no input, update or render. */
export const IDLE_MS = 500;
/** An activity is logged when it dropped at least this share of its frames, and at least MIN_DROPPED. */
export const DROPPED_SHARE = 0.05;
export const MIN_DROPPED = 2;
/** Entries of one kind closer together than this are left out and counted on the next one. */
export const MIN_GAP_MS = 1000;
/** Until this many intervals are measured, the display counts as 60 Hz. */
const MIN_SAMPLES = 10;
const MAX_SAMPLES = 60;
const RENDER_KEEP_MS = 5000;
const MAX_RENDERS = 5000;
/** An input this long before a freeze is no longer named as its cause. */
const INPUT_RECENT_MS = 5000;

interface Span {
  name: string;
  start: number;
  end: number;
  ms: number;
}

interface Activity {
  start: number;
  lastAt: number;
  frames: number;
  dropped: number;
  worst: number;
  inputs: Set<string>;
}

const fmt = (ms: number): string => `${Math.round(ms)} ms`;

/**
 * Counts frames while something happens (an input, an update from the
 * computer, a render) and stays idle otherwise. A gap between frames longer
 * than 1.5 frame intervals is dropped frames, and one of FREEZE_MS or more is a
 * freeze. Times are in one clock across frames (performance.timeOrigin + now).
 */
export class FrameMeter {
  /** The window that took the last input, with its title. */
  screen = '';
  private last: number | null = null;
  /** The first gap after starting runs from the start, not from a frame, so it isn't an interval. */
  private fresh = false;
  /** When a timer last ran, and the longest stretch without one since the last frame: how long the thread was blocked. */
  private lastBeat = -Infinity;
  private longest = 0;
  private readonly intervals: number[] = [];
  private activity: Activity | null = null;
  private lastInput: { label: string; at: number } | null = null;
  private spans: Span[] = [];
  private readonly lastSent = { freeze: -Infinity, frames: -Infinity };
  private readonly skipped = { freeze: 0, frames: 0 };
  /** The worst entry of each kind held back by MIN_GAP_MS, sent once the gap has passed. */
  private readonly held: { freeze: PerfEntry | null; frames: PerfEntry | null } = { freeze: null, frames: null };

  constructor(
    private readonly opts: {
      /** Freezes come from the frame gaps; false when the desktop's long-animation-frame reports give them. */
      freezesFromFrames: boolean;
      report: (e: PerfEntry) => void;
      /** The screen before any input names one (a desktop window's own). */
      screen?: () => string;
    },
  ) {}

  /** The display's frame interval: the median of recent ones, worked out again every 30 frames rather than on each. */
  frameMs(): number {
    return this.median;
  }

  private median = 1000 / 60;
  private sinceMedian = 0;

  private addInterval(gap: number): void {
    this.intervals.push(gap);
    if (this.intervals.length > MAX_SAMPLES) this.intervals.shift();
    if (this.intervals.length < MIN_SAMPLES || (++this.sinceMedian < 30 && this.intervals.length > MIN_SAMPLES)) return;
    this.sinceMedian = 0;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    this.median = Math.min(40, Math.max(4, sorted[sorted.length >> 1]));
  }

  /** Something happened: frames are counted until it's quiet for IDLE_MS. */
  touch(now: number, input?: string): void {
    if (this.last === null) {
      this.last = now;
      this.fresh = true;
    }
    if (!this.activity) this.activity = { start: now, lastAt: now, frames: 0, dropped: 0, worst: 0, inputs: new Set() };
    this.activity.lastAt = Math.max(this.activity.lastAt, now);
    if (input) this.activity.inputs.add(input.split(' ')[0]);
  }

  input(now: number, label: string, screen: string): void {
    this.lastInput = { label, at: now };
    this.screen = screen;
    this.touch(now, label);
  }

  /** Work that ran from start to end: a React commit (ms is its own render time) or a message from the computer. */
  span(name: string, start: number, end: number, ms: number): void {
    this.spans.push({ name, start, end, ms });
    const cutoff = end - RENDER_KEEP_MS;
    let drop = 0;
    while (drop < this.spans.length && (this.spans[drop].end < cutoff || this.spans.length - drop > MAX_RENDERS)) drop++;
    if (drop) this.spans = this.spans.slice(drop);
  }

  /** A timer ran at `now`: the thread was free then. */
  beat(now: number): void {
    if (this.last === null) return;
    this.longest = Math.max(this.longest, now - Math.max(this.lastBeat, this.last));
    this.lastBeat = now;
  }

  /** A frame at `now`. False when the activity has ended and no more frames are needed. */
  frame(now: number): boolean {
    const last = this.last;
    if (last === null) return false;
    const rawGap = Math.max(0, now - last);
    const blocked = Math.max(this.longest, now - Math.max(this.lastBeat, last));
    this.longest = 0;
    this.last = now;
    // A long gap the thread wasn't blocked through is the browser holding frames back (idle, power saving), not jank.
    if (rawGap >= FREEZE_MS && blocked < FREEZE_MS) {
      this.fresh = false;
      return this.continueOrEnd(now);
    }
    const gap = Math.min(rawGap, blocked + this.frameMs());
    const fresh = this.fresh;
    this.fresh = false;
    const interval = this.frameMs();
    if (!fresh && gap < FREEZE_MS) this.addInterval(gap);
    const a = this.activity;
    if (a) {
      const expected = Math.max(1, Math.round(gap / interval));
      a.frames += expected;
      if (gap > interval * 1.5) a.dropped += expected - 1;
      a.worst = Math.max(a.worst, gap);
    }
    const blockedMs = Math.min(rawGap, blocked);
    if (this.opts.freezesFromFrames && blockedMs >= FREEZE_MS) this.freeze(last, now, blockedMs);
    return this.continueOrEnd(now);
  }

  private continueOrEnd(now: number): boolean {
    const a = this.activity;
    if (!a || now - a.lastAt > IDLE_MS) {
      if (a) this.endActivity(now);
      this.flush(now, true);
      this.last = null;
      return false;
    }
    this.flush(now);
    return true;
  }

  /** A long animation frame the desktop reported. */
  longFrame(start: number, ms: number, scripts: string[]): void {
    this.freeze(start, start + ms, ms, scripts);
    this.flush(start + ms, !this.activity);
  }

  /** The page was hidden: frames stop, and the gap until it shows again isn't a freeze. */
  reset(now: number): void {
    this.flush(now, true);
    this.last = null;
    this.activity = null;
  }

  /** `ms`: how long the thread was blocked, within start..end. */
  private freeze(start: number, end: number, ms: number, scripts?: string[]): void {
    this.send(end, {
      kind: 'freeze',
      ms,
      screen: this.currentScreen(),
      ...this.inputAround(start),
      ...this.rendersIn(start, end),
      ...(scripts?.length ? { scripts } : {}),
    });
  }

  private endActivity(now: number): void {
    const a = this.activity;
    this.activity = null;
    if (!a || a.dropped < MIN_DROPPED || a.dropped / a.frames < DROPPED_SHARE) return;
    this.send(now, {
      kind: 'frames',
      ms: now - a.start,
      screen: this.currentScreen(),
      frameMs: this.frameMs(),
      frames: a.frames,
      dropped: a.dropped,
      worstMs: a.worst,
      ...(a.inputs.size ? { input: [...a.inputs].join(', ') } : {}),
      ...this.rendersIn(a.start, now),
    });
  }

  private currentScreen(): string {
    return this.screen || this.opts.screen?.() || '';
  }

  private inputAround(start: number): { input?: string } {
    const i = this.lastInput;
    if (!i || start - i.at > INPUT_RECENT_MS) return {};
    const d = Math.round(i.at - start);
    return { input: d >= 0 ? `${i.label} at +${d} ms` : `${i.label} ${-d} ms before` };
  }

  /** The work that overlapped start..end, by name, most time first. */
  private rendersIn(start: number, end: number): { renders?: string[] } {
    const byName = new Map<string, { ms: number; n: number }>();
    for (const s of this.spans) {
      if (s.end < start || s.start > end) continue;
      const g = byName.get(s.name) ?? { ms: 0, n: 0 };
      g.ms += s.ms;
      g.n++;
      byName.set(s.name, g);
    }
    const renders = [...byName]
      .filter(([, g]) => g.ms >= 1)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 6)
      .map(([name, g]) => `${name} ${fmt(g.ms)}${g.n > 1 ? ` ×${g.n}` : ''}`);
    return renders.length ? { renders } : {};
  }

  /** Within MIN_GAP_MS of the last entry of its kind, an entry waits, and only the worst one waiting is sent. */
  private send(now: number, e: PerfEntry): void {
    const kind = e.kind;
    const held = this.held[kind];
    if (held) {
      this.skipped[kind]++;
      if (e.ms > held.ms) this.held[kind] = e;
    } else if (now - this.lastSent[kind] < MIN_GAP_MS) this.held[kind] = e;
    else this.emit(now, e);
  }

  /** Send what waited once its gap has passed; `force`: now (the activity ended, so no frame may come to send it). */
  private flush(now: number, force = false): void {
    for (const kind of ['freeze', 'frames'] as const) {
      const held = this.held[kind];
      if (held && (force || now - this.lastSent[kind] >= MIN_GAP_MS)) this.emit(now, held);
    }
  }

  private emit(now: number, e: PerfEntry): void {
    const kind = e.kind;
    this.held[kind] = null;
    this.lastSent[kind] = now;
    const skipped = this.skipped[kind];
    this.skipped[kind] = 0;
    this.opts.report(skipped ? { ...e, skipped } : e);
  }
}
