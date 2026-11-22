import { describe, expect, it } from 'vitest';
import { BatchPlace, SETTLE_MS, firstBelow, firstDrawn, nextDrawn, placeKey, placeToRestore, type Drawn } from '../src/renderer/src/components/kept-place';

const KEPT = { chat: 'c1', item: 0, offset: 0, atEnd: false };
const kept = JSON.stringify(KEPT);

describe('a kept place', () => {
  it('comes back for the chat a phone screen or a chat window is loaded to show', () => {
    expect(placeToRestore('c1', '#sessions/c1', kept)).toEqual(KEPT);
    expect(placeToRestore('c1', '#sessions/c1/window', kept)).toEqual(KEPT);
  });

  it('never comes back for a chat opened from a list, even right after Looper starts', () => {
    expect(placeToRestore('c1', '', kept)).toBeNull();
    expect(placeToRestore('c1', '#sessions/c2', kept)).toBeNull();
    expect(placeToRestore('c1', '#sessions/c1', JSON.stringify({ ...KEPT, chat: 'c2' }))).toBeNull();
  });

  it('is kept per phone screen, and per address elsewhere', () => {
    expect(placeKey('?w=7', '#sessions/c1')).toBe('looper.place.7');
    expect(placeKey('', '#sessions/c1/window')).toBe('looper.place.#sessions/c1/window');
  });
});

describe('the items a conversation draws first', () => {
  it('are the newest ones, following what arrives, when it opens anew', () => {
    expect(firstDrawn(1000, 15)).toEqual({ start: 985, end: null });
    expect(firstDrawn(10, 15)).toEqual({ start: 0, end: null });
  });

  it('are a screen from the kept item, however long the conversation, when its place comes back', () => {
    expect(firstDrawn(1000, 15, 0)).toEqual({ start: 0, end: 15 });
    expect(firstDrawn(1000, 15, 500)).toEqual({ start: 500, end: 515 });
  });

  it('follow what arrives once they reach the newest', () => {
    expect(firstDrawn(1000, 15, 990)).toEqual({ start: 990, end: null });
    expect(firstDrawn(1000, 15, 2000)).toEqual({ start: 1000, end: null });
  });
});

describe('the items a conversation draws as it changes', () => {
  const at = (start: number, end: number | null, lead = 0, empty = false): Drawn => ({ key: 'c1', start, end, lead, empty });

  it('stay the newest few when a reopened chat’s history comes after it opened with none', () => {
    // A dashboard card (6 items) drawn before the history was read: then 600 items of history and 1 row of its own.
    expect(nextDrawn(at(0, null, 0, true), 'c1', 601, 600, 6)).toEqual({ key: 'c1', start: 595, end: null, lead: 600, empty: false });
  });

  it('stay the same items when the whole history replaces its newest rows ahead of them', () => {
    // 40 newest rows of history and 2 of the chat's own, 6 drawn; then the whole history, 900 items.
    expect(nextDrawn(at(36, null, 40), 'c1', 902, 900, 6)).toEqual({ key: 'c1', start: 896, end: null, lead: 900, empty: false });
    // A kept place's window moves with its items.
    expect(nextDrawn(at(10, 25, 40), 'c1', 902, 900, 15)).toEqual({ key: 'c1', start: 870, end: 885, lead: 900, empty: false });
  });

  it('take in what arrives at the end, as before', () => {
    const d = at(985, null, 0);
    expect(nextDrawn(d, 'c1', 1001, 0, 15)).toBe(d);
    expect(nextDrawn(at(10, 25), 'c1', 20, 0, 15)).toEqual(at(10, null));
  });

  it('start over for another conversation', () => {
    expect(nextDrawn(at(3, null, 5), 'c2', 100, 0, 15)).toEqual({ key: 'c2', start: 85, end: null, lead: 0, empty: false });
  });
});

describe('the item at the top of the view', () => {
  // Items 100 px tall: item i ends at (i + 1) * 100.
  const bottom = (i: number) => (i + 1) * 100;

  it('is the first one whose bottom is below the view’s top', () => {
    expect(firstBelow(10, bottom, 0)).toBe(0);
    expect(firstBelow(10, bottom, 99)).toBe(0);
    expect(firstBelow(10, bottom, 100)).toBe(1);
    expect(firstBelow(10, bottom, 450)).toBe(4);
  });

  it('is the last one when the view starts past them all', () => {
    expect(firstBelow(10, bottom, 5000)).toBe(9);
    expect(firstBelow(1, bottom, 5000)).toBe(0);
  });
});

