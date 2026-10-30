import type {
  AddonEvent,
  AddonEventSource,
  AddonInfo,
  AddonMenuBar,
  AddonMenuItem,
  AddonLocalRun,
  AddonPaneContent,
  AddonScreen,
  AddonUiEvent,
  EngineLogLevel,
} from './addons';
import type { BuilderSetup, BuilderState } from './builder';
import type { RecentRun } from './dashboard';
import type { RunFilter } from './runs';
import type { Attachment, ChatState, QueuedMessage } from './chat';
import type { SessionActivity, SessionsState } from './sessions';
import type { GitChange, GitCommit, GitCommitDetail, GitFileDiff, GitStatusResult } from './git';
import type { MessageImage, MessagesResult } from './messages';
import type { VersionDetail, VersionSummary } from './versions';
import type { DiscoveredModel } from './model-update';
import type { PaneId } from './panes';
import type { RemoteMessage, RemoteState } from './remote';
import type { PairingCode, RemoteAccessState } from './remote-access';
import type { EngineEvent, Project, RecycleBinEntry, RestState, RunRecord, Settings, Task, TaskFolder, TaskRuntime, Template } from './types';

export interface AppInfo {
  version: string;
  dataDir: string;
  inboxDir: string;
  host: string;
  /** The machine's regional format (e.g. "en-150"); undefined = use the runtime default. */
  locale?: string;
  settings: Settings;
}

