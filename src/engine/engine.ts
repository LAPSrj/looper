import fs from 'node:fs';
import path from 'node:path';
import type { RecentRun } from '../shared/dashboard';
import { modelWindows } from './model-windows';
import type { MessageImage, MessagesResult } from '../shared/messages';
import { runShown, type RunFilter } from '../shared/runs';
import type { EngineEvent, Harness, InboxCommand, PreventSleepState, PreventSleepTimer, Project, ProjectFolder, RecycleBinEntry, RestState, RunRecord, RunSkips, Settings, Task, TaskFolder, TaskRuntime } from '../shared/types';
import {
  FOLDER_TASK_PREFIX,
  folderEnvironment,
  normalizeFolder,
  projectIdOf,
  projectSessionTask,
  projectTaskId,
  sameFolder,
  sessionTask,
  type SessionPlace,
} from '../shared/projects';
import { ProjectStore } from './store/projects';
import { SettingsSchema } from '../shared/types';
import { REPORT_INPUT, issueLines } from '../shared/issues';
import { resolveEnvironment, resolveHarness, startsWithRemoteControl } from '../shared/environments';
import { detectDefaultWslDistro, detectHost, detectWslMountPrefix, type HostKind } from './host';
import { setDetectedMountPrefix } from './target';
import { Inbox } from './inbox';
import { Logger, errMsg } from './log';
import { MessagesService, readRunSessionId, transcriptHostPath } from './messages';
import { openTaskTerminal, writeTerminalLauncher } from './open-terminal';
import { TerminalRuns } from './terminal-runs';
import { TerminalSessions, type TerminalSessionsDeps } from './terminal-sessions';
import { CODEX_CACHE_MS } from './context';
import { CACHE_LONG_MS, lastCacheUse, RemoteControl } from './remote';
import type { RemoteMessage, RemoteState } from '../shared/remote';
import { ChatManager, imageMediaType, kindMismatchText } from './chat';
import { folderStandInId, HistoryService, LEDGER_FILE, runSessionRefs, SessionLedger, transcriptHistory, type HistoryDeps, type HistoryTranscript } from './history';
import { NO_HISTORY_COMMANDS, type HistoryCommands, type HistoryConversation, type HistoryItem, type HistoryList, type HistoryListOptions } from '../shared/history';
import type { CommandOutput } from '../shared/bash-mode';
import type { Attachment, AttachmentInput, ChatSettings, ChatState, QueuedMessage, TerminalInfo } from '../shared/chat';
import { limitsKey, type SessionActivity, type SessionKind, type SessionsState } from '../shared/sessions';
import { SessionHub } from './sessions';
import { GitService } from './git';
import { createWindowsPowerOps } from './power-win';
import { isBusy, RestController, type PowerAdapter, type PowerOps } from './rest';
import { PreventSleep } from './prevent-sleep';
import { Scheduler, type SchedulerSteps } from './scheduler';
import { ensureDir, readJson, writeJsonAtomic, writeText } from './store/fsutil';
import { RunStore, newRunId } from './store/runs';
import { loadSettings, saveSettings } from './store/settings';
import { StateStore, type OpenConversation } from './store/state';
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
  /** Hold or release the app's sleep blocker (Electron's powerSaveBlocker); without it Prevent Sleep is unavailable (CLI serve). */
  keepAwake?: (on: boolean) => void;
  /** Tests replace the terminal sessions' pty. */
  spawnTerminal?: TerminalSessionsDeps['spawn'];
  /** Tests give the folders the History window reads conversations from outside Looper in, instead of asking each environment. */
  historyDirs?: HistoryDeps['configDirs'];
}

