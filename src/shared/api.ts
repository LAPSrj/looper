import type { MessageImage, MessagesResult } from './messages';
import type { EngineEvent, RestState, RunRecord, Settings, Task, TaskFolder, TaskRuntime, Template } from './types';

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
    save(input: unknown): Promise<Task>;
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
  /** Open the task's harness in a terminal window (same env/cwd/model/args, no prompt). */
  openTaskTerminal(taskId: string): Promise<void>;
  /** Open the task's working directory in the file manager (WSL paths cross via wslpath). */
  openTaskWorkFolder(taskId: string): Promise<void>;
  /** Open the run detail window showing all step records for a run. */
  openRunDetail(taskId: string, runId: string): Promise<void>;
  /** Open a conversation window: a run's messages, or a subagent's when agentId is set. */
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
  /** Context menu of the task list's empty space / "Tasks" title (New Folder…). */
  showTasksEmptyContextMenu(): void;
  showRunContextMenu(info: { taskId: string; runId: string; details: string }): void;
  showMessageContextMenu(info: { taskId: string; runId: string; agentId?: string; file?: string; text?: string; label?: string }): void;
  /** Report the conversation window's current filter text (drives the Filter… checkmark and the filter window's initial value). */
  reportMessagesFilter(filter: string): void;
  /** Filter window only: apply this filter to the parent conversation window and close. */
  applyMessagesFilter(value: string): void;
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
        | 'open-work-folder'
        | 'clear-runs'
        | 'toggle-raw-output';
    }
  /** A notification was clicked: select the task and show the right view. */
  | { type: 'open-task'; taskId: string; runId: string; view: 'terminal' | 'log' }
  /** Conversation window View menu: a Show toggle changed. */
  | { type: 'messages-show'; key: MessagesShowKey; checked: boolean }
  /** Conversation window View menu: the Raw Messages toggle changed. */
  | { type: 'messages-raw'; checked: boolean }
  /** The filter window applied a filter (empty = cleared). */
  | { type: 'messages-filter'; value: string };

export type MessagesShowKey = 'messages' | 'thinking' | 'tools' | 'subagents';