/** An item of the fake scroller: a box `height` tall, with an inline margin above it as an element's style has. */
class Item {
  readonly style = { marginTop: '' };
  constructor(
    readonly owner: Scroller,
    public height: number,
    readonly name: string,
  ) {}
  get isConnected(): boolean {
    return this.owner.children.includes(this);
  }
  getBoundingClientRect() {
    const top = this.owner.yOf(this) - this.owner.scrollTop;
    return { top, bottom: top + this.height };
  }
}

/**
 * A scroller whose items stack one under another from its top, as a browser lays them out: a negative margin on the
 * first pulls them all up, and what goes above the top can't be scrolled to. `drops`: a scrollTop written while the
 * reader scrolls (`scrolling`) is dropped, as WebKit on iOS does.
 */
class Scroller {
  children: Item[] = [];
  readonly clientHeight = 600;
  readonly clientTop = 0;
  readonly style = { overflowAnchor: '' };
  scrolling = false;
  private top = 0;
  constructor(private readonly drops = false) {}
  yOf(item: Item): number {
    let y = 0;
    for (const c of this.children) {
      y += parseFloat(c.style.marginTop) || 0;
      if (c === item) return y;
      y += c.height;
    }
    throw new Error('not here');
  }
  get scrollHeight(): number {
    const last = this.children.at(-1);
    return Math.max(this.clientHeight, last ? this.yOf(last) + last.height : 0);
  }
  get scrollTop(): number {
    return this.top;
  }
  set scrollTop(v: number) {
    if (this.drops && this.scrolling) return;
    this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
  }
  /** The reader's own scroll; `bounce`: past the top, as iOS's rubber band goes. */
  scrollBy(dy: number, bounce = false): void {
    const top = this.top + dy;
    this.top = bounce ? top : Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
  }
  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight };
  }
  add(count: number, height: number, name: string): Item[] {
    return Array.from({ length: count }, (_, i) => new Item(this, height, `${name}${i}`));
  }
  /** Older items drawn above the first item (after a title, when there is one). */
  prepend(items: Item[], after = 0): void {
    this.children.splice(after, 0, ...items);
  }
  /** Where each item shows in the view, by name. */
  view(): Record<string, number> {
    return Object.fromEntries(this.children.map((c) => [c.name, c.getBoundingClientRect().top]));
  }
}

function setup(opts: { drops?: boolean; shift?: boolean } = {}) {
  const el = new Scroller(opts.drops);
  el.children = el.add(30, 100, 'old');
  el.scrollTop = 1200;
  let fingers = 0;
  const timers: (() => void)[] = [];
  const place = new BatchPlace({
    shiftWhileScrolling: !!opts.shift,
    fingers: () => fingers,
    setTimer: (fn, ms) => {
      expect(ms).toBe(SETTLE_MS);
      timers.push(fn);
      return fn;
    },
    clearTimer: (t) => timers.splice(timers.indexOf(t as () => void), 1),
    frame: (fn) => timers.push(fn),
  });
  /** SETTLE_MS pass, and two frames. */
  const later = () => {
    for (let i = 0; i < 3; i++) timers.splice(0).forEach((fn) => fn());
  };
  return { el, place, later, fingers: (n: number) => (fingers = n) };
}

/** Where the items that were there already show, leaving out the added ones. */
const oldView = (el: Scroller) => Object.fromEntries(Object.entries(el.view()).filter(([k]) => k.startsWith('old') || k === 'title'));

describe('the place kept as older items are drawn above', () => {
  it('stays where it was: what the reader sees doesn’t move', () => {
    const { el, place } = setup();
    const seen = el.view();
    place.before(el);
    expect(el.style.overflowAnchor).toBe('none');
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    expect(oldView(el)).toEqual(seen);
    expect(el.scrollTop).toBe(1200 + 2400);
    expect(el.style.overflowAnchor).toBe('');
  });

  it('stays where the reader is when they’re drawn, though they went on scrolling after asking for them', () => {
    const { el, place } = setup();
    place.before(el);
    // The reader scrolls up 150 px before the items are drawn: the scroller isn't put back where it was asked from.
    el.scrollBy(-150);
    const seen = el.view();
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    expect(oldView(el)).toEqual(seen);
  });

  it('doesn’t count what changed below the view, such as a reply growing at the end', () => {
    const { el, place } = setup();
    const seen = el.view();
    place.before(el);
    el.children.at(-1)!.height += 300;
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    expect(oldView(el)).toEqual(seen);
  });

  it('is kept by the items, not by a title above where they’re added', () => {
    const { el, place } = setup();
    el.children.unshift(new Item(el, 40, 'title'));
    el.scrollTop = 0;
    const seen = el.view();
    place.before(el);
    el.prepend(el.add(20, 120, 'new'), 1);
    place.drawn(el);
    const after = oldView(el);
    expect(after.old0).toBe(seen.old0);
    expect(after.old5).toBe(seen.old5);
    // The title stays first, above the added items.
    expect(after.title).toBe(seen.title - 2400);
  });
});

