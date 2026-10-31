import { describe, expect, it } from 'vitest';
import type { AttentionRow } from '../src/shared/dashboard';
import type { SessionSummary } from '../src/shared/sessions';
import type { Task } from '../src/shared/types';
import {
  TEXT_LARGER,
  TEXT_SMALLER,
  chatMore,
  clockTime,
  dayGroups,
  dayTitle,
  resultTone,
  splitAttention,
  taskNameOf,
  taskSummary,
  terminalOverlay,
  terminalTitle,
  timeAndDuration,
  waitedFor,
  waitingForYou,
} from '../src/renderer/src/phone-lists';

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 31, 9, 30);

describe('lists by day', () => {
  it('names the day: Today, Yesterday, then the date (with the year only when it is another one)', () => {
    expect(dayTitle(at(2026, 10, 31, 0, 5), NOW)).toBe('Today');
    expect(dayTitle(at(2026, 10, 30, 23, 59), NOW)).toBe('Yesterday');
    expect(dayTitle(at(2026, 10, 19), NOW)).toBe(new Date(at(2026, 10, 19)).toLocaleDateString([], { day: 'numeric', month: 'short' }));
    expect(dayTitle(at(2025, 10, 19), NOW)).toContain('2025');
    // Across the year's edge, "yesterday" is still yesterday.
    expect(dayTitle(at(2025, 12, 31), at(2026, 1, 1))).toBe('Yesterday');
  });

  it('groups a newest-first list into one group per day, keeping the list order', () => {
    const runs = [
      { id: 'a', ts: at(2026, 10, 31, 8) },
      { id: 'b', ts: at(2026, 10, 31, 1) },
      { id: 'c', ts: at(2026, 10, 30, 22) },
      { id: 'd', ts: at(2026, 10, 19, 10) },
      { id: 'e', ts: at(2026, 10, 19, 9) },
    ];
    const groups = dayGroups(runs, (r) => r.ts, NOW);
    expect(groups.map((g) => [g.title, g.items.map((r) => r.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      [dayTitle(at(2026, 10, 19), NOW), ['d', 'e']],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });

  it('keeps an item without a time in the group before it, or in the first group that has a time', () => {
    const items = [{ ts: NaN }, { ts: at(2026, 10, 31, 8) }, { ts: NaN }, { ts: at(2026, 10, 30, 8) }];
    const groups = dayGroups(items, (i) => i.ts, NOW);
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([
      ['Today', 3],
      ['Yesterday', 1],
    ]);
    expect(dayGroups([], () => 0, NOW)).toEqual([]);
  });

  it('writes a row: its time, and its duration when it has one', () => {
    expect(clockTime(at(2026, 10, 31, 22, 40))).toMatch(/^22[:.]40$/);
    expect(timeAndDuration(at(2026, 10, 31, 22, 40), '3s')).toMatch(/^22[:.]40 · 3s$/);
    expect(timeAndDuration(at(2026, 10, 31, 22, 40), '')).toMatch(/^22[:.]40$/);
  });

  it('colors a result as text: errors red, warnings orange, the rest the ordinary gray', () => {
    expect(resultTone('error')).toBe('error');
    expect(resultTone('max-runtime')).toBe('error');
    expect(resultTone('warning')).toBe('warning');
    expect(resultTone('noop')).toBeUndefined();
    expect(resultTone('success')).toBeUndefined();
  });

  it('titles a run window with the task name only', () => {
    expect(taskNameOf('Issue triage – 20261018-002002-lxlk', '20261018-002002-lxlk')).toBe('Issue triage');
    expect(taskNameOf('Subagent: survey', 'r1')).toBe('Subagent: survey');
    expect(taskNameOf(' – r1', 'r1')).toBe(' – r1');
  });
});

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 's', kind: 'chat', taskId: 't', groupName: 'Web app', title: 'A chat', harnessKind: 'claude-code', harnessName: 'Claude Code', status: 'ready', startedAt: 0, background: 0, ...over }) as SessionSummary;

const attention = (over: Partial<AttentionRow> & { name?: string }): AttentionRow =>
  ({ task: { id: 'task-1', name: over.name ?? 'Nightly' } as Task, level: 'warning', problem: 'x', at: 100, runId: null, lastRunId: null, ...over }) as AttentionRow;

describe('Waiting for You', () => {
  it('lists the chats that wait, the longest wait first, then the runs that ask, with the question as subtitle', () => {
    const sessions = [
      session({ id: 'idle', title: 'Idle chat' }),
      session({ id: 'late', title: 'Late', waiting: { reason: 'permission', text: 'Allow Bash?', since: 5000 } }),
      session({ id: 'early', title: 'Early', waiting: { reason: 'notification', text: 'Which database?', since: 1000 } }),
      // A task run's agent is the run's own row, not a chat.
      session({ id: 'run-agent', kind: 'run', waiting: { reason: 'permission', text: 'Allow?', since: 10 } }),
    ];
    const rows = [
      attention({ runId: 'r1', problem: 'The agent asks: Keep going?', at: 2000, question: true }),
      attention({ problem: 'Error: it broke', runId: null, lastRunId: 'r0' }),
    ];
    const list = waitingForYou(sessions, rows);
    expect(list.map((w) => [w.kind, w.title, w.sub])).toEqual([
      ['chat', 'Early', 'Which database?'],
      ['chat', 'Late', 'Allow Bash?'],
      ['run', 'Nightly', 'The agent asks: Keep going?'],
    ]);
  });

  it('uses the agent’s last message as the subtitle of a chat that only finished its turn', () => {
    const [w] = waitingForYou([session({ waiting: { reason: 'turn', text: 'Finished its turn', since: 1 }, latest: 'Shall I also update the docs?' })], []);
    expect(w.sub).toBe('Shall I also update the docs?');
    const [plain] = waitingForYou([session({ waiting: { reason: 'turn', text: 'Finished its turn', since: 1 } })], []);
    expect(plain.sub).toBe('Finished its turn');
  });

  it('is empty when nothing waits', () => {
    expect(waitingForYou([session({})], [attention({ runId: null })])).toEqual([]);
  });

  it('splits Needs Attention: a run that waits is Waiting for You’s, the rest stay', () => {
    const waiting = attention({ runId: 'r1' });
    const failed = attention({ runId: null, lastRunId: 'r0' });
    expect(splitAttention([waiting, failed])).toEqual({ waiting: [waiting], rest: [failed] });
  });

  it('says how long it has waited, and nothing when that is unknown', () => {
    const [chat, run] = waitingForYou([session({ waiting: { reason: 'permission', text: 'Allow?', since: NOW - 5 * 60_000 } })], [attention({ runId: 'r', at: null })]);
    expect(waitedFor(chat, NOW)).toBe('5 min');
    expect(waitedFor(run, NOW)).toBe('');
  });
});

describe('the Dashboard summary row', () => {
  const counts = { running: 0, paused: 0, enabled: 7, disabled: 1, completed: 0 };

  it('joins the counts, leaving out zeros', () => {
    expect(taskSummary({ counts, loaded: true, addonsRunning: 1, remoteSessions: null })).toBe('7 enabled · 1 disabled · 1 addon running');
    expect(taskSummary({ counts: { ...counts, running: 2 }, loaded: true, addonsRunning: 3, remoteSessions: 2 })).toBe(
      '2 running · 7 enabled · 1 disabled · 3 addons running · 2 Remote Control sessions',
    );
  });

  it('shows no counts until the tasks have loaded, and leaves out the addons and sessions that have not answered', () => {
    expect(taskSummary({ counts: { running: 0, paused: 0, enabled: 0, disabled: 0, completed: 0 }, loaded: false, addonsRunning: 0, remoteSessions: 0 })).toBe('');
    expect(taskSummary({ counts, loaded: true, addonsRunning: null, remoteSessions: null })).toBe('7 enabled · 1 disabled');
    // Loaded and none running is a fact, not a placeholder: nothing to say about them either way.
    expect(taskSummary({ counts, loaded: true, addonsRunning: 0, remoteSessions: 0 })).toBe('7 enabled · 1 disabled');
  });
});

describe('terminals on a phone', () => {
  it('titles a terminal with its project when its name is the plain "Terminal"', () => {
    expect(terminalTitle({ title: 'Terminal', groupName: 'Web app' })).toBe('Terminal – Web app');
    expect(terminalTitle({ title: 'Fix the build', groupName: 'Web app' })).toBe('Fix the build');
    expect(terminalTitle({ title: 'Terminal', groupName: '' })).toBe('Terminal');
  });

  it('covers an empty terminal: starting while a session is on its way, the empty view when none is', () => {
    expect(terminalOverlay({ loaded: false, hasOutput: false, sessionActive: true })).toBeNull();
    expect(terminalOverlay({ loaded: true, hasOutput: false, sessionActive: true })).toBe('starting');
    expect(terminalOverlay({ loaded: true, hasOutput: false, sessionActive: false })).toBe('empty');
    expect(terminalOverlay({ loaded: true, hasOutput: true, sessionActive: true })).toBeNull();
  });
});

describe('a conversation’s More menu', () => {
  const refs = (kind: Parameters<typeof chatMore>[0]) => chatMore(kind).map((g) => g.map((r) => ('item' in r ? r.item : 'toolbar' in r ? r.toolbar : '?')));

  it('offers a chat its own commands, with Close Conversation last in a group of its own', () => {
    expect(refs('chat')).toEqual([['chat-find', 'chat-save-markdown', 'chat-copy-session-id'], ['chat-new-in-project', 'chat-send-to-chats'], ['chat-close']]);
  });

  it('leaves out what is desktop-only or lives elsewhere on a phone', () => {
    const all = refs('chat').flat();
    // Open in New Window and Working Directory are for a computer; Stop and Send Now are in the message box;
    // the settings are in the Usage panel; the View and Edit menus are the window's own.
    for (const gone of ['chat-stop', 'chat-send-now', 'chat-harness', 'chat-model', 'chat-effort', 'chat-permission-mode', 'chat-attach']) expect(all).not.toContain(gone);
  });

  it('gives a terminal session its text size instead of a transcript’s commands', () => {
    expect(refs('terminal')[0]).toEqual([TEXT_SMALLER, TEXT_LARGER]);
    expect(refs('terminal').flat()).not.toContain('chat-save-markdown');
    expect(refs('terminal').at(-1)).toEqual(['chat-close']);
  });

  it('gives a task run’s agent no Find', () => {
    expect(refs('run').flat()).not.toContain('chat-find');
  });
});
