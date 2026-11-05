import { describe, expect, it } from 'vitest';
import { AxisDrag, LongPress, LONG_PRESS_MS } from '../src/renderer/src/web/gestures';
import { BACK_SETTLE_MS, BackStack, coversScreen, darkColor, INSPECTOR_WIDTH, presentation, splitLayout } from '../src/renderer/src/web/nav-stack';

describe('the bar over a page top color', () => {
  it('takes a light title over a dark color only', () => {
    expect(darkColor('rgb(0, 0, 0)')).toBe(true);
    expect(darkColor('rgb(30, 30, 30)')).toBe(true);
    expect(darkColor('rgb(242, 242, 247)')).toBe(false);
    expect(darkColor('rgb(255, 255, 255)')).toBe(false);
    expect(darkColor('rgba(0, 0, 0, 0.2)')).toBe(false);
    expect(darkColor('transparent')).toBe(false);
    expect(darkColor(undefined)).toBe(false);
  });
});

/** A browser history: entries with a looperDepth, and popstates delivered when the test says. */
class FakeHistory {
  entries = [0];
  index = 0;
  pops: number[] = [];
  depth = () => this.entries[this.index];
  push = (depth: number) => {
    this.entries = [...this.entries.slice(0, this.index + 1), depth];
    this.index++;
  };
  go = (delta: number) => {
    this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
    this.pops.push(this.entries[this.index]);
  };
  /** The user's own back (Android's button, Safari's swipe). */
  userBack(): number {
    this.index--;
    return this.entries[this.index];
  }
  takePop(): number {
    return this.pops.shift()!;
  }
}

function setup() {
  const h = new FakeHistory();
  const clock = { t: 1000 };
  const stack = new BackStack(h, () => clock.t);
  return { h, clock, stack };
}

describe('BackStack', () => {
  it('pushes one entry per layer, each carrying its depth', () => {
    const { h, stack } = setup();
    stack.sync(2);
    expect(h.entries).toEqual([0, 1, 2]);
    expect(stack.depth).toBe(2);
    stack.sync(2);
    expect(h.entries).toEqual([0, 1, 2]);
  });

  it("a user's back closes one layer and waits for the screen to change before catching up", () => {
    const { h, clock, stack } = setup();
    stack.sync(2);
    expect(stack.popped(h.userBack())).toBe(1);
    expect(stack.depth).toBe(1);
    // The window hasn't closed yet: the history isn't refilled at once.
    stack.sync(2);
    expect(h.index).toBe(1);
    expect(stack.holdRemaining()).toBe(BACK_SETTLE_MS);
    // It closed: nothing to do.
    clock.t += BACK_SETTLE_MS;
    stack.sync(1);
    expect(h.index).toBe(1);
    expect(h.pops).toEqual([]);
  });

  it('a refused close (unsaved changes) gets its entry back once the hold is over', () => {
    const { h, clock, stack } = setup();
    stack.sync(1);
    expect(stack.popped(h.userBack())).toBe(1);
    clock.t += BACK_SETTLE_MS;
    stack.sync(1);
    expect(h.entries.slice(0, h.index + 1)).toEqual([0, 1]);
  });

  it('a window closed by its own button drops the extra entry without acting on the popstate', () => {
    const { h, stack } = setup();
    stack.sync(3);
    stack.sync(1);
    expect(h.index).toBe(1);
    expect(stack.popped(h.takePop())).toBe(0);
    expect(stack.depth).toBe(1);
  });

  it('a layer added while going back is pushed once the browser has arrived', () => {
    const { h, stack } = setup();
    stack.sync(2);
    stack.sync(0);
    stack.sync(1);
    expect(h.entries).toEqual([0, 1, 2]);
    expect(stack.popped(h.takePop())).toBe(0);
    expect(h.entries.slice(0, h.index + 1)).toEqual([0, 1]);
  });

  it("leaves the page's own entry to the browser: Back from the root leaves Looper", () => {
    const { stack } = setup();
    stack.sync(0);
    expect(stack.back()).toBe(false);
    expect(stack.popped(0)).toBe(0);
  });

  it('the bar’s Back goes through the history, so the popstate is what acts', () => {
    const { h, stack } = setup();
    stack.sync(1);
    expect(stack.back()).toBe(true);
    expect(stack.popped(h.takePop())).toBe(1);
  });

  it('a forward move is undone at the next sync', () => {
    const { h, clock, stack } = setup();
    stack.sync(2);
    stack.popped(h.userBack());
    clock.t += BACK_SETTLE_MS;
    stack.sync(1);
    // The user goes forward again to an entry that no longer means anything.
    h.index++;
    expect(stack.popped(2)).toBe(0);
    expect(h.index).toBe(1);
  });

  it('starts at the depth a reload left the history at', () => {
    const h = new FakeHistory();
    h.push(1);
    h.push(2);
    const stack = new BackStack(h, () => 0);
    expect(stack.depth).toBe(2);
    stack.sync(1);
    expect(h.index).toBe(1);
  });
});

