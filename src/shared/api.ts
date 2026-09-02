import type { EngineEvent, RunRecord, Settings, Task, TaskRuntime, Template } from './types';

export interface AppInfo {
  version: string;
  dataDir: string;
  inboxDir: string;
  host: string;
  settings: Settings;
}

/** The API the preload script exposes to the renderer as `window.looper`. */
export interface LooperApi {
  info(): Promise<AppInfo>;
  tasks: {
    list(): Promise<Task[]>;
    save(input: unknown): Promise<Task>;
    remove(id: string): Promise<boolean>;
    /** Native save dialog, then write the task as JSON (store timestamps stripped). */
    export(id: string): Promise<void>;
  };
  templates: {
    list(): Promise<Template[]>;
    save(input: unknown): Promise<Template>;
    remove(id: string): Promise<boolean>;
  };
  runtime: {
    list(): Promise<TaskRuntime[]>;
    runNow(id: string): Promise<boolean>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    stopAgent(id: string): Promise<boolean>;
  };
  runs: {
    list(id: string, limit?: number): Promise<RunRecord[]>;
    output(id: string, runId: string, raw?: boolean): Promise<string>;
    openDir(id: string, runId: string): Promise<void>;
    /** Delete a task's run history. Rejects while the task is mid-cycle. */
    clear(id: string): Promise<void>;
  };
  agent: {
    buffer(id: string): Promise<{ runId: string; data: string } | null>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  openPath(p: string): Promise<void>;
  /** Open the task's harness in a terminal window (same env/cwd/model/args, no prompt). */
  openTaskTerminal(taskId: string): Promise<void>;
  /** Open the task's working directory in the file manager (WSL paths cross via wslpath). */
  openTaskWorkFolder(taskId: string): Promise<void>;
  /** Open the run detail window showing all step records for a run. */
  openRunDetail(taskId: string, runId: string): Promise<void>;
  /** Open the task editor in its own window (no id = new task). */
  openEditor(taskId?: string): Promise<void>;
  /** Open the next-run guidance window for a task. */
  openNoteEditor(taskId: string): Promise<void>;

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
  reportSelection(hasTask: boolean, taskEnabled?: boolean, taskPaused?: boolean, taskState?: string, hasNote?: boolean): void;
  showTaskContextMenu(info: { enabled: boolean; state?: string; held: boolean; hasNote: boolean }): void;
  showRunContextMenu(info: { taskId: string; runId: string; details: string }): void;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  /** UI commands pushed from the application menu. */
  onUi(cb: (e: UiEvent) => void): () => void;
}

export interface UiEvent {
  type:
    | 'run-now'
    | 'stop-agent'
    | 'pause-resume'
    | 'edit-task'
    | 'edit-note'
    | 'clear-note'
    | 'export-task'
    | 'delete-task'
    | 'enable-disable'
    | 'open-terminal'
    | 'open-work-folder'
    | 'clear-runs'
    | 'toggle-raw-output';
}
