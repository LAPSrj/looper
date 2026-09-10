import fs from 'node:fs';
import path from 'node:path';
import type { MessageImage, MessagesResult } from '../shared/messages';
import type { EngineEvent, InboxCommand, RestState, RunRecord, Settings, Task, TaskFolder, TaskRuntime } from '../shared/types';
import { SettingsSchema } from '../shared/types';
import { detectHost, detectWslMountPrefix, type HostKind } from './host';
import { setDetectedMountPrefix } from './target';
import { Inbox } from './inbox';
import { Logger, errMsg } from './log';
import { MessagesService } from './messages';
import { openTaskTerminal } from './open-terminal';
import { createWindowsPowerOps } from './power-win';
import { RestController, type PowerAdapter, type PowerOps } from './rest';
import { Scheduler, type SchedulerSteps } from './scheduler';
import { ensureDir } from './store/fsutil';
import { RunStore } from './store/runs';
import { loadSettings, saveSettings } from './store/settings';
import { StateStore } from './store/state';
import { TaskStore } from './store/tasks';
import { TemplateStore } from './store/templates';

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
  saveTask(input: unknown): Task;
  removeTask(id: string): boolean;
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
  runNow(id: string): boolean;
  pause(id: string, reason?: string): void;
  resume(id: string): void;
  /**
   * Stop a cycle wherever it is (check, classifier or agent). Without a run id
   * the task's newest run in flight is stopped; so do write/resize/buffer.
   */
  stopTask(id: string, reason?: string, runId?: string): Promise<boolean>;
  writeAgent(id: string, data: string, runId?: string): void;
  resizeAgent(id: string, cols: number, rows: number, runId?: string): void;
  agentBuffer(id: string, runId?: string): { runId: string; data: string } | null;
  /** Open the task's harness in a terminal window (same env/cwd/model/args, no prompt). */
  openTaskTerminal(id: string): Promise<void>;
  // rest mode
  /** Throws when Rest Mode is unavailable (non-Windows host, or no power adapter). */
  armRest(): void;
  disarmRest(): void;
  restState(): RestState;
  // history
  listRuns(id: string, limit?: number): RunRecord[];
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
  const tasks = new TaskStore(storeFile('tasks'), () => settings.environments, host);
  const templates = new TemplateStore(storeFile('templates'));
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
  tasks.on('invalid', (raw: unknown, errors: string[]) => {
    const id = (raw as { id?: string })?.id ?? '?';
    log.error(`tasks.json: skipping invalid task ${id}: ${errors.join('; ')}`);
  });

  /** Detect the automount root of bridge environments without an explicit mount prefix. */
  const warmMountPrefixes = () => {
    for (const env of settings.environments) {
      if (env.kind === 'local' || env.mountPrefix) continue;
      const distro = env.kind === 'wsl' ? env.distro : undefined;
      void detectWslMountPrefix(distro).then((prefix) => {
        if (prefix) setDetectedMountPrefix(distro, prefix);
      });
    }
  };

  const messages = new MessagesService({
    getTask: (id) => tasks.get(id),
    runDir: (taskId, runId) => runs.runDir(taskId, runId),
    host,
    settings,
    log,
  });

  const scheduler = new Scheduler({ dataDir, host, settings, tasks, runs, state, log, steps: opts.steps });

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

  // Run-log retention: delete records and run folders past their age limit,
  // sparing whatever runs are currently in progress.
  const RETENTION_SWEEP_MS = 60 * 60 * 1000;
  let retentionTimer: NodeJS.Timeout | null = null;
  const sweepRunLogs = () => {
    const cutoffMs = Date.now() - settings.runRetentionDays * 24 * 60 * 60 * 1000;
    for (const taskId of runs.listTaskIds()) {
      try {
        const active = new Set(scheduler.get(taskId)?.runs.map((r) => r.runId) ?? []);
        const { records, dirs } = runs.pruneOlderThan(taskId, cutoffMs, active);
        if (records || dirs) {
          log.info(`${taskId}: pruned ${records} run records and ${dirs} run folders older than ${settings.runRetentionDays} days`);
        }
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
      tasks.load();
      templates.load();
      tasks.on('reorder', () => emit({ type: 'tasks', tasks: tasks.list() }));
      tasks.on('folders', () => emit({ type: 'folders', folders: tasks.listFolders(), layout: tasks.listLayout() }));
      templates.on('change', () => emit({ type: 'templates', templates: templates.list() }));
      scheduler.start();
      inbox.start();
      rest?.init();
      sweepRunLogs();
      retentionTimer = setInterval(sweepRunLogs, RETENTION_SWEEP_MS);
    },
    async stop() {
      if (!started) return;
      started = false;
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
      inbox.stop();
      rest?.dispose();
      await scheduler.stop();
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
        emit({ type: 'folders', folders: tasks.listFolders(), layout: tasks.listLayout() });
      }
      if (parsed.templatesFile !== oldTemplatesFile) emit({ type: 'templates', templates: templates.list() });
      return { ...settings };
    },
    listTasks: () => tasks.list(),
    getTask: (id) => tasks.get(id),
    saveTask: (input) => tasks.upsert(input),
    removeTask: (id) => tasks.remove(id),
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
    runNow: (id) => scheduler.runNow(id),
    pause: (id, reason) => scheduler.pause(id, reason),
    resume: (id) => scheduler.resume(id),
    stopTask: (id, reason, runId) => scheduler.stopTask(id, reason, runId),
    writeAgent: (id, data, runId) => scheduler.writeAgent(id, data, runId),
    resizeAgent: (id, c, r, runId) => scheduler.resizeAgent(id, c, r, runId),
    agentBuffer: (id, runId) => scheduler.getBuffer(id, runId),
    openTaskTerminal(id: string): Promise<void> {
      const task = tasks.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      return openTaskTerminal(task, { host, settings, taskDir: runs.taskDir(id), log });
    },
    armRest(): void {
      if (!rest) throw new Error('Rest Mode is only available in the Looper app on Windows.');
      rest.arm();
    },
    disarmRest: () => rest?.disarm(),
    restState: () => rest?.state() ?? { armed: false, phase: 'off', sleepAt: null, wakeAt: null },
    listRuns: (id, limit) => runs.list(id, limit),
    readOutput: (id, runId, max, raw) => runs.readOutput(id, runId, max, raw),
    readMessages: (id, runId, agentId, raw) => messages.read(id, runId, agentId, raw),
    readMessageImage: (id, runId, rowId, agentId) => messages.readImage(id, runId, rowId, agentId),
    clearRuns(id: string): void {
      const rt = scheduler.get(id);
      if (rt && rt.runs.length > 0) {
        throw new Error(`The task is ${rt.state}; wait for the run to end or stop the task first.`);
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