export interface Engine {
  readonly dataDir: string;
  readonly host: HostKind;
  readonly settings: Settings;
  readonly log: Logger;
  /** Read-only git for the Git tabs, and which projects are in a repository. */
  readonly git: GitService;
  start(): void;
  stop(): Promise<void>;
  /** Validate, persist and apply a settings patch. Running components see it immediately. */
  updateSettings(patch: unknown): Settings;
  /** Move the current tasks/templates store file to a new path. Call before updateSettings. */
  moveStoreFile(store: 'tasks' | 'templates', targetFile: string): void;
  on(listener: (e: EngineEvent) => void): () => void;
  // projects
  listProjects(): Project[];
  getProject(id: string): Project | undefined;
  /**
   * Validate and persist a project; its tasks take its new values. Without an
   * id it's a new project, whose id comes from its folder. Throws with the reason.
   */
  saveProject(input: unknown): Project;
  /** Delete a project. Throws while tasks belong to it. */
  removeProject(id: string): void;
  /** The projects' order, and as drag and drop sends them, their new folders, the layout and folders' new parents (as reorderTasks). */
  reorderProjects(ids: string[], folderById?: Record<string, string | null>, layout?: Record<string, string[]>, parentById?: Record<string, string | null>): void;
  /** The Projects tab's folders, and each container's order of folders and projects. */
  listProjectFolders(): ProjectFolder[];
  listProjectLayout(): Record<string, string[]>;
  /** A new project folder, in `parentId` (unset: the top level). Throws with the reason. */
  addProjectFolder(name: string, parentId?: string): ProjectFolder;
  renameProjectFolder(id: string, name: string): ProjectFolder;
  /** Delete a project folder; its folders and projects move up to its parent. */
  removeProjectFolder(id: string): void;
  // tasks
  listTasks(): Task[];
  getTask(id: string): Task | undefined;
  /** A task, or the stand-in a project's, a folder's or a Remote Control helper's sessions run as, by its stand-in id. */
  findSessionTask(id: string): Task | undefined;
  /**
   * Other Folder…: the stand-in id a chat or terminal in a folder (a host path)
   * starts under, in the folder's environment (see folderEnvironment) with the
   * harness, model and permission mode a new project there gets. A project on
   * the folder gives its own. Throws with the reason.
   */
  folderTaskId(hostFolder: string): string;
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
   * the task's newest run in flight is stopped.
   */
  stopTask(id: string, reason?: string, runId?: string): Promise<boolean>;
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
  /** `stopped`: quitting Looper stopped its harness, and the next key typed into it starts it again on the conversation. */
  terminalSessionOutput(sessionId: string): { data: string; ended: boolean; stopped?: boolean; note?: string } | null;
  /** Sessions in Looper terminal windows whose harness is still running (Remote Control's not counted). */
  runningTerminalSessions(): number;
  // remote control (settings.remote.enabled turns it on and off: every helper and project gets its conversation, or every one of its sessions ends)
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
  /** Compact into New Chat: a new chat that starts from the chat's messages, without its tool calls; the chat closes after `started` sees the new one. Throws with the reason. */
  compactChat(chatId: string, started?: (next: ChatState) => void): Promise<ChatState>;
  /** Continue Compacted: a new chat that starts from the run's messages, without its tool calls. Throws with the reason. */
  compactRun(id: string, runId: string): Promise<ChatState>;
  // the History window
  /** The newest conversations on this computer: Looper's runs, and every Claude Code and Codex conversation in the environments' folders. */
  historyList(o: HistoryListOptions, progress?: (partial: HistoryList) => void): Promise<HistoryList>;
  /** Of the listed conversations `ids`, the ones whose user or agent messages contain the text. */
  historySearch(query: string, ids: string[]): Promise<string[]>;
  /** A listed conversation's rows and subagents (a subagent's rows with `agentId`); null once it's no longer listed. */
  historyRead(id: string, agentId?: string): Promise<HistoryConversation | null>;
  historyItem(id: string): HistoryItem | undefined;
  /** Which of the History window's commands a conversation offers; `outside`: one from outside Looper that no window of Looper's holds. */
  historyCommands(id: string): HistoryCommands & { outside?: boolean };
  /** When the transcript of a conversation from outside Looper last changed, read now. */
  historyChangedAt(id: string): Promise<number | undefined>;
  /**
   * Continue in Chat on a conversation from outside Looper: a chat in its
   * project, or its folder's stand-in, that resumes it, or the open chat
   * holding it. Throws with the reason (a project harness of another kind
   * among them).
   */
  continueHistoryInChat(id: string): Promise<ChatState>;
  /** Continue in Terminal on a conversation from outside Looper: the Looper terminal session's id, or null in the system's terminal. Throws with the reason. */
  continueHistoryInTerminal(id: string): Promise<string | null>;
  /** Continue Compacted on a conversation from outside Looper: a new chat from its messages. Throws with the reason. */
  compactHistory(id: string): Promise<ChatState>;
  getChat(chatId: string): ChatState | undefined;
  sendChat(chatId: string, text: string, attachments: Attachment[]): void;
  /** End the agent's turn, and the commands the user ran from the message box; the conversation goes on with the next message. */
  stopChat(chatId: string): Promise<void>;
  /**
   * A message box's "!" command, run in the chat's working directory on its
   * target: its output once it ends or is stopped (`chat:command` events show
   * it as it comes). `commandId`: the window's name for it.
   */
  runChatCommand(chatId: string, command: string, commandId: string): Promise<CommandOutput>;
  /** Stop under a running "!" command: that one alone ends. */
  stopChatCommand(chatId: string, commandId: string): Promise<void>;
  /** Chat menu: the chat's own model, effort or permission mode. */
  configureChat(chatId: string, patch: Partial<ChatSettings>): Promise<void>;
  /** Harness menu: a chat nothing has been said in moves to another harness of the task's environment. Throws with the reason. */
  setChatHarness(chatId: string, harnessId: string): Promise<void>;
  /** Answer the agent's permission request. */
  answerChat(chatId: string, requestId: string, allow: boolean): void;
  /** Continue When Limit Resets, on or off, for a chat. */
  setChatAutoContinue(chatId: string, on: boolean): void;
  /** Continue Anyway: the chat's continue goes even though Settings → Chats' cache rule would stop it. */
  setChatContinueAnyway(chatId: string): void;
  /** Rename…: the user's name for a chat or terminal session; '' goes back to its automatic name. Throws when it's closed. */
  renameSession(id: string, name: string): Promise<void>;
  /** End a chat (its window closed). */
  closeChat(chatId: string): Promise<void>;
  /** Chats in a turn or waiting on a permission answer. */
  busyChats(): number;
  /** Copy the files into the chat's task attachments, ready to send. */
  attachToChat(chatId: string, files: AttachmentInput[]): Attachment[];
  /** Send Now: the chat's queued messages go at once, ending the agent's turn if it's working. */
  sendNowChat(chatId: string): Promise<void>;
  /** Take a queued message out of the chat's queue (Cancel, or Edit). */
  unqueueChat(chatId: string, messageId: string): QueuedMessage | undefined;
  /** A message for one of the chat's running subagents, handed over by the chat's subagent hook. */
  messageSubagent(chatId: string, agentId: string, text: string): void;
  /** Take back what waits for the subagent; undefined when it has already read it. */
  unmessageSubagent(chatId: string, agentId: string): string | undefined;
  /** The chat's unsent message in its message box, kept for Looper's next start. */
  setChatDraft(chatId: string, text: string, attachments: Attachment[]): void;
  // sessions window
  sessionsState(): SessionsState;
  /** The background work, subagents and (terminal session) conversation of a session. */
  sessionActivity(id: string): SessionActivity | null;
  /** The sessions the Sessions windows show (their activity is sent as it changes). */
  watchSessions(ids: Iterable<string>): void;
  /** The user looked at a session: a finished turn or notification stops waiting for them. */
  seenSession(id: string): void;
  /** Whether a session is a chat, a terminal session, or a task run the Chats window lists; undefined once it's closed (or gone from the list). */
  sessionKind(id: string): SessionKind | undefined;
  /** The harness's own id for a listed session's conversation (Claude Code's session id, Codex's thread id); null before it has one. */
  harnessSessionId(id: string): string | null;
  /**
   * Stop: end the agent's turn in a chat or terminal session. A chat asks
   * Claude to stop, or ends Codex's turn; a terminal session gets Esc, as if
   * pressed in it.
   */
  stopSession(id: string): Promise<void>;
  /**
   * Restart Agent: the session's harness (Claude Code's or Codex's process)
   * starts again on the same conversation, ending a turn in progress. Throws
   * with the reason it can't.
   */
  restartSession(id: string): Promise<void>;
  /** Whether Restart Agent applies: a chat, or a terminal session on Claude Code or Codex. */
  canRestartSession(id: string): boolean;
  /** End a chat or terminal session for good (stopping Looper keeps them for its next start). */
  closeSession(id: string): Promise<void>;
  /** End every chat and terminal session in the Sessions window for good. */
  closeAllSessions(): Promise<void>;
  /** The end of a background command's output; null when it can't be read. */
  backgroundOutput(sessionId: string, taskId: string): Promise<string | null>;
  /** Send to Sessions: the message to each chat (queued while it works) and typed into each terminal session. */
  sendToSessions(ids: string[], text: string): void;
  /** Whether a host path is one of Looper's attachment copies (the only files a click on an attachment opens). */
  isAttachment(hostPath: string): boolean;
  /**
   * Which Continue items a run offers: claude/codex, a session on record, the
   * run not in flight. While a chat or Looper terminal window holds the
   * conversation, only the item of that kind is on (it brings the window
   * forward), so nothing else writes to the conversation meanwhile.
   */
  canContinueRun(id: string, runId: string): ContinueOptions;
  /** Start a manual run that resumes the run's conversation with `guidance` as its whole prompt (no check/classifier). */
  continueRun(id: string, runId: string, guidance: string): boolean;
  /** Whether a run in flight takes guidance now: its agent is running on Claude Code or Codex. */
  canGuideRun(id: string, runId: string): boolean;
  /** Send guidance to a run in flight; the agent gets it mid-run. Throws when the run cannot take it. */
  sendGuidance(id: string, runId: string, text: string): void;
  // rest mode
  /** Throws when Rest Mode is unavailable (non-Windows host, or no power adapter) or a Prevent Sleep timer is on. */
  armRest(): void;
  disarmRest(): void;
  restState(): RestState;
  // prevent sleep
  /** Start a Prevent Sleep timer (turning Rest Mode off) or turn it off. Throws when Prevent Sleep is unavailable. */
  setPreventSleep(timer: PreventSleepTimer): void;
  preventSleepState(): PreventSleepState;
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

/** Which of a finished run's Continue items can go on with its conversation now. */
export interface ContinueOptions {
  chat: boolean;
  terminal: boolean;
  guidance: boolean;
  /** Continue Compacted. */
  compact: boolean;
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
  const projects = new ProjectStore(path.join(dataDir, 'projects.json'), () => settings.environments, host);
  const tasks = new TaskStore(storeFile('tasks'), () => settings.environments, host, () => settings.completedFolderId, projects);
  const templates = new TemplateStore(storeFile('templates'));
  const runs = new RunStore(dataDir);
  const versions = new VersionStore(dataDir);
  const state = new StateStore(path.join(dataDir, 'state.json'));
  // Every session Looper starts, kept past run retention: the History window doesn't list them as conversations from outside Looper.
  const ledger = new SessionLedger(path.join(dataDir, LEDGER_FILE));
  modelWindows.open(path.join(dataDir, 'model-windows.json'));
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

