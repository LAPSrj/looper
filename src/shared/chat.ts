import type { MessageRow } from './messages';
import { stripMarkdown } from './messages-md';
import type { HarnessModel } from './types';

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

/** The chat's own model, effort and permission mode: the task's to start with, then the Chat menu's. */
export interface ChatSettings {
  /** Unset: the CLI's default model. */
  model?: string;
  /** Unset: the model's default effort (see resolveEffort). */
  effort?: string;
  /** A PERMISSION_MODES value; '' passes no mode. */
  permissionMode: string;
}

/** How full the conversation is: tokens in context, and the model's window when the CLI reports it. */
export interface ChatContext {
  tokens: number;
  window?: number;
}

/**
 * A task chat (Open Project in Chat, Continue in Chat, Fork from Here): the
 * task's harness without a terminal, in a Looper chat window. Once the user
 * sends a message it is a run of the task: its id is the run id, its folder
 * the run folder, and it shows in the run list. It has no time limits and no
 * dashboard row.
 */
export interface ChatState {
  /** The chat's run id. */
  id: string;
  taskId: string;
  taskName: string;
  harnessName: string;
  harnessKind: 'claude-code' | 'codex';
  /** The divider above the earlier conversation ("Earlier in run …"); unset shows it without one. */
  historyLabel?: string;
  /** Fork from Here on the user's own message: the message, waiting in the new chat's message box. */
  draft?: { text: string; attachments: Attachment[] };
  settings: ChatSettings;
  /** The harness's model presets: the Chat menu's Model list and the status bar's names. */
  models: HarnessModel[];
  /** The model the CLI says it runs (Claude Code's init), e.g. when the chat uses the default. */
  activeModel?: string;
  context?: ChatContext;
  status: 'starting' | 'ready' | 'working' | 'ended';
  /** Why the session ended, or why the last turn failed. */
  error?: string;
  /**
   * The conversation before this window: the run's (Continue in Chat), the
   * chat's own when it opens again, or the forked chat's up to the fork.
   */
  history: MessageRow[];
  rows: MessageRow[];
  /** Tool calls waiting for the user's answer, oldest first. */
  permissions: ChatPermissionRequest[];
}

/** What a chat's run folder records about it (chat.json): Continue in Chat opens the chat again from it. */
export interface ChatInfo {
  harnessKind: 'claude-code' | 'codex';
  /** The first line of the chat's first message. */
  title: string;
  settings: ChatSettings;
  context?: ChatContext;
  /** Continue in Chat on a run: the run whose conversation the chat went on with. */
  fromRunId?: string;
  /** Fork from Here: the chat it was forked from. */
  forkedFrom?: string;
}

/**
 * What a terminal session's run folder records about it (terminal.json): a
 * Looper or system terminal window on the task's harness becomes a run once
 * its conversation has a finished turn.
 */
export interface TerminalInfo {
  harnessKind: 'claude-code' | 'codex';
  /** The first line of the conversation's first message. */
  title: string;
  /** Continue in Terminal on a run: the run whose conversation the session went on with. */
  fromRunId?: string;
}

/**
 * Where Fork from Here cuts the conversation `rows` (a chat's history and
 * rows, in order) at the row at `index`. `at` is the message the new chat's
 * conversation ends with, unset when it starts empty; `keep` is how many rows
 * it shows; `draft` is the user's own message, which goes back into the
 * message box. Claude forks at any of its messages (by the message's
 * transcript id). Codex forks only at the end of a turn, so only an agent
 * message no other one follows within its turn qualifies, and not while the
 * turn is still running. Null when the row can't be forked from.
 */
export function forkPoint(
  rows: MessageRow[],
  index: number,
  harnessKind: 'claude-code' | 'codex',
  working: boolean,
): { at?: MessageRow; keep: number; draft?: MessageRow } | null {
  const row = rows[index];
  if (!row) return null;
  const forkable = (i: number): boolean => {
    const r = rows[i];
    if (r.kind !== 'agent' || r.source === 'classifier') return false;
    if (harnessKind === 'claude-code') return !!r.uuid;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].kind === 'prompt') return true;
      if (rows[j].kind === 'agent') return false;
    }
    return !working;
  };
  if (row.kind === 'agent') return forkable(index) ? { at: row, keep: index + 1 } : null;
  if (row.kind !== 'prompt') return null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].kind !== 'agent' || rows[i].source === 'classifier') continue;
    // The last agent message before the user's: the conversation the message was sent into.
    return forkable(i) ? { at: rows[i], keep: i + 1, draft: row } : null;
  }
  return { keep: 0, draft: row };
}

/** 950 → "950", 42_310 → "42k", 1_000_000 → "1M", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/** "42k of 1M context (4%)", or "42k context" before the window is known. */
export function contextText(c: ChatContext): string {
  if (!c.window) return `${formatTokens(c.tokens)} context`;
  return `${formatTokens(c.tokens)} of ${formatTokens(c.window)} context (${Math.round((c.tokens / c.window) * 100)}%)`;
}

/** A chat's title: the first line of its first message, without Markdown markers. */
export function chatTitle(rows: MessageRow[]): string {
  const first = rows.find((r) => r.kind === 'prompt');
  const line = stripMarkdown(first?.text.trim().split('\n')[0] ?? '').trim();
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return first?.attachments?.length ? first.attachments.map((a) => a.name).join(', ') : 'Untitled chat';
}
