import type { EngineEvent, RunRecord, Settings, Task, TaskInput, TaskRuntime } from './types';

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
    example(): Promise<TaskInput>;
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
    output(id: string, runId: string): Promise<string>;
    openDir(id: string, runId: string): Promise<void>;
  };
  agent: {
    buffer(id: string): Promise<{ runId: string; data: string } | null>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
  };
  openPath(p: string): Promise<void>;
  /** Open the task editor in its own window (no id = new task). */
  openEditor(taskId?: string): Promise<void>;
  /** Validate, persist and apply a global settings patch; returns the effective settings. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  onEvent(cb: (e: EngineEvent) => void): () => void;
  /** UI commands pushed from the application menu. */
  onUi(cb: (e: UiEvent) => void): () => void;
}

export interface UiEvent {
  type:
    | 'toggle-log'
    | 'run-now'
    | 'stop-agent'
    | 'pause-resume'
    | 'edit-task'
    | 'delete-task';
}
