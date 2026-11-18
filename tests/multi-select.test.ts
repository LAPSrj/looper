import { describe, expect, it } from 'vitest';
import { clickSelect, moveSelect, stepIndex, type MultiSelection } from '../src/renderer/src/components/multi-select';

const rows = ['a', 'b', 'c', 'd', 'e'];
const none: MultiSelection = { keys: [], lead: null, anchor: null };

describe("DataTable's several selected rows", () => {
  it('selects only the row clicked, and makes it the anchor', () => {
    expect(clickSelect(rows, { keys: ['a', 'c'], lead: 'c', anchor: 'a' }, 'd', {})).toEqual({ keys: ['d'], lead: 'd', anchor: 'd' });
  });

  it('adds or takes out a row with Ctrl, keeping the rows\' order', () => {
    const one = clickSelect(rows, none, 'd', {});
    const two = clickSelect(rows, one, 'b', { ctrl: true });
    expect(two).toEqual({ keys: ['b', 'd'], lead: 'b', anchor: 'b' });
    expect(clickSelect(rows, two, 'd', { ctrl: true })).toEqual({ keys: ['b'], lead: 'd', anchor: 'd' });
  });

  it('selects a range from the anchor with Shift, either way, and adds it with Ctrl+Shift', () => {
    const at = clickSelect(rows, none, 'b', {});
    expect(clickSelect(rows, at, 'd', { shift: true })).toEqual({ keys: ['b', 'c', 'd'], lead: 'd', anchor: 'b' });
    expect(clickSelect(rows, at, 'a', { shift: true }).keys).toEqual(['a', 'b']);
    // A second Shift+click runs from the same anchor, not from the last row.
    const wide = clickSelect(rows, clickSelect(rows, at, 'e', { shift: true }), 'c', { shift: true });
    expect(wide.keys).toEqual(['b', 'c']);
    const e = clickSelect(rows, at, 'e', { ctrl: true });
    expect(clickSelect(rows, e, 'c', { ctrl: true, shift: true }).keys).toEqual(['b', 'c', 'd', 'e']);
  });

  it('extends from the anchor with Shift and the arrows, and starts over without Shift', () => {
    let sel = moveSelect(rows, none, 'b', false);
    sel = moveSelect(rows, sel, 'c', true);
    sel = moveSelect(rows, sel, 'd', true);
    expect(sel).toEqual({ keys: ['b', 'c', 'd'], lead: 'd', anchor: 'b' });
    sel = moveSelect(rows, sel, 'a', true);
    expect(sel.keys).toEqual(['a', 'b']);
    expect(moveSelect(rows, sel, 'e', false)).toEqual({ keys: ['e'], lead: 'e', anchor: 'e' });
  });

  it('a Shift+click with no anchor yet selects the one row', () => {
    expect(clickSelect(rows, none, 'c', { shift: true })).toEqual({ keys: ['c'], lead: 'c', anchor: 'c' });
  });

  it('moves the keyboard with Up, Down, Home and End, inside the rows', () => {
    expect(stepIndex('ArrowDown', -1, 5)).toBe(0);
    expect(stepIndex('ArrowDown', 4, 5)).toBe(4);
    expect(stepIndex('ArrowUp', 0, 5)).toBe(0);
    expect(stepIndex('Home', 3, 5)).toBe(0);
    expect(stepIndex('End', 1, 5)).toBe(4);
    expect(stepIndex('ArrowLeft', 1, 5)).toBeNull();
    expect(stepIndex('ArrowDown', -1, 0)).toBeNull();
  });
});
