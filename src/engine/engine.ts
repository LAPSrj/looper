import fs from 'node:fs';
import path from 'node:path';
import type { RecentRun } from '../shared/dashboard';
import type { MessageImage, MessagesResult } from '../shared/messages';
import { runShown, type RunFilter } from '../shared/runs';
import type { EngineEvent, InboxCommand, RecycleBinEntry, RestState, RunRecord, RunSkips, Settings, Task, TaskFolder, TaskRuntime } from '../shared/types';
import { SettingsSchema } from '../shared/types';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { detectDefaultWslDistro, detectHost, detectWslMountPrefix, type HostKind } from './host';
import { setDetectedMountPrefix } from './target';
import { Inbox } from './inbox';
import { Logger, errMsg } from './log';
import { MessagesService, readRunSessionId } from './messages';
import { openTaskTerminal, writeTerminalLauncher } from './open-terminal';
import { TerminalRuns } from './terminal-runs';
import { TerminalSessions } from './terminal-sessions';
import { RemoteControl } from './remote';
import type { RemoteMessage, RemoteState } from '../shared/remote';
import { ChatManager, imageMediaType } from './chat';
import type { Attachment, AttachmentInput, ChatSettings, ChatState, TerminalInfo } from '../shared/chat';
import { createWindowsPowerOps } from './power-win';
import { RestController, type PowerAdapter, type PowerOps } from './rest';
import { Scheduler, type SchedulerSteps } from './scheduler';
import { ensureDir } from './store/fsutil';
import { RunStore, newRunId } from './store/runs';
import { loadSettings, saveSettings } from './store/settings';
import { StateStore } from './store/state';
import { expiredBinEntries, TaskStore } from './store/tasks';
import { TemplateStore } from './store/templates';
import { VersionStore, type FileContent } from './store/versions';
import { createTarget } from './target';
import { referencedPaths, taskHostPath } from './task-files';
import { BuilderManager } from './builder';
import type { BuilderSetup, BuilderState } from '../shared/builder';
import { validateTask } from '../shared/validate';
import {
  definitionOf,
  diffDefinitions,
  STATUS_FIELDS,
  type TaskVersion,
  type VersionDetail,
  type VersionFile,
  type VersionSource,
  type VersionSummary,
} from '../shared/versions';

export interface EngineOptions {
  dataDir: string;
  /** Echo log lines to stdout/stderr (CLI serve mode). */
  echoLog?: boolean;
  steps?: Partial<SchedulerSteps>;
  /** Electron power hooks; without them Rest Mode is unavailable (CLI serve). */
  power?: PowerAdapter;
  /** OS power command override (tests). */
  powerOps?: PowerOps;
}

