import { describe, expect, it } from 'vitest';
import { placeOnAxis, placeSubmenu, SMOOTH, SNAPPY, springEasing, trailingInset } from '../src/renderer/src/web/menu-motion';

const points = (easing: string) => easing.slice('linear('.length, -1).split(', ').map(Number);

describe('springEasing', () => {
  it('runs from 0 to exactly 1', () => {
    const p = points(SNAPPY.easing);
    expect(p[0]).toBe(0);
    expect(p[p.length - 1]).toBe(1);
  });

  it('overshoots with a bounce, and never without one', () => {
    expect(Math.max(...points(SNAPPY.easing))).toBeGreaterThan(1);
    expect(Math.max(...points(SMOOTH.easing))).toBeLessThanOrEqual(1);
  });

  it('runs about as long as the spring takes to settle', () => {
    expect(SNAPPY.ms).toBeGreaterThan(500);
    expect(SNAPPY.ms).toBeLessThan(900);
    expect(springEasing(0.25, 0).ms).toBeLessThan(springEasing(0.5, 0).ms);
  });
});

describe('placeSubmenu', () => {
  const row = { left: 0, top: 300, width: 250, height: 44 };

  it('puts the header over the row it opened from', () => {
    expect(placeSubmenu(row, 200, 100, 800)).toEqual({ top: 294, maxHeight: 506 });
  });

  it('moves up to fit above the bottom', () => {
    expect(placeSubmenu(row, 600, 100, 800)).toEqual({ top: 200, maxHeight: 600 });
  });

  it('stops under the menu’s top and scrolls past that', () => {
    expect(placeSubmenu(row, 900, 100, 800)).toEqual({ top: 100, maxHeight: 700 });
  });
});

describe('placeOnAxis', () => {
  // The rules each frame had written out before, for comparison.
  const clamp = (x: number, w: number, vw: number) => Math.max(8, Math.min(x, vw - w - 8));
  const shiftIn = (start: number, size: number, limit: number) => (start + size > limit - 4 ? start + Math.max(limit - 4 - (start + size), 4 - start) : start);
  const androidTop = (y: number, h: number, vh: number) => (y + h + 8 <= vh ? y : Math.max(8, y - h));

  it('clamps a menu at a point into the screen, as the phone popups do', () => {
    for (const x of [-20, 0, 5, 100, 300, 380, 500])
      for (const w of [100, 220, 390]) expect(placeOnAxis({ start: Math.max(8, x), back: 400 - 8, size: w, min: 8, max: 400 - 8 }).pos).toBe(clamp(x, w, 400));
  });

  it('shifts a desktop menu in from the edge it crosses, and leaves one that fits', () => {
    for (const start of [0, 2, 100, 700, 790])
      for (const size of [50, 300, 900]) expect(placeOnAxis({ start, back: 796, size, min: 4, max: 796 }).pos).toBe(shiftIn(start, size, 800));
  });

  it('opens an Android popup upward from the finger when it doesn’t fit below', () => {
    for (const y of [10, 300, 600, 790]) for (const h of [100, 400]) expect(placeOnAxis({ start: y, size: h, min: 8, max: 800 - 8 }).pos).toBe(androidTop(y, h, 800));
  });

  it('keeps an iOS menu on the roomier side, with that side’s room', () => {
    expect(placeOnAxis({ start: 300, back: 300, size: 600, min: 8, max: 792, roomier: true })).toEqual({ forward: true, pos: 300, room: 492 });
    expect(placeOnAxis({ start: 600, back: 640, size: 600, min: 8, max: 792, roomier: true })).toEqual({ forward: false, pos: 40, room: 632 });
  });

  it('keeps a trailing edge at least the margin in', () => {
    expect(trailingInset(390, 400)).toBe(10);
    expect(trailingInset(398, 400)).toBe(8);
  });
});
