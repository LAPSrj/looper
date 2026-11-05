import type { MessageRow } from './messages';
import type { SubagentInfo } from './sessions';
import type { Project, View } from './types';

/**
 * Where a conversation in the History window came from: a chat, a terminal
 * session, a Remote Control conversation or a task run of Looper's, or a
 * conversation started in Claude Code or Codex outside Looper.
 */
export type HistorySource = 'chat' | 'terminal' | 'remote' | 'run' | 'claude-code' | 'codex';

/** One conversation on this computer, as the History window lists it. */
export interface HistoryItem {
  /** The list's own id for it (the engine knows what it stands for). */
  id: string;
  source: HistorySource;
  /** The Looper project whose folder it ran in; unset for any other folder. */
  projectId?: string;
  /** The folder it ran in, as its environment sees it; '' when the transcript doesn't say. */
  folder: string;
  environmentId: string;
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
  /** It knows the folder it ran in, to open. */
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

/** How many conversations a Recent menu (the History button's drop-down, a project's Open Recent Chat) lists. */
export const RECENT_CHATS = 15;

/** A conversation's line in a Recent menu: its title, then where it ran when `where` is given, on one line. */
export function recentChatLabel(title: string, where?: string): string {
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const name = clip(oneLine(title) || 'Untitled chat', 60);
  const place = where ? clip(oneLine(where), 24) : '';
  return place ? `${name} — ${place}` : name;
}

/** How many more conversations Show More reads. */
export const HISTORY_PAGE = 100;

/** View → Folder: every folder (''), one project's (`project:<id>`), or the folders outside every project ('other'). */
export type HistoryFolderFilter = '' | 'other' | `project:${string}`;

/** What the engine lists: the newest `limit` conversations that pass the View menu's filters. */
export interface HistoryListOptions {
  /** Read the folders again (slow across WSL); else the files found last, or the cached ones. */
  fresh: boolean;
  limit: number;
  showRuns: boolean;
  folder: HistoryFolderFilter;
  /** The window's own number for the call: the list so far comes as history-progress events with it, while it's read. */
  request?: number;
}

export interface HistoryList {
  items: HistoryItem[];
  /** Older conversations are left to read (Show More). */
  more: boolean;
}

/** Whether a conversation passes View → Folder. */
export function inFolderFilter(item: Pick<HistoryItem, 'projectId'>, f: HistoryFolderFilter): boolean {
  if (!f) return true;
  if (f === 'other') return !item.projectId;
  return item.projectId === f.slice('project:'.length);
}

export interface HistoryFind {
  /** Typed into the find bar: the titles that contain it. */
  title: string;
  /** Search Messages: the conversations whose messages contain it; null before a search. */
  found: ReadonlySet<string> | null;
}

/** The conversations the list shows, newest first. */
export function filterHistory(items: HistoryItem[], f: HistoryFind): HistoryItem[] {
  const title = f.title.trim().toLowerCase();
  return items
    .filter((i) => (f.found ? f.found.has(i.id) : !title || i.title.toLowerCase().includes(title)))
    .sort((a, b) => b.lastActive - a.lastActive);
}

/** A conversation's folder group: its project's, else its folder in its environment. */
export function folderGroupOf(item: Pick<HistoryItem, 'projectId' | 'folder' | 'environmentId'>, projects: Pick<Project, 'id' | 'name'>[]): { key: string; title: string } {
  if (item.projectId) {
    const p = projects.find((x) => x.id === item.projectId);
    if (p) return { key: `project:${p.id}`, title: p.name };
  }
  return { key: `folder:${item.environmentId}\n${item.folder}`, title: item.folder || 'Unknown folder' };
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

const startOfMonth = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

/** Today, Yesterday, This Week, This Month, then one group per earlier month, for a time. */
export function dateGroupOf(ts: number, now: number, monthTitle: (d: Date) => string): { key: string; title: string } {
  const today = startOfDay(now);
  if (ts >= today) return { key: 'today', title: 'Today' };
  if (ts >= today - DAY) return { key: 'yesterday', title: 'Yesterday' };
  if (ts >= startOfWeek(now)) return { key: 'week', title: 'This Week' };
  if (ts >= startOfMonth(now)) return { key: 'month', title: 'This Month' };
  const d = new Date(ts);
  return { key: `${d.getFullYear()}-${d.getMonth() + 1}`, title: monthTitle(d) };
}

const defaultMonthTitle = (d: Date): string => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/**
 * The list's groups, of conversations already in order (filterHistory): by
 * date, or by folder, the projects first in the Projects tab's order, then
 * the other folders newest first.
 */
export function groupHistory(
  items: HistoryItem[],
  by: HistoryView['groupBy'],
  projects: Pick<Project, 'id' | 'name'>[],
  now: number,
  monthTitle: (d: Date) => string = defaultMonthTitle,
): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  if (by === 'folder') {
    for (const p of projects) groups.set(`project:${p.id}`, { key: `project:${p.id}`, title: p.name, items: [] });
  }
  for (const item of items) {
    const g = by === 'folder' ? folderGroupOf(item, projects) : dateGroupOf(item.lastActive, now, monthTitle);
    let group = groups.get(g.key);
    if (!group) {
      group = { ...g, items: [] };
      groups.set(g.key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].filter((g) => g.items.length > 0);
}
