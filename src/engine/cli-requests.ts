import path from 'node:path';
import { draftName, type BuilderState } from '../shared/builder';
import type { AttachmentInput, ChatSettings, ChatState } from '../shared/chat';
import { allows, levelProblem, type CliLevel } from '../shared/cli-levels';
import { attentionKey, attentionRows } from '../shared/dashboard';
import { newEnvironment, newHarness, withoutEnvironment, withoutHarness } from '../shared/environments';
import { guidanceNote } from '../shared/guidance';
import { folderName } from '../shared/projects';
import type { MessageRow } from '../shared/messages';
import type { Environment, Harness, PreventSleepTimer, Settings, TaskFolder } from '../shared/types';
import { slugify } from '../shared/validate';
import { discoverHarnessModels } from './discover-models';
import type { Engine } from './engine';

/** A `looper` command the running app answers: the params the CLI sent, and what it prints. */
export type RequestHandler = (params: Record<string, unknown>) => unknown;

type Params = Record<string, unknown>;

/** What `looper transcript` and `looper history show` get: the conversation's rows under a title. */
export interface Transcript {
  title: string;
  rows: MessageRow[];
}

export const text = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} must be given`);
  return v;
};

export const optText = (p: Params, key: string): string | undefined => {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be text`);
  return v;
};

export const flag = (p: Params, key: string): boolean => {
  const v = p[key];
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw new Error(`${key} must be true or false`);
  return v;
};

const whole = (p: Params, key: string, fallback?: number): number => {
  const v = p[key] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${key} must be a whole number`);
  return v;
};

/** An id that goes into a path: no folder separators, and not "." or "..". */
const safeId = (p: Params, key: string): string => {
  const v = text(p, key);
  if (!/^[\w.@-]+$/.test(v) || v === '.' || v === '..') throw new Error(`${key} isn't an id: ${v}`);
  return v;
};

const fileInputs = (p: Params): AttachmentInput[] => {
  const v = p.files;
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('files must be a list');
  return v.map((f: { name?: unknown; data?: unknown }) => {
    if (typeof f?.name !== 'string' || typeof f.data !== 'string') throw new Error('each file must have a name and its data in base64');
    return { name: path.basename(f.name), data: Uint8Array.from(Buffer.from(f.data, 'base64')) };
  });
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type Live =
  | { kind: 'chat'; id: string; taskId: string; title: string; chat: ChatState }
  | { kind: 'terminal'; id: string; taskId: string; title: string }
  | { kind: 'run'; id: string; taskId: string; title: string };

export const named = (t: Live) => `${t.kind === 'terminal' ? 'terminal session' : t.kind} "${t.title}"`;

/** An open chat or terminal session, or a task run in progress; a compacted chat's id is the chat it went on in. */
export function liveOf(engine: Engine, asked: string): Live | undefined {
  const id = engine.liveSessionId(asked);
  const listed = engine.sessionsState().sessions.find((s) => s.id === id);
  const chat = engine.getChat(id);
  if (chat) return { kind: 'chat', id, taskId: chat.taskId, title: chat.title ?? listed?.title ?? chat.taskName, chat };
  if (engine.sessionKind(id) === 'terminal') return { kind: 'terminal', id, taskId: listed?.taskId ?? '', title: listed?.title ?? id };
  const rt = engine.listRuntimes().find((r) => [...r.runs, ...r.children].some((x) => x.runId === id));
  if (rt) return { kind: 'run', id, taskId: rt.taskId, title: listed?.title ?? engine.taskName(rt.taskId) ?? rt.taskId };
  return undefined;
}

/** The task a run, chat or terminal session belongs to, open or finished. */
export async function runTaskOf(engine: Engine, runId: string): Promise<string> {
  const taskId = await engine.taskOfRun(runId);
  if (!taskId) throw new Error(`No run has the id ${runId}.`);
  return taskId;
}

const builderNamed = (b: BuilderState) => (draftName(b) ? `task builder of "${draftName(b)}"` : 'task builder');

function mustBuilder(engine: Engine, id: string): BuilderState {
  const b = engine.getBuilder(id);
  if (!b) throw new Error(`No open task builder has the id ${id}.`);
  return b;
}

/**
 * `looper build start`: Edit with Agent on a task (the builder already open on
 * it, if any), or New Task with Agent in a project's folder, environment and
 * agent settings; the description is its first message. `edit`: it edits a task.
 */
export function startBuild(engine: Engine, p: Params): { id: string; edit: boolean; message: string } {
  const description = text(p, 'description');
  const taskId = optText(p, 'taskId');
  const projectId = optText(p, 'projectId');
  if (!taskId === !projectId) throw new Error('give the task to edit or the project to build a new task in');
  let id: string;
  let started = true;
  if (taskId) {
    if (!engine.getTask(taskId)) throw new Error(`No task has the id ${taskId}.`);
    const open = engine.builderForTask(taskId);
    started = !open;
    id = open ?? engine.startBuilder({ ...engine.builderSetupFor(taskId), view: 'chat' }).id;
  } else {
    const project = engine.getProject(projectId!);
    if (!project) throw new Error(`No project has the id ${projectId}.`);
    const env = engine.settings.environments.find((x) => x.id === project.environmentId);
    const harnessId = project.harnessId ?? env?.harnesses[0]?.id;
    if (!env || !harnessId) throw new Error(`The environment of "${project.name}" has no harness.`);
    const { model, effort } = project;
    id = engine.startBuilder({ environmentId: env.id, harnessId, cwd: project.cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}), view: 'chat' }).id;
  }
  if (engine.getBuilder(id)?.status === 'ended') throw new Error(`The task builder ${id} has ended: ${engine.getBuilder(id)?.error ?? 'its agent stopped'}.`);
  engine.sendBuilder(id, description);
  return { id, edit: !!taskId, message: `${id}\n${started ? 'Started the task builder and sent it the description.' : 'Sent the description to the task builder already open on the task.'}` };
}

