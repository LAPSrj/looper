import { describe, expect, it } from 'vitest';
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, clampAutoCompactPercent } from '../src/shared/auto-compact';
import { SettingsSchema } from '../src/shared/types';

describe('auto compact share', () => {
  it('clamps to 10-99 as a whole number', () => {
    expect([AUTO_COMPACT_MIN, AUTO_COMPACT_MAX]).toEqual([10, 99]);
    expect(clampAutoCompactPercent(1)).toBe(10);
    expect(clampAutoCompactPercent(0)).toBe(10);
    expect(clampAutoCompactPercent(-5)).toBe(10);
    expect(clampAutoCompactPercent(10)).toBe(10);
    expect(clampAutoCompactPercent(85.6)).toBe(86);
    expect(clampAutoCompactPercent(99)).toBe(99);
    expect(clampAutoCompactPercent(100)).toBe(99);
  });

  it('is the same range in the settings schema', () => {
    const percent = (n: number) => SettingsSchema.safeParse({ chats: { autoCompact: { percent: n } } }).success;
    expect(percent(9)).toBe(false);
    expect(percent(10)).toBe(true);
    expect(percent(99)).toBe(true);
    expect(percent(100)).toBe(false);
    expect(SettingsSchema.parse({}).chats.autoCompact.percent).toBe(90);
  });
});
