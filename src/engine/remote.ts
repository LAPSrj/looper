import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '../shared/ansi';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import {
  isRemoteTaskId,
  remoteTaskId,
  type RemoteConversation,
  type RemoteMessage,
  type RemoteSource,
  type RemoteState,
} from '../shared/remote';
import { TaskSchema, type RemoteFolderProject, type RemoteHelper, type RemoteProject, type Settings, type Task } from '../shared/types';
import { errMsg, type Logger } from './log';
import type { RemoteLaunch } from './open-terminal';
import { readJson, writeJsonAtomic } from './store/fsutil';
import type { Target } from './target';
import { joinTarget } from './target/paths';

const POLL_MS = 1000;
/** A session that exits this soon after starting, unused, failed to start. */
const QUICK_EXIT_MS = 30_000;
/** Failed starts in a row before Looper stops trying an entry until Remote Control starts again. */
const MAX_FAILS = 3;
/** Wait between two starts for the same entry. */
const RESPAWN_GAP_MS = 2_000;
/** How long `looper-remote open` waits for the new session's link. */
const LINK_WAIT_MS = 30_000;
/** Ended conversations the Conversations window lists. */
const MAX_PAST = 200;
const LINK_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;
const HELPER_COMMAND = 'looper-remote';

export interface RemoteDeps {
  dataDir: string;
  settings: Settings;
  log: Logger;
  emit: (state: RemoteState) => void;
  getTask: (id: string) => Task | undefined;
  listTasks: () => Task[];
  createTarget: (task: Task) => Target;
  /**
   * Start a recorded Remote Control session of the task in a new run folder
   * and return its run id; `launch` gets the folder (host path) and target.
   * Throws with the reason.
   */
  startSession: (task: Task, launch: (dir: string, target: Target) => RemoteLaunch) => { runId: string; dir: string };
  /** End a session: its process stops, and its conversation stays as a run. */
  closeSession: (runId: string) => void;
  /** The session's output so far; null once it's closed. */
  output: (runId: string) => { data: string; ended: boolean } | null;
  write: (runId: string, data: string) => void;
  /** The title the run of a used session recorded (its first message). */
  readTitle: (taskId: string, runId: string) => string | undefined;
  /** A run's folder (host path); run-log retention deletes old ones. */
  runDir: (taskId: string, runId: string) => string;
  pollMs?: number;
  now?: () => number;
}

interface Live {
  conv: RemoteConversation;
  /** `helper:<id>` or `project:<id>`: the entry that keeps this session open. */
  entryKey?: string;
  dir: string;
  startedAt: number;
  promptAt: number | null;
  stopAt: number | null;
  /** Looper is ending it (Stop, a helper's restart): its exit isn't a failure. */
  closing: boolean;
  trustAnswered: boolean;
  /** Helper requests being answered, by file name. */
  taken: Set<string>;
  /** The title and link last saved to the record of used conversations. */
  saved?: string;
}

/** The task-like stand-in a folder project or helper runs its sessions as. */
export function remoteStandIn(
  entry: Pick<RemoteHelper, 'id' | 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort' | 'permissionMode'>,
  settings: Settings,
): Task {
  const env = settings.environments.find((e) => e.id === entry.environmentId);
  // No harness named: the environment's first Claude Code one.
  const harnessId = entry.harnessId ?? env?.harnesses.find((h) => h.kind === 'claude-code')?.id;
  const task = TaskSchema.parse({
    id: 'remote',
    name: entry.name,
    environmentId: entry.environmentId,
    cwd: entry.cwd,
    trigger: { mode: 'manual' },
    agent: {
      ...(harnessId ? { harnessId } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.effort ? { effort: entry.effort } : {}),
      permissionMode: entry.permissionMode,
      prompt: '-',
    },
  });
  return { ...task, id: remoteTaskId(entry.id) };
}

/** What a helper's agent is told about itself and `looper-remote`. */
export function helperSystemPrompt(idleRestartMin: number): string {
  return [
    "You are a Remote Control helper that Looper keeps open on the user's computer. The user talks to you from the Claude app while away from the computer, mostly to start Claude Code sessions in other folders.",
    '',
    'Commands:',
    `- \`${HELPER_COMMAND} list\` prints the projects and tasks you can open, with their folders.`,
    `- \`${HELPER_COMMAND} open <project, task id, or folder>\` starts a new Remote Control session there and prints its name and link. A folder is a path on this computer (a relative path is resolved against your working directory).`,
    '',
    "When the user asks for a session somewhere, open it and reply with the session's name and link, so they can switch to it in the Claude app. Don't do the work in that folder yourself unless they ask you to: the new session does it.",
    `Looper replaces this conversation with a fresh one after ${idleRestartMin} minutes without a message, so nothing here needs to be kept for later.`,
  ].join('\n');
}

