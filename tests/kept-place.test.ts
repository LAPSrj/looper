import { describe, expect, it } from 'vitest';
import { firstBelow, firstDrawn, placeKey, placeToRestore } from '../src/renderer/src/components/kept-place';

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
