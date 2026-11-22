import type { ChatContext, ChatState } from './chat';
import { folderParents, itemsInTreeOrder, siblingOrder, type FolderLayout } from './folders';
import type { MessageRow } from './messages';
import type { ProjectFolder, View } from './types';
import type { WorkflowRun } from './workflows';

/** A chat, a terminal session, or a task run's agent (a delegated agent's always, the others with Show Task Runs on), in the Chats window. */
export type SessionKind = 'chat' | 'terminal' | 'run';

/** A tool call a task run's agent waits for the user to allow (ActiveRun.permission). */
export interface RunPermission {
  id: string;
  tool: string;
  input: unknown;
}

/** What a permission request asks, in words ("Wants to run a command"): the Chats list's status, and a task run's step on the dashboards. */
export function permissionText(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return 'Wants to run a command';
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'Wants to change a file';
  return `Wants to use ${tool}`;
}

/** Why a session waits for the user: a tool call to allow, a finished turn not looked at, the agent's notification, or an error. */
export type WaitReason = 'permission' | 'turn' | 'notification' | 'error';

/** One row of the Sessions window's list. */
export interface SessionSummary {
  /** The chat's, terminal session's or task run's id, which is its run id. */
  id: string;
  kind: SessionKind;
  taskId: string;
  /** The project the list groups it under. */
  projectId?: string;
  /** The group's name: the project's, or the task's when it has none. */
  groupName: string;
  title: string;
  /** A delegated agent's run (looper-delegate): the name of the task whose agent started it. */
  startedBy?: string;
  harnessKind: 'claude-code' | 'codex' | 'custom';
  harnessName: string;
  /** Its harness's entry in SessionsState.limits; unset when the task's harness can't be resolved. */
  limitsKey?: string;
  /** A terminal session on Codex or a custom harness reports no turns, so it stays 'ready' while it runs. */
  status: 'starting' | 'working' | 'ready' | 'ended';
  /** A terminal session that quitting Looper stopped: the next key typed into it starts its harness again. */
  stopped?: boolean;
  /** `unread`: the user marked the session unread; looking at it doesn't clear that, opening it does. */
  waiting?: { reason: WaitReason; text: string; since: number; unread?: true };
  /** A chat's Mute Notifications: no device gets a push for it. */
  muted?: true;
  /** A chat's oldest permission request, which the Overview can answer. */
  permissionId?: string;
  /** A task run's agent asked this with looper-ask and waits for the answer. */
  question?: string;
  /** A task run's agent waits for the user to allow this tool call, which its terminal asks too. */
  permission?: RunPermission;
  /** One line: the agent's latest text message since the user's last one (never a tool call). */
  latest?: string;
  /** The agent's messages since the user's last one, as plain text, the newest last (the dashboard's cards). */
  recent?: string[];
  context?: ChatContext;
  startedAt: number;
  /** Background commands and subagents still running. */
  background: number;
  /** When the agent's last reply came (ms since the epoch). */
  lastReplyAt?: number;
  /** Until when the prompt cache of that reply lasts: what Claude's transcript says, or Codex's 30 minutes (CODEX_CACHE_MS). */
  cacheUntil?: number;
  /**
   * The last turn failed on the usage limit: set while the limit holds (until
   * `resetsAt`, or until the next message when the harness didn't say), and
   * `restored` once it has reset, until the user looks at the session.
   */
  limit?: { resetsAt?: number; restored?: boolean };
}

/**
 * Whether the session reads as unread: it waits for a finished turn, a notification or an error (or the user marked it
 * unread), which the list draws in bold until it's opened. A permission request is bold too, but only answering it ends it.
 */
export const isUnread = (s: SessionSummary | undefined): boolean => !!s?.waiting && s.waiting.reason !== 'permission';

/**
 * Whether Mark as Unread (or, once it's unread, Mark as Read) applies. An unread session can always be marked read. A read
 * one can be marked unread once its agent is ready: while it works its next turn is news anyway, and one that is starting or
 * has ended (with nothing unseen) has no finished turn to bring back. A permission request keeps it bold on its own.
 */
export const canToggleUnread = (s: SessionSummary | undefined): boolean => !!s && s.kind !== 'run' && (isUnread(s) || (s.status === 'ready' && !s.waiting));

/** How much of one usage window is used (0 to 1), and when it resets (ms since the epoch). */
export interface UsageWindow {
  used: number;
  resetsAt: number;
}