  projects.on('invalid', (raw: unknown, errors: string[]) => {
    const id = (raw as { id?: string })?.id ?? '?';
    log.error(`projects.json: skipping invalid project ${id}: ${errors.join('; ')}`);
  });

  // Declared ahead: the message reader and terminal sessions reach Remote Control, created below.
  let remote: RemoteControl;

  /** Where a folder's stand-in records the folder its sessions open in (Other Folder…). */
  const folderPlaceFile = (id: string) => path.join(runs.taskDir(id), 'folder.json');
  /** A folder's stand-in: the defaults a new project in its folder gets, so they follow the settings as a project's do. */
  const folderTask = (id: string): Task | undefined => {
    if (!id.startsWith(FOLDER_TASK_PREFIX)) return undefined;
    const raw = readJson<Partial<Record<'name' | 'environmentId' | 'cwd', unknown>> | null>(folderPlaceFile(id), null);
    const { name, environmentId, cwd } = raw ?? {};
    if (typeof name !== 'string' || typeof environmentId !== 'string' || typeof cwd !== 'string' || !name || !cwd) return undefined;
    return sessionTask({ name, environmentId, cwd, permissionMode: 'auto' }, settings, id);
  };
  /** A task, or a project's or folder's stand-in by its stand-in id. */
  const taskOrProject = (id: string): Task | undefined => {
    const task = tasks.get(id);
    if (task) return task;
    const projectId = projectIdOf(id);
    const project = projectId ? projects.get(projectId) : undefined;
    return project ? projectSessionTask(project, settings) : folderTask(id);
  };
  const folderTaskId = (hostFolder: string): string => {
    const folder = hostFolder.trim();
    let isDir = false;
    try {
      isDir = fs.statSync(folder).isDirectory();
    } catch {
      /* not reachable */
    }
    if (!isDir) throw new Error(`${folder} isn't a folder.`);
    const env = folderEnvironment(folder, settings, host === 'windows');
    if (!env) throw new Error(`No WSL environment opens ${folder}. Add one for its distro in Settings → Environments.`);
    const place: SessionPlace = { name: folder, environmentId: env.id, cwd: folder, permissionMode: 'auto' };
    // The folder as the environment sees it (C:\x is /mnt/c/x in WSL, \\wsl.localhost\Ubuntu\x is /x).
    const cwd = normalizeFolder(createTarget(sessionTask(place, settings, 'folder'), { host, settings }).toTargetPath(folder));
    const own = projects.list().find((p) => p.environmentId === env.id && sameFolder(p.cwd, cwd));
    if (own) return projectTaskId(own.id);
    return folderStandIn(env.id, cwd);
  };
  /** The stand-in of a folder (as its environment sees it), recorded so its sessions find it. */
  const folderStandIn = (environmentId: string, cwd: string): string => {
    const id = folderStandInId(environmentId, cwd);
    ensureDir(runs.taskDir(id));
    writeJsonAtomic(folderPlaceFile(id), { name: cwd, environmentId, cwd });
    return id;
  };
  /** Also a Remote Control helper's stand-in, from its run history. */
  const lookup = (id: string): Task | undefined => taskOrProject(id) ?? remote.standIn(id);

  const messages = new MessagesService({
    getTask: lookup,
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
    onSession: (sessionId) => ledger.add({ sessionId, kind: 'builder', taskId: '' }),
  });

  // Declared ahead: chats and terminal sessions tell it when they change.
  let hub: SessionHub | undefined;

  const terminals = new TerminalSessions({
    emit: (e) => {
      emit(e);
      // A Remote Control session's harness exited: Remote Control closes it and opens another if needed.
      if (e.type === 'terminal:end' && remote.owns(e.id)) remote.exited(e.id);
      // A terminal it listed is over.
      else if (e.type === 'terminal:end') remote.detach(e.id);
      if (e.type === 'terminal:end') hub?.changed();
    },
    log,
    spawn: opts.spawnTerminal,
  });

  /** The harness a run's conversation is on: a chat's own (its chat.json), else the task's. Throws when it's gone. */
  const runHarness = (task: Task, runId: string): Harness => {
    const env = resolveEnvironment(task, settings);
    const id = runs.readChatInfo(task.id, runId)?.harnessId;
    if (!id) return resolveHarness(task, env);
    const h = env.harnesses.find((x) => x.id === id);
    if (!h) throw new Error(`The environment "${env.name}" no longer has the harness this chat ran on.`);
    return h;
  };

  /** A terminal or a run of the task goes on with a conversation on the task's own harness: a chat on another one can only go on in a chat. */
  const requireOwnHarness = (task: Task, runId: string): void => {
    const h = runHarness(task, runId);
    if (h.id !== resolveHarness(task, resolveEnvironment(task, settings)).id) {
      throw new Error(`This chat ran on ${h.name}, which isn't the task's harness, so only Continue in Chat can go on with it.`);
    }
  };

  /** Continue in Terminal: the session id the run's conversation was recorded under. */
  const resumeIdOf = (task: Task, runId: string): string => {
    const kind = runHarness(task, runId).kind;
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
    emit: (e) => {
      emit(e);
      if (e.type === 'chat' && e.state.status === 'ended') remote.detach(e.state.id);
      hub?.changed();
      // Its settings, conversation or turn may have changed: what the next start opens again follows.
      saveConversations();
    },
    runDir: runDirOf,
    readHistory,
    readCompactable: (taskId, runId) => messages.compactable(taskId, runId),
    readTranscript: transcriptHistory,
    readName: async (taskId, runId) => {
      const info = runs.readTerminalInfo(taskId, runId) ?? runs.readChatInfo(taskId, runId);
      if (info?.titleBy) return info.title;
      return messages.sessionName(taskId, runId).catch(() => undefined);
    },
    onSession: (c) => ledger.add({ ...c, kind: 'chat', taskName: lookup(c.taskId)?.name }),
    writeInfo: (taskId, runId, info) => runs.writeChatInfo(taskId, runId, info),
    appendRecord,
    taskVersion,
    onLimits: (key, limits) => hub?.setLimits(key, limits),
    cacheUntil: (chatId) => hub?.state().sessions.find((s) => s.id === chatId)?.cacheUntil,
    remoteName: (task, harness) => (remote.isRunning() && startsWithRemoteControl(harness) ? task.name : undefined),
    onRemote: (c) => remote.attach({ ...c, source: 'chat' }),
    onClose: (chatId) => {
      remote.detach(chatId);
      saveConversations();
    },
  });

  const terminalRuns = new TerminalRuns({
    runDir: runDirOf,
    readHistory,
    writeInfo: (taskId, runId, info) => runs.writeTerminalInfo(taskId, runId, info),
    appendRecord,
    taskVersion,
    log,
    onSession: (taskId, runId, sessionId) =>
      ledger.add({ sessionId, kind: remote.owns(runId) ? 'remote' : 'terminal', taskId, taskName: lookup(taskId)?.name, runId }),
  });

  remote = new RemoteControl({
    dataDir,
    settings,
    log,
    emit: (state) => emit({ type: 'remote', state }),
    getTask: taskOrProject,
    listTasks: () => tasks.list(),
    listProjects: () => projects.list(),
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
    // A chat it lists keeps its title in its chat.json.
    readTitle: (taskId, runId) => runs.readTerminalInfo(taskId, runId)?.title ?? (runs.readChatInfo(taskId, runId)?.title || undefined),
    runDir: (taskId, runId) => runs.runDir(taskId, runId),
  });

