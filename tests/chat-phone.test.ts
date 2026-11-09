import { describe, expect, it } from 'vitest';
import { sendsOnEnter } from '../src/renderer/src/components/composer-text';
import { draggedHeight, settleSheet } from '../src/renderer/src/components/phone/sheet-detents';
import { newestFirst, runningText, subagentContext, subagentTabs } from '../src/renderer/src/components/subagents';
import { cacheText, contextValue, limitFacts, sessionFacts, sessionLimits, usageLabel, usageTone } from '../src/renderer/src/components/usage';
import type { SessionSummary, SubagentInfo } from '../src/shared/sessions';

const NOW = Date.parse('2026-10-31T12:00:00');
const clock = (ts: number) => `at ${ts}`;

describe('usageTone', () => {
  it('is normal below 80%, warning from 80%, critical from 95%', () => {
    expect(usageTone(0)).toBe('normal');
    expect(usageTone(0.79)).toBe('normal');
    expect(usageTone(0.8)).toBe('warning');
    expect(usageTone(0.94)).toBe('warning');
    expect(usageTone(0.95)).toBe('critical');
    expect(usageTone(1)).toBe('critical');
  });
});

describe('limitFacts', () => {
  it('lists the 5-hour limit, its reset and the weekly limit', () => {
    const facts = limitFacts({ fiveHour: { used: 0.67, resetsAt: NOW + 130 * 60_000 }, sevenDay: { used: 0.4, resetsAt: NOW + 1e9 } }, NOW);
    expect(facts).toEqual([
      { label: '5-hour limit', value: '67%', tone: undefined },
      { label: 'Resets in', value: '2 h 10 min' },
      { label: 'Weekly limit', value: '40%', tone: undefined },
    ]);
  });

  it('colors a limit close to its end', () => {
    const facts = limitFacts({ fiveHour: { used: 0.85, resetsAt: NOW - 1 }, sevenDay: { used: 0.97, resetsAt: NOW + 1 } }, NOW);
    expect(facts.map((f) => [f.label, f.value, f.tone])).toEqual([
      ['5-hour limit', '85%', 'warning'],
      ['Resets', 'now', undefined],
      ['Weekly limit', '97%', 'error'],
    ]);
  });

  it('has nothing for an account without limits', () => {
    expect(limitFacts({}, NOW)).toEqual([]);
  });
});

describe('sessionLimits', () => {
  it("takes the limits of the session's own harness, and none without a session or a report", () => {
    const work = { sevenDay: { used: 0.4, resetsAt: 1 } };
    const state = { sessions: [], limits: { 'local/work': work, 'local/home': { sevenDay: { used: 0.9, resetsAt: 1 } } } };
    const session = (limitsKey?: string) => ({ limitsKey }) as SessionSummary;
    expect(sessionLimits(state, session('local/work'))).toBe(work);
    expect(sessionLimits(state, session('windows/work'))).toEqual({});
    expect(sessionLimits(state, session())).toEqual({});
    expect(sessionLimits(state, undefined)).toEqual({});
  });
});

describe('sessionFacts', () => {
  it('has one fact per row, in order', () => {
    const facts = sessionFacts(
      { harness: 'Claude Code', model: 'Opus', context: { tokens: 58_000, window: 1_000_000 }, lastReplyAt: 5, cacheUntil: NOW + 3 * 60_000 },
      NOW,
      clock,
    );
    expect(facts).toEqual([
      { label: 'Harness', value: 'Claude Code' },
      { label: 'Model', value: 'Opus' },
      { label: 'Context', value: '58k of 1M (6%)' },
      { label: 'Last reply', value: 'at 5' },
      { label: 'Prompt cache', value: '3 min left' },
    ]);
  });

  it('leaves out what doesn\'t apply yet', () => {
    expect(sessionFacts({ harness: 'Codex' }, NOW, clock)).toEqual([{ label: 'Harness', value: 'Codex' }]);
    expect(sessionFacts({ lastReplyAt: 5 }, NOW, clock)).toEqual([{ label: 'Last reply', value: 'at 5' }]);
  });

  it('says how long the cache has left', () => {
    expect(cacheText(NOW - 1, NOW)).toBe('Expired');
    expect(cacheText(NOW + 30_000, NOW)).toBe('Under a minute left');
    expect(cacheText(NOW + 61 * 60_000, NOW)).toBe('1 h 1 min left');
  });

  it('shortens a context without a window', () => {
    expect(contextValue({ tokens: 900 })).toBe('900');
  });
});

describe('usageLabel', () => {
  it('names the numbers the icon draws', () => {
    expect(usageLabel({ tokens: 58_000, window: 1_000_000 }, { fiveHour: { used: 0.67, resetsAt: NOW } })).toBe('Usage: 58k of 1M context (6%), 5-hour limit 67%');
    expect(usageLabel(undefined, {})).toBe('Usage');
  });
});

