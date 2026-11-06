import { describe, expect, it } from 'vitest';
import type { AttentionRow } from '../src/shared/dashboard';
import type { MenuItemSpec } from '../src/shared/remote-access';
import type { SessionSummary } from '../src/shared/sessions';
import type { Task } from '../src/shared/types';
import type { ToolbarGroup } from '../src/renderer/src/components/toolbar-model';
import { composeMore } from '../src/renderer/src/web/more-menu';
import {
  clockTime,
  conversationMore,
  dayGroups,
  dayTitle,
  resultTone,
  splitAttention,
  taskNameOf,
  taskScreenMore,
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

  it('covers an empty terminal while its session is on its way', () => {
    expect(terminalOverlay({ loaded: false, hasOutput: false })).toBeNull();
    expect(terminalOverlay({ loaded: true, hasOutput: false })).toBe('starting');
    expect(terminalOverlay({ loaded: true, hasOutput: true })).toBeNull();
  });
});

describe('a conversation’s More menu', () => {
  // What the hand-written list gave before the catalog: the menu item where the window's menu bar has it,
  // the toolbar item where it doesn't (a terminal has no Chat menu).
  const sessions = [{ item: 'chat-new-in-project' }, { item: 'chat-send-to-chats', toolbar: 'send-to-chats' }];
  const close = [{ item: 'chat-close', toolbar: 'close-conversation' }];
  const restart = { item: 'chat-restart', toolbar: 'restart-agent' };

  it('offers a chat its own commands, with Close Conversation last in a group of its own', () => {
    expect(conversationMore('chat')).toEqual([
      [
        { item: 'chat-find' },
        { item: 'chat-save-markdown' },
        { item: 'chat-rename' },
        { item: 'chat-auto-continue' },
        { item: 'chat-copy-session-id' },
        restart,
        { item: 'chat-compact', toolbar: 'compact' },
        { item: 'chat-work-folder', toolbar: 'open-work-folder' },
      ],
      sessions,
      close,
    ]);
  });

  it('gives a terminal session its text size and Restart Agent instead of a transcript’s commands', () => {
    expect(conversationMore('terminal')).toEqual([[{ toolbar: 'terminal-text-smaller' }, { toolbar: 'terminal-text-larger' }, restart, { item: 'chat-work-folder', toolbar: 'open-work-folder' }], sessions, close]);
  });

  it('gives a task run’s agent its export and session id, no Find', () => {
    expect(conversationMore('run')).toEqual([[{ item: 'chat-save-markdown' }, { item: 'chat-work-folder', toolbar: 'open-work-folder' }], sessions, close]);
  });

  it('shows the toolbar’s Restart Agent where the window has no Chat menu, and the Chat menu’s where it has', () => {
    const toolbar: ToolbarGroup[] = [{ id: 'session', items: [{ id: 'restart-agent', label: 'Restart Agent', run: () => {} }] }];
    const chatMenu: MenuItemSpec = {
      id: '0',
      key: 'chat',
      type: 'submenu',
      label: 'Chat',
      enabled: true,
      submenu: [{ id: '0.0', key: 'chat-restart', type: 'normal', label: 'Restart Agent', enabled: true }],
    };
    const terminal = composeMore({ toolbar, menu: [], more: conversationMore('terminal') });
    expect(terminal.items.map((i) => i.id)).toEqual(['__page:tb:restart-agent']);
    const chat = composeMore({ toolbar, menu: [chatMenu], more: conversationMore('chat') });
    expect(chat.items.map((i) => i.id)).toEqual(['0.0']);
  });
});

describe('a task screen’s More menu', () => {
  it('has the Task menu’s commands, its project’s New Chat and New Terminal, and Delete last', () => {
    expect(taskScreenMore()).toEqual([
      [{ item: 'task-run-now', toolbar: 'run-now' }, { item: 'task-stop', toolbar: 'stop-task' }, { item: 'task-pause-resume', toolbar: 'pause-resume' }, { item: 'task-enable-disable', toolbar: 'enable-disable' }, { item: 'task-complete', toolbar: 'complete-reopen' }],
      [{ item: 'task-edit', toolbar: 'edit-task' }, { item: 'task-edit-agent' }, { item: 'task-note', toolbar: 'edit-note' }, { item: 'task-note-clear' }],
      [{ item: 'task-move-folder' }, { item: 'task-versions' }, { item: 'task-export' }, { item: 'task-clear-runs' }, { item: 'task-work-folder', toolbar: 'open-work-folder' }],
      [{ item: 'project-new-chat' }, { item: 'project-new-terminal' }],
      [{ item: 'task-delete' }],
    ]);
  });

  it('uses the menu bar’s items: a task’s screen has no toolbar', () => {
    const menu: MenuItemSpec[] = [
      { id: '1', key: 'task', type: 'submenu', label: 'Task', enabled: true, submenu: [{ id: '1.0', key: 'task-edit', type: 'normal', label: 'Edit Task…', enabled: true }] },
    ];
    expect(composeMore({ menu, more: taskScreenMore() }).items.map((i) => i.label)).toEqual(['Edit Task…']);
  });
});
