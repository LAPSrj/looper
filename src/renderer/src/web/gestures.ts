// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

// ---------- long press → contextmenu ----------

export const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll or a drag. */
export const LONG_PRESS_SLOP = 10;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * A finger held still on one spot for LONG_PRESS_MS: `fire` sends the page a
 * contextmenu there (iOS Safari never does). Android's Chrome sends its own;
 * one that comes during the press cancels ours, and one after ours is
 * swallowed, so the page gets exactly one.
 */
export class LongPress<T> {
  private timer: unknown = null;
  private start: { x: number; y: number; target: T } | null = null;
  private fired = false;
  private native = false;

  constructor(
    private readonly timers: Timers,
    private readonly fire: (x: number, y: number, target: T) => void,
    private readonly delay = LONG_PRESS_MS,
    private readonly slop = LONG_PRESS_SLOP,
  ) {}

  /** A single finger went down; a second finger cancels. */
  down(x: number, y: number, target: T, fingers = 1): void {
    this.cancel();
    this.fired = false;
    this.native = false;
    if (fingers !== 1) return;
    this.start = { x, y, target };
    this.timer = this.timers.set(() => {
      this.timer = null;
      const s = this.start;
      if (!s || this.native) return;
      this.fired = true;
      this.fire(s.x, s.y, s.target);
    }, this.delay);
  }

  move(x: number, y: number): void {
    const s = this.start;
    if (s && Math.hypot(x - s.x, y - s.y) > this.slop) this.cancel();
  }

  /** The finger lifted. True when the press fired: the click that follows must not reach the page. */
  up(): boolean {
    const fired = this.fired;
    this.cancel();
    this.fired = false;
    return fired;
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.start = null;
  }

  /** The browser's own contextmenu arrived. True: ours already went, so this one must be stopped. */
  nativeMenu(): boolean {
    if (this.fired) return true;
    this.native = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    return false;
  }
}

// ---------- edge swipe (iOS back) and drag to dismiss (sheets) ----------

/** iOS's back gesture starts this close to the left edge. */
export const EDGE_WIDTH = 24;

export interface DragResult {
  /** Distance along the drag's axis, never negative. */
  offset: number;
}

/**
 * A one-axis drag that decides early whether it's ours: it must start where
 * `accept` allows and move mostly along the axis, in `direction` (-1: toward
 * the start of the axis, a swipe to the left). On release it commits past a
 * third of `extent`, or on a quick flick.
 */
export class AxisDrag {
  private s: { x: number; y: number; t: number } | null = null;
  private last: { v: number; t: number } | null = null;
  private velocity = 0;
  private claimed = false;

  constructor(private readonly axis: 'x' | 'y', private readonly direction: 1 | -1 = 1) {}

  get active(): boolean {
    return this.claimed;
  }

  /** px/ms along the drag's direction at the last move. */
  get speed(): number {
    return this.velocity;
  }

  begin(x: number, y: number, t: number): void {
    this.s = { x, y, t };
    this.last = null;
    this.velocity = 0;
    this.claimed = false;
  }

  /** null: not (or no longer) ours. */
  move(x: number, y: number, t: number): DragResult | null {
    const s = this.s;
    if (!s) return null;
    const along = this.direction * (this.axis === 'x' ? x - s.x : y - s.y);
    const across = this.axis === 'x' ? y - s.y : x - s.x;
    if (!this.claimed) {
      if (Math.abs(across) > 10 && Math.abs(across) > Math.abs(along)) {
        this.s = null;
        return null;
      }
      if (along < 8) return null;
      this.claimed = true;
    }
    const v = Math.max(0, along);
    if (this.last && t > this.last.t) this.velocity = (v - this.last.v) / (t - this.last.t);
    this.last = { v, t };
    return { offset: v };
  }

  /** Whether the drag should complete (back, dismiss). */
  end(extent: number): boolean {
    const done = this.claimed && !!this.last && (this.last.v > extent / 3 || this.velocity > 0.5);
    this.s = null;
    this.claimed = false;
    return done;
  }
}
