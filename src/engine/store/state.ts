import type { ChatDraft, ChatSettings, QueuedMessage } from '../../shared/chat';
import type { SlashCommand } from '../../shared/sessions';
import { isProblemResult, noticeKey } from '../../shared/dashboard';
import type { TaskNotice, TaskRuntime } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * A chat or terminal session in the Chats window, as Looper opens it again at
 * its next start: listed with its conversation, its agent not running.
 */
export type OpenConversation =
  | {
      kind: 'chat';
      /** The chat's run id. */
      id: string;
      taskId: string;
      /** When it opened: the Chats window lists a group's sessions in this order. */
      startedAt: number;
      harnessId: string;
      settings: ChatSettings;
      /** The conversation it goes on with (claude's session, codex's thread). */
      sessionId?: string;
      /** The message box's unsent message. */
      draft?: ChatDraft;
      /** Messages waiting for the agent's turn to end: they come back in the message box. */
      queued?: Pick<QueuedMessage, 'text' | 'attachments'>[];
      /** The "/" list, so it's there before the agent starts again. */
      commands?: SlashCommand[];
      /** The agent was in the middle of a turn: the chat shows it as stopped. */
      working?: true;
    }
  | {
      kind: 'terminal';
      /** The session's run id. */
      id: string;
      taskId: string;
      startedAt: number;
      harnessKind: 'claude-code' | 'codex';
      /** The conversation it started on (Continue in Terminal), before it recorded one of its own. */
      resume?: string;
      /** Continue in Terminal on another run: that run. */
      fromRunId?: string;
    };

interface StateFile {
  version: 2;
  updatedAt: string;
  tasks: Record<string, TaskRuntime>;
  conversations: OpenConversation[];
}

/**
 * Runtime snapshot on disk: lets the CLI show state, lets startup reconcile
 * interrupted runs, and keeps the Chats window's conversations for the next start.
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;
  private data: StateFile | null = null;
  private dirty = false;

  constructor(private readonly file: string) {}

  private read(): StateFile {
    if (!this.data) {
      const raw = readJson<Partial<StateFile>>(this.file, {});
      this.data = { version: 2, updatedAt: raw.updatedAt ?? '', tasks: raw.tasks ?? {}, conversations: raw.conversations ?? [] };
    }
    return this.data;
  }

  load(): Record<string, TaskRuntime> {
    return this.read().tasks;
  }

  save(tasks: Record<string, TaskRuntime>): void {
    this.read().tasks = tasks;
    this.schedule();
  }

  loadConversations(): OpenConversation[] {
    return this.read().conversations;
  }

  saveConversations(list: OpenConversation[]): void {
    this.read().conversations = list;
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    this.data.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(this.file, this.data);
    } catch {
      /* state file is advisory */
    }
  }
}

type RuntimeV1 = Omit<TaskRuntime, 'notices'>;

/** A task completed before version 2: when, and why. */
export interface CompletedTask {
  at: number;
  reason: string;
}

/** What Needs attention showed for a task before version 2: its auto-pause, or its last run's error or warning. */
function v1Notice(rt: RuntimeV1): TaskNotice | null {
  if (rt.pausedReason?.startsWith('auto-paused')) {
    return { runId: rt.lastRunId, result: rt.lastResult ?? 'error', detail: rt.lastDetail, at: rt.lastRunAt, paused: rt.pausedReason };
  }
  if (rt.lastResult && isProblemResult(rt.lastResult)) return { runId: rt.lastRunId, result: rt.lastResult, detail: rt.lastDetail, at: rt.lastRunAt };
  return null;
}

/**
 * Version 1 kept no notices: Needs attention showed each active task's last
 * result, until another run replaced it. Each task keeps the row it showed,
 * unless Clear had taken it off (`cleared`: the settings' attentionCleared),
 * and a task the agent or its end date completed (`completed`, by task id)
 * gets its completion's row, which Needs attention never showed. A notice from
 * before `since` is left out, as run retention deleted its run.
 */
export function migrateStateFile(file: string, cleared: readonly string[], completed: Readonly<Record<string, CompletedTask>>, since: number): void {
  const raw = readJson<{ version?: number; tasks?: Record<string, RuntimeV1> }>(file, {});
  if (raw.version !== 1) return;
  const tasks: Record<string, TaskRuntime> = {};
  for (const [id, rt] of Object.entries(raw.tasks ?? {})) {
    const shown = v1Notice(rt);
    const done = completed[id];
    const notices: TaskNotice[] = shown && !cleared.includes(noticeKey(id, shown)) ? [shown] : [];
    if (done) notices.push({ runId: null, result: null, detail: done.reason, at: done.at, completed: true });
    tasks[id] = { ...rt, notices: notices.filter((n) => n.at === null || n.at >= since) };
  }
  writeJsonAtomic(file, { ...raw, version: 2, tasks });
}
