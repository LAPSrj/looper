import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../src/shared/duration';

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('250ms')).toBe(250);
  });
  it('treats bare numbers as seconds', () => {
    expect(parseDuration('30')).toBe(30_000);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('5x')).toThrow();
    expect(() => parseDuration('0m')).toThrow();
  });
});

describe('formatDuration', () => {
  it('formats', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
  });
});
