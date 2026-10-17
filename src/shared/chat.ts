import type { MessageRow } from './messages';

/** A file the user attached to a chat message, or dropped or pasted into a Looper terminal. */
export interface Attachment {
  /** The file's own name, as the user knows it. */
  name: string;
  /** Host path of Looper's copy, under the task's attachments folder: clicking it opens this. */
  path: string;
  /** An image the agent gets to see itself (PNG, JPEG, GIF or WebP). */
  image: boolean;
}

/** A file handed to Looper to attach: a pasted image's bytes, or a dropped or picked file's host path. */
export type AttachmentInput = { name: string; data: Uint8Array } | { name: string; path: string };

/** A tool call the agent waits on: Allow or Deny in the chat window. */
export interface ChatPermissionRequest {
  id: string;
  tool: string;
  input: unknown;
}

/**
 * A task chat (Open Project in Chat, Continue in Chat): the task's harness
 * without a terminal, in a Looper chat window. Like a terminal session it
 * isn't a run: no time limits, no record, no dashboard row.
 */
export interface ChatState {
  id: string;
  taskId: string;
  taskName: string;
  harnessName: string;
  harnessKind: 'claude-code' | 'codex';
  /** Continue in Chat: the run whose conversation this chat resumes. */
  fromRunId?: string;
  /** The task's permission mode, as the task editor names it. */
  permissionLabel: string;
  status: 'starting' | 'ready' | 'working' | 'ended';
  /** Why the session ended, or why the last turn failed. */
  error?: string;
  /** Continue in Chat: the run's conversation up to where the chat picks it up. */
  history: MessageRow[];
  rows: MessageRow[];
  /** Tool calls waiting for the user's answer, oldest first. */
  permissions: ChatPermissionRequest[];
}