/** The account's usage limits as Claude Code last reported them. */
export interface UsageLimits {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

/** What a phone's Usage button draws: the context used (0..1, null when its size isn't known), the account's limits, and the prompt cache's span (ms since the epoch). */
export interface UsageRing {
  context: number | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  cache?: { from: number; until: number };
}

/** A harness's key in SessionsState.limits: harness ids are only unique within their environment. */
export const limitsKey = (environmentId: string, harnessId: string): string => `${environmentId}/${harnessId}`;

export interface SessionsState {
  sessions: SessionSummary[];
  /** Each harness's limits, by limitsKey: harnesses can run on different accounts. */
  limits: Record<string, UsageLimits>;
  /**
   * The order the list's rows were dragged to with Group Chats By None, by session id. The main process keeps it
   * while it runs, not in the settings, so it's forgotten once Looper closes.
   */
  order: string[];
}

/** A command, subagent or workflow the agent started in the background. */
export interface BackgroundTask {
  /** Claude's background task id. */
  id: string;
  kind: 'command' | 'agent' | 'workflow' | 'monitor';
  /** What it does: the command's (or Monitor's) description, else the command; the subagent's description; the workflow's summary. */
  label: string;
  /** A workflow's run id, which its tab beside the conversation shows. */
  workflowRunId?: string;
  command?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Claude's summary when it ended ("… completed (exit code 0)"). */
  summary?: string;
  startedAt?: string;
  /** Where the command writes its output, in the session's own path form. */
  outputFile?: string;
}

/** A subagent of a session, from its transcript's meta file. */
export interface SubagentInfo {
  agentId: string;
  /** The Agent call that started it. */
  toolUseId: string;
  type: string;
  description: string;
  /** The model the Agent call asked for ("haiku"), when it named one. */
  model?: string;
  status: 'running' | 'done' | 'failed';
  /** When the Agent call that started it was made (ISO), once the conversation has it. */
  startedAt?: string;
  /** From its transcript's newest response: the model id it ran on, its effort, and its context in tokens. */
  modelId?: string;
  effort?: string;
  contextTokens?: number;
  /** The context window of the model it runs on, when the chat's harness has reported it (Claude's result records). */
  contextWindow?: number;
}

/** What the Sessions window's right panel shows for a session. */
export interface SessionActivity {
  id: string;
  /** A terminal session's or task run's conversation, from its transcript (a chat's comes with the chat). */
  rows?: MessageRow[];
  /** A task run's guidance its agent hasn't picked up yet. */
  pendingGuidance?: string;
  /** A task run's or terminal session's skills, from its transcript: its message box's "/" list. */
  commands?: SlashCommand[];
  /** A task run's agent as its message box shows it; unset on a custom harness. */
  agent?: RunAgent;
  background: BackgroundTask[];
  subagents: SubagentInfo[];
  /** The workflow runs the session started (Claude Code's Workflow tool), newest first. */
  workflows: WorkflowRun[];
}

/** A task run's harness, model, effort, permission mode and session type, which its message box shows and can't change, and how it writes a skill. */
export type RunAgent = Pick<ChatState, 'harnessName' | 'harnessKind' | 'models' | 'settings' | 'activeModel' | 'commandPrefix'>;

/** A slash command or skill the message box offers after "/". */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Order of the list's groups: Waiting for you first, then the projects in the Projects tab's order. */
export function sessionsInOrder(sessions: SessionSummary[], projectOrder: string[]): SessionSummary[] {
  const rank = (s: SessionSummary) => {
    const i = s.projectId ? projectOrder.indexOf(s.projectId) : -1;
    return i === -1 ? projectOrder.length : i;
  };
  return [...sessions].sort((a, b) => rank(a) - rank(b) || a.groupName.localeCompare(b.groupName) || a.startedAt - b.startedAt);
}

/** The key of the list group a session is in: its project's id, or the group's name without one. */
export const sessionGroupKey = (s: SessionSummary): string => s.projectId ?? s.groupName;

/** View → Group Chats By: each project, the Projects tab's folder each project is in, or no groups. */
export type ChatGroupBy = 'project' | 'folder' | 'none';

/** The Projects tab's projects and folders, which Group Chats By Project Folder reads. */
export interface ChatPlaces {
  projects: { id: string; folderId?: string }[];
  folders: ProjectFolder[];
  layout: FolderLayout;
}

/** A list group's key with Group Chats By Project Folder: `folder:` and the folder's id, or `folder:` alone for no folder. */
const FOLDER_KEY = 'folder:';

/** The name of the group of chats whose project is in no folder, or that have no project. */
export const NO_FOLDER = 'No Folder';

/** The Projects tab's folder a project is in ('' at the top level or in a folder that's gone). */
function projectFolderOf(places: ChatPlaces, parents: Map<string, string>, projectId: string | undefined): string {
  const folderId = projectId ? places.projects.find((p) => p.id === projectId)?.folderId : undefined;
  return folderId && parents.has(folderId) ? folderId : '';
}

/** A folder's name with the folders it's in: "Clients / Acme". */
function folderPath(folders: ProjectFolder[], parents: Map<string, string>, id: string): string {
  const names: string[] = [];
  for (let at = id; at; at = parents.get(at) ?? '') {
    const f = folders.find((x) => x.id === at);
    if (!f || names.length > folders.length) break;
    names.unshift(f.name);
  }
  return names.join(' / ');
}

/** The key of the list group a session is in, as the list is grouped (none: ''). */
export function chatGroupKey(s: SessionSummary, by: ChatGroupBy, places: ChatPlaces): string {
  if (by === 'none') return '';
  if (by === 'project') return sessionGroupKey(s);
  return FOLDER_KEY + projectFolderOf(places, folderParents(places.folders), s.projectId);
}

/** Whether a session is in the list group `key` (a project's, or with Group Chats By Project Folder a folder's). */
export const inChatGroup = (s: SessionSummary, key: string, places: ChatPlaces): boolean =>
  key.startsWith(FOLDER_KEY) ? chatGroupKey(s, 'folder', places) === key : sessionGroupKey(s) === key;

/** A group of the Chats list: its key (what its closed state is saved under), its name ('' for Group Chats By None's one group, which has no header) and its rows. */
export interface ChatGroup {
  key: string;
  name: string;
  items: SessionSummary[];
}

/**
 * The Chats list's groups, in order, from the sessions in the engine's order
 * (by project). By project: each project's sessions. By folder: the sessions of
 * the projects in each of the Projects tab's folders, the folders in that tab's
 * order, then No Folder. None: one group without a header, its rows in the
 * order they were dragged to (`order`), then the others as they started.
 */
export function chatGroups(sessions: SessionSummary[], by: ChatGroupBy, places: ChatPlaces, order: readonly string[] = []): ChatGroup[] {
  if (by === 'none') {
    const at = new Map(order.map((id, i) => [id, i]));
    const rank = (s: SessionSummary) => at.get(s.id) ?? order.length;
    return sessions.length ? [{ key: '', name: '', items: [...sessions].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt) }] : [];
  }
  const groups: ChatGroup[] = [];
  if (by === 'project') {
    for (const s of sessions) {
      const key = sessionGroupKey(s);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.items.push(s);
      else groups.push({ key, name: s.groupName, items: [s] });
    }
    return groups;
  }
  const parents = folderParents(places.folders);
  const tree = itemsInTreeOrder(places.projects, siblingOrder(places.projects, places.folders, places.layout, parents));
  const rank = new Map(tree.map((p, i) => [p.id, i]));
  const rankOf = (s: SessionSummary) => (s.projectId !== undefined ? (rank.get(s.projectId) ?? tree.length) : tree.length);
  const byKey = new Map<string, ChatGroup>();
  for (const s of [...sessions].sort((a, b) => rankOf(a) - rankOf(b))) {
    const folder = projectFolderOf(places, parents, s.projectId);
    const key = FOLDER_KEY + folder;
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: folder ? folderPath(places.folders, parents, folder) : NO_FOLDER, items: [] };
      byKey.set(key, g);
    }
    g.items.push(s);
  }
  const none = byKey.get(FOLDER_KEY);
  return [...[...byKey.values()].filter((g) => g !== none), ...(none ? [none] : [])];
}