export interface Engine {
  readonly dataDir: string;
  readonly host: HostKind;
  readonly settings: Settings;
  readonly log: Logger;
  start(): void;
  stop(): Promise<void>;
  /** Validate, persist and apply a settings patch. Running components see it immediately. */
  updateSettings(patch: unknown): Settings;
  /** Move the current tasks/templates store file to a new path. Call before updateSettings. */
  moveStoreFile(store: 'tasks' | 'templates', targetFile: string): void;
  on(listener: (e: EngineEvent) => void): () => void;
  // tasks
  listTasks(): Task[];
  getTask(id: string): Task | undefined;
  /**
   * Validate and persist a task the user saved. `builderId`: the save came
   * from a task builder's draft, so the version is the agent's and records
   * the files the builder wrote.
   */
  saveTask(input: unknown, opts?: { builderId?: string }): Task;
  // version history
  /** The task's versions, oldest first. */
  listVersions(id: string): VersionSummary[];
  /** One version's definition and files; `compare` adds its differences from the current task. */
  versionDetail(id: string, n: number, compare?: boolean): Promise<VersionDetail>;
  /**
   * Put version `n`'s definition and files back. The status fields keep their
   * current values, and the restore is itself a new version.
   */
  restoreVersion(id: string, n: number): Promise<Task>;
  // task builder
  /** Start a task builder (New Task with Agent, or Edit with Agent with `setup.taskId`). */
  startBuilder(setup: BuilderSetup): BuilderState;
  /** The setup Edit with Agent starts with: the task's own environment, harness, model, effort and folder. */
  builderSetupFor(taskId: string): BuilderSetup;
  /** The builder already open on a task, if any. */
  builderForTask(taskId: string): string | undefined;
  getBuilder(id: string): BuilderState | undefined;
  /** Send the user's message to the builder's agent. */
  sendBuilder(id: string, text: string): void;
  /** The builder's draft, as Create/Update hands it to the task editor. Throws when there is none. */
  builderDraft(id: string): Record<string, unknown>;
  /** Save: store the builder's draft as it is, without the editor. Throws when the draft isn't valid. */
  saveBuilder(id: string): Promise<Task>;
  /** Whether closing the builder would lose anything: its draft or a file it changed differs from the last save. */
  builderUnsaved(id: string): Promise<boolean>;
  /** Don't Save: stop the builder's agent and put back the files it changed since the last save. */
  discardBuilder(id: string): Promise<void>;
  /** Undo/Redo: move the draft and the task's files back or forward through the builder's changes. */
  undoBuilder(id: string): Promise<void>;
  redoBuilder(id: string): Promise<void>;
  /** Continue the builder's work from saved version `n` (an Undo step); nothing is saved. */
  loadBuilderVersion(id: string, n: number): Promise<void>;
  /** Stop the builder's session and delete its files (its window closed). */
  closeBuilder(id: string): Promise<void>;
  /** Terminal view: keystrokes, size, and the output so far. */
  writeBuilder(id: string, data: string): void;
  resizeBuilder(id: string, cols: number, rows: number): void;
  builderOutput(id: string): string;
  /** Delete a task: it stops and moves to the Recycle Bin. */
  removeTask(id: string): boolean;
  // recycle bin
  listRecycleBin(): RecycleBinEntry[];
  /** Put a deleted task back. Throws with the reason when it can't be. */
  restoreTask(id: string): Task;
  /** Delete a task in the Recycle Bin for good, along with its run history. */
  purgeTask(id: string): boolean;
  /** Delete every task in the Recycle Bin for good. */
  emptyRecycleBin(): void;
  /** Persist a new task order; `folders` reassigns tasks to folders in the same write. */
  reorderTasks(
    ids: string[],
    folders?: Record<string, string | null>,
    layout?: Record<string, string[]>,
    parents?: Record<string, string | null>,
  ): void;
  // folders
  listFolders(): TaskFolder[];
  /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with task ids. */
  listLayout(): Record<string, string[]>;
  addFolder(name: string, parentId?: string): TaskFolder;
  renameFolder(id: string, name: string): TaskFolder;
  /** Delete a folder; its tasks move to the top level. */
  removeFolder(id: string): boolean;
  // templates
  listTemplates(): Task[];
  saveTemplate(input: unknown): Task;
  removeTemplate(id: string): boolean;
  reorderTemplates(ids: string[]): void;
  // runtime
  listRuntimes(): TaskRuntime[];
  /** `skips` is the Run Options window's choice; every other caller passes none. */
  runNow(id: string, skips?: RunSkips): boolean;
  pause(id: string, reason?: string): void;
  resume(id: string): void;
  /** Finish a task for good: it stops being scheduled and is deleted when its retention runs out. */
  completeTask(id: string, reason?: string): void;
  /** Undo a completion: the task is enabled again and its schedule resumes. */
  reopenTask(id: string): void;
  /**
   * Stop a cycle wherever it is (check, classifier or agent). Without a run id
   * the task's newest run in flight is stopped; so do write/resize/buffer.
   */
  stopTask(id: string, reason?: string, runId?: string): Promise<boolean>;
  writeAgent(id: string, data: string, runId?: string): void;
  resizeAgent(id: string, cols: number, rows: number, runId?: string): void;
  agentBuffer(id: string, runId?: string): { runId: string; data: string } | null;
  /**
   * Open the task's harness in a window of the system's terminal (same
   * env/cwd/model/args, no prompt). A run id resumes that run's conversation
   * instead of starting fresh. Looper can't tell when that window's session
   * ends, so it isn't recorded as a run.
   */
  openTaskTerminal(id: string, runId?: string): Promise<void>;
  /**
   * The same session in a pty for a Looper terminal window, a run of the task
   * from its first finished turn (Claude Code and Codex). Returns the session
   * id, which is its run id; Continue in Terminal gives the open window's when
   * one holds the run's conversation (it comes forward).
   */
  startTerminalSession(id: string, runId?: string): string;
  writeTerminalSession(sessionId: string, data: string): void;
  resizeTerminalSession(sessionId: string, cols: number, rows: number): void;
  /** The session's output so far and whether it ended; null once it's closed. */
  terminalSessionOutput(sessionId: string): { data: string; ended: boolean } | null;
  /** End a session (its window closed). */
  closeTerminalSession(sessionId: string): void;
  /** Sessions in Looper terminal windows whose harness is still running (Remote Control's not counted). */
  runningTerminalSessions(): number;
  // remote control
  /** Start Remote Control for this run of Looper: every helper and project gets its conversation. */
  startRemote(): void;
  /** Stop Remote Control: every one of its sessions ends. */
  stopRemote(): void;
  remoteState(): RemoteState;
  /** A conversation's last message (the Conversations window's panel); null before its first. */
  remoteLastMessage(id: string): RemoteMessage | null;
  /** End one Remote Control conversation; its entry gets a new one if it keeps one open. */
  stopRemoteConversation(id: string): void;
  /** Go on with a Remote Control conversation in a new session (an open one ends first). Throws with the reason. */
  restartRemoteConversation(id: string): void;
  /** Whether a terminal session is a Remote Control conversation (closing its window leaves it running). */
  isRemoteSession(id: string): boolean;
  /** Remote Control conversations that have had a message and are still open. */
  usedRemoteConversations(): number;
  /** A task's name, or the name of the folder project or helper whose conversations a stand-in id records. */
  taskName(id: string): string | undefined;
  /** Terminal window: copy the files into the task's attachments; returns their paths as the terminal pastes them. */
  attachToTerminal(sessionId: string, files: AttachmentInput[]): string;
  /**
   * Open Project in Chat, or Continue in Chat with a run id: the task's
   * harness in a chat. Continue gives the open chat holding the run's
   * conversation when there is one (its window comes forward). Throws with the reason.
   */
  startChat(id: string, runId?: string): ChatState;
  /** Fork from Here: a new chat with the conversation up to the row at `index` of the chat's history and rows. Throws with the reason. */
  forkChat(chatId: string, index: number): ChatState;
  getChat(chatId: string): ChatState | undefined;
  sendChat(chatId: string, text: string, attachments: Attachment[]): void;
  /** End the agent's turn; the conversation goes on with the next message. */
  stopChat(chatId: string): Promise<void>;
  /** Chat menu: the chat's own model, effort or permission mode. */
  configureChat(chatId: string, patch: Partial<ChatSettings>): Promise<void>;
  /** Answer the agent's permission request. */
  answerChat(chatId: string, requestId: string, allow: boolean): void;
  /** End a chat (its window closed). */
  closeChat(chatId: string): Promise<void>;
  /** Chats in a turn or waiting on a permission answer. */
  busyChats(): number;
  /** Copy the files into the chat's task attachments, ready to send. */
  attachToChat(chatId: string, files: AttachmentInput[]): Attachment[];
  /** Whether a host path is one of Looper's attachment copies (the only files a click on an attachment opens). */
  isAttachment(hostPath: string): boolean;
  /**
   * Which Continue items a run offers: claude/codex, a session on record, the
   * run not in flight. While a chat or Looper terminal window holds the
   * conversation, only the item of that kind is on (it brings the window
   * forward), so nothing else writes to the conversation meanwhile.
   */
  canContinueRun(id: string, runId: string): { chat: boolean; terminal: boolean; guidance: boolean };
  /** Start a manual run that resumes the run's conversation with `guidance` as its whole prompt (no check/classifier). */
  continueRun(id: string, runId: string, guidance: string): boolean;
  /** Whether a run in flight takes guidance now: its agent is running on Claude Code or Codex. */
  canGuideRun(id: string, runId: string): boolean;
  /** Send guidance to a run in flight; the agent gets it mid-run. Throws when the run cannot take it. */
  sendGuidance(id: string, runId: string, text: string): void;
  // rest mode
  /** Throws when Rest Mode is unavailable (non-Windows host, or no power adapter). */
  armRest(): void;
  disarmRest(): void;
  restState(): RestState;
  // history
  listRuns(id: string, limit?: number): RunRecord[];
  /** The newest `limit` runs the filter shows, across every task and Remote Control folder project and helper. */
  recentRuns(limit: number, filter: RunFilter): RecentRun[];
  readOutput(id: string, runId: string, maxBytes?: number, forceRaw?: boolean): string;
  /** The run's conversation from the harness transcript (agentId: a subagent's instead; raw: every record as JSON). */
  readMessages(id: string, runId: string, agentId?: string, raw?: boolean): Promise<MessagesResult>;
  /** The image payload behind a message row's image marker. */
  readMessageImage(id: string, runId: string, rowId: string, agentId?: string): Promise<MessageImage | null>;
  /** Delete a task's run history. Refused while the task is mid-cycle. */
  clearRuns(id: string): void;
  runDir(id: string, runId: string): string;
  inboxDir(): string;
  /** Tail of the engine log file (whole lines only). */
  readEngineLog(maxBytes?: number): string;
}

