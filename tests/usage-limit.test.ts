import { describe, expect, it } from 'vitest';
import { CONTINUE_MARGIN_MS, CONTINUE_RETRY_MS, continueAt, continueDelay, continueSkipped } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';
import { renameSessionRequest } from '../src/engine/chat';
import { CodexAccumulator, TranscriptAccumulator } from '../src/engine/messages';
import { limitState, usageLimitOf } from '../src/engine/sessions';
import { parseUsageLimitReset, USAGE_LIMIT_RE } from '../src/engine/steps/agent';
import { HeadlessStream, parseCodexLimitReset } from '../src/engine/steps/session';

// The banner text a real usage-limited run shows (captured from claude 2.1.258).
const BANNER = "You've hit your session limit · resets 5:50am (America/Sao_Paulo)";
// Codex's error, from a rollout's task_complete record (codex_error_info "usage_limit_exceeded").
const CODEX =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 22nd, 2026 2:21 AM.';

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

describe("Codex's usage-limit reset", () => {
  const now = new Date(2026, 8, 21, 22, 0, 0).getTime();

  it('reads a dated time, and a bare one as its next occurrence', () => {
    expect(parseCodexLimitReset(CODEX, now)).toBe(new Date(2026, 8, 22, 2, 21, 0).getTime());
    expect(parseCodexLimitReset('try again at 9:05 PM.', now)).toBe(new Date(2026, 8, 22, 21, 5, 0).getTime());
    expect(parseCodexLimitReset('try again later', now)).toBeNull();
  });

  it('gives a task run the reset time instead of the hourly retry', () => {
    const s = new HeadlessStream();
    s.feed(JSON.stringify({ type: 'turn.failed', error: { message: CODEX } }));
    expect(s.usageLimit).toBe(true);
    expect(s.usageLimitResetMs).toBe(new Date(2026, 8, 22, 2, 21, 0).getTime());
  });
});

describe('a conversation that ended on the usage limit', () => {
  const at = Date.UTC(2026, 8, 2, 15, 0, 0);
  const row = (kind: MessageRow['kind'], text: string): MessageRow => ({ id: text, kind, text, preview: '', ts: new Date(at).toISOString() });

  it('is the turn ending on a limit error, until the user writes again', () => {
    const hit = usageLimitOf([row('prompt', 'go'), row('error', BANNER)], 0);
    expect(hit?.at).toBe(at);
    expect(hit?.resetsAt).toBe(parseUsageLimitReset(BANNER, at));
    expect(usageLimitOf([row('prompt', 'go'), row('error', 'API Error: overloaded')], 0)).toBeUndefined();
    expect(usageLimitOf([row('error', BANNER), row('prompt', 'again')], 0)).toBeUndefined();
    expect(usageLimitOf([row('error', CODEX)], 0)?.resetsAt).toBeTypeOf('number');
  });

  it('shows as limited until the reset, restored until the user looks, then not at all', () => {
    expect(limitState({ at: 0, resetsAt: 100 }, 50, 0)).toEqual({ resetsAt: 100 });
    expect(limitState({ at: 0, resetsAt: 100 }, 100, 50)).toEqual({ resetsAt: 100, restored: true });
    expect(limitState({ at: 0, resetsAt: 100 }, 200, 150)).toBeUndefined();
    expect(limitState({ at: 0 }, 1e12, 1e12)).toEqual({});
  });

  it("is read from a Codex rollout's failed turn", () => {
    const acc = new CodexAccumulator();
    acc.addLine(JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'task_complete', error: { message: CODEX, codex_error_info: 'usage_limit_exceeded' } } }));
    expect(acc.rows).toMatchObject([{ kind: 'error', text: CODEX }]);
  });
});

describe('Continue When Limit Resets', () => {
  // A fake clock: the delay is worked out from `now` alone.
  it('waits until just after the reset, and goes at once when the reset has passed', () => {
    expect(continueDelay({ at: 1000, resetsAt: 61_000 }, 1000)).toBe(60_000 + CONTINUE_MARGIN_MS);
    expect(continueDelay({ at: 1000, resetsAt: 61_000 }, 61_000)).toBe(CONTINUE_MARGIN_MS);
    expect(continueDelay({ at: 1000, resetsAt: 61_000 }, 500_000)).toBe(0);
  });

  it('tries hourly without a reset time, or when the turn failed after the time it gave', () => {
    expect(continueDelay({ at: 1000 }, 1000)).toBe(CONTINUE_RETRY_MS);
    expect(continueDelay({ at: 70_000, resetsAt: 61_000 }, 70_000)).toBe(CONTINUE_RETRY_MS);
  });

  it('sends just after the reset time, when there is one', () => {
    expect(continueAt({ at: 1000, resetsAt: 61_000 })).toBe(61_000 + CONTINUE_MARGIN_MS);
    expect(continueAt({ at: 1000 })).toBeUndefined();
  });
});

describe("Settings → Chats' cache rule for continuing", () => {
  const on = (aboveTokens: number) => ({ enabled: true, aboveTokens });

  it('does nothing while off, or while the cache lasts', () => {
    expect(continueSkipped({ enabled: false, aboveTokens: 0 }, 2000, 1000, 500_000)).toBe(false);
    expect(continueSkipped(on(0), 1000, 2000, 500_000)).toBe(false);
  });

  it('at 0, stops any expired chat, even one whose context size is unknown', () => {
    expect(continueSkipped(on(0), 2000, 1000, 10)).toBe(true);
    expect(continueSkipped(on(0), 2000, 1000, undefined)).toBe(true);
  });

  it('above 0, stops only a context over the size', () => {
    expect(continueSkipped(on(200_000), 2000, 1000, 200_001)).toBe(true);
    expect(continueSkipped(on(200_000), 2000, 1000, 200_000)).toBe(false);
    expect(continueSkipped(on(200_000), 2000, 1000, undefined)).toBe(false);
  });

  it("doesn't stop a harness that reports no cache time", () => {
    expect(continueSkipped(on(0), 2000, undefined, 500_000)).toBe(false);
  });
});

describe('session names', () => {
  it("takes Claude Code's latest custom-title over its ai-title, and an empty one takes it away", () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the footer' }));
    expect(acc.sessionName).toBe('Fix the footer');
    acc.addLine(JSON.stringify({ type: 'custom-title', customTitle: 'Footer work' }));
    expect(acc.sessionName).toBe('Footer work');
    acc.addLine(JSON.stringify({ type: 'custom-title', customTitle: '' }));
    expect(acc.sessionName).toBe('Fix the footer');
  });

  it('renames a Claude Code session as a host does', () => {
    expect(JSON.parse(renameSessionRequest('r1', 'Footer', 's1'))).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'rename_session', title: 'Footer', source: 'host', session_id: 's1' },
    });
  });
});