/** The key Waiting for you's closed state is saved under. */
export const WAITING_GROUP_KEY = '@waiting';

/**
 * The sessions the dashboard shows, in the list's order (`groups`), after
 * Dashboard Filter: the hidden ones (`hiddenCards`) only with Show Hidden
 * Chats, and with Only Chats Shown in the List only those the list shows: in an
 * open group, or waiting in an open Waiting for you.
 */
export function dashboardCards(
  groups: ChatGroup[],
  shown: { hiddenCards: string[]; showHiddenCards: boolean; cardsListedOnly: boolean; collapsed: string[]; waitingFirst: boolean },
): SessionSummary[] {
  const hidden = new Set(shown.showHiddenCards ? [] : shown.hiddenCards);
  const closed = new Set(shown.collapsed);
  const waitingOpen = shown.waitingFirst && !closed.has(WAITING_GROUP_KEY);
  return groups.flatMap((g) =>
    g.items.filter((s) => !hidden.has(s.id) && (!shown.cardsListedOnly || !g.name || !closed.has(g.key) || (waitingOpen && !!s.waiting))),
  );
}

/** The list's sessions top to bottom (Waiting for you aside): the order F8, F9 and Ctrl+1 to Ctrl+9 go by. */
export const listOrder = (groups: ChatGroup[]): SessionSummary[] => groups.flatMap((g) => g.items);