/**
 * Tasks whose completion is older than the cutoff, i.e. past the completed-task
 * retention. Whether one still has a run in flight is the caller's business.
 */
export function expiredCompletedTasks(tasks: Task[], cutoffMs: number): Task[] {
  return tasks.filter((t) => {
    if (!t.completedAt) return false;
    const at = Date.parse(t.completedAt);
    return !Number.isNaN(at) && at <= cutoffMs;
  });
}

export function createEngine(opts: EngineOptions): Engine {
  const dataDir = opts.dataDir;
  ensureDir(dataDir);
  const host = detectHost();
  const settings = loadSettings(dataDir, host);
  const log = new Logger(path.join(dataDir, 'engine.log'), opts.echoLog ?? false);
  const storeFile = (store: 'tasks' | 'templates'): string => {
    const custom = store === 'tasks' ? settings.tasksFile : settings.templatesFile;
    return custom ?? path.join(dataDir, `${store}.json`);
  };
  const tasks = new TaskStore(storeFile('tasks'), () => settings.environments, host, () => settings.completedFolderId);
  const templates = new TemplateStore(storeFile('templates'));
  const runs = new RunStore(dataDir);
  const versions = new VersionStore(dataDir);
  const state = new StateStore(path.join(dataDir, 'state.json'));
  const listeners = new Set<(e: EngineEvent) => void>();

  const emit = (e: EngineEvent) => {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        log.error(`listener failed: ${errMsg(err)}`);
      }
    }
  };
  tasks.on('invalid', (raw: unknown, errors: string[]) => {
    const id = (raw as { id?: string })?.id ?? '?';
    log.error(`tasks.json: skipping invalid task ${id}: ${errors.join('; ')}`);
  });

  /** Detect the automount root of bridge environments without an explicit mount prefix. */
  const warmMountPrefixes = () => {
    if (host === 'windows' && settings.environments.some((e) => e.kind === 'wsl' && !e.distro)) {
      void detectDefaultWslDistro();
    }
    for (const env of settings.environments) {
      if (env.kind === 'local' || env.mountPrefix) continue;
      const distro = env.kind === 'wsl' ? env.distro : undefined;
      void detectWslMountPrefix(distro).then((prefix) => {
        if (prefix) setDetectedMountPrefix(distro, prefix);
      });
    }
  };

  // Declared ahead: the message reader and terminal sessions reach Remote Control, created below.
  let remote: RemoteControl;

  const messages = new MessagesService({
    getTask: (id) => tasks.get(id) ?? remote.standIn(id),
    runDir: (taskId, runId) => runs.runDir(taskId, runId),
    host,
    settings,
    log,
  });

  const scheduler = new Scheduler({
    dataDir,
    host,
    settings,
    tasks,
    runs,
    state,
    log,
    steps: opts.steps,
    taskVersion: (id) => versions.current(id),
  });

  // ---------- version history ----------

  /**
   * Who is saving right now. Set around a store call, so the store's change
   * event (fired inside the call) can label the version it records; a change
   * made with nothing set is Looper's own (completion, a used-up note).
   */
  interface SaveMeta {
    source: VersionSource;
    restoredFrom?: number;
    /** Files to record besides the ones the history already knows (the builder's). */
    files?: string[];
    /** Their content before the builder touched them. */
    before?: FileContent[];
  }
  let saveMeta: SaveMeta | null = null;
  const withMeta = <T>(meta: SaveMeta, fn: () => T): T => {
    const prev = saveMeta;
    saveMeta = meta;
    try {
      return fn();
    } finally {
      saveMeta = prev;
    }
  };

  /** A task file's content as the task's environment sees `p`; undefined when Looper can't reach it. */
  const readTaskFile = async (task: Task, p: string): Promise<FileContent | undefined> => {
    const hostPath = await taskHostPath(task, p, host, settings);
    if (!hostPath) return undefined;
    try {
      const st = await fs.promises.stat(hostPath);
      if (!st.isFile()) return undefined;
      return { path: p, content: await fs.promises.readFile(hostPath) };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { path: p, content: null } : undefined;
    }
  };

  /** Versions are recorded one at a time, in the order the saves happened. */
  let versionQueue: Promise<void> = Promise.resolve();

  const recordVersion = (task: Task, previous: Task | undefined): void => {
    // Captured now: the save that set it is over by the time the queue gets here.
    const meta = saveMeta ?? { source: 'looper' as const };
    // Enable/Disable, Move to Folder, a note: a save that changed only status
    // fields is no version, so nothing is read for it (timestamps don't count).
    if (previous && meta.source !== 'restore' && !meta.files?.length) {
      const moved = STATUS_FIELDS.some(
        (k) => k !== 'updatedAt' && k !== 'createdAt' && JSON.stringify(previous[k]) !== JSON.stringify(task[k]),
      );
      if (moved && diffDefinitions(definitionOf(previous), definitionOf(task)).length === 0) return;
    }
    try {
      versions.expectChange(task, previous);
    } catch {
      /* only the run stamp waits for the version then */
    }
    versionQueue = versionQueue.then(async () => {
      try {
        // Files are only read for a deliberate save; Looper's own changes touch status fields.
        let files: FileContent[] = [];
        if (meta.source !== 'looper') {
          const kind = createTarget(task, { host, settings }).kind;
          const known = new Set([...versions.knownFiles(task.id), ...(meta.files ?? [])]);
          const paths = [...new Set([...known, ...referencedPaths(task, kind)])];
          const read = await Promise.all(paths.map((p) => readTaskFile(task, p)));
          // A referenced path that doesn't exist is a word that only looked like one.
          files = read.filter((f): f is FileContent => f !== undefined && (f.content !== null || known.has(f.path)));
        }
        const version = versions.record(task, {
          source: meta.source,
          restoredFrom: meta.restoredFrom,
          previous,
          files,
          before: meta.before,
        });
        if (version) emit({ type: 'versions', taskId: task.id });
      } catch (err) {
        versions.forget(task.id);
        log.error(`[${task.id}] cannot record a version: ${errMsg(err)}`);
      }
    });
  };

  const builders = new BuilderManager({
    dataDir,
    host,
    settings,
    log,
    emit,
    getTask: (id) => tasks.get(id),
    listTasks: () => tasks.list(),
    versions,
  });

  const terminals = new TerminalSessions({
    emit: (e) => {
      emit(e);
      // A Remote Control session's harness exited: Remote Control closes it and opens another if needed.
      if (e.type === 'terminal:end' && remote.owns(e.id)) remote.exited(e.id);
    },
    log,
  });

  /** Continue in Terminal: the session id the run's conversation was recorded under. */
  const resumeIdOf = (task: Task, runId: string): string => {
    const kind = resolveHarness(task, resolveEnvironment(task, settings)).kind;
    if (kind !== 'claude-code' && kind !== 'codex') {
      throw new Error('Only Claude Code and Codex conversations can be continued.');
    }
    const sid = readRunSessionId(runs.runDir(task.id, runId), kind);
    if (!sid) throw new Error('No conversation was recorded for this run.');
    return sid;
  };

  // Chats and terminal sessions are runs: they share how a run's records and conversation are kept.
  const runDirOf = (taskId: string, runId: string) => runs.runDir(taskId, runId);
  const readHistory = async (taskId: string, runId: string) => {
    const r = await messages.read(taskId, runId);
    return r.status === 'ok' ? r.rows.filter((row) => row.kind !== 'raw') : [];
  };
  const appendRecord = (record: RunRecord) => {
    try {
      runs.append(record);
    } catch (err) {
      log.error(`[${record.taskId}] cannot write run log: ${errMsg(err)}`);
    }
    emit({ type: 'record', record });
  };
  const taskVersion = (taskId: string) => {
    try {
      return versions.current(taskId);
    } catch {
      return undefined; // an unreadable history only costs the stamp
    }
  };

  const chats = new ChatManager({
    dataDir,
    host,
    settings,
    log,
    emit,
    runDir: runDirOf,
    readHistory,
    writeInfo: (taskId, runId, info) => runs.writeChatInfo(taskId, runId, info),
    appendRecord,
    taskVersion,
  });

  const terminalRuns = new TerminalRuns({
    runDir: runDirOf,
    readHistory,
    writeInfo: (taskId, runId, info) => runs.writeTerminalInfo(taskId, runId, info),
    appendRecord,
    taskVersion,
    log,
  });

  remote = new RemoteControl({
    dataDir,
    settings,
    log,
    emit: (state) => emit({ type: 'remote', state }),
    getTask: (id) => tasks.get(id),
    listTasks: () => tasks.list(),
    createTarget: (task) => createTarget(task, { host, settings }),
    startSession(task, launch, resume) {
      const runId = resume?.runId ?? newRunId();
      const dir = runs.createRunDir(task.id, runId);
      terminals.start(
        task.id,
        () => {
          const target = createTarget(task, { host, settings });
          const { launcherHost } = writeTerminalLauncher(task, { host, settings }, dir, resume?.sessionId, true, launch(dir, target));
          return { spec: target.spawnSpec(launcherHost), cwd: dir, launcher: launcherHost };
        },
        runId,
      );
      // A restarted conversation is the same run, as Continue in Terminal reopens a terminal session's own.
      const info = resume ? (runs.readTerminalInfo(task.id, runId) ?? undefined) : undefined;
      terminalRuns.start({ taskId: task.id, runId, harnessKind: 'claude-code', info });
      return { runId, dir };
    },
    closeSession(runId) {
      terminals.close(runId);
      terminalRuns.close(runId);
    },
    output: (runId) => terminals.output(runId),
    write: (runId, data) => terminals.write(runId, data),
    readTitle: (taskId, runId) => runs.readTerminalInfo(taskId, runId)?.title,
    runDir: (taskId, runId) => runs.runDir(taskId, runId),
  });

  /**
   * The run of a kind (chat or terminal session) that already holds a run's
   * conversation `sessionId`: the run itself when it is one, else the newest
   * one that went on with it. One per conversation.
   */
  const holderOf = (task: Task, runId: string, sessionId: string, kind: 'chat' | 'terminal'): string | undefined => {
    const harness = resolveHarness(task, resolveEnvironment(task, settings)).kind;
    const ids = kind === 'chat' ? runs.listChatRunIds(task.id) : runs.listTerminalRunIds(task.id);
    if (ids.includes(runId)) return runId;
    return ids.reverse().find((id) => readRunSessionId(runs.runDir(task.id, id), harness) === sessionId);
  };

  /** Which kind of open window holds a run's conversation, if any (the other kind keeps off it). */
  const openHolder = (task: Task, runId: string): { chat?: ChatState; terminal?: string } => {
    let sessionId: string;
    try {
      sessionId = resumeIdOf(task, runId);
    } catch {
      return {};
    }
    return { chat: chats.findOpen(task.id, runId, sessionId), terminal: terminalRuns.findOpen(task.id, runId, sessionId) };
  };

  /**
   * Continue in Chat on a run: one chat per conversation. The open chat that
   * holds it comes forward; else the run's own chat, or the chat that already
   * went on with its conversation, opens again; else a new chat goes on with it.
   */
  const continueInChat = (task: Task, runId: string): ChatState => {
    const sessionId = resumeIdOf(task, runId);
    const open = chats.findOpen(task.id, runId, sessionId);
    if (open) return open;
    if (terminalRuns.findOpen(task.id, runId, sessionId)) throw new Error('The conversation is open in a terminal window.');
    const holder = holderOf(task, runId, sessionId, 'chat');
    const info = holder ? runs.readChatInfo(task.id, holder) : null;
    if (holder && info) return chats.start(task, { kind: 'reopen', runId: holder, info, sessionId });
    return chats.start(task, { kind: 'continue', runId, sessionId });
  };

  /**
   * Where a terminal session goes, as Continue in Chat decides for a chat:
   * the open Looper terminal window holding the conversation (`open`), the
   * terminal session's run that holds it, or a new run.
   */
  const terminalRunFor = (
    task: Task,
    runId?: string,
  ): { runId: string; open?: boolean; resume?: string; info?: TerminalInfo; fromRunId?: string } => {
    if (!runId) return { runId: newRunId() };
    const sessionId = resumeIdOf(task, runId);
    const open = terminalRuns.findOpen(task.id, runId, sessionId);
    if (open) return { runId: open, open: true };
    if (chats.findOpen(task.id, runId, sessionId)) throw new Error('The conversation is open in a chat window.');
    const holder = holderOf(task, runId, sessionId, 'terminal');
    const info = holder ? runs.readTerminalInfo(task.id, holder) : null;
    if (holder && info) return { runId: holder, resume: sessionId, info };
    return { runId: newRunId(), resume: sessionId, fromRunId: runId };
  };

  /** Claude Code and Codex sessions are recorded as runs; a custom harness has no conversation to record. */
  const recordedKind = (task: Task): 'claude-code' | 'codex' | null => {
    const kind = resolveHarness(task, resolveEnvironment(task, settings)).kind;
    return kind === 'custom' ? null : kind;
  };

  /** Copies of the given files (bytes, or a host file) in the task's attachments. */
  const saveAttachments = (taskId: string, files: AttachmentInput[]): Attachment[] =>
    files.map((f) => {
      const file = runs.saveAttachment(taskId, f.name, 'data' in f ? { data: Buffer.from(f.data) } : { file: f.path });
      return { name: path.basename(f.name), path: file, image: !!imageMediaType(file) };
    });

  /**
   * The files that differ between version `n` and the newest version, as each
   * recorded them (null = the file didn't exist). A file one side can't say
   * anything about, or that neither side had, isn't a difference.
   */
  const fileDiffWithCurrent = (id: string, n: number): { path: string; a: string | null; b: string | null }[] => {
    const latest = versions.current(id);
    if (latest === undefined) return [];
    const text = (f: VersionFile | undefined): string | null | undefined =>
      f === undefined ? undefined : f.blob === null ? null : versions.readBlob(id, f.blob)?.toString('utf8');
    const out: { path: string; a: string | null; b: string | null }[] = [];
    for (const p of versions.knownFiles(id)) {
      const a = text(versions.fileStateAt(id, n, p));
      const b = text(versions.fileStateAt(id, latest, p));
      if (a === undefined || b === undefined || a === b) continue;
      out.push({ path: p, a, b });
    }
    return out;
  };

  const summaryOf = (v: TaskVersion): VersionSummary => ({
    n: v.n,
    ts: v.ts,
    source: v.source,
    ...(v.restoredFrom !== undefined ? { restoredFrom: v.restoredFrom } : {}),
    changed: v.changed,
    files: (v.files ?? []).map((f) => f.path),
  });

  // System sleep reaches the scheduler regardless of Rest Mode: runs in
  // flight are stopped at the suspend and their tasks owed a fresh run, and
  // work left due by the sleep is deferred a grace past the wake so it never
  // races the network coming back.
  opts.power?.onSuspend(() => scheduler.onSuspend());
  opts.power?.onResume(() => scheduler.onResume());

  const rest =
    host === 'windows' && opts.power
      ? new RestController({
          settings,
          runtimes: () => scheduler.list(),
          adapter: opts.power,
          ops: opts.powerOps ?? createWindowsPowerOps(),
          log,
          emit: (restState, disarmReason) => emit({ type: 'rest', rest: restState, ...(disarmReason ? { disarmReason } : {}) }),
        })
      : null;

  scheduler.on('event', (e: EngineEvent) => {
    emit(e);
    if (e.type === 'runtime') rest?.poke();
  });

  /**
   * Completed-task retention: a task that has been finished for good long
   * enough moves to the Recycle Bin, whose own retention deletes it for good.
   * A completed task with a run in flight (someone ran it by hand) waits for
   * the next sweep.
   */
  const sweepCompletedTasks = () => {
    const cfg = settings.completedTaskRetention;
    if (!cfg.enabled) return;
    const cutoffMs = Date.now() - cfg.days * 24 * 60 * 60 * 1000;
    for (const task of expiredCompletedTasks(tasks.list(), cutoffMs)) {
      if ((scheduler.get(task.id)?.runs.length ?? 0) > 0) continue;
      try {
        tasks.remove(task.id);
        log.info(`moved completed task ${task.id} to the Recycle Bin: completed ${task.completedAt}, past the ${cfg.days}-day retention`);
      } catch (err) {
        log.error(`moving completed task ${task.id} to the Recycle Bin failed: ${errMsg(err)}`);
      }
    }
  };

  /**
   * Delete a bin entry for good, with its run history: once the task is gone
   * the runs are unreachable in the UI, which only opens them through the task
   * list. The history stays when a task with the same id exists again, since
   * it shares the folder. Refused while a run of the deleted task is still
   * stopping.
   */
  const purge = (id: string): boolean => {
    const recreated = !!tasks.get(id);
    if (!recreated && (scheduler.get(id)?.runs.length ?? 0) > 0) {
      throw new Error('The task is still stopping its run. Try again in a moment.');
    }
    if (!tasks.purge(id)) return false;
    if (!recreated) {
      runs.clear(id);
      versions.remove(id);
      emit({ type: 'versions', taskId: id });
    }
    return true;
  };

  /** Recycle Bin retention: entries deleted longer ago than the setting are deleted for good. */
  const sweepRecycleBin = () => {
    const cutoffMs = Date.now() - settings.recycleBinDays * 24 * 60 * 60 * 1000;
    for (const entry of expiredBinEntries(tasks.listBin(), cutoffMs)) {
      const id = entry.task.id;
      if (!tasks.get(id) && (scheduler.get(id)?.runs.length ?? 0) > 0) continue;
      try {
        purge(id);
        log.info(`deleted task ${id} from the Recycle Bin: deleted ${entry.deletedAt}, past the ${settings.recycleBinDays}-day retention`);
      } catch (err) {
        log.error(`deleting task ${id} from the Recycle Bin failed: ${errMsg(err)}`);
      }
    }
  };

  // Run-log retention: delete records and run folders past their age limit,
  // sparing whatever runs are currently in progress.
  const RETENTION_SWEEP_MS = 60 * 60 * 1000;
  let retentionTimer: NodeJS.Timeout | null = null;
  const sweepRunLogs = () => {
    sweepCompletedTasks();
    sweepRecycleBin();
    const cutoffMs = Date.now() - settings.runRetentionDays * 24 * 60 * 60 * 1000;
    for (const taskId of runs.listTaskIds()) {
      try {
        // Runs in progress and open chats keep their records and folders.
        const active = new Set([
          ...(scheduler.get(taskId)?.runs.map((r) => r.runId) ?? []),
          ...chats.openIds(),
          ...terminalRuns.openIds(),
        ]);
        const { records, dirs } = runs.pruneOlderThan(taskId, cutoffMs, active);
        if (records || dirs) {
          log.info(`${taskId}: pruned ${records} run records and ${dirs} run folders older than ${settings.runRetentionDays} days`);
        }
        const files = runs.pruneAttachments(taskId, cutoffMs);
        if (files) log.info(`${taskId}: pruned ${files} attachments older than ${settings.runRetentionDays} days`);
      } catch (err) {
        log.error(`run-log prune of ${taskId} failed: ${errMsg(err)}`);
      }
    }
    const logCutoffMs = Date.now() - settings.engineLogRetentionDays * 24 * 60 * 60 * 1000;
    log
      .pruneOlderThan(logCutoffMs)
      .then((dropped) => {
        if (dropped) log.info(`engine log: pruned ${dropped} lines older than ${settings.engineLogRetentionDays} days`);
      })
      .catch((err) => log.error(`engine-log prune failed: ${errMsg(err)}`));
  };

  const inbox = new Inbox(
    path.join(dataDir, 'inbox'),
    settings.inboxPollMs,
    {
      onTask: (input) => withMeta({ source: 'cli' }, () => tasks.upsert(input)),
      onCommand: async (cmd: InboxCommand) => {
        switch (cmd.op) {
          case 'run':
            scheduler.runNow(cmd.taskId);
            break;
          case 'pause':
            scheduler.pause(cmd.taskId, cmd.reason);
            break;
          case 'resume':
            scheduler.resume(cmd.taskId);
            break;
          case 'stop':
            await scheduler.stopTask(cmd.taskId, cmd.reason);
            break;
          case 'remove':
            tasks.remove(cmd.taskId);
            break;
          case 'enable':
            tasks.patch(cmd.taskId, { enabled: true });
            break;
          case 'disable':
            tasks.patch(cmd.taskId, { enabled: false });
            break;
          case 'complete':
            scheduler.completeTask(cmd.taskId, cmd.reason ?? 'completed');
            break;
          case 'reopen':
            scheduler.reopenTask(cmd.taskId);
            break;
          case 'guide':
            scheduler.sendGuidance(cmd.taskId, cmd.runId, cmd.text ?? '');
            break;
        }
      },
    },
    log,
  );

  let started = false;
  return {
    dataDir,
    host,
    settings,
    log,
    start() {
      if (started) return;
      started = true;
      log.info(`looper engine starting (host=${host}, dataDir=${dataDir})`);
      warmMountPrefixes();
      builders.sweep();
      tasks.load();
      templates.load();
      tasks.on('change', (task: Task, kind: 'create' | 'update' | 'remove', previous?: Task) => {
        if (kind !== 'remove') recordVersion(task, previous);
      });
      tasks.on('reorder', () => emit({ type: 'tasks', tasks: tasks.list() }));
      tasks.on('bin', () => emit({ type: 'recycleBin', entries: tasks.listBin() }));
      tasks.on('folders', () => emit({ type: 'folders', folders: tasks.listFolders(), layout: tasks.listLayout() }));
      templates.on('change', () => emit({ type: 'templates', templates: templates.list() }));
      scheduler.start();
      inbox.start();
      rest?.init();
      sweepRunLogs();
      retentionTimer = setInterval(sweepRunLogs, RETENTION_SWEEP_MS);
      if (settings.remote.startWithLooper) remote.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
      inbox.stop();
      rest?.dispose();
      remote.stop();
      terminals.closeAll();
      terminalRuns.closeAll();
      await Promise.all([scheduler.stop(), builders.closeAll(), chats.closeAll()]);
      await versionQueue;
      log.info('looper engine stopped');
      log.close();
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    moveStoreFile(store: 'tasks' | 'templates', targetFile: string): void {
      const srcFile = storeFile(store);
      if (srcFile === targetFile) return;
      if (!fs.existsSync(srcFile)) return;
      ensureDir(path.dirname(targetFile));
      fs.copyFileSync(srcFile, targetFile);
      fs.unlinkSync(srcFile);
      log.info(`moved ${store} store from ${srcFile} to ${targetFile}`);
    },
    updateSettings(patch: unknown): Settings {
      const oldTasksFile = settings.tasksFile;
      const oldTemplatesFile = settings.templatesFile;
      const merged = { ...settings, ...(patch as Record<string, unknown>) };
      const parsed = SettingsSchema.parse(merged);
      saveSettings(dataDir, parsed);
      // The settings object is shared by reference across the engine: swap its contents in place.
      for (const key of Object.keys(settings)) delete (settings as Record<string, unknown>)[key];
      Object.assign(settings, parsed);
      if (parsed.tasksFile !== oldTasksFile) {
        tasks.setFile(storeFile('tasks'));
        log.info(`tasks file changed: ${oldTasksFile ?? '(default)'} -> ${parsed.tasksFile ?? '(default)'}`);
      }
      if (parsed.templatesFile !== oldTemplatesFile) {
        templates.setFile(storeFile('templates'));
        log.info(`templates file changed: ${oldTemplatesFile ?? '(default)'} -> ${parsed.templatesFile ?? '(default)'}`);
      }
      log.info('settings updated');
      warmMountPrefixes();
      emit({ type: 'settings', settings: { ...settings } });
      if (parsed.tasksFile !== oldTasksFile) {
        emit({ type: 'tasks', tasks: tasks.list() });
        emit({ type: 'recycleBin', entries: tasks.listBin() });
        emit({ type: 'folders', folders: tasks.listFolders(), layout: tasks.listLayout() });
      }
      if (parsed.templatesFile !== oldTemplatesFile) emit({ type: 'templates', templates: templates.list() });
      remote.settingsChanged();
      return { ...settings };
    },
    listTasks: () => tasks.list(),
    getTask: (id) => tasks.get(id),
    saveTask(input: unknown, saveOpts?: { builderId?: string }): Task {
      const files = saveOpts?.builderId ? builders.filesOf(saveOpts.builderId) : undefined;
      const meta: SaveMeta = files
        ? { source: 'agent', files: files.written, before: files.before }
        : { source: 'user' };
      const saved = withMeta(meta, () => tasks.upsert(input));
      if (saveOpts?.builderId) void builders.saved(saveOpts.builderId, saved);
      return saved;
    },
    async saveBuilder(id: string): Promise<Task> {
      const draft = builders.draftForEditor(id);
      const errors = builders.get(id)?.draft.errors ?? [];
      if (errors.length) throw new Error(`The draft can't be saved yet:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      // A loaded version saved without changes is that version again.
      const restoredFrom = await builders.restoredFrom(id);
      const files = builders.filesOf(id);
      const meta: SaveMeta =
        restoredFrom !== undefined
          ? { source: 'restore', restoredFrom }
          : { source: 'agent', files: files?.written, before: files?.before };
      const saved = withMeta(meta, () => tasks.upsert(draft));
      await builders.saved(id, saved);
      return saved;
    },
    builderUnsaved: (id) => builders.isUnsaved(id),
    discardBuilder: (id) => builders.discard(id),
    undoBuilder: (id) => builders.undo(id),
    redoBuilder: (id) => builders.redo(id),
    loadBuilderVersion: (id, n) => builders.loadVersion(id, n),
    startBuilder: (setup) => builders.start(setup),
    builderSetupFor(taskId: string) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return builders.setupFor(task);
    },
    builderForTask: (taskId) => builders.forTask(taskId),
    getBuilder: (id) => builders.get(id),
    sendBuilder: (id, text) => builders.send(id, text),
    builderDraft: (id) => builders.draftForEditor(id),
    closeBuilder: (id) => builders.close(id),
    writeBuilder: (id, data) => builders.write(id, data),
    resizeBuilder: (id, cols, rows) => builders.resize(id, cols, rows),
    builderOutput: (id) => builders.terminalOutput(id),
    listVersions: (id) => versions.list(id).map(summaryOf),
    async versionDetail(id: string, n: number, compare = false): Promise<VersionDetail> {
      const version = versions.get(id, n);
      if (!version) throw new Error(`Version ${n} no longer exists.`);
      const current = tasks.get(id);
      const files = await Promise.all(
        (version.files ?? []).map(async (f) => {
          const content = f.blob === null ? null : (versions.readBlob(id, f.blob)?.toString('utf8') ?? null);
          let matchesDisk: boolean | null = null;
          if (current) {
            const now = await readTaskFile(current, f.path);
            if (now) {
              const disk = now.content === null ? null : now.content.toString('utf8');
              matchesDisk = f.blob === null ? disk === null : disk === content;
            }
          }
          return { path: f.path, content, matchesDisk };
        }),
      );
      return {
        version: summaryOf(version),
        isCurrent: versions.current(id) === n,
        task: version.task,
        ...(compare && current
          ? {
              current: definitionOf(current),
              diff: diffDefinitions(version.task, definitionOf(current)),
              fileDiff: fileDiffWithCurrent(id, n),
            }
          : {}),
        files,
      };
    },
    async restoreVersion(id: string, n: number): Promise<Task> {
      const current = tasks.get(id);
      if (!current) throw new Error(`unknown task ${id}`);
      const version = versions.get(id, n);
      if (!version) throw new Error(`Version ${n} no longer exists.`);
      const input: Record<string, unknown> = { ...version.task };
      for (const k of STATUS_FIELDS) {
        if (current[k] !== undefined) input[k] = current[k];
      }
      // Check the definition before any file is touched: a version naming an
      // environment that is gone must fail without changing anything.
      const v = validateTask(input, settings.environments, host);
      if (!v.ok) throw new Error(`Version ${n} can't be restored: ${v.errors.join('; ')}`);
      for (const p of versions.knownFiles(id)) {
        const state = versions.fileStateAt(id, n, p);
        // A file the version never had is left alone: deleting it could lose work.
        if (!state || state.blob === null) continue;
        const content = versions.readBlob(id, state.blob);
        const hostPath = content ? await taskHostPath(v.task, p, host, settings) : undefined;
        if (!content || !hostPath) {
          log.warn(`[${id}] restoring version ${n}: cannot restore ${p}`);
          continue;
        }
        await fs.promises.mkdir(path.dirname(hostPath), { recursive: true });
        await fs.promises.writeFile(hostPath, content);
      }
      // The status may have moved while files were written (a completion, a used-up note).
      const now = tasks.get(id);
      if (!now) throw new Error('The task was deleted during the restore.');
      for (const k of STATUS_FIELDS) {
        if (now[k] !== undefined) input[k] = now[k];
        else delete input[k];
      }
      return withMeta({ source: 'restore', restoredFrom: n }, () => tasks.upsert(input));
    },
    removeTask: (id) => tasks.remove(id),
    listRecycleBin: () => tasks.listBin(),
    restoreTask: (id) => tasks.restore(id),
    purgeTask: (id) => purge(id),
    emptyRecycleBin(): void {
      // A task still stopping its run stays behind; the next sweep or empty takes it.
      for (const entry of tasks.listBin()) {
        try {
          purge(entry.task.id);
        } catch (err) {
          log.warn(`emptying the Recycle Bin skipped ${entry.task.id}: ${errMsg(err)}`);
        }
      }
    },
    reorderTasks: (ids, folders, layout, parents) => tasks.reorder(ids, folders, layout, parents),
    listFolders: () => tasks.listFolders(),
    listLayout: () => tasks.listLayout(),
    addFolder: (name, parentId) => tasks.addFolder(name, parentId),
    renameFolder: (id, name) => tasks.renameFolder(id, name),
    removeFolder: (id) => tasks.removeFolder(id),
    listTemplates: () => templates.list(),
    saveTemplate: (input) => templates.upsert(input),
    removeTemplate: (id) => templates.remove(id),
    reorderTemplates: (ids) => templates.reorder(ids),
    listRuntimes: () => scheduler.list(),
    runNow: (id, skips) => scheduler.runNow(id, skips),
    pause: (id, reason) => scheduler.pause(id, reason),
    resume: (id) => scheduler.resume(id),
    completeTask: (id, reason) => scheduler.completeTask(id, reason ?? 'completed by the user'),
    reopenTask: (id) => scheduler.reopenTask(id),
    stopTask: (id, reason, runId) => scheduler.stopTask(id, reason, runId),
    writeAgent: (id, data, runId) => scheduler.writeAgent(id, data, runId),
    resizeAgent: (id, c, r, runId) => scheduler.resizeAgent(id, c, r, runId),
    agentBuffer: (id, runId) => scheduler.getBuffer(id, runId),
    openTaskTerminal(id: string, runId?: string): Promise<void> {
      const task = tasks.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      const resumeSessionId = runId ? resumeIdOf(task, runId) : undefined;
      return openTaskTerminal(task, { host, settings, log }, runs.taskDir(id), resumeSessionId);
    },
    startTerminalSession(id: string, runId?: string): string {
      const task = tasks.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      const kind = recordedKind(task);
      const to = kind ? terminalRunFor(task, runId) : { runId: newRunId() };
      if ('open' in to && to.open) return to.runId;
      const dir = runs.createRunDir(id, to.runId);
      const resume = 'resume' in to ? to.resume : undefined;
      const sessionId = terminals.start(
        id,
        () => {
          const { target, launcherHost } = writeTerminalLauncher(task, { host, settings }, dir, resume, !!kind);
          return { spec: target.spawnSpec(launcherHost), cwd: dir, launcher: launcherHost };
        },
        to.runId,
      );
      if (kind) {
        const extra = to as { info?: TerminalInfo; fromRunId?: string };
        terminalRuns.start({ taskId: id, runId: to.runId, harnessKind: kind, info: extra.info, fromRunId: extra.fromRunId });
      }
      return sessionId;
    },
    writeTerminalSession: (sessionId, data) => terminals.write(sessionId, data),
    resizeTerminalSession: (sessionId, cols, rows) => terminals.resize(sessionId, cols, rows),
    terminalSessionOutput: (sessionId) => terminals.output(sessionId),
    closeTerminalSession(sessionId: string): void {
      // A Remote Control conversation outlives its window: Remote Control ends it.
      if (remote.owns(sessionId)) return;
      const taskId = terminals.taskOf(sessionId);
      terminals.close(sessionId);
      if (terminalRuns.openIds().has(sessionId)) terminalRuns.close(sessionId);
      // A custom harness's session records nothing: its folder only held the launcher.
      else if (taskId) fs.rmSync(runs.runDir(taskId, sessionId), { recursive: true, force: true });
    },
    runningTerminalSessions: () => terminals.running() - remote.liveCount(),
    startRemote(): void {
      // A sleeping computer drops every Remote Control session: Rest Mode stays off meanwhile.
      if (rest?.state().armed) {
        rest.disarm();
        log.info('Rest Mode turned off: Remote Control started');
      }
      remote.start();
    },
    stopRemote: () => remote.stop(),
    remoteState: () => remote.state(),
    remoteLastMessage: (id) => remote.lastMessage(id),
    stopRemoteConversation: (id) => remote.stopConversation(id),
    restartRemoteConversation: (id) => remote.restartConversation(id),
    isRemoteSession: (id) => remote.owns(id),
    usedRemoteConversations: () => remote.usedCount(),
    taskName: (id) => (tasks.get(id) ?? remote.standIn(id))?.name,
    attachToTerminal(sessionId: string, files: AttachmentInput[]): string {
      const taskId = terminals.taskOf(sessionId);
      const task = taskId ? (tasks.get(taskId) ?? remote.standIn(taskId)) : undefined;
      if (!task) throw new Error('This terminal session is closed.');
      const target = createTarget(task, { host, settings });
      return saveAttachments(task.id, files)
        .map((a) => target.toTargetPath(a.path))
        .map((p) => (/\s/.test(p) ? target.quote(p) : p))
        .join(' ');
    },
    startChat(id: string, runId?: string): ChatState {
      const task = tasks.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      return runId ? continueInChat(task, runId) : chats.start(task, { kind: 'new' });
    },
    forkChat(chatId: string, index: number): ChatState {
      const taskId = chats.taskOf(chatId);
      const task = taskId ? tasks.get(taskId) : undefined;
      if (!task) throw new Error('This chat is closed.');
      return chats.fork(task, chatId, index);
    },
    getChat: (chatId) => chats.get(chatId),
    sendChat: (chatId, text, attachments) => chats.send(chatId, text, attachments),
    stopChat: (chatId) => chats.stop(chatId),
    configureChat: (chatId, patch) => chats.configure(chatId, patch),
    answerChat: (chatId, requestId, allow) => chats.answer(chatId, requestId, allow),
    closeChat: (chatId) => chats.close(chatId),
    busyChats: () => chats.busy(),
    attachToChat(chatId: string, files: AttachmentInput[]): Attachment[] {
      const taskId = chats.taskOf(chatId);
      if (!taskId) throw new Error('This chat is closed.');
      return saveAttachments(taskId, files);
    },
    isAttachment(hostPath: string): boolean {
      const rel = path.relative(path.join(dataDir, 'tasks'), path.resolve(hostPath));
      const parts = rel.split(path.sep);
      return !rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 3 && parts[1] === 'attachments';
    },
    canContinueRun(id: string, runId: string): { chat: boolean; terminal: boolean; guidance: boolean } {
      const none = { chat: false, terminal: false, guidance: false };
      const task = tasks.get(id);
      if (!task) return none;
      if (scheduler.get(id)?.runs.some((r) => r.runId === runId)) return none;
      try {
        const kind = recordedKind(task);
        if (!kind) return none;
        if (readRunSessionId(runs.runDir(id, runId), kind) === null) return none;
        const open = openHolder(task, runId);
        return { chat: !open.terminal, terminal: !open.chat, guidance: !open.chat && !open.terminal };
      } catch {
        return none;
      }
    },
    continueRun: (id, runId, guidance) => scheduler.continueRun(id, runId, guidance),
    canGuideRun: (id, runId) => scheduler.canGuideRun(id, runId),
    sendGuidance: (id, runId, text) => scheduler.sendGuidance(id, runId, text),
    armRest(): void {
      if (!rest) throw new Error('Rest Mode is only available in the Looper app on Windows.');
      if (remote.isRunning()) throw new Error('Stop Remote Control first: a sleeping computer drops its sessions.');
      rest.arm();
    },
    disarmRest: () => rest?.disarm(),
    restState: () => rest?.state() ?? { armed: false, phase: 'off', sleepAt: null, wakeAt: null },
    listRuns: (id, limit) => runs.list(id, limit),
    recentRuns(limit: number, filter: RunFilter): RecentRun[] {
      const out: RecentRun[] = [];
      for (const taskId of runs.listTaskIds()) {
        const task = tasks.get(taskId) ?? remote.standIn(taskId);
        if (!task) continue;
        const shown = runs.summaries(taskId).filter((r) => runShown(r, filter));
        for (const r of shown.slice(0, limit)) out.push({ ...r, taskId, taskName: task.name });
      }
      return out.sort((a, b) => b.startTs.localeCompare(a.startTs)).slice(0, limit);
    },
    readOutput: (id, runId, max, raw) => runs.readOutput(id, runId, max, raw),
    readMessages: (id, runId, agentId, raw) => messages.read(id, runId, agentId, raw),
    readMessageImage: (id, runId, rowId, agentId) => messages.readImage(id, runId, rowId, agentId),
    clearRuns(id: string): void {
      const rt = scheduler.get(id);
      if (rt && rt.runs.length > 0) {
        throw new Error(`The task is ${rt.state}; wait for the run to end or stop the task first.`);
      }
      if (chats.hasOpen(id) || terminalRuns.hasOpen(id)) {
        throw new Error('A chat or terminal window of this task is open. Close it first.');
      }
      runs.clear(id);
      log.info(`cleared run history of ${id}`);
    },
    runDir: (id, runId) => runs.runDir(id, runId),
    inboxDir: () => path.join(dataDir, 'inbox'),
    readEngineLog(maxBytes = 1024 * 1024): string {
      const file = path.join(dataDir, 'engine.log');
      try {
        const st = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        try {
          const start = Math.max(0, st.size - maxBytes);
          const buf = Buffer.alloc(st.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          let text = buf.toString('utf8');
          // A tail read may start mid-line; drop the partial first line.
          if (start > 0) text = text.slice(text.indexOf('\n') + 1);
          return text;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return '';
      }
    },
  };
}