/**
 * Remote Control: the Claude Code sessions Looper keeps open for the Claude
 * app. Each helper and project entry in the settings gets a session; a project
 * that keeps a conversation ready gets another once its empty one is used; a
 * helper idle past its restart time is replaced by a fresh one. Every session
 * is a terminal session of a task (a folder project's or helper's stand-in
 * task when no task supplies it), so its conversation is recorded as a run.
 * Remote Control runs only while this Looper does: Stop and quitting end
 * every session.
 */
export class RemoteControl {
  private running = false;
  private readonly live = new Map<string, Live>();
  private readonly problems = new Map<string, string>();
  private readonly fails = new Map<string, number>();
  private readonly lastStart = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastEmitted = '';
  /** The record of used conversations (remote/conversations.json), oldest first; read on first use. */
  private past: RemoteConversation[] | null = null;

  constructor(private readonly d: RemoteDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.problems.clear();
    this.fails.clear();
    this.prunePast();
    this.d.log.info('remote control started');
    this.timer = setInterval(() => this.poll(), this.d.pollMs ?? POLL_MS);
    this.reconcile();
    this.emitState();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const runId of [...this.live.keys()]) this.end(runId);
    this.problems.clear();
    this.d.log.info('remote control stopped');
    this.emitState();
  }

  /** The settings changed: entries that went away lose their empty sessions, new ones get theirs. */
  settingsChanged(): void {
    if (!this.running) return;
    const keys = this.entryKeys();
    for (const [runId, l] of this.live) {
      if (l.entryKey && !keys.has(l.entryKey) && l.conv.status === 'waiting') this.end(runId);
    }
    for (const key of [...this.problems.keys()]) {
      if (!keys.has(key)) this.problems.delete(key);
    }
    // A changed entry gets another try.
    this.fails.clear();
    this.reconcile();
    this.emitState();
  }

  /** Whether a terminal session is one of Remote Control's. */
  owns(runId: string): boolean {
    return this.live.has(runId);
  }

  /** Remote Control's sessions still running. */
  liveCount(): number {
    return this.live.size;
  }

  /** Open conversations that have had a message: quitting ends them. */
  usedCount(): number {
    return [...this.live.values()].filter((l) => l.conv.status !== 'waiting').length;
  }

  /** End one conversation (the Conversations window's Stop). Its entry gets a new one if it needs it. */
  stopConversation(runId: string): void {
    if (!this.live.has(runId)) return;
    this.end(runId);
    this.reconcile();
    this.emitState();
  }

  /** A session's process exited on its own (the conversation ended, or Claude Code failed). */
  exited(runId: string): void {
    const l = this.live.get(runId);
    if (!l) return;
    this.live.delete(runId);
    const tail = lastLines(stripAnsi(this.d.output(runId)?.data.slice(-4000) ?? ''));
    this.d.closeSession(runId);
    if (l.entryKey && !l.closing) {
      const quick = l.conv.status === 'waiting' && this.now() - l.startedAt < QUICK_EXIT_MS;
      const n = quick ? (this.fails.get(l.entryKey) ?? 0) + 1 : 0;
      this.fails.set(l.entryKey, n);
      if (n >= MAX_FAILS) {
        this.problems.set(l.entryKey, `Claude Code exited right after starting, ${n} times in a row${tail ? `: ${tail}` : '.'}`);
        this.d.log.warn(`remote control: ${l.entryKey} stopped after ${n} failed starts${tail ? `: ${tail}` : ''}`);
      }
    }
    if (this.running) this.reconcile();
    this.emitState();
  }

  /** `pruned`: drop ended conversations whose run folder is gone (run-log retention). */
  state(pruned = true): RemoteState {
    const open = [...this.live.values()].map((l) => ({ ...l.conv })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const ids = new Set(open.map((c) => c.id));
    if (pruned) this.prunePast();
    const past = this.pastList()
      .filter((c) => !ids.has(c.id))
      .map((c) => ({ ...c, status: 'ended' as const }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { running: this.running, conversations: [...open, ...past], problems: Object.fromEntries(this.problems) };
  }

  /**
   * The conversation's last message, from the hooks' records in its run
   * folder: the user's message while a turn works on it, else Claude's last
   * answer. Null before the first message, or once the run is gone.
   */
  lastMessage(id: string): RemoteMessage | null {
    const conv = this.live.get(id)?.conv ?? this.pastList().find((c) => c.id === id);
    if (!conv) return null;
    const dir = this.d.runDir(conv.taskId, id);
    const read = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const promptAt = mtime(path.join(dir, 'prompt.json'));
    const stopAt = mtime(path.join(dir, 'stop.json'));
    if (promptAt !== null && promptAt > (stopAt ?? 0)) {
      const text = read('prompt.json')?.prompt;
      if (typeof text === 'string') return { from: 'user', text };
    }
    const text = read('stop.json')?.last_assistant_message;
    return typeof text === 'string' ? { from: 'agent', text } : null;
  }

  /** The stand-in task a folder project's or helper's conversations were recorded under, from its run history. */
  standIn(taskId: string): Task | undefined {
    if (!isRemoteTaskId(taskId)) return undefined;
    const raw = readJson<unknown>(this.standInFile(taskId), null);
    const parsed = raw ? TaskSchema.safeParse({ ...(raw as object), id: 'remote' }) : null;
    return parsed?.success ? { ...parsed.data, id: taskId } : undefined;
  }

  // ---------- starting sessions ----------

  private entryKeys(): Set<string> {
    const r = this.d.settings.remote;
    return new Set([...r.helpers.map((h) => `helper:${h.id}`), ...r.projects.map((p) => `project:${p.id}`)]);
  }

  /** Give every entry the sessions it needs. */
  private reconcile(): void {
    if (!this.running) return;
    const r = this.d.settings.remote;
    for (const h of r.helpers) {
      const mine = this.sessionsOf(`helper:${h.id}`);
      if (mine.length === 0) this.startEntry(`helper:${h.id}`, () => this.launchHelper(h));
    }
    for (const p of r.projects) {
      const key = `project:${p.id}`;
      const mine = this.sessionsOf(key);
      const needs = p.keepReady ? !mine.some((l) => l.conv.status === 'waiting') : mine.length === 0;
      if (!needs) continue;
      this.startEntry(key, () => (p.kind === 'task' ? this.launchTask(p.taskId, 'project', p.id, p.name) : this.launchFolder(p, 'project')));
    }
  }

  private sessionsOf(entryKey: string): Live[] {
    return [...this.live.values()].filter((l) => l.entryKey === entryKey && !l.closing);
  }

  private startEntry(entryKey: string, launch: () => Live): void {
    if ((this.fails.get(entryKey) ?? 0) >= MAX_FAILS) return;
    const last = this.lastStart.get(entryKey);
    if (last !== undefined && this.now() - last < RESPAWN_GAP_MS) return;
    this.lastStart.set(entryKey, this.now());
    try {
      const l = launch();
      l.entryKey = entryKey;
      this.problems.delete(entryKey);
    } catch (err) {
      const msg = errMsg(err);
      if (this.problems.get(entryKey) !== msg) this.d.log.warn(`remote control: cannot start ${entryKey}: ${msg}`);
      this.problems.set(entryKey, msg);
    }
  }

  private launchHelper(h: RemoteHelper): Live {
    if (!h.cwd.trim()) throw new Error('Choose its working directory.');
    const task = remoteStandIn(h, this.d.settings);
    return this.launch(task, 'helper', h.name, h.id, (dir, target) => {
      const dirT = target.toTargetPath(dir);
      return {
        name: h.name,
        systemPrompt: helperSystemPrompt(h.idleRestartMin),
        helpers: target.renderRequestHelpers(
          { [HELPER_COMMAND]: 'remote' },
          { dirVar: 'LOOPER_REMOTE_DIR', script: 'looper-remote-request', hint: 'is Remote Control still on?' },
        ),
        env: { LOOPER_REMOTE_DIR: dirT },
        settings: {
          // The helper must never wait on a permission prompt nobody at the computer can answer.
          permissions: { allow: [`Bash(${HELPER_COMMAND}:*)`, `Bash(${HELPER_COMMAND})`] },
          sandbox: { excludedCommands: [HELPER_COMMAND] },
          // Looper replaces an idle helper itself; compacting it first would only cost usage.
          idleCompaction: false,
        },
      };
    });
  }

  private launchFolder(p: RemoteFolderProject, source: RemoteSource, overrides?: { cwd: string; name: string; entryId?: string }): Live {
    const entry = overrides ? { ...p, cwd: overrides.cwd, name: overrides.name } : p;
    if (!entry.cwd.trim()) throw new Error('Choose its working directory.');
    const task = remoteStandIn({ ...entry, id: p.id }, this.d.settings);
    return this.launch(task, source, entry.name, overrides ? overrides.entryId : p.id, () => ({ name: entry.name }));
  }

  /** `name`: the session's own name, instead of the task's. */
  private launchTask(taskId: string, source: RemoteSource, entryId?: string, name?: string): Live {
    const task = this.d.getTask(taskId);
    if (!task) throw new Error('The task no longer exists.');
    const shown = name ?? task.name;
    return this.launch(task, source, shown, entryId, () => ({ name: shown }));
  }

  /** A project's session name: its own, or for a task project without one, the task's. */
  private projectName(p: RemoteProject): string | undefined {
    return p.kind === 'folder' ? p.name : (p.name ?? this.d.getTask(p.taskId)?.name);
  }

  private launch(
    task: Task,
    source: RemoteSource,
    name: string,
    entryId: string | undefined,
    launch: (dir: string, target: Target) => RemoteLaunch,
  ): Live {
    const harness = resolveHarness(task, resolveEnvironment(task, this.d.settings));
    if (harness.kind !== 'claude-code') throw new Error(`Remote Control needs a Claude Code harness, and "${harness.name}" isn't one.`);
    if (isRemoteTaskId(task.id)) {
      const { id: _id, ...rest } = task;
      writeJsonAtomic(this.standInFile(task.id), rest);
    }
    const { runId, dir } = this.d.startSession(task, launch);
    const now = this.now();
    const l: Live = {
      conv: {
        id: runId,
        taskId: task.id,
        source,
        ...(entryId ? { entryId } : {}),
        name,
        cwd: task.cwd,
        startedAt: new Date(now).toISOString(),
        status: 'waiting',
      },
      dir,
      startedAt: now,
      promptAt: null,
      stopAt: null,
      closing: false,
      trustAnswered: false,
      taken: new Set(),
    };
    this.live.set(runId, l);
    this.d.log.info(`remote control: started ${source} session ${runId} "${name}" in ${task.cwd}`);
    return l;
  }

  private standInFile(taskId: string): string {
    return path.join(this.d.dataDir, 'tasks', taskId, 'remote-task.json');
  }

  private end(runId: string): void {
    const l = this.live.get(runId);
    if (!l) return;
    l.closing = true;
    this.live.delete(runId);
    try {
      this.d.closeSession(runId);
    } catch (err) {
      this.d.log.warn(`remote control: cannot stop ${runId}: ${errMsg(err)}`);
    }
  }

  // ---------- watching sessions ----------

  private poll(): void {
    if (!this.running) return;
    for (const [runId, l] of [...this.live]) {
      this.watchOutput(runId, l);
      this.watchTurns(l);
      if (l.conv.source === 'helper') {
        void this.answerRequests(l);
        this.recycle(runId, l);
      }
    }
    this.reconcile();
    this.emitState();
  }

  private watchOutput(runId: string, l: Live): void {
    if (l.trustAnswered && l.conv.link) return;
    const out = this.d.output(runId);
    if (!out) return;
    const text = stripAnsi(out.data.slice(-32768));
    if (!l.conv.link) {
      const m = LINK_RE.exec(text);
      if (m) l.conv.link = m[0];
    }
    if (!l.trustAnswered && text.replace(/\s+/g, '').toLowerCase().includes('trustthisfolder')) {
      // The folder was chosen deliberately, as for a run: claude preselects "No, exit", so Down to "Yes", then Enter.
      l.trustAnswered = true;
      this.d.log.info(`remote control: answering the workspace trust dialog for ${l.conv.cwd}`);
      setTimeout(() => this.d.write(runId, '\x1b[B'), 300);
      setTimeout(() => this.d.write(runId, '\r'), 700);
    }
    // Claude Code prints its link once connected: no trust dialog comes after that.
    if (l.conv.link) l.trustAnswered = true;
  }

  private watchTurns(l: Live): void {
    l.promptAt = mtime(path.join(l.dir, 'prompt.json'));
    l.stopAt = mtime(path.join(l.dir, 'stop.json'));
    const wasWaiting = l.conv.status === 'waiting';
    if (l.promptAt === null && l.stopAt === null) l.conv.status = 'waiting';
    else l.conv.status = l.promptAt !== null && l.promptAt > (l.stopAt ?? 0) ? 'working' : 'idle';
    if (!l.conv.title && l.stopAt !== null) l.conv.title = this.d.readTitle(l.conv.taskId, l.conv.id);
    if (wasWaiting && l.conv.status !== 'waiting') this.d.log.info(`remote control: ${l.conv.id} "${l.conv.name}" got its first message`);
    // A used conversation goes on the record, and again when its title or link arrives.
    const saved = JSON.stringify([l.conv.title, l.conv.link]);
    if (l.conv.status !== 'waiting' && l.saved !== saved) {
      l.saved = saved;
      this.remember(l.conv);
    }
  }

  /** A helper idle past its restart time: a fresh one takes its place, then it ends. */
  private recycle(runId: string, l: Live): void {
    if (l.conv.status !== 'idle' || !l.entryKey) return;
    const helper = this.d.settings.remote.helpers.find((h) => `helper:${h.id}` === l.entryKey);
    if (!helper) return;
    const last = Math.max(l.promptAt ?? 0, l.stopAt ?? 0);
    if (this.now() - last < helper.idleRestartMin * 60_000) return;
    this.d.log.info(`remote control: helper "${helper.name}" idle for ${helper.idleRestartMin} min; starting a fresh one`);
    try {
      const fresh = this.launchHelper(helper);
      fresh.entryKey = l.entryKey;
    } catch (err) {
      this.d.log.warn(`remote control: cannot restart helper "${helper.name}": ${errMsg(err)}`);
      return;
    }
    this.end(runId);
  }

  // ---------- a helper's requests ----------

  private async answerRequests(l: Live): Promise<void> {
    const reqDir = path.join(l.dir, 'requests');
    let names: string[];
    try {
      names = fs.readdirSync(reqDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.req') || l.taken.has(name)) continue;
      l.taken.add(name);
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(reqDir, name), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
        fs.rmSync(path.join(reqDir, name), { force: true });
      } catch {
        l.taken.delete(name);
        continue;
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const [, callerCwd, sub, ...args] = lines;
      let out: { text: string; code: number };
      try {
        out = await this.request(l, callerCwd ?? '', sub, args.join(' ').trim());
      } catch (err) {
        out = { text: `looper: ${errMsg(err)}`, code: 1 };
      }
      const res = path.join(l.dir, 'responses');
      const rid = name.slice(0, -4);
      try {
        fs.mkdirSync(res, { recursive: true });
        fs.writeFileSync(path.join(res, `${rid}.out`), out.text.endsWith('\n') ? out.text : out.text + '\n');
        fs.writeFileSync(path.join(res, `${rid}.code.tmp`), String(out.code));
        fs.renameSync(path.join(res, `${rid}.code.tmp`), path.join(res, `${rid}.code`));
      } catch (err) {
        this.d.log.warn(`remote control: cannot answer a helper request: ${errMsg(err)}`);
      }
      l.taken.delete(name);
    }
  }

  private async request(helper: Live, callerCwd: string, sub: string | undefined, arg: string): Promise<{ text: string; code: number }> {
    if (sub === 'list') return { text: this.listTargets(), code: 0 };
    if (sub !== 'open' || !arg) return { text: `usage: ${HELPER_COMMAND} list | ${HELPER_COMMAND} open <project, task id, or folder>`, code: 2 };
    const opened = this.open(helper, callerCwd, arg);
    const link = await this.waitForLink(opened.conv.id);
    const where = `"${opened.conv.name}" in ${opened.conv.cwd}`;
    return {
      text: link
        ? `Opened ${where}.\nLink: ${link}`
        : `Opened ${where}. It shows in the Claude app's session list under that name (Claude Code hasn't printed its link yet).`,
      code: 0,
    };
  }

  private listTargets(): string {
    const r = this.d.settings.remote;
    const lines: string[] = [];
    const tasks = this.d.listTasks().filter((t) => this.isClaudeTask(t));
    if (r.projects.length) {
      lines.push('Projects:');
      for (const p of r.projects) {
        if (p.kind === 'folder') lines.push(`- ${p.name}: ${p.cwd}`);
        else {
          const t = this.d.getTask(p.taskId);
          if (t) lines.push(`- ${this.projectName(p)} (task ${t.id}): ${t.cwd}`);
        }
      }
    }
    if (tasks.length) {
      if (lines.length) lines.push('');
      lines.push('Tasks:');
      for (const t of tasks) lines.push(`- ${t.id} (${t.name}): ${t.cwd}`);
    }
    return lines.length ? lines.join('\n') : 'No projects or tasks yet; open a folder by its path.';
  }

  private isClaudeTask(t: Task): boolean {
    try {
      return resolveHarness(t, resolveEnvironment(t, this.d.settings)).kind === 'claude-code';
    } catch {
      return false;
    }
  }

  /** `looper-remote open`: a project (by name), a task (by id or name), or a folder in the helper's environment. */
  private open(helper: Live, callerCwd: string, arg: string): Live {
    const r = this.d.settings.remote;
    const want = arg.toLowerCase();
    const project = r.projects.find((p) => p.id === arg || this.projectName(p)?.toLowerCase() === want);
    if (project?.kind === 'folder') return this.launchFolder(project, 'opened', { cwd: project.cwd, name: project.name });
    if (project?.kind === 'task') return this.launchTask(project.taskId, 'opened', undefined, project.name);
    const task = this.d.listTasks().find((t) => t.id === arg || t.name.toLowerCase() === want);
    if (task) return this.launchTask(task.id, 'opened');
    const entry = this.d.settings.remote.helpers.find((h) => `helper:${h.id}` === helper.entryKey);
    if (!entry) throw new Error('This helper was removed from the Remote Control settings.');
    const stand = remoteStandIn(entry, this.d.settings);
    const target = this.d.createTarget(stand);
    if (arg.startsWith('~')) throw new Error(`Give the folder's full path: ${arg} starts with ~, which Looper can't expand.`);
    const joined = isAbsolutePath(arg) ? arg : joinTarget(target.kind, callerCwd || entry.cwd, arg);
    const folder = (target.kind === 'windows' ? path.win32 : path.posix).normalize(joined).replace(/(.)[\\/]+$/, '$1');
    let isDir = false;
    try {
      isDir = fs.statSync(target.toHostPath(folder)).isDirectory();
    } catch {
      /* not reachable */
    }
    if (!isDir) throw new Error(`No project or task is named "${arg}", and ${folder} isn't a folder.`);
    const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
    return this.launchFolder({ ...entry, kind: 'folder', keepReady: false }, 'opened', { cwd: folder, name });
  }

  private async waitForLink(runId: string): Promise<string | undefined> {
    const until = this.now() + LINK_WAIT_MS;
    while (this.now() < until) {
      const l = this.live.get(runId);
      if (!l) return undefined;
      this.watchOutput(runId, l);
      if (l.conv.link) return l.conv.link;
      await new Promise((r) => setTimeout(r, 500));
    }
    return undefined;
  }

  // ---------- the record of used conversations ----------

  private indexFile(): string {
    return path.join(this.d.dataDir, 'remote', 'conversations.json');
  }

  private pastList(): RemoteConversation[] {
    if (!this.past) {
      const list = readJson<unknown>(this.indexFile(), []);
      this.past = Array.isArray(list) ? (list as RemoteConversation[]) : [];
    }
    return this.past;
  }

  private savePast(): void {
    try {
      writeJsonAtomic(this.indexFile(), this.pastList());
    } catch (err) {
      this.d.log.warn(`remote control: cannot save the conversation list: ${errMsg(err)}`);
    }
  }

  /** Forget ended conversations whose run is gone. */
  private prunePast(): void {
    const list = this.pastList();
    const open = new Set(this.live.keys());
    const kept = list.filter((c) => open.has(c.id) || fs.existsSync(this.d.runDir(c.taskId, c.id)));
    if (kept.length === list.length) return;
    this.past = kept;
    this.savePast();
  }

  /** Add a used conversation to the record, or update its title and link. */
  private remember(conv: RemoteConversation): void {
    const list = this.pastList();
    const entry: RemoteConversation = { ...conv, status: 'ended' };
    const i = list.findIndex((c) => c.id === conv.id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    if (list.length > MAX_PAST) list.splice(0, list.length - MAX_PAST);
    this.savePast();
  }

  private emitState(): void {
    const state = this.state(false);
    const json = JSON.stringify(state);
    if (json === this.lastEmitted) return;
    this.lastEmitted = json;
    this.d.emit(state);
  }
}

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The last non-empty lines of a session's output, as one line. */
function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ')
    .slice(-300);
}