  // A chat or terminal session is working, as the Chats window's list last said.
  let chatsWorking = false;
  const sessionHub = new SessionHub({
    chats: () => chats.list(),
    terminals: () => terminals.list().filter((t) => !remote.owns(t.id)),
    runs: () =>
      settings.view.sessions.showRuns
        ? scheduler.list().flatMap((rt) =>
            rt.runs
              .filter((r) => r.state === 'running')
              .map((r) => ({ id: r.runId, taskId: rt.taskId, startedAt: r.startedAt, held: r.held, question: r.question })),
          )
        : [],
    findTask: lookup,
    projects: () => projects.list(),
    harnessOf(task) {
      try {
        const env = resolveEnvironment(task, settings);
        const h = resolveHarness(task, env);
        return { kind: h.kind, name: h.name, limitsKey: limitsKey(env.id, h.id) };
      } catch {
        return { kind: 'custom', name: 'Terminal' };
      }
    },
    runDir: runDirOf,
    readRows: (taskId, runId) => messages.read(taskId, runId),
    subagents: (taskId, runId) => messages.subagents(taskId, runId),
    subagentStats: (taskId, runId, agentId) => messages.subagentStats(taskId, runId, agentId),
    workflows: (taskId, runId, opts) => messages.workflows(taskId, runId, opts),
    contextTokens: (taskId, runId) => messages.contextTokens(taskId, runId),
    contextModel: (taskId, runId) => messages.contextModel(taskId, runId),
    cacheUse: async (taskId, runId) => {
      const tail = await messages.transcriptTail(taskId, runId);
      if (!tail) {
        const at = await messages.codexLastResponse(taskId, runId);
        return at !== null ? { at, ttlMs: CODEX_CACHE_MS } : {};
      }
      const use = lastCacheUse(tail);
      // A session that only read the cache kept alive an entry another one wrote: the long lifetime, as Remote Control assumes.
      return use.at !== undefined && use.ttlMs === undefined ? { ...use, ttlMs: CACHE_LONG_MS } : use;
    },
    terminalTitle: (taskId, runId) => terminalRuns.title(runId) ?? runs.readTerminalInfo(taskId, runId) ?? undefined,
    sessionName: async (taskId, runId) => {
      const name = await messages.sessionName(taskId, runId).catch(() => undefined);
      // terminal.json keeps it, so History lists the run under it too.
      if (name) terminalRuns.nameFromHarness(runId, name);
      return name;
    },
    emit: (e) => {
      emit(e);
      if (e.type !== 'sessions') return;
      chatsWorking = e.state.sessions.some((s) => s.kind !== 'run' && s.status === 'working');
      preventSleep?.poke();
      rest?.poke();
    },
    log,
  });
  hub = sessionHub;

  const git = new GitService({
    projectTask: (id) => {
      const project = projects.get(id);
      return project ? projectSessionTask(project, settings) : undefined;
    },
    projectIds: () => projects.list().map((p) => p.id),
    settings: () => settings,
    host,
    log,
    onRepos: (ids) => emit({ type: 'git-repos', ids }),
  });

  const history = new HistoryService({
    dataDir,
    host,
    settings,
    log,
    projects: () => projects.list(),
    runTaskIds: () => runs.listTaskIds(),
    findTask: lookup,
    summaries: (taskId) => runs.summaries(taskId),
    runDir: runDirOf,
    readChatInfo: (taskId, runId) => runs.readChatInfo(taskId, runId),
    readTerminalInfo: (taskId, runId) => runs.readTerminalInfo(taskId, runId),
    remoteRuns: () => new Set(remote.state(false).conversations.filter((c) => c.source !== 'chat' && c.source !== 'terminal').map((c) => c.id)),
    readRun: async (taskId, runId, agentId) => {
      const r = await messages.read(taskId, runId, agentId);
      return r.status === 'ok' ? r.rows.filter((row) => row.kind !== 'raw') : [];
    },
    compactableRun: (taskId, runId) => messages.compactable(taskId, runId),
    runSubagents: (taskId, runId) => messages.subagents(taskId, runId),
    runSubagentStats: (taskId, runId, agentId) => messages.subagentStats(taskId, runId, agentId),
    subagentsAt: (hostPath) => messages.subagentsAt(hostPath),
    ledger,
    configDirs: opts.historyDirs,
  });

  /**
   * A conversation from outside Looper's runs, and the stand-in a chat or
   * terminal on it runs as: its project's, else its folder's (`inFolder`).
   * Throws with the reason.
   */
  const outsideOf = async (id: string): Promise<{ t: HistoryTranscript; task: Task; inFolder: boolean }> => {
    const t = history.transcript(id);
    if (!t) throw new Error('This conversation is no longer in the History window’s list. Refresh the list and try again.');
    if (t.projectId) {
      const project = projects.get(t.projectId);
      if (!project) throw new Error('Its project no longer exists.');
      return { t, task: projectSessionTask(project, settings), inFolder: false };
    }
    if (!t.folder) throw new Error('The transcript doesn’t say which folder the conversation ran in.');
    const env = settings.environments.find((e) => e.id === t.environmentId);
    if (!env) throw new Error('The environment the conversation was found in no longer exists.');
    const hostFolder = await transcriptHostPath(t.folder, host, env.kind === 'wsl' ? env.distro : undefined);
    const isDir = hostFolder ? await fs.promises.stat(hostFolder).then((st) => st.isDirectory(), () => false) : false;
    if (!isDir) throw new Error(`The folder ${t.folder} no longer exists.`);
    const task = taskOrProject(folderStandIn(env.id, t.folder));
    if (!task) throw new Error(`Looper can’t open ${t.folder}.`);
    return { t, task, inFolder: true };
  };

  /**
   * The run of a kind (chat or terminal session) that already holds a run's
   * conversation `sessionId`: the run itself when it is one, else the newest
   * one that went on with it. One per conversation.
   */
  const holderOf = (task: Task, runId: string, sessionId: string, kind: 'chat' | 'terminal'): string | undefined => {
    const ids = kind === 'chat' ? runs.listChatRunIds(task.id) : runs.listTerminalRunIds(task.id);
    if (ids.includes(runId)) return runId;
    const kindOf = (id: string): Harness['kind'] => {
      try {
        return runHarness(task, id).kind;
      } catch {
        return 'custom'; // its harness is gone: it holds no conversation that can go on
      }
    };
    return ids.reverse().find((id) => readRunSessionId(runs.runDir(task.id, id), kindOf(id)) === sessionId);
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
    requireOwnHarness(task, runId);
    const sessionId = resumeIdOf(task, runId);
    const open = terminalRuns.findOpen(task.id, runId, sessionId);
    if (open) return { runId: open, open: true };
    if (chats.findOpen(task.id, runId, sessionId)) throw new Error('The conversation is open in a chat window.');
    const holder = holderOf(task, runId, sessionId, 'terminal');
    const info = holder ? runs.readTerminalInfo(task.id, holder) : null;
    if (holder && info) return { runId: holder, resume: sessionId, info };
    return { runId: newRunId(), resume: sessionId, fromRunId: runId };
  };

  /** A terminal session's output when Looper quit, shown again when it reopens it at its next start. */
  const TERMINAL_OUTPUT = 'terminal-output.txt';
  /** The conversation each open terminal session started on (Continue in Terminal), until it records its own. */
  const terminalResume = new Map<string, string>();

  /** End a Looper terminal session for good; one that never became a run leaves nothing behind. */
  const closeTerminal = (sessionId: string): void => {
    const taskId = terminals.taskOf(sessionId);
    terminals.close(sessionId);
    terminalResume.delete(sessionId);
    if (taskId) fs.rmSync(path.join(runs.runDir(taskId, sessionId), TERMINAL_OUTPUT), { force: true });
    if (terminalRuns.openIds().has(sessionId)) terminalRuns.close(sessionId);
    // A custom harness's session records nothing: its folder only held the launcher.
    else if (taskId) fs.rmSync(runs.runDir(taskId, sessionId), { recursive: true, force: true });
    saveConversations();
  };