function timers() {
  let now = 0;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    set: (fn: () => void, ms: number) => {
      const id = ++seq;
      pending.push({ at: now + ms, fn, id });
      return id;
    },
    clear: (h: unknown) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const p of [...pending].sort((a, b) => a.at - b.at)) {
        if (p.at > now) continue;
        pending.splice(pending.indexOf(p), 1);
        p.fn();
      }
    },
  };
}

describe('LongPress', () => {
  it('fires at the pressed point after 500 ms, and the click after it is swallowed', () => {
    const t = timers();
    const fired: [number, number, string][] = [];
    const lp = new LongPress<string>(t, (x, y, target) => void fired.push([x, y, target]));
    lp.down(10, 20, 'row');
    t.advance(LONG_PRESS_MS - 1);
    expect(fired).toEqual([]);
    t.advance(1);
    expect(fired).toEqual([[10, 20, 'row']]);
    expect(lp.up()).toBe(true);
  });

  it('a short tap is a click', () => {
    const t = timers();
    const lp = new LongPress<string>(t, () => undefined);
    lp.down(0, 0, 'x');
    t.advance(200);
    expect(lp.up()).toBe(false);
    t.advance(1000);
  });

  it('is cancelled by movement past the slop, but not by a jitter', () => {
    const t = timers();
    let n = 0;
    const lp = new LongPress<string>(t, () => void n++);
    lp.down(0, 0, 'x');
    lp.move(4, 5);
    t.advance(600);
    expect(n).toBe(1);
    lp.up();
    lp.down(0, 0, 'x');
    lp.move(0, 15);
    t.advance(600);
    expect(n).toBe(1);
  });

  it('a second finger (a pinch) is no press', () => {
    const t = timers();
    let n = 0;
    const lp = new LongPress<string>(t, () => void n++);
    lp.down(0, 0, 'x', 2);
    t.advance(600);
    expect(n).toBe(0);
  });

  it("Android's own contextmenu during the press wins; one after ours is swallowed", () => {
    const t = timers();
    let n = 0;
    const lp = new LongPress<string>(t, () => void n++);
    lp.down(0, 0, 'x');
    t.advance(450);
    expect(lp.nativeMenu()).toBe(false);
    t.advance(200);
    expect(n).toBe(0);
    lp.up();
    lp.down(0, 0, 'x');
    t.advance(500);
    expect(n).toBe(1);
    expect(lp.nativeMenu()).toBe(true);
  });
});