const agent = (agentId: string, status: SubagentInfo['status']): SubagentInfo => ({ agentId, toolUseId: agentId, type: 't', description: agentId, status });

describe('newestFirst', () => {
  it('lists the subagents by when their Agent call was made, newest first, one not in the conversation yet first of all', () => {
    const at = (id: string, startedAt?: string): SubagentInfo => ({ ...agent(id, 'done'), ...(startedAt ? { startedAt } : {}) });
    const list = [at('a', '2026-11-04T10:00:00Z'), at('b', '2026-11-04T10:05:00Z'), at('c'), at('d', '2026-11-04T09:00:00Z')];
    expect(newestFirst(list).map((a) => a.agentId)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('subagentContext', () => {
  it('fills by its context in its window, and not without the window', () => {
    expect(subagentContext({ ...agent('a', 'running'), contextTokens: 50_000, contextWindow: 200_000 })).toBe(0.25);
    expect(subagentContext({ ...agent('a', 'running'), contextTokens: 50_000 })).toBeNull();
    expect(subagentContext(agent('a', 'running'))).toBeNull();
  });
});

describe('subagentTabs', () => {
  const all = [agent('a', 'done'), agent('b', 'running'), agent('c', 'failed'), agent('d', 'running')];

  it('shows only the running ones, in order, when none is open', () => {
    expect(subagentTabs(all, null).map((a) => a.agentId)).toEqual(['b', 'd']);
  });

  it('keeps the open finished one, after the running ones', () => {
    expect(subagentTabs(all, 'a').map((a) => a.agentId)).toEqual(['b', 'd', 'a']);
  });

  it('puts the open running one among the running', () => {
    expect(subagentTabs(all, 'd').map((a) => a.agentId)).toEqual(['b', 'd']);
  });

  it('has none for finished subagents', () => {
    expect(subagentTabs([agent('a', 'done')], null)).toEqual([]);
  });
});

describe('runningText', () => {
  it('counts only the running ones', () => {
    expect(runningText(['done', 'running', 'running'], [])).toBe('2 subagents running');
    expect(runningText([], ['running', 'failed'])).toBe('1 workflow running');
    expect(runningText(['running'], ['running'])).toBe('1 subagent and 1 workflow running');
  });

  it('is null when none is running, so the bar has no subtitle', () => {
    expect(runningText(['done', 'failed'], ['done'])).toBeNull();
    expect(runningText([], [])).toBeNull();
  });
});

describe('sendsOnEnter', () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

  it('sends on Enter on the desktop, but not with Shift or Ctrl', () => {
    expect(sendsOnEnter(key('Enter'), false)).toBe(true);
    expect(sendsOnEnter(key('Enter', { shiftKey: true }), false)).toBe(false);
    expect(sendsOnEnter(key('Enter', { ctrlKey: true }), false)).toBe(false);
    expect(sendsOnEnter(key('a'), false)).toBe(false);
  });

  it('adds a line break on Enter on a phone, and sends on Ctrl+Enter or Cmd+Enter', () => {
    expect(sendsOnEnter(key('Enter'), true)).toBe(false);
    expect(sendsOnEnter(key('Enter', { shiftKey: true }), true)).toBe(false);
    expect(sendsOnEnter(key('Enter', { ctrlKey: true }), true)).toBe(true);
    expect(sendsOnEnter(key('Enter', { metaKey: true }), true)).toBe(true);
  });
});

describe('settleSheet', () => {
  it('stays put for a small drag', () => {
    expect(settleSheet('medium', 20, 0, 800)).toBe('medium');
    expect(settleSheet('large', -20, 0, 800)).toBe('large');
  });

  it('opens to large when dragged up or flicked up', () => {
    expect(settleSheet('medium', -100, 0, 800)).toBe('large');
    expect(settleSheet('medium', -10, -1, 800)).toBe('large');
  });

  it('closes large to medium, and medium to nothing', () => {
    expect(settleSheet('large', 120, 0, 800)).toBe('medium');
    expect(settleSheet('medium', 120, 0, 800)).toBe('dismiss');
    expect(settleSheet('medium', 10, 1, 800)).toBe('dismiss');
  });

  it('closes large outright when dragged past half the page', () => {
    expect(settleSheet('large', 500, 0, 800)).toBe('dismiss');
  });
});

describe('draggedHeight', () => {
  it('follows the finger between nothing and the large height', () => {
    expect(draggedHeight('medium', 0, 1000)).toBe(500);
    expect(draggedHeight('medium', 100, 1000)).toBe(400);
    expect(draggedHeight('medium', -900, 1000)).toBe(920);
    expect(draggedHeight('medium', 900, 1000)).toBe(0);
  });
});