  /** Claude Code and Codex sessions are recorded as runs; a custom harness has no conversation to record. */
  const recordedKind = (task: Task): 'claude-code' | 'codex' | null => {
    const kind = resolveHarness(task, resolveEnvironment(task, settings)).kind;
    return kind === 'custom' ? null : kind;
  };

  /** Start the task's harness in a Looper terminal session under run `runId` (`kind` null: a custom harness, not recorded). */
  const launchTerminal = (taskId: string, task: Task, runId: string, kind: 'claude-code' | 'codex' | null, resume?: string): string => {
    const dir = runs.createRunDir(taskId, runId);
    // The harness starts its sessions with Remote Control while it's turned on: the Claude app can drive this one.
    const withRemote = kind === 'claude-code' && remote.isRunning() && startsWithRemoteControl(resolveHarness(task, resolveEnvironment(task, settings)));
    const sessionId = terminals.start(
      taskId,
      () => {
        const { target, launcherHost } = writeTerminalLauncher(task, { host, settings }, dir, resume, !!kind, withRemote ? { name: task.name } : undefined);
        return { spec: target.spawnSpec(launcherHost), cwd: dir, launcher: launcherHost };
      },
      runId,
    );
    if (withRemote) remote.attach({ id: sessionId, taskId, source: 'terminal', name: task.name, cwd: task.cwd, dir });
    return sessionId;
  };

  // ---------- the Chats window's conversations across a restart of Looper ----------

  /** Off until start() has opened the saved ones again, and from when stop() saved them last. */
  let keepConversations = false;
  let savedConversations = '';

  /**
   * The chats and Looper terminal sessions in the Chats window, kept in
   * state.json each time they change, so Looper's next start (even after a
   * crash) opens them again. Remote Control's own sessions, and a custom
   * harness's terminals, which have no conversation to go on with, aren't kept.
   */
  function openConversations(): OpenConversation[] {
    const list: OpenConversation[] = chats.saved();
    for (const t of terminals.list()) {
      const info = remote.owns(t.id) ? undefined : terminalRuns.openInfo(t.id);
      if (!info) continue;
      const resume = terminalResume.get(t.id);
      list.push({ kind: 'terminal', id: t.id, taskId: t.taskId, startedAt: t.startedAt, ...info, ...(resume ? { resume } : {}) });
    }
    return list;
  }

  function saveConversations(): void {
    if (!keepConversations) return;
    const list = openConversations();
    const key = JSON.stringify(list);
    if (key === savedConversations) return;
    savedConversations = key;
    state.saveConversations(list);
  }

  /**
   * A terminal session that quitting stopped, typed into: its harness starts
   * again on the conversation it had (its own once it had a turn, else the
   * one it started on), at the window's size, after the output it had.
   */
  const wakeTerminal = (taskId: string, runId: string): void => {
    const task = taskOrProject(taskId);
    if (!task) throw new Error("This terminal session's project or task no longer exists.");
    const kind = recordedKind(task);
    if (!kind || kind !== terminalRuns.openInfo(runId)?.harnessKind) {
      throw new Error("The task's harness has changed, so this conversation can't go on in a terminal.");
    }
    const dir = runs.runDir(taskId, runId);
    // The session's own conversation once it has one on disk: a finished turn (stop.json), or a prompt it took (prompt.json, a turn a restart cut short).
    const started = fs.existsSync(path.join(dir, 'stop.json')) || fs.existsSync(path.join(dir, 'prompt.json'));
    const own = started ? readRunSessionId(dir, kind) : null;
    launchTerminal(taskId, task, runId, kind, own ?? terminalResume.get(runId));
    // The turn quitting cut short is over, whatever the files from before say.
    sessionHub.stopped(runId);
    sessionHub.changed();
  };

  /** Whether Restart Agent applies to a session: a chat, or a Looper terminal session on Claude Code or Codex. */
  const canRestart = (id: string): boolean => {
    if (chats.taskOf(id)) return true;
    const taskId = remote.owns(id) ? undefined : terminals.taskOf(id);
    const task = taskId ? taskOrProject(taskId) : undefined;
    try {
      return !!task && !!recordedKind(task) && !!terminalRuns.openInfo(id);
    } catch {
      return false; // the task's environment or harness is gone
    }
  };

  /** What a terminal stopped for its expired cache says until a key starts it again. */
  const CACHE_STOPPED = 'stopped when the prompt cache expired · press any key to go on';

  /**
   * Settings → Chats → Stop the agent once its cache expires: each idle chat
   * and terminal session whose last reply's prompt cache has expired gets its
   * harness stopped. Nothing is lost: the next message (or key) starts it
   * again on the conversation. One running background work is left alone.
   */
  const stopExpiredAgents = (): void => {
    if (!settings.chats.stopWhenCacheExpires) return;
    const now = Date.now();
    for (const s of sessionHub.state().sessions) {
      if (s.kind === 'run' || s.status !== 'ready' || s.waiting?.reason === 'permission' || s.background > 0) continue;
      if (s.cacheUntil === undefined || s.cacheUntil > now) continue;
      if (s.kind === 'chat') {
        if (chats.agentRunning(s.id)) void chats.stopIdleAgent(s.id).then((stopped) => stopped && sessionHub.changed());
      } else if (!s.stopped && !remote.owns(s.id) && terminals.taskOf(s.id) && canRestart(s.id)) {
        // Keys typed since the agent's last reply are a prompt on its way, which stopping would lose.
        if ((terminals.inputAt(s.id) ?? 0) > (s.lastReplyAt ?? 0)) continue;
        const taskId = s.taskId;
        terminals.suspend(s.id, () => wakeTerminal(taskId, s.id), CACHE_STOPPED);
        sessionHub.changed();
      }
    }
  };
  let cacheTimer: NodeJS.Timeout | null = null;

  /** Open again a terminal session that was open when Looper quit: listed with its output, its harness not running. */
  const restoreTerminal = (c: Extract<OpenConversation, { kind: 'terminal' }>): void => {
    const dir = runs.runDir(c.taskId, c.id);
    if (!fs.existsSync(dir)) throw new Error('its run folder is gone');
    let output = '';
    try {
      output = fs.readFileSync(path.join(dir, TERMINAL_OUTPUT), 'utf8');
    } catch {
      /* Looper didn't get to save it (a crash): the harness shows the conversation again once it starts */
    }
    const info = runs.readTerminalInfo(c.taskId, c.id) ?? undefined;
    terminalRuns.start({ taskId: c.taskId, runId: c.id, harnessKind: c.harnessKind, info, fromRunId: c.fromRunId, restored: true });
    if (c.resume) terminalResume.set(c.id, c.resume);
    terminals.restore(c.id, c.taskId, c.startedAt, output, () => wakeTerminal(c.taskId, c.id));
  };

  /** Looper's start: the conversations that were open when it quit come back, none of their agents running. */
  const restoreConversations = (): void => {
    const back: string[] = [];
    for (const c of state.loadConversations()) {
      const task = taskOrProject(c.taskId);
      try {
        if (!task) throw new Error('its project or task no longer exists');
        if (c.kind === 'chat') chats.restore(task, c, runs.readChatInfo(c.taskId, c.id));
        else restoreTerminal(c);
        back.push(c.id);
      } catch (err) {
        log.warn(`[${c.taskId}] cannot open ${c.kind} ${c.id} again: ${errMsg(err)}`);
      }
    }
    sessionHub.restored(back);
    keepConversations = true;
    saveConversations();
  };

