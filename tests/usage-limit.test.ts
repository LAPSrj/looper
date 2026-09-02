import { describe, expect, it } from 'vitest';
import { parseUsageLimitReset, USAGE_LIMIT_RE } from '../src/engine/steps/agent';

// The banner text a real usage-limited run shows (captured from claude 2.1.258).
const BANNER = "You've hit your session limit · resets 5:50am (America/Sao_Paulo)";

describe('USAGE_LIMIT_RE', () => {
  it('matches the real banner and common wordings', () => {
    expect(USAGE_LIMIT_RE.test(BANNER)).toBe(true);
    expect(USAGE_LIMIT_RE.test("You've reached your usage limit · resets at 10pm")).toBe(true);
    expect(USAGE_LIMIT_RE.test("You've hit your weekly limit · resets 22:30")).toBe(true);
  });

  it('needs the reset tail, so conversation text about limits cannot end a run', () => {
    expect(USAGE_LIMIT_RE.test("You've hit your session limit")).toBe(false);
    expect(USAGE_LIMIT_RE.test('the rate limit resets every hour')).toBe(false);
  });
});

describe('parseUsageLimitReset', () => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime(); // local noon

  const local = (dayOffset: number, hour: number, minute: number): number =>
    new Date(2026, 8, 2 + dayOffset, hour, minute, 0).getTime();

  it('resolves am/pm times to the next occurrence', () => {
    expect(parseUsageLimitReset(BANNER, now)).toBe(local(1, 5, 50)); // 5:50am already passed today
    expect(parseUsageLimitReset('resets 1pm', now)).toBe(local(0, 13, 0));
    expect(parseUsageLimitReset('resets at 12am', now)).toBe(local(1, 0, 0));
  });

  it('accepts 24h times and rejects nonsense', () => {
    expect(parseUsageLimitReset('resets 22:30', now)).toBe(local(0, 22, 30));
    expect(parseUsageLimitReset('resets 25:00', now)).toBeNull();
    expect(parseUsageLimitReset('no time here', now)).toBeNull();
  });
});