describe('the place kept on a scroller that drops a scrollTop written while the reader scrolls (WebKit on iOS)', () => {
  it('is lost by writing the scroller’s position during a fling: the reader sees the start of the added items', () => {
    // What Leandro saw on his iPhone, and why the items are shifted there instead.
    const { el, place } = setup({ drops: true });
    el.scrollTop = 300;
    el.scrolling = true;
    const seen = el.view();
    place.before(el);
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    expect(el.scrollTop).toBe(300);
    expect(el.view().new17).toBe(-300 + 17 * 120);
    expect(oldView(el).old3).toBe(seen.old3 + 2400);
  });

  it('is kept by shifting the items while the reader scrolls, and by the scroller once the scroll has ended', () => {
    const { el, place, later } = setup({ drops: true, shift: true });
    el.scrollTop = 300;
    el.scrolling = true;
    place.before(el);
    el.scrollBy(-40);
    const seen = el.view();
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    expect(oldView(el)).toEqual(seen);
    expect(el.scrollTop).toBe(260);
    // The added items are above the top, out of reach, until the scroll ends.
    expect(el.view().new19).toBeLessThan(-260 + 1);
    expect(el.style.overflowAnchor).toBe('none');
    // The fling goes on: nothing changes.
    el.scrollBy(-60);
    const moving = el.view();
    later();
    expect(el.view()).toEqual(moving);
    expect(el.children[0].style.marginTop).not.toBe('');
    // It has ended: held still for SETTLE_MS, the shift goes into the scroller's position, and nothing moves on the screen.
    el.scrolling = false;
    later();
    expect(el.view()).toEqual(moving);
    expect(el.children[0].style.marginTop).toBe('');
    expect(el.scrollTop).toBe(200 + 2400);
    expect(oldView(el)).toEqual(Object.fromEntries(Object.entries(moving).filter(([k]) => k.startsWith('old'))));
    expect(el.style.overflowAnchor).toBe('');
  });

  it('waits for a finger to lift and for the rubber band at the top to come back', () => {
    const { el, place, later, fingers } = setup({ drops: true, shift: true });
    el.scrollTop = 100;
    place.before(el);
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    fingers(1);
    later();
    later();
    expect(el.children[0].style.marginTop).not.toBe('');
    fingers(0);
    el.scrollBy(-180, true);
    later();
    later();
    expect(el.children[0].style.marginTop).not.toBe('');
    el.scrollBy(80, true);
    const seen = el.view();
    later();
    later();
    expect(el.children[0].style.marginTop).toBe('');
    expect(el.scrollTop).toBe(2400);
    expect(el.view()).toEqual(seen);
  });

  it('waits while the scroller reports scrolling, though its position is where it was', () => {
    const { el, place, later } = setup({ drops: true, shift: true });
    el.scrollTop = 300;
    place.before(el);
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    place.scrolled();
    later();
    expect(el.children[0].style.marginTop).not.toBe('');
    later();
    expect(el.children[0].style.marginTop).toBe('');
  });

  it('takes in a second batch drawn during the same fling', () => {
    const { el, place, later } = setup({ drops: true, shift: true });
    el.scrollTop = 300;
    el.scrolling = true;
    place.before(el);
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    el.scrollBy(-100);
    place.before(el);
    el.prepend(el.add(10, 90, 'newer'));
    place.drawn(el);
    const seen = el.view();
    expect(el.children.filter((c) => c.style.marginTop !== '')).toEqual([el.children[0]]);
    el.scrolling = false;
    later();
    later();
    expect(el.view()).toEqual(seen);
    expect(el.scrollTop).toBe(200 + 2400 + 900);
  });

  it('is dropped without moving when the scroller goes elsewhere (a status bar tap to the top)', () => {
    const { el, place } = setup({ drops: true, shift: true });
    el.scrollTop = 300;
    el.scrolling = true;
    place.before(el);
    el.prepend(el.add(20, 120, 'new'));
    place.drawn(el);
    place.drop(el);
    expect(el.children.every((c) => c.style.marginTop === '')).toBe(true);
    expect(el.style.overflowAnchor).toBe('');
  });
});
