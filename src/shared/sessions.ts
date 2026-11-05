import type { ChatContext } from './chat';
import type { MessageRow } from './messages';
import type { WorkflowRun } from './workflows';

/** A chat, a terminal session, or (with Show Task Runs on) a task run's agent, in the Chats window. */
export type SessionKind = 'chat' | 'terminal' | 'run';

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
  harnessKind: 'claude-code' | 'codex' | 'custom';
  harnessName: string;
  /** Its harness's entry in SessionsState.limits; unset when the task's harness can't be resolved. */
  limitsKey?: string;
  /** A terminal session on Codex or a custom harness reports no turns, so it stays 'ready' while it runs. */
  status: 'starting' | 'working' | 'ready' | 'ended';
  /** A terminal session that quitting Looper stopped: the next key typed into it starts its harness again. */
  stopped?: boolean;
  waiting?: { reason: WaitReason; text: string; since: number };
  /** A chat's oldest permission request, which the Overview can answer. */
  permissionId?: string;
  /** A task run's agent asked this with looper-ask and waits for the answer. */
  question?: string;
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

/** A harness's key in SessionsState.limits: harness ids are only unique within their environment. */
export const limitsKey = (environmentId: string, harnessId: string): string => `${environmentId}/${harnessId}`;

export interface SessionsState {
  sessions: SessionSummary[];
  /** Each harness's limits, by limitsKey: harnesses can run on different accounts. */
  limits: Record<string, UsageLimits>;
}

/** A command, subagent or workflow the agent started in the background. */
export interface BackgroundTask {
  /** Claude's background task id. */
  id: string;
  kind: 'command' | 'agent' | 'workflow';
  /** What it does: the command's description, else the command; the subagent's description; the workflow's summary. */
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
  background: BackgroundTask[];
  subagents: SubagentInfo[];
  /** The workflow runs the session started (Claude Code's Workflow tool), newest first. */
  workflows: WorkflowRun[];
}

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
 * waits for a permission, and a chat's "!" commands (`runningCommands`). A task run is
 * listed only while it runs, and its Stop stops the whole run, after asking.
 */
export const canStop = (s: SessionSummary | undefined, runningCommands = 0): boolean =>
  !!s && (s.kind === 'run' || s.status === 'working' || s.waiting?.reason === 'permission' || runningCommands > 0);

/** "3 min", "1 h 5 min": how long something has waited. */
export function waitedText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** A background command's end from Claude's task notification: its task id, status and summary. */
export function parseTaskNotification(text: string): { id: string; status: BackgroundTask['status']; summary?: string } | null {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const id = tag('task-id');
  const status = tag('status');
  if (!id || !status) return null;
  const mapped: BackgroundTask['status'] =
    status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : 'running';
  return { id, status: mapped, summary: tag('summary') };
}