describe('AxisDrag', () => {
  it('completes past a third of the screen, or on a flick', () => {
    const d = new AxisDrag('x');
    d.begin(5, 100, 0);
    expect(d.move(20, 101, 16)).toEqual({ offset: 15 });
    d.move(150, 102, 400);
    expect(d.end(390)).toBe(true);
    d.begin(5, 100, 0);
    d.move(40, 100, 100);
    d.move(80, 100, 150);
    expect(d.end(390)).toBe(true);
    d.begin(5, 100, 0);
    d.move(40, 100, 300);
    d.move(60, 100, 600);
    expect(d.end(390)).toBe(false);
  });

  it('follows a swipe to the left with a direction of -1, and ignores one to the right', () => {
    const d = new AxisDrag('x', -1);
    d.begin(300, 100, 0);
    expect(d.move(320, 100, 16)).toBeNull();
    expect(d.move(280, 100, 32)).toEqual({ offset: 20 });
    expect(d.move(200, 101, 400)).toEqual({ offset: 100 });
    expect(d.end(120)).toBe(true);
  });

  it('lets a mostly vertical move go (the page scrolls)', () => {
    const d = new AxisDrag('x');
    d.begin(5, 100, 0);
    expect(d.move(9, 130, 16)).toBeNull();
    expect(d.move(200, 130, 32)).toBeNull();
    expect(d.end(390)).toBe(false);
  });
});

describe('presentation', () => {
  const phone = { width: 393, height: 852 };
  const ipad = { width: 820, height: 1180 };
  const win = (w: number, h: number, modal: boolean) => ({ width: w, height: h, modal });

  it('on a phone: the main window is the root, modeless windows push, modal ones are sheets', () => {
    expect(presentation('ios', win(1400, 900, false), true, phone)).toBe('root');
    expect(presentation('ios', win(900, 700, false), false, phone)).toBe('push');
    expect(presentation('ios', win(760, 620, true), false, phone)).toBe('page-sheet');
    expect(presentation('android', win(900, 700, false), false, phone)).toBe('push');
    expect(presentation('android', win(760, 620, true), false, phone)).toBe('full-dialog');
    expect(presentation('android', win(420, 260, true), false, phone)).toBe('bottom-sheet');
  });

  it('on an iPad: form sheets for small windows, page sheets for bigger ones, full screen for large ones', () => {
    expect(presentation('ios', win(480, 300, true), false, ipad)).toBe('form-sheet');
    expect(presentation('ios', win(480, 300, false), false, ipad)).toBe('form-sheet');
    expect(presentation('ios', win(760, 620, false), false, ipad)).toBe('page-sheet');
    expect(presentation('ios', win(1388, 895, false), false, ipad)).toBe('push');
  });

  it('on an Android tablet: modal windows are dialogs', () => {
    expect(presentation('android', win(760, 620, true), false, ipad)).toBe('dialog');
    expect(presentation('android', win(760, 620, false), false, ipad)).toBe('push');
  });

  it('knows which presentations hide what is under them', () => {
    expect(coversScreen('push')).toBe(true);
    expect(coversScreen('full-dialog')).toBe(true);
    expect(coversScreen('page-sheet')).toBe(false);
    expect(coversScreen('bottom-sheet')).toBe(false);
  });
});

describe('splitLayout', () => {
  const portrait = { width: 1032, height: 1376 };
  const landscape = { width: 1376, height: 1032 };

  it('splits on an iPad in both orientations: 320 pt list in portrait, 375 pt in landscape', () => {
    expect(splitLayout(1032, portrait)).toEqual({ lead: 320, inspector: 0 });
    expect(splitLayout(1376, landscape)).toEqual({ lead: 375, inspector: INSPECTOR_WIDTH });
  });

  it('puts the inspector beside the detail only when the detail keeps 600 pt', () => {
    // 1194 wide (iPad Pro 11 landscape): 320 + 360 leaves 514.
    expect(splitLayout(1194, { width: 1194, height: 834 })).toEqual({ lead: 320, inspector: 0 });
    // 1366 (iPad Pro 12.9 landscape): 375 + 360 leaves 631.
    expect(splitLayout(1366, { width: 1366, height: 1024 })?.inspector).toBe(INSPECTOR_WIDTH);
  });

  it('shows one column on a phone, and in a narrow window on an iPad', () => {
    expect(splitLayout(402, { width: 402, height: 874 })).toBeNull();
    expect(splitLayout(874, { width: 874, height: 402 })).toBeNull();
    // Split View multitasking: half of a landscape iPad.
    expect(splitLayout(678, landscape)).toBeNull();
    expect(splitLayout(744, { width: 744, height: 1133 })).toEqual({ lead: 320, inspector: 0 });
  });
});
