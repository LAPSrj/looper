import type { MessageRow } from './messages';
import type { SubagentInfo } from './sessions';
import type { Project, View } from './types';

/**
 * Where a conversation in the History window came from: a chat, a terminal
 * session, a Remote Control conversation or a task run of Looper's, or a
 * conversation started in Claude Code or Codex outside Looper.
 */
export type HistorySource = 'chat' | 'terminal' | 'remote' | 'run' | 'claude-code' | 'codex';

/** One conversation of a project, as the History window lists it. */
export interface HistoryItem {
  /** The list's own id for it (the engine knows what it stands for). */
  id: string;
  source: HistorySource;
  projectId: string;
  /** Claude's title for the conversation, else its first message; a task run's summary. */
  title: string;
  /** When it was last active (ms since the epoch). */
  lastActive: number;
  harnessKind: 'claude-code' | 'codex';
  /** Claude Code's session id or Codex's thread id; unset before the harness named one. */
  sessionId?: string;
  /** The task, or the project's stand-in, its rows belong to. */
  taskId: string;
  /** Looper's run of it, while its run folder is there. */
  runId?: string;
  /** A task run's task. */
  taskName?: string;
}

/** The History window's View menu, kept with the settings. */
export type HistoryView = View['history'];

/** A conversation as the History window shows it: its rows and the subagents it started. */
export interface HistoryConversation {
  rows: MessageRow[];
  subagents: SubagentInfo[];
}

/** What the History window can do with a conversation. */
export interface HistoryCommands {
  chat: boolean;
  compact: boolean;
  terminal: boolean;
  sessionId: string | null;
  /** Its project still has a folder to open. */
  folder: boolean;
}

/** The History window's commands, by the name the menus, toolbar and IPC use. */
export type HistoryCommand = 'chat' | 'compact' | 'terminal' | 'copy-id' | 'open-folder';

export const HISTORY_COMMANDS: readonly HistoryCommand[] = ['chat', 'compact', 'terminal', 'copy-id', 'open-folder'];

export const NO_HISTORY_COMMANDS: HistoryCommands = { chat: false, compact: false, terminal: false, sessionId: null, folder: false };

/** The second line's last part: where the conversation came from. */
export function historySourceText(item: Pick<HistoryItem, 'source' | 'taskName'>): string {
  switch (item.source) {
    case 'chat':
      return 'Chat';
    case 'terminal':
      return 'Terminal';
    case 'remote':
      return 'Remote Control';
    case 'run':
      return item.taskName ? `Task run · ${item.taskName}` : 'Task run';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
  }
}

export interface HistoryFilter {
  /** '' for every project. */
  projectId: string;
  showRuns: boolean;
  /** Typed into the search box: the titles that contain it. */
  title: string;
  /** Enter in the search box: the conversations whose messages contain it; null before a search. */
  found: ReadonlySet<string> | null;
}

/** The conversations the list shows, newest first. */
export function filterHistory(items: HistoryItem[], f: HistoryFilter): HistoryItem[] {
  const title = f.title.trim().toLowerCase();
  return items
    .filter((i) => (!f.projectId || i.projectId === f.projectId) && (f.showRuns || i.source !== 'run'))
    .filter((i) => (f.found ? f.found.has(i.id) : !title || i.title.toLowerCase().includes(title)))
    .sort((a, b) => b.lastActive - a.lastActive);
}

export interface HistoryGroup {
  key: string;
  title: string;
  items: HistoryItem[];
}

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** The week starts on Monday. */
const startOfWeek = (ts: number): number => {
  const today = startOfDay(ts);
  const weekday = (new Date(today).getDay() + 6) % 7;
  return new Date(today).setDate(new Date(today).getDate() - weekday);
};

/** Today, Yesterday, This Week, then one group per month, for a time. */
export function dateGroupOf(ts: number, now: number, monthTitle: (d: Date) => string): { key: string; title: string } {
  const today = startOfDay(now);
  if (ts >= today) return { key: 'today', title: 'Today' };
  if (ts >= today - DAY) return { key: 'yesterday', title: 'Yesterday' };
  if (ts >= startOfWeek(now)) return { key: 'week', title: 'This Week' };
  const d = new Date(ts);
  return { key: `${d.getFullYear()}-${d.getMonth() + 1}`, title: monthTitle(d) };
}

const defaultMonthTitle = (d: Date): string => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/**
 * The list's groups, of conversations already in order (filterHistory): by
 * date, or by project in the Projects pane's order.
 */
export function groupHistory(
  items: HistoryItem[],
  by: HistoryView['groupBy'],
  projects: Pick<Project, 'id' | 'name'>[],
  now: number,
  monthTitle: (d: Date) => string = defaultMonthTitle,
): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  if (by === 'project') {
    for (const p of projects) groups.set(p.id, { key: p.id, title: p.name, items: [] });
  }
  for (const item of items) {
    const g = by === 'project' ? { key: item.projectId, title: projects.find((p) => p.id === item.projectId)?.name ?? item.projectId } : dateGroupOf(item.lastActive, now, monthTitle);
    let group = groups.get(g.key);
    if (!group) {
      group = { ...g, items: [] };
      groups.set(g.key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].filter((g) => g.items.length > 0);
}
