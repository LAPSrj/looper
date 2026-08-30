import path from 'node:path';
import type { EngineEvent, InboxCommand, RunRecord, Settings, Task, TaskRuntime } from '../shared/types';
import { SettingsSchema } from '../shared/types';
import { detectHost, type HostKind } from './host';
import { Inbox } from './inbox';
import { Logger, errMsg } from './log';
import { Scheduler, type SchedulerSteps } from './scheduler';
import { ensureDir } from './store/fsutil';
import { RunStore } from './store/runs';
import { loadSettings, saveSettings } from './store/settings';
import { StateStore } from './store/state';
import { TaskStore } from './store/tasks';

export interface EngineOptions {
  dataDir: string;
  /** Echo log lines to stdout/stderr (CLI serve mode). */
  echoLog?: boolean;
  steps?: Partial<SchedulerSteps>;
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
  on(listener: (e: EngineEvent) => void): () => void;
  // tasks
  listTasks(): Task[];
  getTask(id: string): Task | undefined;
  saveTask(input: unknown): Task;
  removeTask(id: string): boolean;
  // runtime
  listRuntimes(): TaskRuntime[];
  runNow(id: string): boolean;
  pause(id: string, reason?: string): void;
  resume(id: string): void;
  stopAgent(id: string, reason?: string): Promise<boolean>;
  writeAgent(id: string, data: string): void;
  resizeAgent(id: string, cols: number, rows: number): void;
  agentBuffer(id: string): { runId: string; data: string } | null;
  // history
  listRuns(id: string, limit?: number): RunRecord[];
  readOutput(id: string, runId: string, maxBytes?: number): string;
  runDir(id: string, runId: string): string;
  inboxDir(): string;
}

export function createEngine(opts: EngineOptions): Engine {
  const dataDir = opts.dataDir;
  ensureDir(dataDir);
  const host = detectHost();
  const settings = loadSettings(dataDir);
  const log = new Logger(path.join(dataDir, 'engine.log'), opts.echoLog ?? false);
  const tasks = new TaskStore(path.join(dataDir, 'tasks.json'));
  const runs = new RunStore(dataDir);
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
  log.onLine((line) => emit({ type: 'log', line }));

  tasks.on('invalid', (raw: unknown, errors: string[]) => {
    const id = (raw as { id?: string })?.id ?? '?';
    log.error(`tasks.json: skipping invalid task ${id}: ${errors.join('; ')}`);
  });

  const scheduler = new Scheduler({ dataDir, host, settings, tasks, runs, state, log, steps: opts.steps });
  scheduler.on('event', emit);

  const inbox = new Inbox(
    path.join(dataDir, 'inbox'),
    settings.inboxPollMs,
    {
      onTask: (input) => tasks.upsert(input),
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
            await scheduler.stopAgent(cmd.taskId, cmd.reason);
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
      tasks.load();
      scheduler.start();
      inbox.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      inbox.stop();
      await scheduler.stop();
      log.info('looper engine stopped');
      log.close();
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    updateSettings(patch: unknown): Settings {
      const merged = { ...settings, ...(patch as Record<string, unknown>) };
      // Empty strings mean "unset" for optional fields.
      if (merged.defaultDistro === '') delete merged.defaultDistro;
      const parsed = SettingsSchema.parse(merged);
      saveSettings(dataDir, parsed);
      // The settings object is shared by reference across the engine: swap its contents in place.
      for (const key of Object.keys(settings)) delete (settings as Record<string, unknown>)[key];
      Object.assign(settings, parsed);
      log.info('settings updated');
      return { ...settings };
    },
    listTasks: () => tasks.list(),
    getTask: (id) => tasks.get(id),
    saveTask: (input) => tasks.upsert(input),
    removeTask: (id) => tasks.remove(id),
    listRuntimes: () => scheduler.list(),
    runNow: (id) => scheduler.runNow(id),
    pause: (id, reason) => scheduler.pause(id, reason),
    resume: (id) => scheduler.resume(id),
    stopAgent: (id, reason) => scheduler.stopAgent(id, reason),
    writeAgent: (id, data) => scheduler.writeAgent(id, data),
    resizeAgent: (id, c, r) => scheduler.resizeAgent(id, c, r),
    agentBuffer: (id) => scheduler.getBuffer(id),
    listRuns: (id, limit) => runs.list(id, limit),
    readOutput: (id, runId, max) => runs.readOutput(id, runId, max),
    runDir: (id, runId) => runs.runDir(id, runId),
    inboxDir: () => path.join(dataDir, 'inbox'),
  };
}
