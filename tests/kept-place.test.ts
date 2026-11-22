import { describe, expect, it } from 'vitest';
import { firstBelow, firstDrawn, nextDrawn, placeKey, placeToRestore, type Drawn } from '../src/renderer/src/components/kept-place';

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
