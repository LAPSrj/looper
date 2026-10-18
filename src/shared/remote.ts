/** Where a Remote Control conversation came from. */
export type RemoteSource = 'helper' | 'project' | 'opened';

/**
 * One Remote Control conversation: a Claude Code session on this computer,
 * started with `--remote-control`, that the Claude app can drive. Its id is
 * its run id; `taskId` is the task whose runs record it (a folder entry's or
 * a helper's own stand-in id when no task supplies it).
 */
export interface RemoteConversation {
  id: string;
  taskId: string;
  source: RemoteSource;
  /** The helper or project entry that keeps it open; unset for one a helper opened. */
  entryId?: string;
  /** The session's name in the Claude app's session list. */
  name: string;
  /** The first line of its first message, once it has one. */
  title?: string;
  /** Working directory, as the environment sees it. */
  cwd: string;
  startedAt: string;
  /**
   * waiting: open, no message yet. working: a turn is running. idle: open
   * between turns. ended: the session is over (its conversation is a run).
   */
  status: 'waiting' | 'working' | 'idle' | 'ended';
  /** The session's claude.ai address, once Claude Code printed it. */
  link?: string;
}

/** A conversation's last message: Claude's last answer, or the user's message a running turn works on. */
export interface RemoteMessage {
  from: 'user' | 'agent';
  text: string;
}

export interface RemoteState {
  /** Remote Control is on in this run of Looper. */
  running: boolean;
  /** Open conversations first (newest first), then ended ones. */
  conversations: RemoteConversation[];
  /** Why a helper or project isn't getting a conversation, by `helper:<id>` or `project:<id>`. */
  problems: Record<string, string>;
}

/** The stand-in task id a folder project or a helper records its conversations under (a task id can't start with "@"). */
export const remoteTaskId = (entryId: string): string => `@remote-${entryId}`;
export const isRemoteTaskId = (taskId: string): boolean => taskId.startsWith('@remote-');