  /**
   * Quitting: every chat's and terminal session's agent stops, and each stays
   * for the next start, a terminal with its output so far. The rest (Remote
   * Control's, a custom harness's terminals) close as before.
   */
  const suspendConversations = async (): Promise<void> => {
    saveConversations();
    keepConversations = false;
    const kept = new Set(state.loadConversations().map((c) => c.id));
    for (const t of terminals.list()) {
      if (!kept.has(t.id)) continue;
      const out = terminals.output(t.id)?.data ?? '';
      try {
        writeText(path.join(runs.runDir(t.taskId, t.id), TERMINAL_OUTPUT), out);
      } catch (err) {
        log.warn(`[${t.taskId}] cannot save terminal session ${t.id}'s output: ${errMsg(err)}`);
      }
      terminals.close(t.id);
      terminalRuns.close(t.id, true);
    }
    for (const t of terminals.list()) closeTerminal(t.id);
    terminalRuns.closeAll();
    await chats.suspendAll();
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
          busy: () => settings.preventSleepWhileWorking && chatsWorking,
          adapter: opts.power,
          ops: opts.powerOps ?? createWindowsPowerOps(),
          log,
          emit: (restState, disarmReason) => emit({ type: 'rest', rest: restState, ...(disarmReason ? { disarmReason } : {}) }),
        })
      : null;

  const preventSleep = opts.keepAwake
    ? new PreventSleep({
        settings,
        working: () => chatsWorking || scheduler.list().some(isBusy),
        keepAwake: opts.keepAwake,
        emit: (state) => emit({ type: 'prevent-sleep', state }),
        log,
      })
    : null;

  /** Remote Control runs while it's turned on (settings.remote.enabled), from Looper's start on. */
  const applyRemote = (): void => {
    if (settings.remote.enabled === remote.isRunning()) return;
    if (!settings.remote.enabled) {
      remote.stop();
      chats.remoteOff();
      return;
    }
    // A sleeping computer drops every Remote Control session: Rest Mode stays off meanwhile.
    if (rest?.state().armed) {
      rest.disarm();
      log.info('Rest Mode turned off: Remote Control started');
    }
    remote.start();
  };

  scheduler.on('event', (e: EngineEvent) => {
    emit(e);
    // A task run's sessions (its agent's, its classifier's) go in the ledger as its steps record them.
    if (e.type === 'record') {
      const { taskId, runId } = e.record;
      void runSessionRefs(runs.runDir(taskId, runId)).then((refs) => {
        for (const r of refs) ledger.add({ sessionId: r.sessionId, kind: r.classifier ? 'classifier' : 'run', taskId, taskName: tasks.get(taskId)?.name, runId });
      });
      return;
    }
    if (e.type !== 'runtime') return;
    rest?.poke();
    preventSleep?.poke();
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
  /** How often idle sessions are checked for an expired prompt cache (Settings → Chats). */
  const CACHE_CHECK_MS = 15_000;
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
    git,
    start() {
      if (started) return;
      started = true;
      log.info(`looper engine starting (host=${host}, dataDir=${dataDir})`);
      warmMountPrefixes();
      builders.sweep();
      projects.load();
      tasks.load();
      templates.load();
      const emitProjects = () => emit({ type: 'projects', projects: projects.list() });
      // A changed project's tasks take its values; Remote Control opens or ends its conversation.
      projects.on('change', (project: Project, kind: 'create' | 'update' | 'remove') => {
        if (kind !== 'remove') tasks.rederive(project.id);
        emitProjects();
        remote.settingsChanged();
        git.checkAll();
      });
      projects.on('reorder', emitProjects);
      projects.on('folders', () => emit({ type: 'project-folders', folders: projects.listFolders(), layout: projects.listLayout() }));
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
      // Remote Control first: a chat that opens again starts with it, as a new one would.
      applyRemote();
      // Before the sweep: an open conversation's run is never pruned.
      restoreConversations();
      sweepRunLogs();
      retentionTimer = setInterval(sweepRunLogs, RETENTION_SWEEP_MS);
      sessionHub.start();
      cacheTimer = setInterval(stopExpiredAgents, CACHE_CHECK_MS);
      git.checkAll();
    },
    async stop() {
      if (!started) return;
      started = false;
      sessionHub.stop();
      if (cacheTimer) clearInterval(cacheTimer);
      cacheTimer = null;
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
      inbox.stop();
      rest?.dispose();
      preventSleep?.dispose();
      remote.stop();
      // The chats and terminal sessions stay for the next start; only their agents stop.
      await Promise.all([scheduler.stop(), builders.closeAll(), suspendConversations()]);
      state.flush();
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
      const result = SettingsSchema.safeParse(merged, REPORT_INPUT);
      if (!result.success) throw new Error(issueLines(result.error));
      const parsed = result.data;
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
      // Show Task Runs adds or takes away the task runs in the Chats window's list.
      sessionHub.changed();
      // While a Session Is Working may have changed.
      preventSleep?.poke();
      rest?.poke();
      if (parsed.tasksFile !== oldTasksFile) {
        emit({ type: 'tasks', tasks: tasks.list() });
        emit({ type: 'recycleBin', entries: tasks.listBin() });
        emit({ type: 'folders', folders: tasks.listFolders(), layout: tasks.listLayout() });
      }
      if (parsed.templatesFile !== oldTemplatesFile) emit({ type: 'templates', templates: templates.list() });
      // Advanced → Remote Control → Turn On / Turn Off.
      if (started) applyRemote();
      remote.settingsChanged();
      return { ...settings };
    },
    listProjects: () => projects.list(),
    getProject: (id) => projects.get(id),
    saveProject(input: unknown): Project {
      const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (raw.id) return projects.upsert(raw);
      const { id } = projects.draft(String(raw.environmentId ?? ''), String(raw.cwd ?? ''));
      return projects.upsert({ ...raw, id });
    },
    removeProject(id: string): void {
      const using = tasks.list().filter((t) => t.projectId === id);
      if (using.length) {
        const names = using.slice(0, 5).map((t) => `"${t.name}"`).join(', ');
        throw new Error(
          `${using.length === 1 ? 'A task belongs' : `${using.length} tasks belong`} to this project (${names}${using.length > 5 ? ', …' : ''}). Move ${using.length === 1 ? 'it' : 'them'} to another project or delete ${using.length === 1 ? 'it' : 'them'} first.`,
        );
      }
      projects.remove(id);
    },
    reorderProjects: (ids, folderById, layout, parentById) => projects.reorder(ids, folderById, layout, parentById),
    listProjectFolders: () => projects.listFolders(),
    listProjectLayout: () => projects.listLayout(),
    addProjectFolder: (name, parentId) => projects.addFolder(name, parentId),
    renameProjectFolder: (id, name) => projects.renameFolder(id, name),
    removeProjectFolder: (id) => void projects.removeFolder(id),
    listTasks: () => tasks.list(),
    getTask: (id) => tasks.get(id),
    findSessionTask: lookup,
    folderTaskId,
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
    openTaskTerminal(id: string, runId?: string): Promise<void> {
      const task = taskOrProject(id);
      if (!task) throw new Error(`unknown task ${id}`);
      if (runId) requireOwnHarness(task, runId);
      const resumeSessionId = runId ? resumeIdOf(task, runId) : undefined;
      return openTaskTerminal(task, { host, settings, log }, runs.taskDir(id), resumeSessionId);
    },
    startTerminalSession(id: string, runId?: string): string {
      const task = taskOrProject(id);
      if (!task) throw new Error(`unknown task ${id}`);
      const kind = recordedKind(task);
      const to = kind ? terminalRunFor(task, runId) : { runId: newRunId() };
      if ('open' in to && to.open) return to.runId;
      const resume = 'resume' in to ? to.resume : undefined;
      const sessionId = launchTerminal(id, task, to.runId, kind, resume);
      if (kind) {
        const extra = to as { info?: TerminalInfo; fromRunId?: string };
        terminalRuns.start({ taskId: id, runId: to.runId, harnessKind: kind, info: extra.info, fromRunId: extra.fromRunId });
        if (resume) terminalResume.set(sessionId, resume);
      }
      sessionHub.changed();
      saveConversations();
      return sessionId;
    },
    writeTerminalSession: (sessionId, data) => terminals.write(sessionId, data),
    resizeTerminalSession: (sessionId, cols, rows) => terminals.resize(sessionId, cols, rows),
    terminalSessionOutput: (sessionId) => terminals.output(sessionId),
    runningTerminalSessions: () => terminals.running() - remote.liveCount(),
    remoteState: () => remote.state(),
    remoteLastMessage: (id) => remote.lastMessage(id),
    stopRemoteConversation: (id) => remote.stopConversation(id),
    restartRemoteConversation: (id) => remote.restartConversation(id),
    isRemoteSession: (id) => remote.owns(id),
    usedRemoteConversations: () => remote.usedCount(),
    taskName: (id) => lookup(id)?.name,
    attachToTerminal(sessionId: string, files: AttachmentInput[]): string {
      const taskId = terminals.taskOf(sessionId);
      const task = taskId ? lookup(taskId) : undefined;
      if (!task) throw new Error('This terminal session is closed.');
      const target = createTarget(task, { host, settings });
      return saveAttachments(task.id, files)
        .map((a) => target.toTargetPath(a.path))
        .map((p) => (/\s/.test(p) ? target.quote(p) : p))
        .join(' ');
    },
    startChat(id: string, runId?: string): ChatState {
      const task = taskOrProject(id);
      if (!task) throw new Error(`unknown task ${id}`);
      return runId ? continueInChat(task, runId) : chats.start(task, { kind: 'new' });
    },
    forkChat(chatId: string, index: number): ChatState {
      const taskId = chats.taskOf(chatId);
      const task = taskId ? taskOrProject(taskId) : undefined;
      if (!task) throw new Error('This chat is closed.');
      return chats.fork(task, chatId, index);
    },
    async compactChat(chatId: string, started?: (next: ChatState) => void): Promise<ChatState> {
      const taskId = chats.taskOf(chatId);
      const task = taskId ? taskOrProject(taskId) : undefined;
      if (!task) throw new Error('This chat is closed.');
      return chats.compact(task, chatId, (next) => {
        sessionHub.changed();
        started?.(next);
      });
    },
    async compactRun(id: string, runId: string): Promise<ChatState> {
      const task = taskOrProject(id);
      if (!task) throw new Error(`unknown task ${id}`);
      const history = await messages.compactable(task.id, runId);
      if (!history.some((r) => r.kind === 'agent')) throw new Error('No conversation was recorded for this run.');
      // A chat's run goes on with its harness and settings, while the environment still has that harness.
      const info = runs.readChatInfo(task.id, runId);
      const kept = info?.harnessId && resolveEnvironment(task, settings).harnesses.some((h) => h.id === info.harnessId);
      return chats.start(task, { kind: 'compact', from: runId, history, ...(kept ? { harnessId: info.harnessId, settings: info.settings } : {}) });
    },
    historyList: (o, progress) => history.list(o, progress),
    historySearch: (query, ids) => history.search(query, ids),
    historyRead: (id, agentId) => history.read(id, agentId),
    historyItem: (id) => history.item(id),
    historyCommands(id: string): HistoryCommands & { outside?: boolean } {
      const item = history.item(id);
      if (!item) return NO_HISTORY_COMMANDS;
      const base = { sessionId: item.sessionId ?? null, folder: !!item.folder };
      if (item.runId) {
        const c = this.canContinueRun(item.taskId, item.runId);
        return { ...base, chat: c.chat, terminal: c.terminal, compact: c.compact };
      }
      const t = history.transcript(id);
      const project = t?.projectId ? projects.get(t.projectId) : undefined;
      if (!t || (t.projectId && !project)) return NO_HISTORY_COMMANDS;
      // Without its folder there's nowhere to go on.
      if (!project && !t.folder) return { ...NO_HISTORY_COMMANDS, sessionId: base.sessionId };
      // A harness of another kind is refused when it's picked, saying why.
      const taskId = project ? projectTaskId(project.id) : folderStandInId(t.environmentId, t.folder);
      const chat = chats.findOpen(taskId, '', t.sessionId);
      const terminal = terminalRuns.findOpen(taskId, '', t.sessionId);
      // A chat or terminal of Looper's holding it comes forward: there's nothing to ask about another one.
      return { ...base, chat: !terminal, terminal: !chat, compact: true, outside: !chat && !terminal };
    },
    historyChangedAt: (id) => history.changedAt(id),
    async continueHistoryInChat(id: string): Promise<ChatState> {
      const { t, task, inFolder } = await outsideOf(id);
      const open = chats.findOpen(task.id, '', t.sessionId);
      if (open) return open;
      if (terminalRuns.findOpen(task.id, '', t.sessionId)) throw new Error('The conversation is open in a terminal window.');
      // A folder has no harness of its own: the environment's of the conversation's kind goes on with it.
      const harnessId = inFolder ? resolveEnvironment(task, settings).harnesses.find((h) => h.kind === t.harnessKind)?.id : undefined;
      return chats.start(task, { kind: 'resume', sessionId: t.sessionId, harnessKind: t.harnessKind, transcript: t.path, ...(harnessId ? { harnessId } : {}) });
    },
    async continueHistoryInTerminal(id: string): Promise<string | null> {
      const { t, task } = await outsideOf(id);
      const kind = resolveHarness(task, resolveEnvironment(task, settings)).kind;
      if (kind !== t.harnessKind) throw new Error(kindMismatchText(t.harnessKind, kind));
      if (settings.terminal === 'system') {
        await openTaskTerminal(task, { host, settings, log }, runs.taskDir(task.id), t.sessionId);
        return null;
      }
      const open = terminalRuns.findOpen(task.id, '', t.sessionId);
      if (open) return open;
      if (chats.findOpen(task.id, '', t.sessionId)) throw new Error('The conversation is open in a chat window.');
      const runId = newRunId();
      const sessionId = launchTerminal(task.id, task, runId, t.harnessKind, t.sessionId);
      terminalRuns.start({ taskId: task.id, runId, harnessKind: t.harnessKind });
      terminalResume.set(sessionId, t.sessionId);
      sessionHub.changed();
      saveConversations();
      return sessionId;
    },
    async compactHistory(id: string): Promise<ChatState> {
      const { t, task } = await outsideOf(id);
      const rows = await history.compactable(id);
      if (!rows.some((r) => r.kind === 'agent')) throw new Error('The conversation has no reply to compact yet.');
      return chats.start(task, { kind: 'compact', from: t.sessionId, label: `Compacted from "${t.title}"`, history: rows });
    },
    getChat: (chatId) => chats.get(chatId),
    sendChat: (chatId, text, attachments) => chats.send(chatId, text, attachments),
    stopChat: (chatId) => chats.stop(chatId),
    runChatCommand: (chatId, command, commandId) => chats.runCommand(chatId, command, commandId),
    stopChatCommand: (chatId, commandId) => chats.stopCommand(chatId, commandId),
    configureChat: (chatId, patch) => chats.configure(chatId, patch),
    async setChatHarness(chatId: string, harnessId: string): Promise<void> {
      const taskId = chats.taskOf(chatId);
      const task = taskId ? taskOrProject(taskId) : undefined;
      if (!task) throw new Error('This chat is closed.');
      await chats.setHarness(task, chatId, harnessId);
    },
    answerChat: (chatId, requestId, allow) => chats.answer(chatId, requestId, allow),
    setChatAutoContinue: (chatId, on) => chats.setAutoContinue(chatId, on),
    setChatContinueAnyway: (chatId) => chats.setContinueAnyway(chatId),
    async renameSession(id: string, name: string): Promise<void> {
      if (chats.taskOf(id)) chats.rename(id, name);
      else if (terminals.taskOf(id) && !remote.owns(id)) await terminalRuns.rename(id, name);
      else throw new Error('This conversation is closed.');
      sessionHub.changed();
    },
    closeChat: (chatId) => chats.close(chatId),
    busyChats: () => chats.busy(),
    attachToChat(chatId: string, files: AttachmentInput[]): Attachment[] {
      const taskId = chats.taskOf(chatId);
      if (!taskId) throw new Error('This chat is closed.');
      return saveAttachments(taskId, files);
    },
    sendNowChat: (chatId) => chats.sendNow(chatId),
    unqueueChat: (chatId, messageId) => chats.unqueue(chatId, messageId),
    messageSubagent: (chatId, agentId, text) => chats.messageSubagent(chatId, agentId, text),
    unmessageSubagent: (chatId, agentId) => chats.unmessageSubagent(chatId, agentId),
    setChatDraft(chatId: string, text: string, attachments: Attachment[]): void {
      chats.setDraft(chatId, { text, attachments });
      saveConversations();
    },
    sessionsState: () => sessionHub.state(),
    sessionActivity: (id) => sessionHub.activity(id),
    watchSessions: (ids) => sessionHub.watch(ids),
    seenSession: (id) => sessionHub.seen(id),
    sessionKind(id: string): SessionKind | undefined {
      if (chats.taskOf(id)) return 'chat';
      if (terminals.taskOf(id) && !remote.owns(id)) return 'terminal';
      return sessionHub.runTask(id) ? 'run' : undefined;
    },
    harnessSessionId(id: string): string | null {
      // A chat may run on another harness than its task's.
      const chat = chats.get(id);
      if (chat) return readRunSessionId(runs.runDir(chat.taskId, id), chat.harnessKind);
      const taskId = chats.taskOf(id) ?? (remote.owns(id) ? undefined : terminals.taskOf(id)) ?? sessionHub.runTask(id);
      const task = taskId ? lookup(taskId) : undefined;
      if (!taskId || !task) return null;
      try {
        const kind = recordedKind(task);
        return kind ? readRunSessionId(runs.runDir(taskId, id), kind) : null;
      } catch {
        return null; // the task's environment or harness is gone
      }
    },
    async stopSession(id: string): Promise<void> {
      if (chats.taskOf(id)) await chats.stop(id);
      // Esc would start a terminal that quitting stopped again: it has no turn to stop.
      else if (terminals.taskOf(id) && !remote.owns(id) && !terminals.isStopped(id)) {
        terminals.write(id, '\x1b');
        sessionHub.stopped(id);
      }
    },
    async restartSession(id: string): Promise<void> {
      if (!canRestart(id)) throw new Error('This conversation’s agent can’t be restarted.');
      if (chats.taskOf(id)) {
        await chats.restartAgent(id);
      } else {
        const taskId = terminals.taskOf(id)!;
        terminals.restart(id, () => wakeTerminal(taskId, id));
      }
      sessionHub.changed();
      saveConversations();
    },
    canRestartSession: (id) => canRestart(id),
    async closeSession(id: string): Promise<void> {
      if (chats.taskOf(id)) await chats.close(id);
      else if (terminals.taskOf(id) && !remote.owns(id)) closeTerminal(id);
      sessionHub.changed();
    },
    async closeAllSessions(): Promise<void> {
      for (const t of terminals.list()) if (!remote.owns(t.id)) closeTerminal(t.id);
      await chats.closeAll();
      sessionHub.changed();
    },
    async backgroundOutput(sessionId: string, taskId: string): Promise<string | null> {
      const owner =
        chats.taskOf(sessionId) ?? terminals.taskOf(sessionId) ?? sessionHub.runTask(sessionId);
      const file = owner ? sessionHub.backgroundFile(sessionId, taskId) : undefined;
      return owner && file ? messages.readTail(owner, file) : null;
    },
    sendToSessions(ids: string[], text: string): void {
      const t = text.trim();
      if (!t) return;
      for (const id of ids) {
        if (chats.taskOf(id)) chats.send(id, t, []);
        // Pasted the way a terminal pastes, so a line break doesn't send it early, then Enter. A terminal
        // that quitting stopped isn't listed: the text would only start its harness, not reach it.
        else if (terminals.taskOf(id) && !remote.owns(id) && !terminals.isStopped(id)) terminals.write(id, `\x1b[200~${t}\x1b[201~\r`);
      }
    },
    isAttachment(hostPath: string): boolean {
      const rel = path.relative(path.join(dataDir, 'tasks'), path.resolve(hostPath));
      const parts = rel.split(path.sep);
      return !rel.startsWith('..') && !path.isAbsolute(rel) && parts.length === 3 && parts[1] === 'attachments';
    },
    canContinueRun(id: string, runId: string): ContinueOptions {
      const none = { chat: false, terminal: false, guidance: false, compact: false };
      const task = taskOrProject(id);
      if (!task) return none;
      if (scheduler.get(id)?.runs.some((r) => r.runId === runId)) return none;
      try {
        const harness = runHarness(task, runId);
        if (harness.kind === 'custom') return none;
        if (readRunSessionId(runs.runDir(id, runId), harness.kind) === null) return none;
        const open = openHolder(task, runId);
        // A terminal and a run of the task use the task's harness: a chat on another one goes on only in a chat.
        const own = harness.id === resolveHarness(task, resolveEnvironment(task, settings)).id;
        // Continue with Guidance starts a run of a task: a project's sessions have none.
        // Continue Compacted only reads the conversation: a chat or terminal open on it doesn't matter.
        return { chat: !open.terminal, terminal: own && !open.chat, guidance: own && !!tasks.get(id) && !open.chat && !open.terminal, compact: true };
      } catch {
        return none;
      }
    },
    continueRun(id: string, runId: string, guidance: string): boolean {
      const task = tasks.get(id);
      if (task) requireOwnHarness(task, runId);
      return scheduler.continueRun(id, runId, guidance);
    },
    canGuideRun: (id, runId) => scheduler.canGuideRun(id, runId),
    sendGuidance: (id, runId, text) => scheduler.sendGuidance(id, runId, text),
    armRest(): void {
      if (!rest) throw new Error('Rest Mode is only available in the Looper app on Windows.');
      if (remote.isRunning()) throw new Error('Turn off Remote Control first: a sleeping computer drops its sessions.');
      if (preventSleep && preventSleep.state().timer !== 'off') throw new Error('Turn Prevent Sleep off first: Rest Mode puts the computer to sleep.');
      rest.arm();
    },
    disarmRest: () => rest?.disarm(),
    restState: () => rest?.state() ?? { armed: false, phase: 'off', sleepAt: null, wakeAt: null },
    setPreventSleep(timer: PreventSleepTimer): void {
      if (!preventSleep) throw new Error('Prevent Sleep is only available in the Looper app.');
      // Rest Mode would put the computer to sleep: it stays off while a timer is on.
      if (timer !== 'off' && rest?.state().armed) rest.disarm('Prevent Sleep turned on');
      preventSleep.set(timer);
    },
    preventSleepState: () => preventSleep?.state() ?? { timer: 'off', until: null, active: false },
    listRuns: (id, limit) => runs.list(id, limit),
    recentRuns(limit: number, filter: RunFilter): RecentRun[] {
      const out: RecentRun[] = [];
      for (const taskId of runs.listTaskIds()) {
        const task = lookup(taskId);
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
