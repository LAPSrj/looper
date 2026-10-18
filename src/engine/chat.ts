import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  chatTitle,
  forkPoint,
  type Attachment,
  type ChatContext,
  type ChatInfo,
  type ChatPermissionRequest,
  type ChatSettings,
  type ChatState,
} from '../shared/chat';
import {
  codexPermissionArgs,
  harnessKindLabel,
  harnessModels,
  projectMcpApproval,
  resolveEffort,
  resolveEnvironment,
  resolveHarness,
} from '../shared/environments';
import type { MessageRow } from '../shared/messages';
import type { EngineEvent, Harness, RunRecord, Settings, Task } from '../shared/types';
import { ClaudeStreamAccumulator, CodexExecAccumulator } from './builder/stream';
import { contextOfLine, readCodexContextWindow, readContextTokens } from './context';
import type { HostKind } from './host';
import { errMsg, type Logger } from './log';
import { findCodexRollout, transcriptHostPath } from './messages';
import { childEnv, writeLauncher, type RunContext } from './steps/common';
import { recordCodexHome } from './steps/session';
import { writeJsonAtomic, writeText } from './store/fsutil';
import { newRunId } from './store/runs';
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

/**
 * Claude's stream-json control request that switches the permission mode of
 * the running session. '' (no mode) is the CLI's default mode.
 */
export function permissionModeRequest(requestId: string, mode: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode: mode || 'default' } });
}

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/** The turn of Codex's thread (as `thread/turns/list` lists it) holding the `occurrence`-th agent message with this text. */
export function forkTurnId(turns: unknown[], text: string, occurrence: number): string | null {
  let seen = 0;
  for (const turn of turns) {
    const t = obj(turn);
    const items = Array.isArray(t?.items) ? t.items : [];
    for (const item of items) {
      const i = obj(item);
      if (i?.type !== 'agentMessage' || typeof i.text !== 'string' || i.text.trim() !== text) continue;
      seen += 1;
      if (seen === occurrence) return typeof t?.id === 'string' ? t.id : null;
    }
  }
  return null;
}

/** How long Codex's app server gets to copy a thread. */
const FORK_TIMEOUT_MS = 60_000;

/**
 * Fork a Codex thread through the turn holding an agent message, over the
 * app server's JSON-RPC on stdio (`codex app-server`): list the thread's
 * turns, then `thread/fork` with that turn as the last one. Returns the new
 * thread's id; rejects with the reason.
 */