/** `looper build close`: refused while the builder has changes that aren't saved, unless `discard` drops them (Don't Save). */
export async function closeBuild(engine: Engine, p: Params): Promise<string> {
  const b = mustBuilder(engine, text(p, 'id'));
  if (await engine.builderUnsaved(b.id)) {
    if (!flag(p, 'discard')) throw new Error(`The ${builderNamed(b)} has changes that aren't saved. Save them with looper build save ${b.id}, or close it with --discard, which also puts back the files it changed.`);
    await engine.discardBuilder(b.id);
  }
  await engine.closeBuilder(b.id);
  return `Closed the ${builderNamed(b)}.`;
}

const PROJECT_FIELDS = new Set(['name', 'cwd', 'environmentId', 'harnessId', 'model', 'effort', 'permissionMode', 'mode', 'remote', 'folderId']);

/** The commands `looper` sends the running app, by method. */
export function cliRequests(engine: Engine): Record<string, RequestHandler> {
  const live = (id: string) => liveOf(engine, id);
  /** Refuse a command's option that needs more than the method itself (Settings → Advanced → Command-line tool). */
  const need = (level: CliLevel) => {
    if (!allows(engine.settings.cliCommands, level)) throw new Error(levelProblem(level, engine.settings.cliCommands));
  };
  const object = (p: Params, key: string): Record<string, unknown> => {
    const v = p[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key} must be an object`);
    return v as Record<string, unknown>;
  };
  const environment = (id: string): Environment => {
    const env = engine.settings.environments.find((e) => e.id === id);
    if (!env) throw new Error(`No environment has the id ${id}.`);
    return env;
  };
  const setEnvironments = (patch: Partial<Settings>) => engine.updateSettings(patch);
  const mustLive = (id: string): Live => {
    const t = live(id);
    if (!t) throw new Error(`No open chat, terminal session or run in progress has the id ${id}.`);
    return t;
  };
  const mustChat = (id: string): Live & { kind: 'chat' } => {
    const t = live(id);
    if (t?.kind !== 'chat') throw new Error(`No open chat has the id ${id}.`);
    return t;
  };
  const mustTask = (id: string) => {
    const task = engine.getTask(id);
    if (!task) throw new Error(`No task has the id ${id}.`);
    return task;
  };
  const taskOfRun = (runId: string) => runTaskOf(engine, runId);
  /** A task folder (or a project folder) by its id, or by its name when only one has it. */
  const folderOf = (folders: TaskFolder[], idOrName: string): TaskFolder => {
    const byId = folders.find((f) => f.id === idOrName);
    if (byId) return byId;
    const byName = folders.filter((f) => f.name === idOrName);
    if (byName.length === 1) return byName[0];
    throw new Error(byName.length ? `${byName.length} folders are named "${idOrName}": give its id` : `No folder is named "${idOrName}".`);
  };
  const runOf = async (p: Params) => {
    const runId = safeId(p, 'id');
    return { runId, taskId: await taskOfRun(runId) };
  };

  return {
    // ---------- chats and sessions ----------

    sessions: () =>
      engine.sessionsState().sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        project: s.groupName,
        taskId: s.taskId,
        ...(s.projectId ? { projectId: s.projectId } : {}),
        status: s.stopped ? 'stopped' : s.status,
        ...(s.waiting ? { waiting: s.waiting.reason, waitingText: s.waiting.text } : {}),
        harness: s.harnessName,
        startedAt: new Date(s.startedAt).toISOString(),
      })),

    send: async (p) => {
      const ids = p.ids;
      if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x)) throw new Error('ids must list one or more chats, terminal sessions, runs or task builders');
      const body = optText(p, 'text') ?? '';
      const files = fileInputs(p);
      if (!body.trim() && !files.length) throw new Error('give a message or a file to send');
      // Every id is checked before anything is sent, so a typo doesn't leave the message sent to only some of them.
      const targets = (ids as string[]).map((id): Live | { kind: 'builder'; id: string; builder: BuilderState } => {
        const builder = engine.getBuilder(id);
        if (builder?.status === 'ended') throw new Error(`The ${builderNamed(builder)} has ended.`);
        return builder ? { kind: 'builder', id, builder } : mustLive(id);
      });
      const sent: string[] = [];
      for (const t of targets) {
        if (t.kind === 'builder') {
          // Its message box takes files as the paths it pastes, as its terminal does.
          engine.sendBuilder(t.id, [body, files.length ? await engine.attachToBuilder(t.id, files) : ''].filter(Boolean).join(' '));
          sent.push(`Sent to the ${builderNamed(t.builder)}.`);
          continue;
        }
        // The files and the message go as the conversation's message box sends them.
        const attachments = files.length ? await (t.kind === 'chat' ? engine.attachToChat(t.id, files) : engine.attachToRun(t.taskId, files)) : [];
        if (t.kind === 'run') engine.sendGuidance(t.taskId, t.id, body, attachments);
        else engine.sendToSessions([t.id], body, attachments);
        sent.push(`Sent to the ${named(t)}.`);
      }
      return sent.join('\n');
    },

    end: async (p) => {
      const id = text(p, 'id');
      const reason = optText(p, 'reason');
      const t = live(id);
      if (t?.kind === 'chat' || t?.kind === 'terminal') {
        await engine.closeSession(t.id);
        return `Closed the ${named(t)}.`;
      }
      if (t?.kind === 'run') {
        const taskName = engine.taskName(t.taskId) ?? t.taskId;
        if (!(await engine.stopTask(t.taskId, reason, id))) throw new Error(`The run ${id} of "${taskName}" has already ended.`);
        return `Stopped the run ${id} of "${taskName}".`;
      }
      const task = engine.getTask(id);
      if (task) {
        if (!(await engine.stopTask(id, reason))) throw new Error(`"${task.name}" has no run in progress.`);
        return `Stopped the run of "${task.name}".`;
      }
      throw new Error(`No open chat, terminal session, run or task has the id ${id}.`);
    },

    interrupt: async (p) => {
      const t = mustLive(text(p, 'id'));
      await engine.stopSession(t.id);
      return t.kind === 'run' ? `Stopped the ${named(t)}.` : `Stopped the turn of the ${named(t)}.`;
    },

    'send-now': async (p) => {
      const t = mustLive(text(p, 'id'));
      if (t.kind === 'chat') await engine.sendNowChat(t.id);
      else if (t.kind === 'run') await engine.sendNowRun(t.taskId, t.id);
      else throw new Error('A terminal session has no queue.');
      return `Sent what was waiting for the ${named(t)}.`;
    },

    queue: async (p) => {
      const t = mustLive(text(p, 'id'));
      const cancel = optText(p, 'cancel');
      if (t.kind === 'chat') {
        if (cancel !== undefined) {
          if (!engine.unqueueChat(t.id, cancel)) throw new Error(`The ${named(t)} has no queued message ${cancel}.`);
          return `Took back the message ${cancel}.`;
        }
        return t.chat.queued.filter((m) => !m.sent).map((m) => ({ id: m.id, text: m.text, files: m.attachments.map((a) => a.name) }));
      }
      if (t.kind === 'run') {
        if (cancel !== undefined) {
          if (!engine.unqueueGuidance(t.taskId, t.id)) throw new Error(`The ${named(t)} has no guidance waiting.`);
          return `Took back the guidance waiting for the ${named(t)}.`;
        }
        const pending = (await engine.readMessages(t.taskId, t.id)).pendingGuidance;
        return pending ? [{ id: 'guidance', text: pending, files: [] }] : [];
      }
      throw new Error('A terminal session has no queue.');
    },

    restart: async (p) => {
      const t = mustLive(text(p, 'id'));
      if (!engine.canRestartSession(t.id)) throw new Error(`The agent of the ${named(t)} can't be restarted.`);
      await engine.restartSession(t.id);
      return `Restarted the agent of the ${named(t)}.`;
    },

    rename: async (p) => {
      const t = mustLive(text(p, 'id'));
      if (t.kind === 'run') throw new Error("A task run is named after its task.");
      const name = optText(p, 'name') ?? '';
      await engine.renameSession(t.id, name);
      return name ? `Renamed the ${t.kind === 'chat' ? 'chat' : 'terminal session'} "${name}".` : `The ${named(t)} has its automatic name again.`;
    },

    configure: async (p) => {
      const t = mustChat(text(p, 'id'));
      const patch: Partial<ChatSettings> = {};
      const model = optText(p, 'model');
      const effort = optText(p, 'effort');
      if (model) patch.model = model;
      if (effort) patch.effort = effort;
      const autoCompact = optText(p, 'autoCompact');
      if (autoCompact !== undefined) {
        if (autoCompact !== 'on' && autoCompact !== 'off' && autoCompact !== 'default') throw new Error('auto compact is on, off or default');
        patch.autoCompact = autoCompact === 'default' ? undefined : autoCompact === 'on';
      }
      // These let an agent raise a chat's permissions, its own included.
      const permissionMode = optText(p, 'permissionMode');
      const harnessId = optText(p, 'harnessId');
      if (permissionMode !== undefined || harnessId) need('unrestricted');
      if (permissionMode !== undefined) patch.permissionMode = permissionMode;
      if (!Object.keys(patch).length && !harnessId) throw new Error('give a model, an effort, auto compact, a permission mode or a harness');
      if (harnessId) await engine.setChatHarness(t.id, harnessId);
      if (Object.keys(patch).length) await engine.configureChat(t.id, patch);
      const changed = [...Object.keys(patch).map((k) => (k === 'permissionMode' ? 'permission mode' : k === 'autoCompact' ? 'auto compact' : k)), ...(harnessId ? ['harness'] : [])];
      return `Set the ${changed.join(' and ')} of the ${named(t)}.`;
    },

    compact: async (p) => {
      const id = safeId(p, 'id');
      const chat = live(id);
      const next = chat?.kind === 'chat' ? await engine.compactChat(chat.id) : await engine.compactRun(await taskOfRun(id), id);
      return `${next.id}\nStarted a chat from the messages of ${chat ? named(chat) : `the run ${id}`}.`;
    },

    fork: (p) => {
      const t = mustChat(text(p, 'id'));
      const at = whole(p, 'at');
      const next = engine.forkChat(t.id, at);
      return `${next.id}\nStarted a chat from the ${named(t)} up to row ${at}.`;
    },

    'auto-continue': (p) => {
      const t = mustChat(text(p, 'id'));
      const on = flag(p, 'on');
      engine.setChatAutoContinue(t.id, on);
      return `The ${named(t)} ${on ? 'continues' : "doesn't continue"} when its usage limit resets.`;
    },

    mute: (p) => {
      const t = mustChat(text(p, 'id'));
      const on = flag(p, 'on');
      engine.setChatMuted(t.id, on);
      return `The ${named(t)} ${on ? 'sends no notifications' : 'sends notifications again'}.`;
    },

    'continue-anyway': (p) => {
      const t = mustChat(text(p, 'id'));
      engine.setChatContinueAnyway(t.id);
      return `The ${named(t)} continues even though its prompt cache has expired.`;
    },

    watch: (p) => {
      const t = mustChat(text(p, 'id'));
      const task = mustTask(text(p, 'taskId'));
      const eventId = optText(p, 'eventId') ?? '';
      const stop = flag(p, 'stop');
      engine.setChatWatch(t.id, task.id, eventId, !stop);
      const what = eventId ? `the events of "${task.name}" related to ${eventId}` : `the runs and events of "${task.name}"`;
      return stop ? `The ${named(t)} no longer watches ${what}.` : `The ${named(t)} watches ${what}.`;
    },

    transcript: async (p): Promise<Transcript> => {
      const id = safeId(p, 'id');
      const agentId = optText(p, 'agentId');
      const raw = flag(p, 'raw');
      const builder = engine.getBuilder(id);
      if (builder) return { title: draftName(builder) || 'New task', rows: builder.rows };
      const found = await engine.conversation(id, agentId, raw);
      if (!found) throw new Error(`No chat, terminal session, run or task builder has the id ${id}.`);
      return { title: live(id)?.title ?? `${engine.taskName(found.taskId) ?? found.taskId}, run ${id}`, rows: found.rows };
    },

    activity: (p) => {
      const t = mustLive(text(p, 'id'));
      const a = engine.sessionActivity(t.id);
      return { background: a?.background ?? [], subagents: a?.subagents ?? [], workflows: (a?.workflows ?? []).map((w) => ({ runId: w.runId, name: w.name, status: w.status })) };
    },

    'close-all': async (p) => {
      const project = optText(p, 'project');
      const open = engine.sessionsState().sessions.filter((s) => s.kind !== 'run' && (!project || s.projectId === project || s.taskId === project));
      if (project) for (const s of open) await engine.closeSession(s.id);
      else await engine.closeAllSessions();
      return `Closed ${plural(open.length, 'conversation')}.`;
    },

    terminal: async (p) => {
      const id = text(p, 'id');
      const runId = optText(p, 'runId');
      if (!engine.getTask(id) && !engine.getProject(id)) throw new Error(`No task or project has the id ${id}.`);
      if (flag(p, 'system')) {
        await engine.openTaskTerminal(id, runId);
        return "Opened it in the system's terminal.";
      }
      return `${engine.startTerminalSession(id, runId)}\nStarted a terminal session.`;
    },
    command: async (p) => {
      const projectId = text(p, 'projectId');
      const argv = p.argv;
      if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) throw new Error('argv must be the program and its arguments');
      if (!engine.getProject(projectId)) throw new Error(`No project has the id ${projectId}.`);
      if (flag(p, 'system')) {
        await engine.openCommandTerminal({ projectId }, argv as string[]);
        return "Opened it in the system's terminal.";
      }
      return `${engine.startCommandTerminal({ projectId }, argv as string[], (argv as string[]).join(' '))}\nStarted a terminal session.`;
    },
    allow: (p) => answer(p, true),
    deny: (p) => answer(p, false),

    // ---------- task builder ----------

    'build-start': (p) => startBuild(engine, p).message,
    'build-draft': async (p) => {
      const b = mustBuilder(engine, text(p, 'id'));
      return {
        status: b.status,
        ...(b.error ? { error: b.error } : {}),
        unsaved: await engine.builderUnsaved(b.id),
        problems: b.draft.errors,
        changed: b.draft.changed ?? [],
        draft: b.draft.raw ?? null,
      };
    },
    'build-save': async (p) => {
      const b = mustBuilder(engine, text(p, 'id'));
      const task = await engine.saveBuilder(b.id);
      return `${task.id}\nSaved "${task.name}".`;
    },
    'build-close': (p) => closeBuild(engine, p),

    // ---------- tasks ----------

    run: async (p) => {
      const task = mustTask(text(p, 'taskId'));
      const before = new Set(engine.listRuntimes().find((r) => r.taskId === task.id)?.runs.map((r) => r.runId));
      const skips = { ...(flag(p, 'skipCheck') ? { check: true } : {}), ...(flag(p, 'skipClassifier') ? { classifier: true } : {}) };
      if (!engine.runNow(task.id, skips)) throw new Error(`"${task.name}" didn't start a run; \`looper logs ${task.id}\` says why.`);
      for (let i = 0; i < 100; i++) {
        const fresh = engine.listRuntimes().find((r) => r.taskId === task.id)?.runs.find((r) => !before.has(r.runId));
        if (fresh) return { runId: fresh.runId };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`The run of "${task.name}" started, but Looper didn't list it within 10 s.`);
    },

    continue: async (p) => {
      const { runId, taskId } = await runOf(p);
      if (!engine.continueRun(taskId, runId, text(p, 'text'))) throw new Error(`"${engine.taskName(taskId) ?? taskId}" didn't start a run; \`looper logs ${taskId}\` says why.`);
      return `Started a run of "${engine.taskName(taskId) ?? taskId}" that continues the run ${runId}.`;
    },

    recent: (p) => {
      const since = p.since === undefined ? Date.now() : whole(p, 'since');
      return engine.recentRuns(whole(p, 'limit', 30), { hideSkipped: !flag(p, 'skipped'), hideNoAction: false }, since);
    },

    output: async (p) => {
      const { runId, taskId } = await runOf(p);
      return engine.readOutput(taskId, runId, undefined, flag(p, 'raw'));
    },

    note: (p) => {
      const task = mustTask(text(p, 'taskId'));
      const result = guidanceNote(optText(p, 'note') ?? '', p.runs === undefined ? 1 : Number(p.runs));
      if ('problem' in result) throw new Error(result.problem);
      engine.saveTask({ ...task, note: result.note });
      const n = result.note?.runsLeft ?? 1;
      return result.note ? `Set the guidance for the next ${n === 1 ? 'run' : `${n} runs`} of "${task.name}".` : `Cleared the guidance for the next run of "${task.name}".`;
    },

    attention: () => {
      const runtimes = Object.fromEntries(engine.listRuntimes().map((r) => [r.taskId, r]));
      return attentionRows(engine.listTasks(), runtimes).map((r) => ({
        key: attentionKey(r),
        taskId: r.task.id,
        task: r.task.name,
        level: r.level,
        problem: r.problem,
        runId: r.runId ?? r.lastRunId,
        at: r.at === null ? null : new Date(r.at).toISOString(),
      }));
    },

    'attention-clear': (p) => {
      const taskId = optText(p, 'taskId');
      const runtimes = Object.fromEntries(engine.listRuntimes().map((r) => [r.taskId, r]));
      const rows = attentionRows(engine.listTasks(), runtimes).filter((r) => !taskId || r.task.id === taskId);
      engine.clearNotices(rows.map(attentionKey));
      return `Cleared ${plural(rows.length, 'item')} from Needs Attention.`;
    },

    'clear-runs': (p) => {
      const task = mustTask(text(p, 'taskId'));
      engine.clearRuns(task.id);
      return `Deleted the run history of "${task.name}".`;
    },

    versions: (p) => engine.listVersions(mustTask(text(p, 'taskId')).id),
    version: (p) => engine.versionDetail(mustTask(text(p, 'taskId')).id, whole(p, 'n'), flag(p, 'diff')),
    rollback: async (p) => {
      const task = mustTask(text(p, 'taskId'));
      const n = whole(p, 'n');
      await engine.restoreVersion(task.id, n);
      return `Restored version ${n} of "${task.name}".`;
    },

    folders: () => engine.listFolders(),
    'folder-add': (p) => {
      const parent = optText(p, 'parent');
      const f = engine.addFolder(text(p, 'name'), parent ? folderOf(engine.listFolders(), parent).id : undefined);
      return `${f.id}\nAdded the folder "${f.name}".`;
    },
    'folder-rename': (p) => {
      const f = folderOf(engine.listFolders(), text(p, 'folder'));
      const next = engine.renameFolder(f.id, text(p, 'name'));
      return `Renamed the folder "${f.name}" to "${next.name}".`;
    },
    'folder-remove': (p) => {
      const f = folderOf(engine.listFolders(), text(p, 'folder'));
      engine.removeFolder(f.id);
      return `Deleted the folder "${f.name}"; its tasks moved to the top level.`;
    },
    move: (p) => {
      const task = mustTask(text(p, 'taskId'));
      const folder = optText(p, 'folder');
      const f = folder ? folderOf(engine.listFolders(), folder) : undefined;
      engine.reorderTasks(engine.listTasks().map((t) => t.id), { [task.id]: f?.id ?? null });
      return f ? `Moved "${task.name}" to the folder "${f.name}".` : `Moved "${task.name}" to the top level.`;
    },

    bin: () => engine.listRecycleBin().map((e) => ({ id: e.task.id, name: e.task.name, deletedAt: e.deletedAt })),
    restore: (p) => `Restored "${engine.restoreTask(text(p, 'taskId')).name}".`,
    purge: (p) => {
      const id = text(p, 'taskId');
      const entry = engine.listRecycleBin().find((e) => e.task.id === id);
      if (!entry || !engine.purgeTask(id)) throw new Error(`No task in the Recycle Bin has the id ${id}.`);
      return `Deleted "${entry.task.name}" and its run history for good.`;
    },
    'empty-bin': () => {
      const n = engine.listRecycleBin().length;
      engine.emptyRecycleBin();
      return `Deleted ${plural(n, 'task')} for good.`;
    },

    path: async (p) => {
      const id = safeId(p, 'id');
      const runDir = flag(p, 'runDir');
      const place = engine.getTask(id) ?? engine.getProject(id);
      if (place) {
        if (runDir) throw new Error('A task or project has no run folder of its own: give a run id.');
        return place.cwd;
      }
      const taskId = await taskOfRun(id);
      if (runDir) return engine.runDir(taskId, id);
      const folder = engine.workFolder(taskId, id);
      if (!folder) throw new Error(`Looper doesn't know the working directory of ${id}.`);
      return folder;
    },

    // ---------- templates ----------

    templates: () => engine.listTemplates().map((t) => ({ id: t.id, name: t.name })),
    template: (p) => {
      const id = text(p, 'id');
      const t = engine.listTemplates().find((x) => x.id === id);
      if (!t) throw new Error(`No template has the id ${id}.`);
      return t;
    },
    'template-import': (p) => {
      const input = p.template;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('template must be an object');
      const def = { ...(input as Record<string, unknown>) };
      if (!def.id && typeof def.name === 'string') def.id = slugify(def.name);
      if (engine.listTemplates().some((x) => x.id === def.id)) throw new Error(`A template already has the id ${String(def.id)}: give this one another id.`);
      const t = engine.saveTemplate(def);
      return `${t.id}\nImported the template "${t.name}".`;
    },
    'template-remove': (p) => {
      const id = text(p, 'id');
      const t = engine.listTemplates().find((x) => x.id === id);
      if (!t || !engine.removeTemplate(id)) throw new Error(`No template has the id ${id}.`);
      return `Deleted the template "${t.name}".`;
    },

    // ---------- projects ----------

    projects: () => ({
      projects: engine.listProjects().map((x) => ({ id: x.id, name: x.name, cwd: x.cwd, environmentId: x.environmentId, harnessId: x.harnessId, ...(x.folderId ? { folderId: x.folderId } : {}) })),
      folders: engine.listProjectFolders(),
    }),
    'project-remove': (p) => {
      const project = engine.getProject(text(p, 'id'));
      if (!project) throw new Error(`No project has the id ${String(p.id)}.`);
      engine.removeProject(project.id);
      return `Deleted the project "${project.name}"; its folder and files stay as they are.`;
    },
    'project-move': (p) => {
      const project = engine.getProject(text(p, 'id'));
      if (!project) throw new Error(`No project has the id ${String(p.id)}.`);
      const folder = optText(p, 'folder');
      const f = folder ? folderOf(engine.listProjectFolders(), folder) : undefined;
      engine.reorderProjects(engine.listProjects().map((x) => x.id), { [project.id]: f?.id ?? null });
      return f ? `Moved "${project.name}" to the folder "${f.name}".` : `Moved "${project.name}" to the top level.`;
    },
    'project-folder-add': (p) => {
      const parent = optText(p, 'parent');
      const f = engine.addProjectFolder(text(p, 'name'), parent ? folderOf(engine.listProjectFolders(), parent).id : undefined);
      return `${f.id}\nAdded the project folder "${f.name}".`;
    },
    'project-folder-rename': (p) => {
      const f = folderOf(engine.listProjectFolders(), text(p, 'folder'));
      const next = engine.renameProjectFolder(f.id, text(p, 'name'));
      return `Renamed the project folder "${f.name}" to "${next.name}".`;
    },
    'project-folder-remove': (p) => {
      const f = folderOf(engine.listProjectFolders(), text(p, 'folder'));
      engine.removeProjectFolder(f.id);
      return `Deleted the project folder "${f.name}"; its projects moved up.`;
    },
    'project-save': (p) => {
      // Only what `looper projects add` and `edit` set; the rest (extra arguments, variables) the project editor checks.
      const fields = Object.fromEntries(Object.entries(object(p, 'project')).filter(([k]) => PROJECT_FIELDS.has(k)));
      const id = optText(p, 'id');
      const current = id ? engine.getProject(id) : undefined;
      if (id && !current) throw new Error(`No project has the id ${id}.`);
      const cwd = typeof fields.cwd === 'string' ? fields.cwd : current?.cwd;
      if (!cwd) throw new Error('give the folder of the project');
      const project = engine.saveProject({
        ...(current ?? { environmentId: engine.settings.defaultEnvironmentId }),
        ...fields,
        ...(current || fields.name ? {} : { name: folderName(cwd) }),
      });
      return `${project.id}\n${current ? 'Saved' : 'Added'} the project "${project.name}".`;
    },

    // ---------- environments, harnesses, settings and logins ----------

    models: (p) => {
      const harnessId = text(p, 'harnessId');
      const envId = optText(p, 'environmentId');
      const env = engine.settings.environments.find((e) => (envId ? e.id === envId : e.harnesses.some((h) => h.id === harnessId)));
      const harness = env?.harnesses.find((h) => h.id === harnessId);
      if (!env || !harness) throw new Error(`No harness has the id ${harnessId}${envId ? ` in the environment ${envId}` : ''}.`);
      return discoverHarnessModels(env, harness, engine.host);
    },
    settings: (p) => {
      const key = optText(p, 'key');
      let v: unknown = engine.settings;
      for (const part of key ? key.split('.') : []) {
        if (!v || typeof v !== 'object' || !(part in v)) throw new Error(`The settings have no ${key}.`);
        v = (v as Record<string, unknown>)[part];
      }
      return v ?? null;
    },
    'settings-set': (p) => {
      const key = text(p, 'key');
      const [top, ...rest] = key.split('.');
      if (!(top in engine.settings)) throw new Error(`The settings have no ${top}.`);
      // updateSettings replaces each top-level setting whole, so a nested key changes a copy of the rest of it.
      const copy: unknown = structuredClone((engine.settings as Record<string, unknown>)[top]);
      let next: unknown = p.value;
      if (rest.length) {
        let at = copy as Record<string, unknown>;
        for (const part of rest.slice(0, -1)) {
          if (!at[part] || typeof at[part] !== 'object') throw new Error(`The settings have no ${key}.`);
          at = at[part] as Record<string, unknown>;
        }
        at[rest[rest.length - 1]] = p.value;
        next = copy;
      }
      engine.updateSettings({ [top]: next });
      return `Set ${key}.`;
    },
    'store-move': (p) => {
      const store = text(p, 'store');
      if (store !== 'tasks' && store !== 'templates') throw new Error('store must be tasks or templates');
      engine.moveStoreFile(store, text(p, 'file'));
      return `Moved the ${store} file.`;
    },
    'environment-save': (p) => {
      const fields = object(p, 'environment');
      const id = optText(p, 'id');
      const envs = engine.settings.environments;
      const current = id ? environment(id) : undefined;
      const next: Environment = { ...(current ?? newEnvironment()), ...(fields as Partial<Environment>), ...(current ? { id: current.id } : {}) };
      if (!current && envs.some((e) => e.id === next.id)) throw new Error(`An environment already has the id ${next.id}.`);
      setEnvironments({ environments: current ? envs.map((e) => (e.id === current.id ? next : e)) : [...envs, next] });
      return `${next.id}\n${current ? 'Saved' : 'Added'} the environment "${next.name}".`;
    },
    'environment-remove': (p) => {
      const env = environment(text(p, 'id'));
      const patch = withoutEnvironment(engine.settings, env.id);
      if (!patch) throw new Error("Looper needs at least one environment, so the last one can't be removed.");
      setEnvironments(patch);
      return `Removed the environment "${env.name}".`;
    },
    'harness-save': (p) => {
      const env = environment(text(p, 'environmentId'));
      const fields = object(p, 'harness');
      const id = optText(p, 'id');
      const current = id ? env.harnesses.find((h) => h.id === id) : undefined;
      if (id && !current) throw new Error(`The environment "${env.name}" has no harness with the id ${id}.`);
      const next: Harness = { ...(current ?? newHarness()), ...(fields as Partial<Harness>), ...(current ? { id: current.id } : {}) } as Harness;
      if (!current && env.harnesses.some((h) => h.id === next.id)) throw new Error(`The environment "${env.name}" already has a harness with the id ${next.id}.`);
      const harnesses = current ? env.harnesses.map((h) => (h.id === current.id ? next : h)) : [...env.harnesses, next];
      setEnvironments({ environments: engine.settings.environments.map((e) => (e.id === env.id ? { ...e, harnesses } : e)) });
      return `${next.id}\n${current ? 'Saved' : 'Added'} the harness "${next.name}" in "${env.name}".`;
    },
    'harness-remove': (p) => {
      const env = environment(text(p, 'environmentId'));
      const harnessId = text(p, 'id');
      const harness = env.harnesses.find((h) => h.id === harnessId);
      if (!harness) throw new Error(`The environment "${env.name}" has no harness with the id ${harnessId}.`);
      const harnesses = withoutHarness(env, harnessId);
      if (!harnesses) throw new Error(`An environment needs at least one harness, so the last one of "${env.name}" can't be removed.`);
      setEnvironments({ environments: engine.settings.environments.map((e) => (e.id === env.id ? { ...e, harnesses } : e)) });
      return `Removed the harness "${harness.name}" from "${env.name}".`;
    },
    logins: () => engine.logins(),

    // ---------- history ----------

    history: async (p) => {
      const project = optText(p, 'project');
      const task = optText(p, 'task');
      const result = optText(p, 'result');
      // Task History's list: the runs only, with its filters. A task or a result means the runs.
      const runs = flag(p, 'runs') || !!task || !!result;
      const list = await engine.historyList({
        fresh: false,
        limit: whole(p, 'limit', 50),
        folder: project ? `project:${project}` : '',
        ...(runs ? { runs: { taskId: task ?? '', result: result ?? '', hideSkipped: flag(p, 'hideSkipped'), hideNoAction: flag(p, 'hideNoAction') } } : {}),
      });
      const search = optText(p, 'search');
      const hits = search ? new Set(await engine.historySearch(search, list.items.map((i) => i.id))) : undefined;
      return list.items
        .filter((i) => !hits || hits.has(i.id))
        .map((i) => ({ id: i.id, title: i.title, folder: i.folder, source: i.source, harness: i.harnessKind, lastActive: new Date(i.lastActive).toISOString(), taskId: i.taskId, ...(i.runId ? { runId: i.runId } : {}), ...(i.result ? { result: i.result } : {}) }));
    },
    'history-show': async (p): Promise<Transcript> => {
      const id = text(p, 'id');
      const c = await engine.historyRead(id, optText(p, 'agentId'));
      if (!c) throw new Error(`No conversation in the history has the id ${id}.`);
      return { title: engine.historyItem(id)?.title ?? id, rows: c.rows };
    },
    'history-continue': async (p) => {
      const id = text(p, 'id');
      if (flag(p, 'terminal')) {
        need('unrestricted');
        const session = await engine.continueHistoryInTerminal(id);
        return session ? `${session}\nContinued it in a terminal session.` : "Continued it in the system's terminal.";
      }
      const chat = flag(p, 'compact') ? await engine.compactHistory(id) : await engine.continueHistoryInChat(id);
      return `${chat.id}\nContinued it in a chat.`;
    },

    // ---------- Remote Control, Rest Mode and Prevent Sleep ----------

    remote: () => engine.remoteState(),
    'remote-stop': (p) => {
      const id = text(p, 'id');
      if (!engine.remoteState().conversations.some((c) => c.id === id)) throw new Error(`No Remote Control conversation has the id ${id}.`);
      engine.stopRemoteConversation(id);
      return 'Ended the Remote Control conversation.';
    },
    'remote-restart': (p) => {
      const id = text(p, 'id');
      if (!engine.remoteState().conversations.some((c) => c.id === id)) throw new Error(`No Remote Control conversation has the id ${id}.`);
      engine.restartRemoteConversation(id);
      return 'Continued the Remote Control conversation in a new session.';
    },
    rest: (p) => {
      if (p.on === undefined) return engine.restState();
      if (flag(p, 'on')) engine.armRest();
      else engine.disarmRest();
      return flag(p, 'on') ? 'Rest Mode is on.' : 'Rest Mode is off.';
    },
    'prevent-sleep': (p) => {
      if (p.timer === undefined) return engine.preventSleepState();
      const timer = p.timer as PreventSleepTimer;
      if (!(['off', 30, 60, 120, 'until-off'] as unknown[]).includes(timer)) throw new Error('timer must be off, 30, 60, 120 or until-off');
      engine.setPreventSleep(timer);
      return timer === 'off' ? 'Prevent Sleep is off.' : timer === 'until-off' ? 'Prevent Sleep is on until you turn it off.' : `Prevent Sleep is on for ${timer} min.`;
    },
  };

  /** Allow or deny the oldest tool call a chat's or run's agent waits on. */
  function answer(p: Params, allow: boolean): string {
    const verb = allow ? 'Allowed' : 'Denied';
    const t = mustLive(text(p, 'id'));
    if (t.kind === 'chat') {
      const request = t.chat.permissions[0];
      if (!request) throw new Error(`The ${named(t)} isn't waiting on a permission answer.`);
      engine.answerChat(t.id, request.id, allow);
      return `${verb} the ${request.tool} call in the ${named(t)}.`;
    }
    const request = engine.listRuntimes().flatMap((r) => [...r.runs, ...r.children]).find((r) => r.runId === t.id)?.permission;
    if (t.kind !== 'run' || !request || !engine.answerRunPermission(t.taskId, t.id, request.id, allow)) throw new Error(`The ${named(t)} isn't waiting on a permission answer.`);
    return `${verb} the ${request.tool} call in the ${named(t)}.`;
  }
}
