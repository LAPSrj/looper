import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, ChatPermissionRequest, ChatState } from '../shared/chat';
import { PERMISSION_MODES, codexPermissionArgs, resolveEffort, resolveEnvironment, resolveHarness } from '../shared/environments';
import type { MessageRow } from '../shared/messages';
import type { EngineEvent, Harness, Settings, Task } from '../shared/types';
import { ClaudeStreamAccumulator, CodexExecAccumulator } from './builder/stream';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { childEnv, writeLauncher, type RunContext } from './steps/common';
import { writeJsonAtomic, writeText } from './store/fsutil';
import { createTarget, type Target } from './target';
import { killHostTree } from './target/kill';
import { joinTarget } from './target/paths';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The media type of an image the agents can see, by the file's extension; undefined for any other file. */
export function imageMediaType(file: string): string | undefined {
  return IMAGE_TYPES[path.extname(file).toLowerCase()];
}

/** Largest image sent to Claude inside the message: base64 grows it by a third, and the API refuses images over 5 MB. */
export const MAX_INLINE_IMAGE = 3_750_000;

/** How long a permission hook may wait for the user: the chat window stays open meanwhile. */
const PERMISSION_TIMEOUT_SEC = 86_400;

/** The message the agent gets: the user's text, then the paths of the files it reads itself. */
export function withFileList(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f}`).join('\n');
  return `${text}\n\nAttached files (read them from these paths):\n${list}`.trim();
}

/**
 * One message for Claude's stream-json input. An image goes inside the
 * message, where Claude sees it at once; any other file, or an image too
 * large to send that way, goes as its path in the target's form.
 */
export function claudeUserMessage(
  text: string,
  attachments: Attachment[],
  toTargetPath: (hostPath: string) => string,
  read: (hostPath: string) => Buffer = (p) => fs.readFileSync(p),
): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [];
  const files: string[] = [];
  for (const a of attachments) {
    const mediaType = a.image ? imageMediaType(a.path) : undefined;
    const data = mediaType ? read(a.path) : null;
    if (mediaType && data && data.length <= MAX_INLINE_IMAGE) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } });
    } else {
      files.push(toTargetPath(a.path));
    }
  }
  const body = withFileList(text, files);
  const content = body ? [{ type: 'text', text: body }, ...blocks] : blocks;
  return { type: 'user', message: { role: 'user', content } };
}

/** The decision a PermissionRequest hook prints for claude. */
export function permissionAnswer(allow: boolean, input: unknown): string {
  const decision = allow
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'The user denied this in Looper.' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

export interface ChatDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  emit: (e: EngineEvent) => void;
  /** Continue in Chat: the conversation id a run recorded (throws with the reason when there is none). */
  resumeIdOf: (task: Task, runId: string) => string;
  /** Continue in Chat: the run's conversation, shown above the chat. */
  readHistory: (taskId: string, runId: string) => Promise<MessageRow[]>;
}

interface Pending {
  text: string;
  attachments: Attachment[];
}

class ChatSession {
  readonly id = randomUUID().slice(0, 8);
  readonly taskId: string;
  private readonly dir: string;
  private readonly harness: Harness;
  private readonly target: Target;
  private readonly ctx: RunContext;
  private readonly acc: ClaudeStreamAccumulator | CodexExecAccumulator;
  private readonly claude: boolean;
  private status: ChatState['status'] = 'starting';
  private error?: string;
  private history: MessageRow[] = [];
  private proc: ChildProcess | null = null;
  private stdoutBuf = '';
  private stderrTail = '';
  /** The conversation to go on with: claude's session (after a Stop), codex's thread. */
  private sessionId?: string;
  private codexTurns = 0;
  /** Codex: messages sent while a turn runs; the next turn takes them together. */
  private queued: Pending[] = [];
  private permissions: ChatPermissionRequest[] = [];
  private readonly takenRequests = new Set<string>();
  /** Stop was pressed: the process exit that follows ends the turn, not the chat. */
  private stopping = false;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: ChatDeps,
    private readonly task: Task,
    private readonly fromRunId?: string,
  ) {
    this.taskId = task.id;
    const own = resolveHarness(task, resolveEnvironment(task, d.settings));
    if (own.kind === 'custom') throw new Error('A chat needs a Claude Code or Codex harness.');
    this.harness = task.agent.command ? { ...own, command: task.agent.command } : own;
    this.claude = own.kind === 'claude-code';
    this.acc = this.claude ? new ClaudeStreamAccumulator() : new CodexExecAccumulator();
    this.sessionId = fromRunId ? d.resumeIdOf(task, fromRunId) : undefined;
    this.dir = path.join(d.dataDir, 'chats', this.id);
    this.target = createTarget(task, { host: d.host, settings: d.settings });
    this.ctx = {
      task,
      runId: `chat-${this.id}`,
      runDir: this.dir,
      target: this.target,
      settings: d.settings,
      host: d.host,
      log: d.log,
      dataDir: d.dataDir,
      vars: {},
    };
  }

  // ---------- lifecycle ----------

  start(): void {
    fs.mkdirSync(path.join(this.dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'permissions'), { recursive: true });
    if (this.fromRunId) {
      void this.d
        .readHistory(this.taskId, this.fromRunId)
        .then((rows) => {
          this.history = rows;
          this.scheduleEmit();
        })
        .catch(() => undefined);
    }
    if (this.claude) {
      const hook = path.join(this.dir, 'bin', this.target.permissionHookFile);
      writeText(hook, this.target.renderPermissionHook(this.targetFile('permissions')), 0o755);
      writeJsonAtomic(path.join(this.dir, 'settings.json'), {
        hooks: {
          PermissionRequest: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: this.target.stopHookCommand(this.targetFile('bin', this.target.permissionHookFile)),
                  timeout: PERMISSION_TIMEOUT_SEC,
                },
              ],
            },
          ],
        },
      });
      this.timers.push(setInterval(() => this.pollPermissions(), 300));
      this.startClaude();
    } else {
      this.setStatus('ready');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    await this.kill();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot delete ${this.dir}: ${errMsg(err)}`);
    }
  }

  private async kill(): Promise<void> {
    const pid = this.proc?.pid;
    this.proc = null;
    if (pid) await killHostTree(pid).catch(() => undefined);
    await this.target.killLeftovers(this.ctx.runId).catch(() => undefined);
  }

  /** Stop: end the agent's turn. The conversation goes on with the next message. */
  async stop(): Promise<void> {
    if (!this.proc || this.closed) return;
    this.stopping = true;
    this.permissions = [];
    await this.kill();
  }

  // ---------- the session ----------

  private targetFile(...parts: string[]): string {
    return joinTarget(this.target.kind, this.target.toTargetPath(this.dir), ...parts);
  }

  private launcher(name: string, body: string): { command: string; args: string[] } {
    const exec = this.target.kind === 'windows' ? '' : 'exec ';
    return writeLauncher(this.ctx, name, exec + body, this.harness.env).spec;
  }

  /** The task's own model, effort and permission mode, as a run would pass them. */
  private startClaude(): void {
    const q = (s: string) => this.target.quote(s);
    const a = this.task.agent;
    const parts = [this.harness.command];
    if (a.model) parts.push('--model', q(a.model));
    const effort = resolveEffort(a, this.harness);
    if (effort) parts.push('--effort', q(effort));
    if (a.permissionMode) parts.push('--permission-mode', q(a.permissionMode));
    if (this.sessionId) parts.push('--resume', q(this.sessionId));
    parts.push('--settings', q(this.targetFile('settings.json')));
    // A question form needs answers Looper can't collect: the agent asks in the conversation instead.
    parts.push('--disallowedTools', 'AskUserQuestion');
    parts.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of a.extraArgs) parts.push(q(extra));
    this.spawnProc(this.launcher('chat', parts.join(' ')), () => {
      if (this.closed) return;
      if (this.stopping) {
        this.afterStop();
        return;
      }
      // The one process is the whole conversation: once it is gone, so is the chat.
      this.end(this.exitText('The session ended.'));
    });
    if (this.status !== 'working') this.setStatus('ready');
  }

  /** One codex turn: `codex exec`, resuming the thread after the first. */
  private startCodexTurn(p: Pending): void {
    this.codexTurns += 1;
    const q = (s: string) => this.target.quote(s);
    const a = this.task.agent;
    const images = p.attachments.filter((x) => x.image && imageMediaType(x.path));
    const files = p.attachments.filter((x) => !images.includes(x)).map((x) => this.target.toTargetPath(x.path));
    const promptFile = `turn-${this.codexTurns}.txt`;
    writeText(path.join(this.dir, promptFile), withFileList(p.text, files) || 'See the attached image.');
    const parts = [this.harness.command, 'exec', ...codexPermissionArgs(a.permissionMode, false)];
    if (a.model) parts.push('--model', q(a.model));
    const effort = resolveEffort(a, this.harness);
    if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
    if (this.sessionId) parts.push('resume', q(this.sessionId));
    parts.push('--json', '--skip-git-repo-check');
    // The equals form: `exec`'s --image takes several values and would swallow the prompt.
    for (const img of images) parts.push(q(`--image=${this.target.toTargetPath(img.path)}`));
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of a.extraArgs) parts.push(q(extra));
    parts.push(this.target.catFile(this.targetFile(promptFile)));
    this.setStatus('working');
    this.spawnProc(this.launcher(`turn-${this.codexTurns}`, parts.join(' ')), (code) => {
      if (this.closed) return;
      if (this.stopping) {
        this.afterStop();
        return;
      }
      if (code !== 0) this.acc.addNote(this.exitText(`Codex exited with code ${code}.`));
      this.setStatus('ready');
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queued.length === 0) return;
    const next: Pending = {
      text: this.queued.map((x) => x.text).filter(Boolean).join('\n\n'),
      attachments: this.queued.flatMap((x) => x.attachments),
    };
    this.queued = [];
    this.startCodexTurn(next);
  }

  private afterStop(): void {
    this.stopping = false;
    this.acc.addNote('Stopped.');
    this.setStatus('ready');
    this.drainQueue();
  }

  private spawnProc(spec: { command: string; args: string[] }, onExit: (code: number | null) => void): void {
    this.stdoutBuf = '';
    this.stderrTail = '';
    const child = spawn(spec.command, spec.args, {
      cwd: this.dir,
      env: childEnv(),
      stdio: [this.claude ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => this.onStdout(d));
    child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.stdin?.on('error', () => {
      /* the process went away mid-write; its exit reports why */
    });
    child.on('error', (err) => {
      if (!this.closed) this.end(`Couldn't start ${this.harness.name}: ${err.message}`);
    });
    child.on('close', (code) => {
      if (this.proc === child) this.proc = null;
      if (this.stdoutBuf.trim()) this.onLine(this.stdoutBuf.trim());
      this.stdoutBuf = '';
      onExit(code);
    });
    this.d.log.info(`[${this.taskId}] chat ${this.id}: ${spec.command} ${spec.args.join(' ')}`);
  }

  private exitText(fallback: string): string {
    const err = this.stderrTail
      .replace(/^bash: (cannot set terminal process group|no job control in this shell).*$\n?/gm, '')
      .trim();
    return err ? `${fallback}\n${err.split('\n').slice(-6).join('\n')}` : fallback;
  }

  private onStdout(d: string): void {
    this.stdoutBuf += d;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.acc.addLine(line);
    if (this.claude) {
      if (rec.type === 'system' && rec.subtype === 'init' && typeof rec.session_id === 'string') this.sessionId = rec.session_id;
      if (rec.type === 'result') this.setStatus('ready', false);
    } else if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') {
      this.sessionId = rec.thread_id;
    }
    this.scheduleEmit();
  }

  send(text: string, attachments: Attachment[]): void {
    const t = text.trim();
    if (this.closed || this.status === 'ended' || (!t && attachments.length === 0)) return;
    this.acc.addPrompt(t, attachments);
    if (this.claude) {
      // After a Stop the process is gone: a new one resumes the conversation.
      if (!this.proc) this.startClaude();
      const msg = claudeUserMessage(t, attachments, (p) => this.target.toTargetPath(p));
      this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
      this.setStatus('working');
    } else if (this.status === 'working') {
      this.queued.push({ text: t, attachments });
      this.scheduleEmit();
    } else {
      this.startCodexTurn({ text: t, attachments });
    }
  }

  // ---------- permission requests (claude) ----------

  private pollPermissions(): void {
    const dir = path.join(this.dir, 'permissions');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.req') || this.takenRequests.has(name)) continue;
      this.takenRequests.add(name);
      const id = name.slice(0, -4);
      try {
        const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
        this.permissions.push({ id, tool: String(req.tool_name ?? 'tool'), input: req.tool_input ?? {} });
        this.scheduleEmit();
      } catch (err) {
        // Unreadable: refuse it rather than leave the agent waiting for nobody.
        this.d.log.warn(`chat ${this.id}: unreadable permission request ${name}: ${errMsg(err)}`);
        this.writeAnswer(id, permissionAnswer(false, {}));
      }
    }
  }

  answerPermission(requestId: string, allow: boolean): void {
    const p = this.permissions.find((x) => x.id === requestId);
    if (!p) return;
    this.permissions = this.permissions.filter((x) => x !== p);
    this.writeAnswer(requestId, permissionAnswer(allow, p.input));
    this.scheduleEmit();
  }

  private writeAnswer(id: string, json: string): void {
    const file = path.join(this.dir, 'permissions', `${id}.ans`);
    try {
      // Whole or not at all: the hook prints the answer as soon as the file exists.
      fs.writeFileSync(`${file}.tmp`, json);
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot answer permission request ${id}: ${errMsg(err)}`);
    }
  }

  // ---------- state ----------

  private setStatus(status: ChatState['status'], emitNow = true): void {
    if (this.status === 'ended') return;
    this.status = status;
    if (emitNow) this.scheduleEmit();
  }

  private end(error: string): void {
    this.status = 'ended';
    this.error = error;
    this.permissions = [];
    this.d.log.warn(`chat ${this.id} ended: ${error}`);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.closed) this.d.emit({ type: 'chat', state: this.state() });
    }, 100);
  }

  /** The chat is doing something closing would cut short: a turn, or a question to the user. */
  busy(): boolean {
    return this.status === 'working' || this.permissions.length > 0;
  }

  state(): ChatState {
    const kind = this.claude ? 'claude-code' : 'codex';
    const mode = this.task.agent.permissionMode ?? '';
    return {
      id: this.id,
      taskId: this.taskId,
      taskName: this.task.name,
      harnessName: this.harness.name,
      harnessKind: kind,
      ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
      permissionLabel: PERMISSION_MODES[kind].find(([v]) => v === mode)?.[1] ?? mode,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      history: this.history,
      rows: this.acc.rows,
      permissions: this.permissions,
    };
  }
}

/** The open task chats, one per chat window. */
export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly d: ChatDeps) {}

  /** Delete the folders of chats a Looper that quit (or crashed) left behind. */
  sweep(): void {
    fs.rmSync(path.join(this.d.dataDir, 'chats'), { recursive: true, force: true });
  }

  /** Start a chat on the task, resuming the run's conversation when given one. Throws with the reason. */
  start(task: Task, fromRunId?: string): ChatState {
    const session = new ChatSession(this.d, task, fromRunId);
    this.sessions.set(session.id, session);
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(session.id);
      void session.close();
      throw err;
    }
    return session.state();
  }

  get(id: string): ChatState | undefined {
    return this.sessions.get(id)?.state();
  }

  taskOf(id: string): string | undefined {
    return this.sessions.get(id)?.taskId;
  }

  send(id: string, text: string, attachments: Attachment[]): void {
    this.sessions.get(id)?.send(text, attachments);
  }

  async stop(id: string): Promise<void> {
    await this.sessions.get(id)?.stop();
  }

  answer(id: string, requestId: string, allow: boolean): void {
    this.sessions.get(id)?.answerPermission(requestId, allow);
  }

  /** Chats in the middle of a turn or waiting on the user: quitting would cut them short. */
  busy(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.busy()) n++;
    return n;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