/** The API the preload script exposes to the renderer as `window.looper`. */
export interface LooperApi {
  info(): Promise<AppInfo>;
  tasks: {
    list(): Promise<Task[]>;
    /** `builderId`: the editor was opened by a task builder's Create/Update; the version is the agent's. */
    save(input: unknown, opts?: { builderId?: string }): Promise<Task>;
    /** Delete a task: it stops and moves to the Recycle Bin. */
    remove(id: string): Promise<boolean>;
    /** Native save dialog, then write the task as a .loopertask document (store timestamps stripped). */
    export(id: string): Promise<void>;
    /**
     * Persist a new task order; `folders` reassigns tasks to folders,
     * `layout` sets the sibling display order per container and `parents`
     * re-nests folders, all in the same write.
     */
    reorder(
      ids: string[],
      folders?: Record<string, string | null>,
      layout?: Record<string, string[]>,
      parents?: Record<string, string | null>,
    ): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** Validate and persist (no id = a new project); rejects with the reason. */
    save(input: unknown): Promise<Project>;
    /** Asks first; shows why when tasks still belong to it. */
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    /** The Edit Project window (no id = New Project). */
    openEditor(id?: string): Promise<void>;
    /** The New Task editor with the project picked. */
    newTask(id: string): Promise<void>;
    /** A new chat or terminal session in the project, on its harness and settings; shows why when it can't start. */
    newChat(id: string): Promise<void>;
    newTerminal(id: string): Promise<void>;
    /** A project row's right-click menu; '' = the pane's (New Project…). */
    showContextMenu(id: string): void;
  };
  versions: {
    /** A task's versions, oldest first. */
    list(taskId: string): Promise<VersionSummary[]>;
    /** One version's definition and files; `compare` adds its differences from the current task. */
    detail(taskId: string, n: number, compare?: boolean): Promise<VersionDetail>;
    /** Put a version's definition and files back; rejects with the reason when it can't be. */
    restore(taskId: string, n: number): Promise<Task>;
    /** Open the task's Version History window. */
    open(taskId: string): Promise<void>;
    /** Open a version in its own window: its definition and files, or (compare) its differences from the current task. */
    openDetail(taskId: string, n: number, compare: boolean): Promise<void>;
  };
  builder: {
    /** Setup window only: start the builder; the window becomes its conversation. Rejects with the reason. */
    start(setup: BuilderSetup): Promise<void>;
    get(id: string): Promise<BuilderState | null>;
    send(id: string, text: string): void;
    /** Create/Update: open the task editor prefilled with the draft. */
    review(id: string): Promise<void>;
    /** Save the draft as it is; rejects with the reason when it isn't valid. */
    save(id: string): Promise<Task>;
    /** Move the draft and the task's files back or forward through the builder's changes; rejects with the reason. */
    undo(id: string): Promise<void>;
    redo(id: string): Promise<void>;
    /** The builder open on a task, if any. */
    forTask(taskId: string): Promise<string | null>;
    /** Version History: continue the open builder's work from a saved version; rejects with the reason. */
    loadVersion(taskId: string, n: number): Promise<void>;
    /** Open Edit with Agent for a task (or bring its open builder forward). */
    editTask(taskId: string): Promise<void>;
    /** Open the New Task with Agent setup window. */
    openNew(): Promise<void>;
    /** Terminal view. */
    output(id: string): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  recycleBin: {
    /** Most recently deleted first. */
    list(): Promise<RecycleBinEntry[]>;
    /** Put a deleted task back; rejects with the reason when it can't be. */
    restore(id: string): Promise<Task>;
    /** Delete a task in the bin for good, with its run history; rejects while its run is still stopping. */
    delete(id: string): Promise<boolean>;
    empty(): Promise<void>;
  };
  folders: {
    list(): Promise<TaskFolder[]>;
    /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with task ids. */
    layout(): Promise<Record<string, string[]>>;
    add(name: string, parentId?: string): Promise<TaskFolder>;
    rename(id: string, name: string): Promise<TaskFolder>;
    /** Delete a folder; its tasks move to the top level. */
    remove(id: string): Promise<boolean>;
  };
  templates: {
    list(): Promise<Template[]>;
    save(input: unknown): Promise<Template>;
    remove(id: string): Promise<boolean>;
    reorder(ids: string[]): Promise<void>;
    /** Native save dialog, then write the template as a .loopertpl document (store timestamps stripped). */
    export(id: string): Promise<void>;
    /** Native open dialog, then a New Template editor prefilled from the picked .loopertpl file. */
    import(): Promise<void>;
  };
  runtime: {
    list(): Promise<TaskRuntime[]>;
    runNow(id: string): Promise<boolean>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    /** Finish a task for good: it stops being scheduled and is deleted when its retention runs out. */
    complete(id: string): Promise<void>;
    /** Undo a completion: the task is enabled again and its schedule resumes. */
    reopen(id: string): Promise<void>;
    /** No run id = the task's newest run in flight. */
    stopTask(id: string, runId?: string): Promise<boolean>;
  };
  runs: {
    list(id: string, limit?: number): Promise<RunRecord[]>;
    /** The newest `limit` runs the filter shows, across every task and Remote Control folder project and helper. */
    recent(limit: number, filter: RunFilter): Promise<RecentRun[]>;
    output(id: string, runId: string, raw?: boolean): Promise<string>;
    openDir(id: string, runId: string): Promise<void>;
    /** Delete a task's run history. Rejects while the task is mid-cycle. */
    clear(id: string): Promise<void>;
    /** The run's conversation from the harness transcript (agentId: a subagent's instead; raw: every record as JSON). */
    messages(id: string, runId: string, agentId?: string, raw?: boolean): Promise<MessagesResult>;
    /** The image payload behind a message row's image marker. */
    messageImage(id: string, runId: string, rowId: string, agentId?: string): Promise<MessageImage | null>;
  };
  /** Terminal of one run; without a run id, of the task's newest run in flight. */
  agent: {
    buffer(id: string, runId?: string): Promise<{ runId: string; data: string } | null>;
    write(id: string, data: string, runId?: string): void;
    resize(id: string, cols: number, rows: number, runId?: string): void;
  };
  /** Current Rest Mode state; live updates arrive as `rest` engine events. */
  restState(): Promise<RestState>;
  openPath(p: string): Promise<void>;
  /** Open a dropped Looper document (.loopertask/.loopertpl) as if it were double-clicked. */
  openLooperFile(file: File): Promise<void>;
  /** Tail of the engine log file (whole lines only). */
  readEngineLog(): Promise<string>;
  /**
   * Open the task's harness in a terminal (same env/cwd/model/args, no prompt):
   * a Looper terminal window or the system's terminal, as the setting says. A
   * run id resumes that run's conversation.
   */
  openTaskTerminal(taskId: string, runId?: string): Promise<void>;
  /** Open Project in Chat, or Continue in Chat with a run id: the task's harness in a Looper chat window. */
  openTaskChat(taskId: string, runId?: string): Promise<void>;
  /** A chat in the Sessions window. */
  chat: {
    get(id: string): Promise<ChatState | null>;
    /** To the agent, or into the chat's queue while it works. */
    send(id: string, text: string, attachments: Attachment[]): void;
    /** Send Now: the queued messages go at once, ending the agent's turn if it's working. */
    sendNow(id: string): Promise<void>;
    /** Take a message out of the queue (Cancel; Edit puts it back in the message box). */
    unqueue(id: string, messageId: string): Promise<QueuedMessage | null>;
    /** Allow or deny the agent's permission request. */
    answer(id: string, requestId: string, allow: boolean): void;
    /** End the agent's turn (Esc). */
    stop(id: string): Promise<void>;
    /** The message box's Model, Effort or Permission Mode menu, at (x, y) in the window. */
    showSettingMenu(id: string, which: 'model' | 'effort' | 'permission', x: number, y: number): void;
    /** Attach Files: the open dialog, then the picked files copied in like dropped ones. */
    pickFiles(id: string): Promise<Attachment[]>;
    /** Copy pasted or dropped files into the task's attachments, ready to send. */
    attachFiles(id: string, files: File[]): Promise<Attachment[]>;
    /**
     * A message's right-click menu: Copy (the selection), the copy items for
     * the message, Open File and Copy Path for a file, Edit as New Message
     * for the user's own message (it comes back as a chat-edit ui event), and
     * Fork from Here when `fork` gives the message's index in the chat's
     * history and rows.
     */
    showContextMenu(info: {
      chatId: string;
      taskId: string;
      selection?: string;
      text?: string;
      /** The text's copy item, e.g. "Copy Input"; default "Copy Message". */
      textLabel?: string;
      result?: string;
      file?: string;
      resend?: { text: string; attachments: Attachment[] };
      fork?: number;
    }): void;
  };
  /** The Sessions window: every chat and terminal session, and the one it shows. */
  sessions: {
    state(): Promise<SessionsState>;
    activity(id: string): Promise<SessionActivity | null>;
    /** The window shows this session now (null: the Overview): its conversation and activity come as events. */
    show(id: string | null): void;
    /** The user looked at the session: a finished turn or a notification stops waiting. */
    seen(id: string): void;
    /** Close Conversation, asking first when the agent is working. */
    close(id: string): Promise<void>;
    /** Stop: end the agent's turn (Claude's interrupt in a chat, Esc in a terminal session). */
    stop(id: string): Promise<void>;
    showContextMenu(id: string): void;
    /** The Send to Sessions window. */
    openSend(): void;
    /** The Sessions window, opened or brought forward; `id` shows that session in it. */
    openWindow(id?: string): void;
    /** New Chat's or New Terminal's drop-down list of projects, at (x, y) in the window. */
    showNewMenu(kind: 'chat' | 'terminal', x: number, y: number): void;
    send(ids: string[], text: string): void;
    /** The end of a background command's output; null when it can't be read. */
    backgroundOutput(id: string, taskId: string): Promise<string | null>;
    /** A thumbnail of an image file the agent read or wrote (a path in the session's own form); null for any other file. */
    fileThumbnail(taskId: string, path: string): Promise<string | null>;
  };
  /** A project's git repository, read-only, for the Git tabs. */
  git: {
    /** The projects whose folder is in a git repository; changes come as git-repos events. */
    repos(): Promise<string[]>;
    /** Check one project again (its folder may have become a repository). */
    check(projectId: string): Promise<boolean>;
    status(projectId: string): Promise<GitStatusResult>;
    /** An uncommitted file's change against HEAD (`initial`: the branch has no commits yet). */
    changeDiff(projectId: string, change: Pick<GitChange, 'path' | 'origPath' | 'kind'>, initial: boolean): Promise<GitFileDiff>;
    log(projectId: string, skip: number, limit: number): Promise<GitCommit[]>;
    commit(projectId: string, hash: string): Promise<GitCommitDetail>;
    commitDiff(projectId: string, hash: string, path: string, origPath?: string): Promise<GitFileDiff>;
    /** A file's right-click menu: Open File, Show in Folder, Copy Path. */
    showFileMenu(info: { projectId: string; root: string; path: string; exists: boolean }): void;
    /** A commit's right-click menu: Copy Commit ID, Copy Subject. */
    showCommitMenu(info: { hash: string; subject: string }): void;
  };
  /** One of Looper's attachment copies: open it in its default app, or get a thumbnail of an image. */
  attachment: {
    open(path: string): Promise<void>;
    thumbnail(path: string): Promise<string | null>;
  };
  /** A Looper terminal window's session. */
  terminalSession: {
    /** Copy dropped or pasted files into the task's attachments; returns their paths as the terminal pastes them. */
    attachFiles(id: string, files: File[]): Promise<string>;
    /** The terminal's right-click menu: Copy, Paste, Attach Files…; the choice comes back as a ui event. */
    showContextMenu(id: string, hasSelection: boolean): void;
    /** The output so far and whether the session ended; null once it's closed. */
    output(id: string): Promise<{ data: string; ended: boolean } | null>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  /** Advanced → Remote Control: its conversations and its helper and project editors. */
  remote: {
    state(): Promise<RemoteState>;
    /** The conversation's last message; null before its first. */
    lastMessage(id: string): Promise<RemoteMessage | null>;
    /** An open conversation in a Looper terminal window, an ended one in its run window. */
    open(id: string): Promise<void>;
    /** A conversation's right-click menu: Open, Open in Browser, Copy Link, Restart, Stop. */
    showContextMenu(id: string): void;
    openHelperEditor(id: string, isNew?: boolean): Promise<void>;
    /** Fire-and-forget removal of a freshly created, never-saved helper. */
    discard(id: string): void;
  };
  /** Advanced → Remote Access: its status, paired devices and pairing codes. */
  remoteAccess: {
    state(): Promise<RemoteAccessState>;
    /** A new code (replacing the one before); rejects while Remote Access isn't on. */
    pairingCode(): Promise<PairingCode>;
    cancelPairing(): Promise<void>;
    /** Unpair it: its open connections close. */
    removeDevice(id: string): Promise<void>;
    renameDevice(id: string, name: string): Promise<void>;
    signOut(): Promise<void>;
    /** Tailscale's sign-in page, in the system browser. */
    openLogin(): Promise<void>;
    openPair(): Promise<void>;
    openRename(id: string): Promise<void>;
  };
  /** Continue-run window only: start a manual run that resumes the run's conversation with `guidance` as its whole prompt. */
  continueRun(taskId: string, runId: string, guidance: string): Promise<boolean>;
  /** Whether a run in flight takes guidance now: its agent is running on Claude Code or Codex. */
  canGuideRun(taskId: string, runId: string): Promise<boolean>;
  /** Send guidance to a run in flight; the agent gets it mid-run. Rejects with the reason when the run cannot take it. */
  sendGuidance(taskId: string, runId: string, text: string): Promise<void>;
  /** Open the task's working directory in the file manager (WSL paths cross via wslpath). */
  openTaskWorkFolder(taskId: string): Promise<void>;
  /** Open a run's window (its step records and conversation), or a subagent's conversation when agentId is set. */
  openMessages(taskId: string, runId: string, agentId?: string, label?: string): Promise<void>;
  /** Open a message row's image in a zoomable window. */
  openMessageImage(taskId: string, runId: string, rowId: string, agentId?: string, label?: string): Promise<void>;
  /** Open the task editor in its own window (no id = new task). */
  openEditor(taskId?: string): Promise<void>;
  /** Open the next-run guidance window for a task. */
  openNoteEditor(taskId: string): Promise<void>;
  /** Open the move-to-folder window for a task. */
  openMoveToFolder(taskId: string): Promise<void>;

  /** Open the environment editor in its own window (isNew: discard the environment when closed unsaved). */
  openEnvironmentEditor(envId: string, isNew?: boolean): Promise<void>;
  /** Open the harness editor in its own window (isNew: discard the harness when closed unsaved). */
  openHarnessEditor(envId: string, harnessId: string, isNew?: boolean): Promise<void>;
  /** Open the model editor for a harness's preset list (no index = add a new model). */
  openModelEditor(envId: string, harnessId: string, index?: number): Promise<void>;
  /** Open the Update Models window (no ids = every claude-code/codex harness). */
  openModelUpdate(envId?: string, harnessId?: string): Promise<void>;
  /** Query a harness's CLI/API for its current model catalog. */
  discoverModels(envId: string, harnessId: string): Promise<DiscoveredModel[]>;
  /** Open the template editor (no id = new template). */
  openTemplateEditor(templateId?: string): Promise<void>;
  /** Open the template picker, then the task editor prefilled with the chosen template. */
  openTemplatePicker(): Promise<void>;
  /** Open the task editor prefilled from a template. */
  openEditorFromTemplate(templateId: string): Promise<void>;
  /** Take (once) the raw JSON behind an import editor window; null when already consumed. */
  importDraft(key: string): Promise<unknown>;
  /** Fire-and-forget removal of a freshly created, never-saved environment/harness. */
  discardEnvironment(envId: string): void;
  discardHarness(envId: string, harnessId: string): void;
  /**
   * Native directory picker. Returns the chosen directory in the environment's
   * native path form (flavor + distro decide the translation), or null when
   * cancelled.
   */
  pickDirectory(opts: { current?: string; flavor?: 'posix' | 'windows'; distro?: string }): Promise<string | null>;
  /** Installed WSL distro names; empty when wsl.exe is unavailable. */
  listWslDistros(): Promise<string[]>;
  /** Detected Windows-drive mount root of a distro (no distro = default/host distro). */
  detectWslMountPrefix(distro?: string): Promise<string | undefined>;
  /** Move the current tasks/templates store file to a new path. Call before updateSettings. */
  moveStoreFile(store: 'tasks' | 'templates', targetFile: string): Promise<void>;
  /** Native file-save dialog. Returns the chosen path, or null when cancelled. */
  pickSaveFile(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  /** Validate, persist and apply a global settings patch; returns the effective settings. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Whether looper is registered to start with the computer (OS login item). */
  getStartWithSystem(): Promise<boolean>;
  /** Register/unregister looper as an OS login item (starts hidden in the tray). */
  setStartWithSystem(enabled: boolean): Promise<void>;
  /** Show a native error dialog (OK button only). */
  showError(message: string): Promise<void>;
  /** Show a native confirmation dialog; resolves true when the user clicks Yes/OK. */
  confirm(message: string): Promise<boolean>;
  /** Tell the main process whether a task is currently selected (enables/disables the Task menu). */
  reportSelection(
    hasTask: boolean,
    taskEnabled?: boolean,
    taskPaused?: boolean,
    taskState?: string,
    hasNote?: boolean,
    canRunNow?: boolean,
    taskCompleted?: boolean,
    /** The task's "Allow this task to be marked completed" option. */
    allowComplete?: boolean,
  ): void;
  showTaskContextMenu(info: {
    enabled: boolean;
    /** The task is finished for good: the menu offers Reopen instead of Complete. */
    completed: boolean;
    /** The task's "Allow this task to be marked completed" option. */
    allowComplete: boolean;
    state?: string;
    held: boolean;
    hasNote: boolean;
    /** Runs in flight and the task's cap: Run Now stays enabled below it. */
    activeRuns?: number;
    maxRuns?: number;
  }): void;
  /** Context menu of a task-list folder header. */
  showFolderContextMenu(info: { folderId: string }): void;
  /** Context menu of a Recycle Bin item (Restore, Delete). */
  showRecycleBinContextMenu(): void;
  /** Context menu of a Version History item (View, Compare with Current, then Restore or, with Edit Task with Agent open on the task, Edit with Agent). */
  showVersionContextMenu(info: { builder: boolean }): void;
  /** Context menu of the task list's empty space (New Folder…). */
  showTasksEmptyContextMenu(): void;
  /** Context menu of a task list's header: that pane's view options (no pane = the single list's), then New Folder…. */
  showPaneContextMenu(info: { pane?: PaneId }): void;
  showRunContextMenu(info: { taskId: string; runId: string; details: string }): void;
  showMessageContextMenu(info: { taskId: string; runId: string; agentId?: string; file?: string; text?: string; label?: string }): void;
  /** Report the conversation window's current filter text (drives the Filter… checkmark and the filter window's initial value). */
  reportMessagesFilter(filter: string): void;
  /** Filter window only: apply this filter to the parent conversation window and close. */
  applyMessagesFilter(value: string): void;
  /** Export-options window only: confirm the Save-as-Markdown choice and close. */
  applyMarkdownExport(opts: { includeThinking: boolean; includeTools: boolean; plain: boolean }): void;
  /** Run-options window only: start the manual run with these steps (true = run the step) and close. */
  applyRunOptions(opts: { check: boolean; classifier: boolean; agent: boolean }): void;
  /** Installed addons and their screens (docs/addons.md). */
  addons: {
    list(): Promise<AddonInfo[]>;
    /** A pane's items; rejects with the reason when the addon can't give them. */
    pane(id: string, pane: string): Promise<AddonPaneContent>;
    render(id: string, view: string, params: Record<string, unknown>): Promise<AddonScreen>;
    /** Log a screen that took `ms` from being asked for to being drawn. */
    reportSlowDraw(id: string, view: string, ms: number): void;
    /**
     * Send an event and carry out the actions it answers with (an error the
     * addon reports shows in a dialog). `confirm` is asked first. Returns a
     * revealed secret and new field values; a copied secret never comes back.
     */
    event(
      id: string,
      ev: AddonEvent,
      confirm?: string,
    ): Promise<{ value?: string; values?: Record<string, string | number | boolean> }>;
    restart(id: string): Promise<void>;
    /** Open the Edit Addon window, over the calling window. */
    edit(id: string): Promise<void>;
    /** Change how the addon runs and restart it; null goes back to its own file's settings and the default environment. Rejects with the reason when `run` isn't valid. */
    setRun(id: string, run: AddonLocalRun | null): Promise<void>;
    /** A file field's Browse…: the picked file's path as the addon sees it (WSL or Windows), or null. */
    pickFile(id: string, accept?: { label: string; extensions: string[] }[]): Promise<string | null>;
    /** Start (true) or stop (false) an addon; Looper remembers it, and a stopped addon's windows close. */
    setEnabled(id: string, enabled: boolean): Promise<void>;
    /** The main toolbar's right-click menu: a check box per addon for whether its buttons show. */
    showToolbarMenu(): void;
    /** One of the addon's Tools windows, or the open one brought forward. */
    openTool(id: string, toolId: string): Promise<void>;
    /** Asks first. */
    remove(id: string): Promise<void>;
    /** Pick a .looperaddon file, then confirm and install it. */
    install(): Promise<void>;
    /** A pane item's or pane header's right-click menu; a pick goes to the addon. */
    showMenu(id: string, pane: string, menu: AddonMenuItem[], opts: { item?: string; header?: boolean }): void;
    /** This window's menu bar (null: none). `item`: the selected pane item and its menu, for `needsItem` items (commandOn) and the events. */
    setMenuBar(id: string, source: AddonEventSource, menuBar: AddonMenuBar | null, item?: { id: string; menu?: AddonMenuItem[] }): void;
    onEvent(cb: (e: AddonUiEvent) => void): () => void;
  };
  onEvent(cb: (e: EngineEvent) => void): () => void;
  /** UI commands pushed from the application menu. */
  onUi(cb: (e: UiEvent) => void): () => void;
}

export type UiEvent =
  | {
      type:
        | 'run-now'
        | 'stop-task'
        | 'pause-resume'
        | 'edit-task'
        | 'edit-note'
        | 'clear-note'
        | 'move-to-folder'
        | 'export-task'
        | 'delete-task'
        | 'enable-disable'
        | 'complete-reopen'
        | 'open-terminal'
        | 'open-chat'
        | 'open-work-folder'
        /** Main toolbar: a new task, in the selected project or the selected task's project. */
        | 'new-task'
        /** Chat window: Edit → Find…. */
        | 'chat-find'
        | 'clear-runs'
        | 'edit-with-agent'
        | 'version-history'
        /** Main window: clear the task selection, which shows the dashboard. */
        | 'show-dashboard'
        /** Recycle Bin window: act on the selected item. */
        | 'bin-restore'
        | 'bin-delete'
        /** Version History window: act on the selected version. */
        | 'version-view'
        | 'version-compare'
        | 'version-restore';
    }
  /** A notification was clicked: select the task and show the right view. */
  | { type: 'open-task'; taskId: string; runId: string; view: 'terminal' | 'runs' }
  /** Conversation window View menu: a Show toggle changed. */
  | { type: 'messages-show'; key: MessagesShowKey; checked: boolean }
  /** Conversation window View menu: the Raw Messages toggle changed. */
  | { type: 'messages-raw'; checked: boolean }
  /** Run window View menu: the Raw Agent Output toggle changed. */
  | { type: 'messages-raw-output'; checked: boolean }
  /** Conversation window View menu: the Auto Scroll toggle changed. */
  | { type: 'messages-auto-scroll'; checked: boolean }
  /** The filter window applied a filter (empty = cleared). */
  | { type: 'messages-filter'; value: string }
  /** Engine Log window View menu: the sources (engineLogSource keys) and levels it hides. */
  | { type: 'engine-log-view'; hiddenSources: string[]; hiddenLevels: EngineLogLevel[] }
  /** Terminal window right-click menu: copy the selection, paste the clipboard. */
  | { type: 'terminal-copy' | 'terminal-paste' }
  /** Terminal window: Attach Files… copied the files; paste their paths. */
  | { type: 'terminal-attached'; text: string }
  /** Chat window: File → Attach Files… copied the files; they wait to be sent. */
  | { type: 'chat-attached'; attachments: Attachment[] }
  /** Chat window: Edit as New Message put a sent message back in the message box. */
  | { type: 'chat-edit'; text: string; attachments: Attachment[] }
  /** Sessions window: show this session (a chat or terminal opened elsewhere). */
  | { type: 'sessions-select'; id: string }
  /** Sessions window View menu: the next or previous session, or waiting session. */
  | { type: 'sessions-nav'; dir: 1 | -1; waiting: boolean }
  /** Sessions window View menu: show the dashboard. */
  | { type: 'sessions-dashboard' }
  /** Sessions window View menu: move the focus to the next or previous pane (list, conversation, activity pane). */
  | { type: 'sessions-pane'; dir: 1 | -1 };

/** run: the run's own step records (check, classifier, agent, result, guidance). */
export type MessagesShowKey = 'run' | 'messages' | 'thinking' | 'tools' | 'subagents';
