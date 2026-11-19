import { describe, expect, it } from 'vitest';
import { modUsageLimits } from '../src/engine/chat';
import type { LooperApi } from '../src/shared/api';
import type { ChatState } from '../src/shared/chat';
import { chatSettingEntries } from '../src/shared/chat-settings';
import { sessionTask } from '../src/shared/projects';
import { SettingsSchema } from '../src/shared/types';

const settings = SettingsSchema.parse({});
const place = { name: 'Site', environmentId: settings.environments[0].id, cwd: '/w/site', permissionMode: 'auto' };

describe("an interactive chat's usage", () => {
  it("reads the account's limits from the mod's usage record, as Claude Code 2.1.327 writes it", () => {
    const usage = {
      context: { tokens: 33700, window: 1000000, percent: 3 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-11-19T01:10:00.000Z' },
        { kind: 'seven_day', percentUsed: 44, resetsAt: '2026-11-24T11:00:00.000Z' },
      ],
    };
    expect(modUsageLimits(usage)).toEqual({
      fiveHour: { used: 0.62, resetsAt: Date.parse('2026-11-19T01:10:00.000Z') },
      sevenDay: { used: 0.44, resetsAt: Date.parse('2026-11-24T11:00:00.000Z') },
    });
    expect(modUsageLimits({ context: { tokens: 1 } })).toBeNull();
  });
});

describe('a chat’s session type', () => {
  it("comes from its project, and is interactive for a place that doesn't say", () => {
    expect(sessionTask({ ...place, mode: 'headless' }, settings, '@project-site').agent.mode).toBe('headless');
    expect(sessionTask({ ...place, mode: 'interactive' }, settings, '@project-site').agent.mode).toBe('interactive');
    expect(sessionTask(place, settings, '@folder-1').agent.mode).toBe('interactive');
  });

  it('changes from the Chat menu between turns, and a Codex chat stays headless', () => {
    const looper = { chat: { configure: async () => undefined, setHarness: async () => undefined }, showError: () => undefined } as unknown as LooperApi;
    const chat = (over: Partial<ChatState>): ChatState =>
      ({ id: 'c', harnessKind: 'claude-code', harnesses: [], harnessId: 'h', harnessLocked: true, models: [], settings: { permissionMode: 'auto', mode: 'interactive' }, status: 'ready', permissions: [], ...over }) as ChatState;
    const mode = (s: ChatState) => chatSettingEntries(s, looper).mode.map((e) => ('label' in e ? [e.id, e.checked, e.enabled] : []));
    expect(mode(chat({}))).toEqual([
      ['interactive', true, true],
      ['headless', false, true],
    ]);
    expect(mode(chat({ status: 'working' }))).toEqual([
      ['interactive', true, false],
      ['headless', false, false],
    ]);
    expect(mode(chat({ harnessKind: 'codex', settings: { permissionMode: 'auto', mode: 'headless' } }))).toEqual([
      ['interactive', false, false],
      ['headless', true, true],
    ]);
    // In a terminal Looper can't change the permission mode in place: it waits for the turn to end, as the model does.
    const plan = (s: ChatState) => chatSettingEntries(s, looper).permission.find((e) => 'id' in e && e.id === 'plan');
    expect(plan(chat({ status: 'working' }))).toMatchObject({ enabled: false });
    expect(plan(chat({ status: 'working', settings: { permissionMode: 'auto', mode: 'headless' } }))).toMatchObject({ enabled: true });
  });
});
