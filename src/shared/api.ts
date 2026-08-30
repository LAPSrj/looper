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
  onEvent(cb: (e: EngineEvent) => void): () => void;
}