/** The sessions waiting for the user, the one that waited longest first. */
export const waitingOf = (sessions: SessionSummary[]): SessionSummary[] =>
  sessions.filter((s) => s.waiting).sort((a, b) => a.waiting!.since - b.waiting!.since);

/**
 * The dashboard's cards: the ones dragged into place in that order (`order`,
 * by session id), then the others in the list's order. `waitingFirst`: the
 * ones waiting for the user come first, the one that waited longest first.
 */
export function dashboardOrder(sessions: SessionSummary[], order: string[], waitingFirst: boolean): SessionSummary[] {
  const at = new Map(order.map((id, i) => [id, i]));
  const rank = (s: SessionSummary) => at.get(s.id) ?? order.length;
  const placed = sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
  return waitingFirst ? [...waitingOf(placed), ...placed.filter((s) => !s.waiting)] : placed;
}

/**
 * The Chats window's View settings with a compacted chat's id (`from`) put
 * in place of the chat it went on in (`to`): its card keeps its size, its
 * place, Hide from Dashboard and Focus's large card. Undefined when nothing names it.
 */
export function compactedView(shown: View['sessions'], from: string, to: string): View['sessions'] | undefined {
  const swap = (ids: string[]) => ids.map((id) => (id === from ? to : id));
  const named = [shown.bigCards, shown.hiddenCards, shown.cardOrder].some((ids) => ids.includes(from)) || shown.focusCard === from;
  if (!named) return undefined;
  return {
    ...shown,
    bigCards: swap(shown.bigCards),
    hiddenCards: swap(shown.hiddenCards),
    cardOrder: swap(shown.cardOrder),
    ...(shown.focusCard === from ? { focusCard: to } : {}),
  };
}

/** The card order `ids` with the card `id` dropped before (or `after`) the card `target`. */
export function placeCard(ids: string[], id: string, target: string, after: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at === -1) return ids;
  rest.splice(after ? at + 1 : at, 0, id);
  return rest;
}

/**
 * Whether a session's dashboard card shows the conversation itself while it's in view:
 * a chat's (with its message box) and a task run's (read from its transcript). A
 * terminal session's card shows a summary, since its conversation is the terminal.
 */
export const showsConversation = (s: SessionSummary): boolean => s.kind !== 'terminal';

/** The cards of the dashboard's that show their conversation now: those in view (`inView`, by session id). */
export const liveCards = (sessions: SessionSummary[], inView: ReadonlySet<string>): string[] =>
  sessions.filter((s) => showsConversation(s) && inView.has(s.id)).map((s) => s.id);

/**
 * The sessions the engine reads closely for the Chats windows: the one each shows,
 * and the task runs among the live cards of its dashboard (`cards`), whose
 * conversations come with their activity. A chat's card has its chat's own events.
 */
export function watchedSessions(views: Iterable<{ shown: string | null; cards: string[] }>, isRun: (id: string) => boolean): string[] {
  const ids = new Set<string>();
  for (const v of views) {
    if (v.shown !== null) ids.add(v.shown);
    for (const id of v.cards) if (isRun(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * Whether Stop applies to a session: it ends the agent's turn while the agent works or
 * waits for a permission, and the "!" commands from its message box (`runningCommands`).
 * A task run goes on with its next guidance: Stop Run… (or the Tasks tab's Stop) ends it.
 */
export const canStop = (s: SessionSummary | undefined, runningCommands = 0): boolean =>
  !!s && (s.status === 'working' || s.waiting?.reason === 'permission' || runningCommands > 0);

/** "3 min", "1 h 5 min": how long something has waited. */
export function waitedText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** A Monitor's expiry notice, without the advice to the agent after its first sentence. */
const MONITOR_EXPIRED_RE = /<event>\s*\[(Monitor expired[^.\]]*)/;

/**
 * A background command's end from Claude's task notification: its task id, status, summary and output file. A
 * Monitor's events have no status, and neither has its expiry ("[Monitor expired after 30m …]", claude 2.1.325),
 * which ends it.
 */
export function parseTaskNotification(text: string): { id: string; status: BackgroundTask['status']; summary?: string; outputFile?: string } | null {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const id = tag('task-id');
  if (!id) return null;
  const status = tag('status');
  if (!status) {
    const expired = MONITOR_EXPIRED_RE.exec(text)?.[1];
    return expired ? { id, status: 'completed', summary: expired } : null;
  }
  const mapped: BackgroundTask['status'] =
    status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : 'running';
  const outputFile = tag('output-file');
  return { id, status: mapped, summary: tag('summary'), ...(outputFile ? { outputFile } : {}) };
}
