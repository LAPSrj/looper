import { describe, expect, it } from 'vitest';
import type { AttentionRow } from '../src/shared/dashboard';
import { noMnemonic } from '../src/shared/commands/command';
import { EMPTY_CONTEXT, type CommandContext } from '../src/shared/commands/context';
import type { SessionSummary } from '../src/shared/sessions';
import type { Task } from '../src/shared/types';
import { phoneMore } from '../src/renderer/src/components/command-surfaces';
import {
  clockTime,
  dayGroups,
  dayTitle,
  resultTone,
  splitAttention,
  taskNameOf,
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
  const chatState = { id: 'c', status: 'idle', queued: [], history: [], rows: [], models: [], harnessId: 'h', harnesses: [{ id: 'h', name: 'Claude Code' }], settings: { permissionMode: 'default' }, permissions: [], harnessKind: 'claude-code' };
  const phone = (kind: 'chat' | 'terminal' | 'run'): CommandContext => {
    const summary = { id: 'c', kind, taskId: 't', status: 'idle' };
    return { ...EMPTY_CONTEXT, here: 'mobile', chats: { single: false, tab: true, selected: 'c', summary, chat: kind === 'chat' ? chatState : null, sessions: [summary], shown: {} } as never };
  };
  const moreOf = (kind: 'chat' | 'terminal' | 'run'): string[] => phoneMore(['conversation'], phone(kind)).map((i) => (i.type === 'separator' ? '-' : noMnemonic(i.label ?? '')));

  it('offers a chat its own commands, with Close Conversation in a group of its own', () => {
    const more = moreOf('chat');
    for (const l of ['Find…', 'Save as Markdown…', 'Rename…', 'Copy Session ID', 'Restart Agent', 'Compact into New Chat', 'Open Working Directory']) expect(more, l).toContain(l);
    const at = more.indexOf('Close Conversation');
    expect(at).toBeGreaterThan(0);
    expect(more[at - 1]).toBe('-');
    expect(more[at + 1]).toBe('-');
  });

  it('gives a terminal session Restart Agent instead of a transcript’s commands', () => {
    const more = moreOf('terminal');
    expect(more).toContain('Restart Agent');
    for (const l of ['Find…', 'Save as Markdown…', 'Rename…', 'Compact into New Chat']) expect(more, l).not.toContain(l);
  });

  it('gives a task run’s agent its export, no Find and no Restart Agent', () => {
    const more = moreOf('run');
    expect(more).toContain('Save as Markdown…');
    expect(more).toContain('Open Working Directory');
    for (const l of ['Find…', 'Restart Agent']) expect(more, l).not.toContain(l);
  });
});

describe('a task screen’s More menu', () => {
  const phone: CommandContext = { ...EMPTY_CONTEXT, here: 'mobile', task: { id: 't1', name: 'N', enabled: true, maxConcurrentRuns: 1, completion: { allowed: true } } as unknown as Task, project: { id: 'p', name: 'Site' } as never };
  const more = phoneMore(['task'], phone).map((i) => (i.type === 'separator' ? '-' : noMnemonic(i.label ?? '')));

  it('has the task’s commands, its project’s New Chat and New Terminal, and Delete Task', () => {
    for (const l of ['Stop Task', 'Pause', 'Disable', 'Complete', 'Edit with Agent…', 'Move to Folder…', 'Version History', 'Clear Run History…', 'Open Working Directory', 'Delete Task', 'New Chat', 'New Terminal']) expect(more, l).toContain(l);
  });

  it('keeps Delete Task apart from the commands around it', () => {
    const at = more.indexOf('Delete Task');
    expect(more[at - 1]).toBe('-');
    expect(more[at + 1]).toBe('-');
  });
});
