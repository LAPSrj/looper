import { describe, expect, it } from 'vitest';
import { placeSubmenu, SMOOTH, SNAPPY, springEasing } from '../src/renderer/src/web/menu-motion';

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