export function codexForkThread(
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'on'>,
  threadId: string,
  text: string,
  occurrence: number,
  timeoutMs = FORK_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const waiting = new Map<number, (msg: Rec) => void>();
    let seq = 0;
    let done = false;
    const finish = (err: Error | null, id?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      if (err) reject(err);
      else resolve(id!);
    };
    const timer = setTimeout(() => finish(new Error("Codex's app server didn't answer in time.")), timeoutMs);
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let msg: Rec | null;
      try {
        msg = obj(JSON.parse(line));
      } catch {
        return;
      }
      // Answers carry the request's id; the server's own requests and notifications don't concern a fork.
      if (!msg || typeof msg.id !== 'number' || !('result' in msg || 'error' in msg)) return;
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    child.on('error', (err: Error) => finish(err));
    child.on('close', () => finish(new Error("Codex's app server ended before the fork was made.")));
    child.stdin?.on('error', () => {
      /* the close reports it */
    });
    const send = (msg: Rec) => child.stdin?.write(JSON.stringify(msg) + '\n');
    const call = (method: string, params: Rec): Promise<Rec> =>
      new Promise((ok, fail) => {
        const id = ++seq;
        waiting.set(id, (msg) => {
          const error = obj(msg.error);
          if (error) fail(new Error(String(error.message ?? `${method} failed`)));
          else ok(obj(msg.result) ?? {});
        });
        send({ id, method, params });
      });
    void (async () => {
      await call('initialize', { clientInfo: { name: 'looper', version: '1' } });
      send({ method: 'initialized' });
      const turns: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await call('thread/turns/list', {
          threadId,
          sortDirection: 'asc',
          itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        });
        if (Array.isArray(page.data)) turns.push(...page.data);
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      const lastTurnId = forkTurnId(turns, text, occurrence);
      if (!lastTurnId) throw new Error("Codex's thread doesn't have this message.");
      const res = await call('thread/fork', { threadId, lastTurnId, excludeTurns: true });
      const id = obj(res.thread)?.id;
      if (typeof id !== 'string' || !id) throw new Error("Codex's app server didn't name the new thread.");
      finish(null, id);
    })().catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/** The model's context window from claude's `result` record (modelUsage per model): the named model's, else the only one. */
export function claudeContextWindow(result: Rec, model: string | undefined): number | undefined {
  const usage = obj(result.modelUsage);
  if (!usage) return undefined;
  const entries = Object.entries(usage);
  const entry = obj(model ? usage[model] : undefined) ?? (entries.length === 1 ? obj(entries[0][1]) : null);
  const w = entry?.contextWindow;
  return typeof w === 'number' && w > 0 ? w : undefined;
}

/**
 * Claude runs one process for the whole chat, and only the permission mode
 * changes while it runs (Bypass excepted: the CLI refuses it unless started
 * with it). A new model, effort or Bypass needs a new process that resumes
 * the conversation.
 */
export function needsNewProcess(
  launched: { model?: string; effort?: string; bypass: boolean },
  next: ChatSettings,
  nextEffort: string | undefined,
): boolean {
  return launched.model !== next.model || launched.effort !== nextEffort || (next.permissionMode === 'bypassPermissions' && !launched.bypass);
}

export interface ChatDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  emit: (e: EngineEvent) => void;
  /** The folder of a run: a chat's id is its run id. */
  runDir: (taskId: string, runId: string) => string;
  /** The conversation a run recorded, as rows: a run's (Continue in Chat) or a chat's own (opened again). */
  readHistory: (taskId: string, runId: string) => Promise<MessageRow[]>;
  writeInfo: (taskId: string, runId: string, info: ChatInfo) => void;
  /** Add a record to the task's run log and tell the windows. */
  appendRecord: (record: RunRecord) => void;
  taskVersion: (taskId: string) => number | undefined;
}

interface Pending {
  text: string;
  attachments: Attachment[];
}

/**
 * Fork from Here: the conversation the new chat starts from, until the agent
 * has made its copy. Claude copies it up to a message (by its transcript id);
 * Codex up to the end of the turn holding an agent message (found by its text,
 * the `occurrence`-th time that text appears, counting from 1).
 */
type ForkSource = { sessionId: string; claudeAt: string } | { sessionId: string; codexText: string; occurrence: number };

/** How a chat window starts. */
export type ChatOpening =
  /** Open Project in Chat: a new conversation. */
  | { kind: 'new' }
  /** Continue in Chat on a run that isn't a chat: a new chat that goes on with the run's conversation. */
  | { kind: 'continue'; runId: string; sessionId: string }
  /** Continue in Chat on a chat's run: the chat again, in its own run. */
  | { kind: 'reopen'; runId: string; info: ChatInfo; sessionId: string }
  /** Fork from Here. */
  | {
      kind: 'fork';
      from: string;
      fork?: ForkSource;
      settings: ChatSettings;
      history: MessageRow[];
      draft?: ChatState['draft'];
    };

class ChatSession {
  readonly id: string;
  readonly taskId: string;
  private readonly dir: string;
  private readonly harness: Harness;
  private readonly target: Target;
  private readonly ctx: RunContext;
  private readonly acc: ClaudeStreamAccumulator | CodexExecAccumulator;
  private readonly claude: boolean;
  /** Continue in Chat on a run: the run whose conversation this chat goes on with. */
  readonly fromRunId?: string;
  /** Fork from Here: the chat this one was forked from. */
  private readonly forkedFrom?: string;
  private readonly historyLabel?: string;
  /** Opened again: the run's conversation is read from its transcript. */
  private readonly reopened: boolean;
  /** The chat is a run (the user sent a message, now or before): it has records and a chat.json. */
  private recorded: boolean;
  /** When this window's first message made its "Chat opened" record. */
  private openedAt?: number;
  private title: string;
  private fork?: ForkSource;
  private readonly draft?: ChatState['draft'];
  private settings: ChatSettings;
  private activeModel?: string;
  private context?: ChatContext;
  /** Claude: what the running process was started with. */
  private launched?: { model?: string; effort?: string; bypass: boolean };
  private status: ChatState['status'] = 'starting';
  private error?: string;
  private history: MessageRow[] = [];
  private proc: ChildProcess | null = null;
  /** Codex's app server while it forks the thread. */
  private forkProc: ChildProcess | null = null;
  /** Processes Looper ended (Stop, a restart): their exit isn't the chat's end. */
  private readonly retired = new WeakSet<ChildProcess>();
  /** A Stop or restart is ending the process: messages wait for the next one. */
  private killing = false;
  /** The conversation to go on with: claude's session, codex's thread. */
  sessionId?: string;
  private codexTurns = 0;
  private codexRollout?: string;
  /** Messages sent while codex runs a turn, or while claude's process is replaced. */
  private queued: Pending[] = [];
  private permissions: ChatPermissionRequest[] = [];
  private readonly takenRequests = new Set<string>();
  /** Permission mode changes claude hasn't confirmed yet: request id → the mode to go back to. */
  private readonly modeRequests = new Map<string, string>();
  private controlSeq = 0;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: ChatDeps,
    private readonly task: Task,
    opening: ChatOpening,
  ) {
    this.taskId = task.id;
    const own = resolveHarness(task, resolveEnvironment(task, d.settings));
    if (own.kind === 'custom') throw new Error('A chat needs a Claude Code or Codex harness.');
    const info = opening.kind === 'reopen' ? opening.info : undefined;
    if (info && info.harnessKind !== own.kind) {
      throw new Error(`This chat ran on ${harnessKindLabel(info.harnessKind)}, and the task now uses ${harnessKindLabel(own.kind)}.`);
    }
    this.harness = task.agent.command ? { ...own, command: task.agent.command } : own;
    this.claude = own.kind === 'claude-code';
    this.acc = this.claude ? new ClaudeStreamAccumulator() : new CodexExecAccumulator();
    this.id = opening.kind === 'reopen' ? opening.runId : newRunId();
    this.reopened = opening.kind === 'reopen';
    this.recorded = this.reopened;
    this.title = info?.title ?? '';
    this.settings = info?.settings ??
      (opening.kind === 'fork'
        ? opening.settings
        : { model: task.agent.model, effort: task.agent.effort, permissionMode: task.agent.permissionMode ?? '' });
    this.context = info?.context;
    if (opening.kind === 'continue') {
      this.fromRunId = opening.runId;
      this.historyLabel = `Earlier in run ${opening.runId}`;
      this.sessionId = opening.sessionId;
    } else if (opening.kind === 'reopen') {
      this.fromRunId = info?.fromRunId;
      this.forkedFrom = info?.forkedFrom;
      this.sessionId = opening.sessionId;
    } else if (opening.kind === 'fork') {
      this.forkedFrom = opening.from;
      this.historyLabel = `Forked from run ${opening.from}`;
      this.fork = opening.fork;
      this.history = opening.history;
      this.draft = opening.draft;
    }
    this.dir = d.runDir(task.id, this.id);
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
    // Continue in Chat shows the run's conversation; a chat opened again, its own.
    const historyRun = this.reopened ? this.id : this.historyLabel && this.fromRunId ? this.fromRunId : undefined;
    if (historyRun) {
      void this.d
        .readHistory(this.taskId, historyRun)
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
        ...projectMcpApproval(this.harness),
        hooks: {
          // As in a run: the payload names the session and its transcript, which the run window and Continue read.
          SessionStart: [{ hooks: [{ type: 'command', command: this.target.renderPipeHook(this.targetFile('session.json')) }] }],
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
      if (this.sessionId) writeJsonAtomic(path.join(this.dir, 'codex-session.json'), { thread_id: this.sessionId });
      this.setStatus('ready');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.openedAt !== undefined) this.record('closed', Date.now() - this.openedAt);
    this.save();
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.forkProc?.kill();
    await this.kill();
    // A chat nobody wrote in leaves nothing behind; a run keeps its folder, minus the permission requests.
    const gone = this.recorded ? path.join(this.dir, 'permissions') : this.dir;
    try {
      fs.rmSync(gone, { recursive: true, force: true });
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot delete ${gone}: ${errMsg(err)}`);
    }
  }

  private async kill(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (child) this.retired.add(child);
    if (child?.pid) await killHostTree(child.pid).catch(() => undefined);
    await this.target.killLeftovers(this.ctx.runId).catch(() => undefined);
  }

  /** Stop: end the agent's turn. The conversation goes on with the next message. */
  async stop(): Promise<void> {
    if (!this.proc || this.closed || this.killing) return;
    this.killing = true;
    this.permissions = [];
    await this.kill();
    this.killing = false;
    if (this.closed) return;
    this.acc.addNote('Stopped.');
    this.setStatus('ready');
    this.save();
    this.drainQueue();
  }

  /** Claude: a new process with the chat's settings that resumes the conversation. */
  private async restart(): Promise<void> {
    this.killing = true;
    this.setStatus('starting');
    await this.kill();
    this.killing = false;
    if (this.closed || this.status === 'ended') return;
    this.startClaude();
    this.drainQueue();
  }

  // ---------- settings ----------

  /** Chat menu: a new model, effort or permission mode for this chat (the task keeps its own). */
  async configure(patch: Partial<ChatSettings>): Promise<void> {
    if (this.closed || this.status === 'ended' || this.killing) return;
    const prev = this.settings;
    const next: ChatSettings = { ...prev, ...patch };
    // An effort the new model doesn't offer falls back to its default, as in the task editor.
    if ('model' in patch && next.effort) {
      const entry = harnessModels(this.harness).find((m) => m.id === next.model);
      if (entry?.efforts && !entry.efforts.includes(next.effort)) next.effort = undefined;
    }
    // Codex starts a process per turn, and a stopped claude starts one with the next message: both take the settings then.
    if (this.claude && this.proc && this.launched) {
      if (needsNewProcess(this.launched, next, resolveEffort(next, this.harness))) {
        // The Chat menu keeps these off during a turn: a new process would cut it short.
        if (this.busy()) return;
        this.settings = next;
        this.save();
        await this.restart();
        return;
      }
      if (next.permissionMode !== prev.permissionMode) {
        const id = `mode-${++this.controlSeq}`;
        this.modeRequests.set(id, prev.permissionMode);
        this.proc.stdin?.write(permissionModeRequest(id, next.permissionMode) + '\n');
      }
    }
    this.settings = next;
    this.save();
    this.scheduleEmit();
  }

  // ---------- the session ----------

  private targetFile(...parts: string[]): string {
    return joinTarget(this.target.kind, this.target.toTargetPath(this.dir), ...parts);
  }

  /** prelude: lines that run before the harness, which replaces the launcher's shell. */
  private launcher(name: string, body: string, prelude = ''): { command: string; args: string[] } {
    const exec = this.target.kind === 'windows' ? '' : 'exec ';
    return writeLauncher(this.ctx, name, (prelude ? prelude + '\n' : '') + exec + body, this.harness.env).spec;
  }

  /** The chat's model, effort and permission mode, as a run would pass the task's. */
  private startClaude(): void {
    const q = (s: string) => this.target.quote(s);
    const a = this.task.agent;
    const s = this.settings;
    const parts = [this.harness.command];
    if (s.model) parts.push('--model', q(s.model));
    const effort = resolveEffort(s, this.harness);
    if (effort) parts.push('--effort', q(effort));
    if (s.permissionMode) parts.push('--permission-mode', q(s.permissionMode));
    if (this.sessionId) parts.push('--resume', q(this.sessionId));
    else if (this.fork && 'claudeAt' in this.fork) {
      // A new session holding the conversation up to the message; init names it.
      parts.push('--resume', q(this.fork.sessionId), '--fork-session', '--resume-session-at', q(this.fork.claudeAt));
    }
    parts.push('--settings', q(this.targetFile('settings.json')));
    // A question form needs answers Looper can't collect: the agent asks in the conversation instead.
    parts.push('--disallowedTools', 'AskUserQuestion');
    parts.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of a.extraArgs) parts.push(q(extra));
    this.launched = { model: s.model, effort, bypass: s.permissionMode === 'bypassPermissions' };
    this.spawnProc(this.launcher('chat', parts.join(' ')), (_code, stderr) => {
      // The one process is the whole conversation: once it is gone, so is the chat.
      this.end(exitText('The session ended.', stderr));
    });
    if (this.status !== 'working') this.setStatus('ready');
  }

  /** One codex turn: `codex exec`, resuming the thread after the first. */
  private startCodexTurn(p: Pending): void {
    if (this.fork && 'codexText' in this.fork && !this.sessionId) {
      this.forkCodexThen(this.fork, p);
      return;
    }
    this.codexTurns += 1;
    const q = (s: string) => this.target.quote(s);
    const a = this.task.agent;
    const s = this.settings;
    const images = p.attachments.filter((x) => x.image && imageMediaType(x.path));
    const files = p.attachments.filter((x) => !images.includes(x)).map((x) => this.target.toTargetPath(x.path));
    const promptFile = `turn-${this.codexTurns}.txt`;
    writeText(path.join(this.dir, promptFile), withFileList(p.text, files) || 'See the attached image.');
    const parts = [this.harness.command, 'exec', ...codexPermissionArgs(s.permissionMode, false)];
    if (s.model) parts.push('--model', q(s.model));
    const effort = resolveEffort(s, this.harness);
    if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
    if (this.sessionId) parts.push('resume', q(this.sessionId));
    parts.push('--json', '--skip-git-repo-check');
    // The equals form: `exec`'s --image takes several values and would swallow the prompt.
    for (const img of images) parts.push(q(`--image=${this.target.toTargetPath(img.path)}`));
    for (const arg of this.harness.args) parts.push(q(arg));
    for (const extra of a.extraArgs) parts.push(q(extra));
    parts.push(this.target.catFile(this.targetFile(promptFile)));
    // The rollout behind the context size lives under codex's home, which only the target knows.
    const prelude = recordCodexHome(this.target.kind, q(this.targetFile('codex-home')));
    this.setStatus('working');
    this.spawnProc(this.launcher(`turn-${this.codexTurns}`, parts.join(' '), prelude), (code, stderr) => {
      if (code !== 0) this.acc.addNote(exitText(`Codex exited with code ${code}.`, stderr));
      this.setStatus('ready');
      void this.readCodexContext().finally(() => this.save());
      this.drainQueue();
    });
  }

  /**
   * Fork from Here on Codex: `codex exec` can only copy a whole thread, so
   * Codex's app server copies it through the turn, and the message goes to
   * the copy. When the copy fails the message stays unsent, and the next one
   * tries again.
   */
  private forkCodexThen(fork: { sessionId: string; codexText: string; occurrence: number }, p: Pending): void {
    this.setStatus('working');
    const spec = this.launcher('fork', `${this.harness.command} app-server`);
    const child = spawn(spec.command, spec.args, { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.forkProc = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-2000);
    });
    this.d.log.info(`[${this.taskId}] chat ${this.id}: forking codex thread ${fork.sessionId}`);
    void codexForkThread(child, fork.sessionId, fork.codexText, fork.occurrence)
      .then(
        (threadId) => {
          if (this.closed) return;
          this.setSession(threadId);
          this.startCodexTurn(p);
        },
        (err: unknown) => {
          if (this.closed) return;
          this.acc.addNote(exitText(`Couldn't fork the conversation: ${errMsg(err)}`, stderr));
          this.setStatus('ready');
          this.drainQueue();
        },
      )
      .finally(() => {
        this.forkProc = null;
        if (child.pid) void killHostTree(child.pid).catch(() => undefined);
      });
  }

  /** The conversation the chat goes on with from now: a fork is made once it has its own. */
  private setSession(id: string): void {
    if (this.sessionId === id) return;
    this.sessionId = id;
    this.fork = undefined;
    // Codex reports no transcript path: the run window and Continue find the rollout by the thread id.
    if (!this.claude) writeJsonAtomic(path.join(this.dir, 'codex-session.json'), { thread_id: id });
  }

  /** Send what waited: codex's next turn takes it all at once, claude gets each message. */
  private drainQueue(): void {
    if (this.queued.length === 0 || this.killing) return;
    if (this.claude) {
      const waiting = this.queued;
      this.queued = [];
      for (const p of waiting) this.writeClaude(p);
      return;
    }
    if (this.status === 'working') return;
    const next: Pending = {
      text: this.queued.map((x) => x.text).filter(Boolean).join('\n\n'),
      attachments: this.queued.flatMap((x) => x.attachments),
    };
    this.queued = [];
    this.startCodexTurn(next);
  }

  /** onExit runs only when the process ends by itself, not when Looper ended it. */
  private spawnProc(spec: { command: string; args: string[] }, onExit: (code: number | null, stderr: string) => void): void {
    let stdoutBuf = '';
    let stderrTail = '';
    const child = spawn(spec.command, spec.args, {
      cwd: this.dir,
      env: childEnv(),
      stdio: [this.claude ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = child;
    const live = () => !this.closed && !this.retired.has(child);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (!live()) return;
      stdoutBuf += d;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr?.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.stdin?.on('error', () => {
      /* the process went away mid-write; its exit reports why */
    });
    child.on('error', (err) => {
      if (live()) this.end(`Couldn't start ${this.harness.name}: ${err.message}`);
    });
    child.on('close', (code) => {
      if (this.proc === child) this.proc = null;
      if (!live()) return;
      if (stdoutBuf.trim()) this.onLine(stdoutBuf.trim());
      onExit(code, stderrTail);
    });
    this.d.log.info(`[${this.taskId}] chat ${this.id}: ${spec.command} ${spec.args.join(' ')}`);
  }

  private onLine(line: string): void {
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      return;
    }
    this.acc.addLine(line);
    if (this.claude) this.onClaudeRecord(rec, line);
    else if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') this.setSession(rec.thread_id);
    this.scheduleEmit();
  }

  private onClaudeRecord(rec: Rec, line: string): void {
    if (rec.type === 'system' && rec.subtype === 'init') {
      if (typeof rec.session_id === 'string') this.setSession(rec.session_id);
      if (typeof rec.model === 'string') this.activeModel = rec.model;
    } else if ((rec.type === 'assistant' && rec.parent_tool_use_id == null) || (rec.type === 'system' && rec.subtype === 'compact_boundary')) {
      // A subagent's messages (parent_tool_use_id set) fill its own context, not the chat's.
      const tokens = contextOfLine(line, 'claude');
      if (typeof tokens === 'number') this.context = { tokens, window: this.context?.window };
      else if (tokens === 'unknown') this.context = undefined;
    } else if (rec.type === 'control_response') {
      const res = obj(rec.response);
      const id = typeof res?.request_id === 'string' ? res.request_id : '';
      const back = this.modeRequests.get(id);
      if (back === undefined) return;
      this.modeRequests.delete(id);
      if (res?.subtype === 'error') {
        this.settings = { ...this.settings, permissionMode: back };
        this.acc.addNote(`Couldn't change the permission mode: ${String(res.error ?? 'unknown error')}`);
        this.save();
      }
    } else if (rec.type === 'result') {
      const window = claudeContextWindow(rec, this.activeModel);
      if (this.context && window) this.context = { ...this.context, window };
      this.setStatus('ready', false);
      this.save();
    }
  }

  /** Codex: the context size and window from the thread's rollout, after each turn. */
  private async readCodexContext(): Promise<void> {
    if (!this.sessionId) return;
    try {
      if (!this.codexRollout) {
        const home = fs.readFileSync(path.join(this.dir, 'codex-home'), 'utf8').trim();
        const env = resolveEnvironment(this.task, this.d.settings);
        const hostHome = await transcriptHostPath(home, this.d.host, env.kind === 'wsl' ? env.distro : undefined);
        if (!hostHome) return;
        this.codexRollout = (await findCodexRollout(path.join(hostHome, 'sessions'), this.sessionId)) ?? undefined;
        if (!this.codexRollout) return;
      }
      const [tokens, window] = await Promise.all([readContextTokens(this.codexRollout, 'codex'), readCodexContextWindow(this.codexRollout)]);
      this.context = tokens === null ? undefined : { tokens, window: window ?? undefined };
      this.scheduleEmit();
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot read codex context: ${errMsg(err)}`);
    }
  }

  send(text: string, attachments: Attachment[]): void {
    const t = text.trim();
    if (this.closed || this.status === 'ended' || (!t && attachments.length === 0)) return;
    this.acc.addPrompt(t, attachments);
    this.markOpened();
    if (this.killing || (!this.claude && this.status === 'working')) {
      this.queued.push({ text: t, attachments });
      this.scheduleEmit();
    } else if (this.claude) {
      this.writeClaude({ text: t, attachments });
    } else {
      this.startCodexTurn({ text: t, attachments });
    }
  }

  private writeClaude(p: Pending): void {
    // After a Stop the process is gone: a new one resumes the conversation.
    if (!this.proc) this.startClaude();
    const msg = claudeUserMessage(p.text, p.attachments, (x) => this.target.toTargetPath(x));
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
    this.setStatus('working');
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
        const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')) as Rec;
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
    this.save();
    this.scheduleEmit();
  }

  /**
   * The window's first message: the chat becomes a run (a chat that only
   * shows a run's conversation isn't one yet), and the run list gets a
   * "Chat opened" record.
   */
  private markOpened(): void {
    if (this.openedAt !== undefined) return;
    this.openedAt = Date.now();
    if (!this.recorded) {
      this.recorded = true;
      this.title = chatTitle(this.acc.rows);
    }
    this.record('opened');
    this.save();
  }

  private record(event: 'opened' | 'closed', durationMs?: number): void {
    const version = this.d.taskVersion(this.taskId);
    this.d.appendRecord({
      ts: new Date().toISOString(),
      taskId: this.taskId,
      runId: this.id,
      phase: 'chat',
      result: 'chat',
      summary: this.title,
      ...(durationMs !== undefined ? { durationMs } : {}),
      detail: {
        event,
        ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
        ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
      },
      ...(version !== undefined ? { taskVersion: version } : {}),
    });
  }

  /** The chat's chat.json: what Continue in Chat opens it again with. */
  private save(): void {
    if (this.closed || !this.recorded) return;
    try {
      this.d.writeInfo(this.taskId, this.id, {
        harnessKind: this.claude ? 'claude-code' : 'codex',
        title: this.title,
        settings: this.settings,
        ...(this.context ? { context: this.context } : {}),
        ...(this.fromRunId ? { fromRunId: this.fromRunId } : {}),
        ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
      });
    } catch (err) {
      this.d.log.warn(`chat ${this.id}: cannot save: ${errMsg(err)}`);
    }
  }

  /** Fork from Here on the row at `index` of the history and rows: how the new chat starts. Throws with the reason. */
  forkAt(index: number): Extract<ChatOpening, { kind: 'fork' }> {
    const rows = [...this.history, ...this.acc.rows];
    const point = forkPoint(rows, index, this.claude ? 'claude-code' : 'codex', this.status === 'working');
    if (!point) throw new Error("The chat can't be forked from this message.");
    let fork: ForkSource | undefined;
    if (point.at) {
      const sessionId = this.sessionId ?? this.fork?.sessionId;
      // A fork that hasn't sent anything yet forks its source again.
      if (!sessionId) throw new Error("The conversation hasn't started yet.");
      if (this.claude) fork = { sessionId, claudeAt: point.at.uuid! };
      else {
        const text = point.at.text.trim();
        const occurrence = rows.slice(0, point.keep).filter((r) => r.kind === 'agent' && r.text.trim() === text).length;
        fork = { sessionId, codexText: text, occurrence };
      }
    }
    return {
      kind: 'fork',
      from: this.id,
      ...(fork ? { fork } : {}),
      settings: this.settings,
      history: rows.slice(0, point.keep),
      ...(point.draft ? { draft: { text: point.draft.text, attachments: point.draft.attachments ?? [] } } : {}),
    };
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
    return {
      id: this.id,
      taskId: this.taskId,
      taskName: this.task.name,
      harnessName: this.harness.name,
      harnessKind: this.claude ? 'claude-code' : 'codex',
      ...(this.historyLabel ? { historyLabel: this.historyLabel } : {}),
      ...(this.draft ? { draft: this.draft } : {}),
      settings: this.settings,
      models: harnessModels(this.harness),
      ...(this.activeModel ? { activeModel: this.activeModel } : {}),
      ...(this.context ? { context: this.context } : {}),
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      history: this.history,
      rows: this.acc.rows,
      permissions: this.permissions,
    };
  }
}

function exitText(fallback: string, stderr: string): string {
  const err = stderr.replace(/^bash: (cannot set terminal process group|no job control in this shell).*$\n?/gm, '').trim();
  return err ? `${fallback}\n${err.split('\n').slice(-6).join('\n')}` : fallback;
}

/** The open task chats, one per chat window. */
export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly d: ChatDeps) {}

  /** Start a chat on the task. Throws with the reason. */
  start(task: Task, opening: ChatOpening): ChatState {
    return this.open(new ChatSession(this.d, task, opening));
  }

  /**
   * The open chat holding a run's conversation: the run's own chat, a chat
   * that went on with the run, or one on the same session.
   */
  findOpen(taskId: string, runId: string, sessionId: string): ChatState | undefined {
    for (const s of this.sessions.values()) {
      if (s.taskId !== taskId) continue;
      if (s.id === runId || s.fromRunId === runId || s.sessionId === sessionId) return s.state();
    }
    return undefined;
  }

  /** Fork from Here: a new chat with the conversation up to the row at `index` of the chat's history and rows. */
  fork(task: Task, chatId: string, index: number): ChatState {
    const source = this.sessions.get(chatId);
    if (!source) throw new Error('This chat is closed.');
    return this.start(task, source.forkAt(index));
  }

  private open(session: ChatSession): ChatState {
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

  /** The chats with a window open: run-log pruning leaves their runs alone. */
  openIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  /** Whether the task has a chat open: clearing its run history would delete the chat's folder. */
  hasOpen(taskId: string): boolean {
    return [...this.sessions.values()].some((s) => s.taskId === taskId);
  }

  send(id: string, text: string, attachments: Attachment[]): void {
    this.sessions.get(id)?.send(text, attachments);
  }

  async stop(id: string): Promise<void> {
    await this.sessions.get(id)?.stop();
  }

  async configure(id: string, patch: Partial<ChatSettings>): Promise<void> {
    await this.sessions.get(id)?.configure(patch);
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
