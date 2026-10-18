import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BuilderDraft, BuilderSetup, BuilderState, BuilderTest, ProbeOperation } from '../../shared/builder';
import { EXAMPLE_TASK } from '../../shared/example-task';
import { stripAnsi } from '../../shared/ansi';
import { autoTrustWorkspace, resolveEffort, resolveHarness, codexPermissionArgs } from '../../shared/environments';
import { taskSchemaDoc } from '../../shared/schema-doc';
import { TaskSchema, type EngineEvent, type Environment, type Harness, type Settings, type Task } from '../../shared/types';
import { validateTask } from '../../shared/validate';
import { changedFields, definitionOf, STATUS_FIELDS } from '../../shared/versions';
import type { HostKind } from '../host';
import { errMsg, type Logger } from '../log';
import { runCheck } from '../steps/check';
import { AGENT_DONE, childEnv, writeLauncher, type RunContext } from '../steps/common';
import { spawnPty, startSession, type SessionHandle, type SessionProc } from '../steps/session';
import { writeJsonAtomic, writeText } from '../store/fsutil';
import type { FileContent, VersionStore } from '../store/versions';
import { createTarget, type Target } from '../target';
import { killHostTree } from '../target/kill';
import { joinTarget } from '../target/paths';
import { taskHostPath } from '../task-files';
import { codexFileChanges, contentBeforeCodexEdits } from './patch';
import { PROBE_SCHEMA, PROBE_SYSTEM_PROMPT, builderSystemPrompt } from './prompt';
import { ClaudeStreamAccumulator, CodexExecAccumulator } from './stream';

export interface BuilderDeps {
  dataDir: string;
  host: HostKind;
  settings: Settings;
  log: Logger;
  emit: (e: EngineEvent) => void;
  getTask: (id: string) => Task | undefined;
  listTasks: () => Task[];
  /** Undo/Redo reads the saved versions and their files. */
  versions: VersionStore;
}

const sameContent = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b));

/** One Undo/Redo step: the draft file's text and the touched files' content (a file not in it held its `before`). */
interface Step {
  draft: string;
  files: Map<string, Buffer | null>;
  /** The step is a saved version loaded from Version History. */
  fromVersion?: number;
}

/** The helpers on the builder's PATH: command -> request op. */
const HELPERS = { 'looper-validate': 'validate', 'looper-test': 'test' };

/** Longest an access probe may run. */
const PROBE_MAX_MS = 10 * 60_000;
/** How long the builder's shell lets a helper wait for its answer: past the probe's limit. */
const HELPER_TIMEOUT_MS = PROBE_MAX_MS + 60_000;
/** Bytes of terminal output kept for a window that attaches late (terminal view). */
const TERMINAL_BUFFER = 262_144;

/** Tools whose calls write a file (claude). */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * One task builder: a harness session in the task's working directory that
 * keeps a task definition in its draft file, with the request loop behind
 * `looper-validate` and `looper-test`. Everything lives in
 * <dataDir>/builder/<id>, deleted when the window closes.
 */
class BuilderSession {
  readonly id: string;
  private readonly dir: string;
  private readonly env: Environment;
  private readonly harness: Harness;
  private readonly target: Target;
  private readonly ctx: RunContext;
  private mode: 'new' | 'edit';
  private taskId?: string;
  private status: BuilderState['status'] = 'starting';
  private error?: string;
  private readonly view: 'chat' | 'terminal';
  private readonly acc: ClaudeStreamAccumulator | CodexExecAccumulator;
  private draft: BuilderDraft = { errors: [] };
  private draftMtime = 0;
  private readonly tests: BuilderTest[] = [];
  private readonly files = new Set<string>();
  private readonly before = new Map<string, Buffer | null>();
  /** Files whose before-state came from codex's own record of its patches (not a best-effort read). */
  private readonly exactBefore = new Set<string>();
  /** Chat: the claude process (one for the whole conversation) or the codex turn running now. */
  private proc: ChildProcess | null = null;
  private pty: SessionProc | null = null;
  private terminalBuffer = '';
  private stdoutBuf = '';
  private stderrTail = '';
  private codexThread?: string;
  private codexTurns = 0;
  /** Messages sent while a codex turn was running; the next turn takes them together. */
  private queued: string[] = [];
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private readonly testAborts = new Set<AbortController>();
  private readonly probes = new Set<SessionHandle>();
  private readonly takenRequests = new Set<string>();
  /** Each touched file's content at the last save; a file not in it still holds what `before` has. */
  private readonly savedContent = new Map<string, Buffer | null>();
  /** Files changed since the last save, for the ones whose earlier content Looper couldn't read. */
  private readonly changedSinceSave = new Set<string>();
  /** The touched files that differ from their saved content (refreshed after each change). */
  private changedFiles: string[] = [];
  private dirtyTimer: NodeJS.Timeout | null = null;
  /** The new task's starting draft: until the draft differs from it, there is nothing to save. */
  private initialJson = '';
  /**
   * Undo/Redo: the work in progress after each change, oldest first. A step
   * is added when an agent turn (or, in the terminal view, a burst of the
   * agent's changes) leaves the draft or a file different, and when a saved
   * version is loaded. Undo and Redo move `stepIndex`; a new step drops the
   * ones ahead of it.
   */
  private steps: Step[] = [];
  private stepIndex = 0;
  /** Steps are taken and applied one at a time. */
  private stepQueue: Promise<void> = Promise.resolve();
  private stepTimer: NodeJS.Timeout | null = null;
  /** Undo/Redo or a loaded version changed the draft since the agent's last message: the next one tells it. */
  private movedByUser = false;

  constructor(
    private readonly d: BuilderDeps,
    private readonly setup: BuilderSetup,
  ) {
    this.id = randomUUID().slice(0, 8);
    this.dir = path.join(d.dataDir, 'builder', this.id);
    const env = d.settings.environments.find((e) => e.id === setup.environmentId);
    if (!env) throw new Error('This environment no longer exists.');
    this.env = env;
    const harness = env.harnesses.find((h) => h.id === setup.harnessId);
    if (!harness) throw new Error('This harness no longer exists.');
    if (harness.kind === 'custom') throw new Error('Choose a Claude Code or Codex harness.');
    this.harness = harness;
    if (!setup.cwd.trim()) throw new Error('Choose the working directory.');
    this.mode = setup.taskId ? 'edit' : 'new';
    this.taskId = setup.taskId;
    this.view = d.settings.builder.view;
    this.acc = harness.kind === 'codex' ? new CodexExecAccumulator() : new ClaudeStreamAccumulator();
    // The builder's own launcher context: a stand-in task carrying the
    // environment, folder and variables, so the launcher, PATH helpers and
    // path translation work exactly as for a run.
    const stand = TaskSchema.parse({
      id: `builder-${this.id}`,
      name: 'Task builder',
      environmentId: env.id,
      cwd: setup.cwd,
      trigger: { mode: 'manual' },
      agent: { harnessId: harness.id, prompt: '-' },
    });
    this.target = createTarget(stand, { host: d.host, settings: d.settings });
    const dirT = this.target.toTargetPath(this.dir);
    stand.env = {
      LOOPER_BUILDER_DIR: dirT,
      LOOPER_DRAFT_FILE: joinTarget(this.target.kind, dirT, 'draft.json'),
    };
    this.ctx = {
      task: stand,
      runId: `builder-${this.id}`,
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
    fs.mkdirSync(path.join(this.dir, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'responses'), { recursive: true });
    const helpers = this.target.renderRequestHelpers(HELPERS, {
      dirVar: 'LOOPER_BUILDER_DIR',
      script: 'looper-builder',
      hint: 'is the task builder window still open?',
    });
    for (const [name, content] of Object.entries(helpers)) {
      writeText(path.join(this.dir, 'bin', name), content, 0o755);
    }
    const initial = this.initialDraft();
    this.initialJson = JSON.stringify(initial);
    writeJsonAtomic(this.draftHostPath(), initial);
    this.steps = [{ draft: fs.readFileSync(this.draftHostPath(), 'utf8'), files: new Map() }];
    this.readDraft(true);
    writeText(path.join(this.dir, 'system.txt'), this.systemPrompt());
    if (this.harness.kind === 'claude-code') {
      writeJsonAtomic(path.join(this.dir, 'settings.json'), {
        // The helpers must never wait on a permission prompt nobody can answer.
        permissions: { allow: Object.keys(HELPERS).flatMap((c) => [`Bash(${c}:*)`, `Bash(${c})`]) },
        sandbox: { excludedCommands: Object.keys(HELPERS) },
        // An access test can outlast the Bash tool's 2-minute default; its answer must reach the agent.
        env: { BASH_DEFAULT_TIMEOUT_MS: String(HELPER_TIMEOUT_MS), BASH_MAX_TIMEOUT_MS: String(HELPER_TIMEOUT_MS) },
      });
    }
    this.timers.push(setInterval(() => this.readDraft(false), 1000));
    this.timers.push(setInterval(() => void this.pollRequests(), 500));
    if (this.view === 'terminal') this.startTerminal();
    else if (this.harness.kind === 'claude-code') this.startClaude();
    else this.setStatus('ready');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    if (this.stepTimer) clearTimeout(this.stepTimer);
    for (const a of this.testAborts) a.abort();
    await Promise.all([...this.probes].map((p) => p.stop('stopped', 'the window was closed').catch(() => undefined)));
    await this.killSession();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      this.d.log.warn(`task builder ${this.id}: cannot delete ${this.dir}: ${errMsg(err)}`);
    }
  }

  private async killSession(): Promise<void> {
    const pid = this.proc?.pid ?? (this.pty?.pid || undefined);
    this.proc = null;
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
      this.pty = null;
    }
    if (pid) await killHostTree(pid).catch(() => undefined);
    await this.target.killLeftovers(this.ctx.runId).catch(() => undefined);
  }

  // ---------- the session ----------

  private systemPrompt(): string {
    const dirT = this.target.toTargetPath(this.dir);
    return builderSystemPrompt({
      mode: this.mode,
      taskId: this.taskId,
      harnessKind: this.harness.kind as 'claude-code' | 'codex',
      draftFile: joinTarget(this.target.kind, dirT, 'draft.json'),
      builderDir: dirT,
      cwd: this.setup.cwd,
      environmentId: this.env.id,
      schemaDoc: JSON.stringify(taskSchemaDoc()),
      settings: this.d.settings,
      example: JSON.stringify(EXAMPLE_TASK, null, 2),
    });
  }

  /** Claude's flags shared by the chat and terminal views: no user/project config, the builder dir writable. */
  private claudeArgs(): string[] {
    const q = (s: string) => this.target.quote(s);
    const dirT = this.target.toTargetPath(this.dir);
    const parts = [
      // Safe mode drops CLAUDE.md, hooks, skills, plugins and MCP servers; an
      // empty source list also drops the permission rules of every settings
      // file (the equals form survives PowerShell, which drops '' arguments).
      '--safe-mode',
      '--setting-sources=',
      '--permission-mode',
      'auto',
      '--add-dir',
      q(dirT),
      '--settings',
      q(joinTarget(this.target.kind, dirT, 'settings.json')),
      '--append-system-prompt',
      this.target.catFile(joinTarget(this.target.kind, dirT, 'system.txt')),
    ];
    if (this.setup.model) parts.push('--model', q(this.setup.model));
    const effort = this.effort();
    if (effort) parts.push('--effort', q(effort));
    for (const arg of this.harness.args) parts.push(q(arg));
    return parts;
  }

  private effort(): string | undefined {
    return resolveEffort({ model: this.setup.model, effort: this.setup.effort }, this.harness);
  }

  private launcher(name: string, body: string): { command: string; args: string[] } {
    const exec = this.target.kind === 'windows' ? '' : 'exec ';
    return writeLauncher(this.ctx, name, exec + body, this.harness.env).spec;
  }

  /** Codex's home for this builder: a copy of the user's login and nothing else (see renderCodexHomeWrapper). */
  private codexHomeHost(): string {
    return path.join(this.dir, 'codex-home');
  }

  /** A launcher that runs a codex command line in the builder's own codex home. */
  private codexLauncher(name: string, command: string): { command: string; args: string[] } {
    const homeT = this.target.toTargetPath(this.codexHomeHost());
    return writeLauncher(this.ctx, name, this.target.renderCodexHomeWrapper(command, homeT), this.harness.env).spec;
  }

  /**
   * Codex doesn't report a file's old content, but its session file records
   * every patch: undoing them from the file as it is now gives the content
   * from before the builder touched it. A file a shell command also changed
   * keeps the copy read when codex announced the change.
   */
  private async refreshCodexBefore(): Promise<void> {
    // The home is the builder's own, so every session file in it is this builder's.
    let text = '';
    try {
      const files = (await fs.promises.readdir(path.join(this.codexHomeHost(), 'sessions'), { recursive: true }))
        .map(String)
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      for (const f of files) text += (await fs.promises.readFile(path.join(this.codexHomeHost(), 'sessions', f), 'utf8')) + '\n';
    } catch {
      return;
    }
    let noted = false;
    for (const [p, changes] of codexFileChanges(text)) {
      if (this.inBuilderDir(p)) continue;
      if (!this.files.has(p)) {
        this.noteFile(p);
        noted = true;
      }
      if (this.exactBefore.has(p)) continue;
      const hostPath = await taskHostPath(this.ctx.task, p, this.d.host, this.d.settings);
      if (!hostPath) continue;
      let now: string | null;
      try {
        now = await fs.promises.readFile(hostPath, 'utf8');
      } catch {
        now = null;
      }
      const original = contentBeforeCodexEdits(now, changes);
      if (original === undefined) continue;
      this.before.set(p, original === null ? null : Buffer.from(original));
      this.exactBefore.add(p);
    }
    if (noted) {
      this.agentChanged();
      this.scheduleEmit();
    }
  }

  private startClaude(): void {
    const parts = [
      this.harness.command,
      ...this.claudeArgs(),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      // Nobody answers a permission prompt in the chat view: deny it, as a run would.
      '--permission-prompts',
      'none',
    ];
    const spec = this.launcher('builder', parts.join(' '));
    this.spawnChat(spec, () => {
      // The one process is the whole conversation: once it is gone, so is the chat.
      if (!this.closed) this.end(this.exitText('The session ended.'));
    });
    this.setStatus('ready');
  }

  /** One codex turn: `codex exec` for the first, `codex exec resume` after it. */
  private startCodexTurn(text: string): void {
    this.codexTurns += 1;
    const q = (s: string) => this.target.quote(s);
    const dirT = this.target.toTargetPath(this.dir);
    const promptFile = `turn-${this.codexTurns}.txt`;
    // Codex has no system prompt flag: the first turn carries the instructions.
    const prompt =
      this.codexThread === undefined
        ? `${fs.readFileSync(path.join(this.dir, 'system.txt'), 'utf8')}\n\n# The user's first message\n\n${text}`
        : text;
    writeText(path.join(this.dir, promptFile), prompt);
    const parts = [
      this.harness.command,
      'exec',
      '--json',
      '--skip-git-repo-check',
      // The user's config.toml and execpolicy rules stay out; so do project AGENTS.md files.
      '--ignore-user-config',
      '--ignore-rules',
      '-c',
      q('project_doc_max_bytes=0'),
      ...codexPermissionArgs('auto', false),
      ...this.codexAddDir(dirT),
    ];
    if (this.setup.model) parts.push('--model', q(this.setup.model));
    const effort = this.effort();
    if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
    if (this.codexThread) parts.push('resume', q(this.codexThread));
    for (const arg of this.harness.args) parts.push(q(arg));
    parts.push(this.target.catFile(joinTarget(this.target.kind, dirT, promptFile)));
    const spec = this.codexLauncher(`turn-${this.codexTurns}`, parts.join(' '));
    this.setStatus('working');
    this.spawnChat(spec, (code) => {
      if (this.closed) return;
      void this.refreshCodexBefore();
      if (code !== 0 && this.codexThread === undefined) {
        this.end(this.exitText(`Codex exited with code ${code}.`));
        return;
      }
      // A later turn that failed leaves the conversation usable, but says why.
      if (code !== 0) this.acc.addNote(this.exitText(`Codex exited with code ${code}.`));
      this.setStatus('ready');
      if (this.queued.length > 0) {
        const next = this.queued.join('\n\n');
        this.queued = [];
        // After the finished turn's Undo step, which setStatus just queued.
        this.setStatus('working');
        void this.queueStep(async () => this.startCodexTurn(next));
      }
    });
  }

  /**
   * Codex's sandbox must reach the builder dir to write the draft and the
   * helpers' requests. Never with a UNC dir (WSL host, Windows target): the
   * Windows sandbox can't mount a share, and --add-dir would break its shell.
   */
  private codexAddDir(dirT: string): string[] {
    return dirT.startsWith('\\\\') ? [] : ['--add-dir', this.target.quote(dirT)];
  }

  private spawnChat(spec: { command: string; args: string[] }, onExit: (code: number | null) => void): void {
    this.stdoutBuf = '';
    this.stderrTail = '';
    const claude = this.harness.kind === 'claude-code';
    const child = spawn(spec.command, spec.args, {
      cwd: this.dir,
      env: childEnv(),
      stdio: [claude ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
    this.d.log.info(`task builder ${this.id}: ${spec.command} ${spec.args.join(' ')}`);
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
    let rec: Record<string, unknown> | null = null;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.acc.addLine(line);
    if (this.harness.kind === 'claude-code') {
      if (rec.type === 'result') this.setStatus('ready', false);
      this.noteClaudeFiles(rec);
    } else {
      if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') this.codexThread = rec.thread_id;
      this.noteCodexFiles(rec);
    }
    this.scheduleEmit();
  }

  /**
   * Claude names the file in the file tool's call, and reports its previous
   * content (originalFile) with the tool's result. Read off the events
   * themselves: the chat's rows stop growing once it holds its maximum.
   */
  private noteClaudeFiles(rec: Record<string, unknown>): void {
    if (rec.type === 'assistant') {
      const content = (rec.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
        if (block?.type !== 'tool_use' || !FILE_TOOLS.has(String(block.name))) continue;
        const input = block.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
        const file = input?.file_path ?? input?.notebook_path;
        if (typeof file === 'string' && file.trim()) {
          this.noteFile(file.trim());
          this.agentChanged();
        }
      }
    }
    const r = rec.tool_use_result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return;
    if (!('originalFile' in r)) return;
    this.rememberBefore(r.filePath, typeof r.originalFile === 'string' ? Buffer.from(r.originalFile) : null);
  }

  /**
   * Codex reports a file change when it starts, before the patch is applied:
   * an added file had nothing before it; an updated one is read right away,
   * which is the best Looper can do (codex never sends the old content).
   */
  private noteCodexFiles(rec: Record<string, unknown>): void {
    if (rec.type !== 'item.started') return;
    const item = rec.item as { type?: string; changes?: { path?: unknown; kind?: unknown }[] } | undefined;
    if (item?.type !== 'file_change' || !Array.isArray(item.changes)) return;
    for (const c of item.changes) {
      if (typeof c.path !== 'string') continue;
      this.noteFile(c.path);
      this.agentChanged();
      if (this.before.has(c.path)) continue;
      if (c.kind === 'add') {
        this.rememberBefore(c.path, null);
        continue;
      }
      const p = c.path;
      try {
        this.rememberBefore(p, fs.readFileSync(this.target.toHostPath(p)));
      } catch {
        // A WSL default distro has no direct host path: wslpath finds it (later, so the best effort is later too).
        void taskHostPath(this.ctx.task, p, this.d.host, this.d.settings).then((hostPath) => {
          if (!hostPath) return;
          try {
            this.rememberBefore(p, fs.readFileSync(hostPath));
          } catch {
            /* unreadable: the history can't restore this file's earlier state */
          }
        });
      }
    }
  }

  private rememberBefore(p: string, content: Buffer | null): void {
    if (this.inBuilderDir(p) || this.before.has(p)) return;
    this.before.set(p, content);
    this.scheduleDirtyCheck();
  }

  private noteFile(p: string): void {
    if (this.inBuilderDir(p)) return;
    this.files.add(p);
    this.changedSinceSave.add(p);
    this.scheduleDirtyCheck();
  }

  /**
   * The agent changed the draft or a file. The chat takes its Undo step when
   * the turn ends; the terminal view has no turns, so the step is taken once
   * the changes pause.
   */
  private agentChanged(): void {
    if (this.view !== 'terminal' || this.closed) return;
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => {
      this.stepTimer = null;
      void this.queueStep(() => this.commitStep());
    }, 3000);
  }

  /** The draft, probes and helpers are the builder's own files, never the task's. */
  private inBuilderDir(p: string): boolean {
    const dirT = this.target.toTargetPath(this.dir).replace(/[\\/]+$/, '');
    const norm = (s: string) => (this.target.kind === 'windows' ? s.toLowerCase().replace(/\//g, '\\') : s);
    return norm(p).startsWith(norm(dirT));
  }

  send(text: string): void {
    const t = text.trim();
    if (!t || this.closed || this.status === 'ended' || this.view !== 'chat') return;
    this.acc.addPrompt(t);
    // The chat shows the message as typed; the agent also learns that Undo/Redo or a loaded version changed its work.
    const forAgent = this.movedByUser
      ? '(Looper: the user used Undo/Redo or loaded a saved version of the task, so the draft file and the ' +
        "task's files may have changed since your last turn. Read them again before changing anything.)\n\n" +
        t
      : t;
    this.movedByUser = false;
    if (this.harness.kind === 'claude-code') {
      this.setStatus('working');
      // The last turn's Undo step reads the files first: the next turn mustn't change them under it.
      void this.queueStep(async () => {
        const line = JSON.stringify({ type: 'user', message: { role: 'user', content: forAgent } });
        this.proc?.stdin?.write(line + '\n');
      });
    } else if (this.status === 'working') {
      this.queued.push(forAgent);
      this.scheduleEmit();
    } else {
      this.setStatus('working');
      void this.queueStep(async () => this.startCodexTurn(forAgent));
    }
  }

  // ---------- terminal view ----------

  private startTerminal(): void {
    let body: string;
    if (this.harness.kind === 'claude-code') {
      body = [this.harness.command, ...this.claudeArgs()].join(' ');
    } else {
      const q = (s: string) => this.target.quote(s);
      const dirT = this.target.toTargetPath(this.dir);
      // Interactive codex has no flag to skip the user's config; the project's AGENTS.md still stays out.
      const parts = [
        this.harness.command,
        '--no-alt-screen',
        '-c',
        q('project_doc_max_bytes=0'),
        ...codexPermissionArgs('auto', true),
        ...this.codexAddDir(dirT),
      ];
      if (this.setup.model) parts.push('--model', q(this.setup.model));
      const effort = this.effort();
      if (effort) parts.push('-c', q('model_reasoning_effort=' + effort));
      for (const arg of this.harness.args) parts.push(q(arg));
      // Codex has no system prompt flag: the instructions open the session.
      parts.push(this.target.catFile(joinTarget(this.target.kind, dirT, 'system.txt')));
      body = parts.join(' ');
    }
    const spec = this.harness.kind === 'codex' ? this.codexLauncher('builder', body) : this.launcher('builder', body);
    try {
      this.pty = spawnPty(spec, this.dir);
    } catch (err) {
      this.end(`Couldn't start ${this.harness.name}: ${errMsg(err)}`);
      return;
    }
    // The folder was chosen deliberately, so the CLI's first-use trust dialog
    // is answered for the user, as for a run (unless the harness says not to).
    const claude = this.harness.kind === 'claude-code';
    let head = '';
    let trustHandled = !autoTrustWorkspace(this.harness);
    this.pty.onStdout((data) => {
      this.terminalBuffer = (this.terminalBuffer + data).slice(-TERMINAL_BUFFER);
      this.d.emit({ type: 'builder:data', id: this.id, data });
      if (trustHandled) return;
      head = (head + data).slice(-16384);
      // Cursor moves may stand in for spaces, so compare without any whitespace.
      const flat = stripAnsi(head).replace(/\s+/g, '').toLowerCase();
      if (!flat.includes(claude ? 'trustthisfolder' : 'trustthecontentsofthisdirectory')) return;
      trustHandled = true;
      // claude preselects "No, exit": Down to "Yes", then Enter. codex preselects "Yes, continue".
      if (claude) setTimeout(() => this.pty?.write('\x1b[B'), 300);
      setTimeout(() => this.pty?.write('\r'), 700);
    });
    // Codex's terminal shows no tool calls: its session files say which files it changed.
    if (this.harness.kind === 'codex') this.timers.push(setInterval(() => void this.refreshCodexBefore(), 5000));
    this.pty.onExit(() => {
      this.pty = null;
      if (!this.closed) this.end('The session ended.');
    });
    this.setStatus('ready');
  }

  writeTerminal(data: string): void {
    this.pty?.write(data);
  }

  resizeTerminal(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows);
    } catch {
      /* the pty is gone */
    }
  }

  terminalOutput(): string {
    return this.terminalBuffer;
  }

  // ---------- the draft ----------

  private draftHostPath(): string {
    return path.join(this.dir, 'draft.json');
  }

  private initialDraft(): Record<string, unknown> {
    if (this.taskId) {
      const task = this.d.getTask(this.taskId);
      if (!task) throw new Error('This task no longer exists.');
      const def = definitionOf(task) as unknown as Record<string, unknown>;
      return def;
    }
    return {
      id: '',
      name: '',
      environmentId: this.env.id,
      cwd: this.setup.cwd,
      trigger: { mode: 'manual' },
      agent: {
        harnessId: this.harness.id,
        ...(this.setup.model ? { model: this.setup.model } : {}),
        ...(this.setup.effort ? { effort: this.setup.effort } : {}),
        prompt: '',
      },
    };
  }

  /** Re-read the draft when it changed (or always, with `force`): the panel shows it and its errors. */
  private readDraft(force: boolean): void {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.draftHostPath()).mtimeMs;
    } catch {
      /* deleted: reported below */
    }
    if (!force && mtime === this.draftMtime) return;
    // Looper's own writes re-read with force; a change found by the poll is the agent's.
    if (!force) this.agentChanged();
    this.draftMtime = mtime;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.draftHostPath(), 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      this.draft = { errors: [`The draft file isn't valid JSON: ${errMsg(err)}`], raw: this.draft.raw };
      this.scheduleEmit();
      return;
    }
    const rawObj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const v = validateTask(raw, this.d.settings.environments, this.d.host);
    const errors = v.ok ? [] : [...v.errors];
    if (v.ok) {
      const other = this.d.listTasks().find((t) => t.id === v.task.id);
      if (other && other.id !== this.taskId) errors.push(`The id "${v.task.id}" is already used by the task "${other.name}".`);
      if (this.taskId && v.task.id !== this.taskId) errors.push(`The id must stay "${this.taskId}".`);
    }
    const stored = this.taskId ? this.d.getTask(this.taskId) : undefined;
    this.draft = {
      ...(v.ok && errors.length === 0 ? { task: v.task } : {}),
      errors,
      ...(stored ? { changed: changedFields(definitionOf(stored), v.ok ? definitionOf(v.task) : rawObj) } : {}),
      ...(rawObj ? { raw: rawObj } : {}),
    };
    this.scheduleEmit();
  }

  /** The draft as Create/Update hands it to the editor. */
  draftForEditor(): Record<string, unknown> {
    this.readDraft(true);
    if (!this.draft.raw) throw new Error(this.draft.errors[0] ?? 'The draft is empty.');
    const draft: Record<string, unknown> = this.draft.task ? { ...this.draft.task } : { ...this.draft.raw };
    // The draft is the definition only: Update keeps the stored task's status
    // (a disabled task stays disabled, a completed one completed).
    const stored = this.taskId ? this.d.getTask(this.taskId) : undefined;
    if (stored) {
      for (const k of STATUS_FIELDS) {
        if (stored[k] !== undefined) draft[k] = stored[k];
        else delete draft[k];
      }
    }
    return draft;
  }

  /** The draft was saved (Save, or the editor Create/Update opened): from now on it saves over that task. */
  async saved(task: Task): Promise<void> {
    this.mode = 'edit';
    this.taskId = task.id;
    this.changedSinceSave.clear();
    this.readDraft(true);
    for (const p of this.files) {
      const now = await this.readNow(p);
      if (now !== undefined) this.savedContent.set(p, now);
    }
    this.changedFiles = [];
    this.scheduleEmit();
  }

  /** Saving a loaded version unchanged restores that version. Takes a pending step first. */
  async restoredFrom(): Promise<number | undefined> {
    await this.queueStep(() => this.commitStep());
    return this.steps[this.stepIndex]?.fromVersion;
  }

  filesForVersion(): { written: string[]; before: FileContent[] } {
    return {
      written: [...this.files],
      before: [...this.before.entries()].map(([p, content]) => ({ path: p, content })),
    };
  }

  // ---------- unsaved changes, Don't Save, Undo/Redo ----------

  private hostPath(p: string): Promise<string | undefined> {
    return taskHostPath(this.ctx.task, p, this.d.host, this.d.settings);
  }

  /** A task file's content now: null = it doesn't exist, undefined = Looper can't read it. */
  private async readNow(p: string): Promise<Buffer | null | undefined> {
    const hostPath = await this.hostPath(p);
    if (!hostPath) return undefined;
    try {
      return await fs.promises.readFile(hostPath);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
  }

  /** Put a task file back to `content` (null = delete it). */
  private async writeNow(p: string, content: Buffer | null): Promise<void> {
    const hostPath = await this.hostPath(p);
    if (!hostPath) throw new Error(`Looper can't reach ${p}`);
    if (content === null) {
      await fs.promises.rm(hostPath, { force: true });
    } else {
      await fs.promises.mkdir(path.dirname(hostPath), { recursive: true });
      await fs.promises.writeFile(hostPath, content);
    }
  }

  /** What a touched file held at the last save (or before the builder): undefined = Looper never read it. */
  private savedState(p: string): Buffer | null | undefined {
    return this.savedContent.has(p) ? this.savedContent.get(p)! : this.before.get(p);
  }

  private draftDirty(): boolean {
    if (this.taskId && this.d.getTask(this.taskId)) return (this.draft.changed?.length ?? 0) > 0;
    return JSON.stringify(this.draft.raw ?? null) !== this.initialJson;
  }

  private scheduleDirtyCheck(): void {
    if (this.dirtyTimer || this.closed) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.refreshFilesDirty();
    }, 800);
  }

  private async refreshFilesDirty(): Promise<boolean> {
    const changed: string[] = [];
    for (const p of this.files) {
      const was = this.savedState(p);
      if (was === undefined) {
        if (this.changedSinceSave.has(p)) changed.push(p);
      } else {
        const now = await this.readNow(p);
        if (now !== undefined && !sameContent(was, now)) changed.push(p);
      }
    }
    if (changed.join('\n') !== this.changedFiles.join('\n')) {
      this.changedFiles = changed;
      this.scheduleEmit();
    }
    return changed.length > 0;
  }

  /** Whether closing would lose anything: the draft or a task file differs from the last save. */
  async isUnsaved(): Promise<boolean> {
    this.readDraft(true);
    const files = await this.refreshFilesDirty();
    return files || this.draftDirty();
  }

  /**
   * Don't Save: stop the agent and put every file it changed back the way it
   * was at the last save. Each file is written whatever it holds now: a read
   * of a WSL file from Windows isn't trusted to say it already matches.
   */
  async discard(): Promise<void> {
    await this.killSession();
    const failed: string[] = [];
    const putBack: string[] = [];
    for (const p of this.files) {
      const was = this.savedState(p);
      if (was === undefined) {
        failed.push(p);
        continue;
      }
      try {
        await this.writeNow(p, was);
        putBack.push(p);
      } catch (err) {
        this.d.log.warn(`task builder ${this.id}: cannot put back ${p}: ${errMsg(err)}`);
        failed.push(p);
      }
    }
    if (putBack.length) this.d.log.info(`task builder ${this.id}: Don't Save put back ${putBack.join(', ')}`);
    if (failed.length) throw new Error(`Looper couldn't put back ${failed.join(', ')}.`);
  }

  private busy(): boolean {
    return this.status === 'working' || this.status === 'starting';
  }

  private historyState(): BuilderState['history'] {
    const idle = !this.busy();
    return { canUndo: idle && this.stepIndex > 0, canRedo: idle && this.stepIndex < this.steps.length - 1 };
  }

  private queueStep(fn: () => Promise<void>): Promise<void> {
    const run = this.stepQueue.then(fn);
    this.stepQueue = run.catch(() => undefined);
    return run;
  }

  private async captureStep(): Promise<Step> {
    const files = new Map<string, Buffer | null>();
    for (const p of this.files) {
      const now = await this.readNow(p);
      if (now !== undefined) files.set(p, now);
    }
    return { draft: fs.readFileSync(this.draftHostPath(), 'utf8'), files };
  }

  /** A file's content in a step: a file the step doesn't list still held its content from before the builder. */
  private contentIn(step: Step, p: string): Buffer | null | undefined {
    return step.files.has(p) ? step.files.get(p)! : this.before.get(p);
  }

  private sameStep(a: Step, b: Step): boolean {
    if (a.draft !== b.draft) return false;
    for (const p of new Set([...a.files.keys(), ...b.files.keys()])) {
      const x = this.contentIn(a, p);
      const y = this.contentIn(b, p);
      if (x === undefined || y === undefined ? x !== y : !sameContent(x, y)) return false;
    }
    return true;
  }

  /** Add the work in progress as a new step when it differs from the current one (dropping the steps ahead). */
  private async commitStep(fromVersion?: number): Promise<void> {
    if (this.closed) return;
    const step = await this.captureStep();
    if (fromVersion === undefined && this.sameStep(step, this.steps[this.stepIndex])) return;
    if (fromVersion !== undefined) step.fromVersion = fromVersion;
    this.steps = [...this.steps.slice(0, this.stepIndex + 1), step];
    this.stepIndex = this.steps.length - 1;
    this.scheduleEmit();
  }

  /** Put the draft and the touched files back to a step. */
  private async applyStep(step: Step): Promise<void> {
    for (const p of [...this.files]) {
      const content = this.contentIn(step, p);
      if (content !== undefined) await this.looperWrite(p, content);
    }
    writeText(this.draftHostPath(), step.draft);
    this.readDraft(true);
    this.movedByUser = true;
    await this.refreshFilesDirty();
    this.scheduleEmit();
  }

  /** Undo: back to the work in progress before the last change (an agent turn, or a loaded version). */
  undo(): Promise<void> {
    return this.queueStep(async () => {
      if (this.busy()) return;
      // A change the terminal view hasn't taken a step for yet is the one to undo.
      await this.commitStep();
      if (this.stepIndex === 0) return;
      this.stepIndex -= 1;
      await this.applyStep(this.steps[this.stepIndex]);
    });
  }

  redo(): Promise<void> {
    return this.queueStep(async () => {
      if (this.busy() || this.stepIndex >= this.steps.length - 1) return;
      this.stepIndex += 1;
      await this.applyStep(this.steps[this.stepIndex]);
    });
  }

  /** Version History's Edit with Agent: continue from saved version `n`, as a step Undo can take back. */
  loadVersion(n: number): Promise<void> {
    return this.queueStep(async () => {
      if (!this.taskId) throw new Error('The task has no saved versions yet.');
      if (this.busy()) throw new Error(`Wait until ${this.harness.name} finishes its turn.`);
      await this.commitStep();
      await this.load(n);
      await this.commitStep(n);
    });
  }

  /** Looper changes a task file (Undo/Redo, a loaded version): its content from before is kept first, so Don't Save can put it back. */
  private async looperWrite(p: string, content: Buffer | null): Promise<void> {
    const now = await this.readNow(p);
    if (now === undefined) {
      this.d.log.warn(`task builder ${this.id}: cannot read ${p}, so Undo/Redo leaves it alone`);
      return;
    }
    // Written even when the read says it matches (see discard); only an untouched match is left alone.
    if (!this.files.has(p) && sameContent(now, content)) return;
    if (!this.before.has(p)) this.before.set(p, now);
    await this.writeNow(p, content);
    this.noteFile(p);
  }

  /** Put saved version `n` in place: its definition in the draft, its recorded files on disk. */
  private async load(n: number): Promise<void> {
    const id = this.taskId!;
    const version = this.d.versions.get(id, n);
    if (!version) throw new Error(`Version ${n} no longer exists.`);
    for (const p of new Set([...this.d.versions.knownFiles(id), ...this.files])) {
      const state = this.d.versions.fileStateAt(id, n, p);
      let content: Buffer | null;
      if (state && state.blob !== null) {
        const blob = this.d.versions.readBlob(id, state.blob);
        if (!blob) continue;
        content = blob;
      } else if (this.files.has(p) && (state?.blob === null || this.before.get(p) === null)) {
        // A file this session created, or one the version didn't have: Redo or Don't Save brings it back.
        content = null;
      } else {
        continue;
      }
      await this.looperWrite(p, content);
    }
    writeJsonAtomic(this.draftHostPath(), version.task);
    this.readDraft(true);
    this.movedByUser = true;
    await this.refreshFilesDirty();
    this.scheduleEmit();
  }

  // ---------- helper requests ----------

  private async pollRequests(): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(this.dir, 'requests'));
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.req') || this.takenRequests.has(name)) continue;
      this.takenRequests.add(name);
      const rid = name.slice(0, -4);
      let lines: string[];
      try {
        lines = fs
          .readFileSync(path.join(this.dir, 'requests', name), 'utf8')
          .replace(/^﻿/, '')
          .split(/\r?\n/);
        fs.rmSync(path.join(this.dir, 'requests', name), { force: true });
      } catch {
        // Held open for a moment (antivirus, a share): the next poll tries again.
        this.takenRequests.delete(name);
        continue;
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const [op, callerCwd, ...args] = lines;
      void this.answer(rid, op, callerCwd ?? '', args).finally(() => this.takenRequests.delete(name));
    }
  }

  private async answer(rid: string, op: string | undefined, callerCwd: string, args: string[]): Promise<void> {
    let out: { text: string; code: number };
    try {
      if (op === 'validate') out = this.validateRequest();
      else if (op === 'test' && args[0] === 'check') out = await this.testCheck();
      else if (op === 'test' && args[0] === 'agent') out = await this.testAgent(args[1], callerCwd);
      else out = { text: 'usage: looper-test check | looper-test agent <probe file>\n', code: 2 };
    } catch (err) {
      out = { text: `looper: ${errMsg(err)}\n`, code: 1 };
    }
    if (this.closed) return;
    const res = path.join(this.dir, 'responses');
    try {
      fs.writeFileSync(path.join(res, `${rid}.out`), out.text.endsWith('\n') ? out.text : out.text + '\n');
      // The code file last, and whole (a rename): the helper waits for it, so
      // the output is complete and the code readable once it exists.
      fs.writeFileSync(path.join(res, `${rid}.code.tmp`), String(out.code));
      fs.renameSync(path.join(res, `${rid}.code.tmp`), path.join(res, `${rid}.code`));
    } catch (err) {
      this.d.log.warn(`task builder ${this.id}: cannot answer ${op}: ${errMsg(err)}`);
    }
  }

  private validateRequest(): { text: string; code: number } {
    this.readDraft(true);
    if (this.draft.errors.length === 0) return { text: 'The draft is valid.', code: 0 };
    return {
      text: `The draft has ${this.draft.errors.length} problem${this.draft.errors.length === 1 ? '' : 's'}:\n${this.draft.errors.map((e) => `- ${e}`).join('\n')}`,
      code: 1,
    };
  }

  /** The validated draft, or an error the helper prints. */
  private draftTask(): Task {
    this.readDraft(true);
    if (!this.draft.task) {
      throw new Error(`fix the draft first (run looper-validate):\n${this.draft.errors.map((e) => `- ${e}`).join('\n')}`);
    }
    return this.draft.task;
  }

  private newTest(kind: BuilderTest['kind'], summary: string): BuilderTest {
    const test: BuilderTest = { id: this.tests.length + 1, kind, status: 'running', startedAt: Date.now(), summary };
    this.tests.push(test);
    this.scheduleEmit();
    return test;
  }

  private testContext(task: Task, test: BuilderTest): RunContext {
    const runDir = path.join(this.dir, 'tests', String(test.id));
    fs.mkdirSync(path.join(runDir, 'bin'), { recursive: true });
    return {
      task,
      runId: `builder-${this.id}-test-${test.id}`,
      runDir,
      target: createTarget(task, { host: this.d.host, settings: this.d.settings }),
      settings: this.d.settings,
      host: this.d.host,
      log: this.d.log,
      dataDir: this.d.dataDir,
      vars: { task: task.name, taskId: task.id, trigger: 'manual' },
    };
  }

  private async testCheck(): Promise<{ text: string; code: number }> {
    const draft = this.draftTask();
    if (!draft.check || !draft.check.enabled) throw new Error('the draft has no check step to test');
    const test = this.newTest('check', 'Running the check…');
    // LOOPER_TEST tells a check that keeps a cursor not to move it.
    const task: Task = { ...draft, env: { ...draft.env, LOOPER_TEST: '1' } };
    const abort = new AbortController();
    this.testAborts.add(abort);
    try {
      const res = await runCheck({ ...this.testContext(task, test), signal: abort.signal });
      const secs = (res.durationMs / 1000).toFixed(1);
      test.endedAt = Date.now();
      test.status = res.status === 'error' ? 'failed' : 'passed';
      test.summary =
        res.status === 'error'
          ? `Check failed: ${res.error ?? 'error'}`
          : `Check answered act: ${res.status === 'act'}${res.summary ? ` (${res.summary})` : ''}`;
      this.scheduleEmit();
      const lines = [
        res.status === 'error' ? `The check failed: ${res.error}` : `The check answered act: ${res.status === 'act'}`,
        ...(res.summary ? [`Summary: ${res.summary}`] : []),
        ...(res.context !== undefined ? [`Context: ${JSON.stringify(res.context, null, 2)}`] : []),
        `Exit code ${res.exitCode ?? 'none'}, ${secs} s.`,
        ...(res.stdoutTail.trim() ? ['Output (end):', res.stdoutTail.trimEnd()] : []),
      ];
      return { text: lines.join('\n'), code: res.status === 'error' ? 1 : 0 };
    } finally {
      this.testAborts.delete(abort);
    }
  }

  private async testAgent(probeFile: string | undefined, callerCwd: string): Promise<{ text: string; code: number }> {
    if (!probeFile) throw new Error('usage: looper-test agent <probe file>');
    const task = this.draftTask();
    // A relative path is relative to the folder the helper ran in.
    const absolute = this.target.kind === 'windows' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(probeFile) : probeFile.startsWith('/');
    const base = callerCwd || this.setup.cwd;
    const probePath = absolute ? probeFile : joinTarget(this.target.kind, base, probeFile.replace(/^\.[\\/]/, ''));
    const hostPath = await taskHostPath(task, probePath, this.d.host, this.d.settings);
    let probe: string;
    try {
      if (!hostPath) throw new Error('unreachable path');
      probe = fs.readFileSync(hostPath, 'utf8').trim();
    } catch (err) {
      throw new Error(`cannot read the probe file ${probeFile}: ${errMsg(err)}`);
    }
    if (!probe) throw new Error('the probe file is empty');
    const env = this.d.settings.environments.find((e) => e.id === task.environmentId);
    if (!env) throw new Error(`unknown environment ${task.environmentId}`);
    const harness = resolveHarness(task, env);
    if (harness.kind === 'custom') throw new Error('access tests need a Claude Code or Codex harness');
    const test = this.newTest('agent', 'Testing access…');
    const a = task.agent;
    const ctx = this.testContext(task, test);
    let handle: SessionHandle | null = null;
    try {
      // The task's own harness, model, permission mode, arguments and
      // variables, and the project's full configuration: what a run gets,
      // except the prompt, which is only the probe.
      handle = await startSession(
        ctx,
        {
          step: 'agent',
          prefix: '',
          launcherName: 'probe',
          harness: a.command ? { ...harness, command: a.command } : harness,
          headless: true,
          model: a.model,
          effort: resolveEffort(a, harness),
          permissionMode: a.permissionMode,
          extraArgs: a.extraArgs,
          footer: PROBE_SYSTEM_PROMPT,
          prompt: `Check these operations:\n\n${probe}`,
          jsonSchema: PROBE_SCHEMA,
          doneCommand: AGENT_DONE.command,
          doneStatuses: AGENT_DONE.statuses,
          stopGate: false,
          maxRuntimeMs: PROBE_MAX_MS,
          maxRuntimeText: 'the access test took longer than 10 minutes',
          idleGraceMs: PROBE_MAX_MS,
          idleText: 'the access test went idle',
          onIdleTimeout: 'finish',
        },
        { onData: () => {} },
      );
      this.probes.add(handle);
      const end = await handle.finished;
      const ops = this.probeOperations(end.structured);
      test.endedAt = Date.now();
      if (!ops) {
        test.status = 'failed';
        test.summary = `The access test didn't report: ${end.headline ?? end.reason}`;
        this.scheduleEmit();
        return { text: `The access test session ended without a report (${end.headline ?? end.reason}).\n${end.body ?? ''}`, code: 1 };
      }
      const allowed = ops.filter((o) => o.allowed).length;
      test.operations = ops;
      test.status = allowed === ops.length ? 'passed' : 'failed';
      test.summary = `${allowed} of ${ops.length} operation${ops.length === 1 ? '' : 's'} allowed`;
      this.scheduleEmit();
      const lines = ops.map((o, i) => `${i + 1}. ${o.allowed ? 'allowed' : 'NOT allowed'}: ${o.operation}${o.detail ? ` (${o.detail})` : ''}`);
      return { text: [`${test.summary}, under permission mode "${a.permissionMode || 'none'}":`, ...lines].join('\n'), code: allowed === ops.length ? 0 : 1 };
    } finally {
      if (handle) this.probes.delete(handle);
      if (test.status === 'running') {
        test.status = 'failed';
        test.endedAt = Date.now();
        test.summary = 'The access test couldn\'t start';
        this.scheduleEmit();
      }
    }
  }

  private probeOperations(structured: unknown): ProbeOperation[] | null {
    const ops = (structured as { operations?: unknown } | undefined)?.operations;
    if (!Array.isArray(ops)) return null;
    return ops
      .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
      .map((o) => ({
        operation: String(o.operation ?? ''),
        allowed: o.allowed === true,
        ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}),
      }));
  }

  // ---------- state ----------

  private setStatus(status: BuilderState['status'], emitNow = true): void {
    if (this.status === 'ended') return;
    const turnEnded = this.status === 'working' && status === 'ready';
    this.status = status;
    // A finished turn may have changed files through the shell, which no tool event names.
    if (status === 'ready') this.scheduleDirtyCheck();
    // Each agent turn that changed something is one Undo step.
    if (turnEnded) void this.queueStep(() => this.commitStep());
    if (emitNow) this.scheduleEmit();
  }

  private end(error: string): void {
    this.status = 'ended';
    this.error = error;
    this.d.log.warn(`task builder ${this.id} ended: ${error}`);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.closed) this.d.emit({ type: 'builder', state: this.state() });
    }, 120);
  }

  state(): BuilderState {
    const unsaved = this.changedFiles.length > 0 || this.draftDirty();
    return {
      id: this.id,
      mode: this.mode,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      setup: this.setup,
      harnessName: this.harness.name,
      harnessKind: this.harness.kind as 'claude-code' | 'codex',
      view: this.view,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      rows: this.acc.rows,
      draft: this.draft,
      tests: this.tests,
      files: [...this.files],
      changedFiles: this.changedFiles,
      unsaved,
      history: this.historyState(),
    };
  }
}

/** The open task builders, one per builder window. */
export class BuilderManager {
  private sessions = new Map<string, BuilderSession>();

  constructor(private readonly d: BuilderDeps) {}

  /** Delete the folders of builders a Looper that quit (or crashed) left behind. */
  sweep(): void {
    fs.rmSync(path.join(this.d.dataDir, 'builder'), { recursive: true, force: true });
  }

  /** Start a builder; throws with a message for the user when the setup can't work. */
  start(setup: BuilderSetup): BuilderState {
    const session = new BuilderSession(this.d, setup);
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

  /** The builder already open on a task (Edit with Agent opens one per task). */
  forTask(taskId: string): string | undefined {
    for (const s of this.sessions.values()) if (s.state().taskId === taskId) return s.id;
    return undefined;
  }

  /** The setup Edit with Agent uses: the task's own environment, harness, model, effort and folder. */
  setupFor(task: Task): BuilderSetup {
    const env = this.d.settings.environments.find((e) => e.id === task.environmentId);
    if (!env) throw new Error(`The task's environment "${task.environmentId}" no longer exists.`);
    const own = resolveHarness(task, env);
    const harness = own.kind === 'custom' ? env.harnesses.find((h) => h.kind !== 'custom') : own;
    if (!harness) throw new Error('Edit with Agent needs a Claude Code or Codex harness in the task\'s environment.');
    const sameHarness = harness.id === own.id;
    // Another harness's CLI picks its own default model.
    const model = sameHarness ? task.agent.model : undefined;
    return {
      environmentId: env.id,
      harnessId: harness.id,
      ...(model ? { model } : {}),
      ...(sameHarness && task.agent.effort ? { effort: task.agent.effort } : {}),
      cwd: task.cwd,
      taskId: task.id,
    };
  }

  get(id: string): BuilderState | undefined {
    return this.sessions.get(id)?.state();
  }

  send(id: string, text: string): void {
    this.sessions.get(id)?.send(text);
  }

  draftForEditor(id: string): Record<string, unknown> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('The conversation with the agent was closed.');
    return s.draftForEditor();
  }

  filesOf(id: string): { written: string[]; before: FileContent[] } | undefined {
    return this.sessions.get(id)?.filesForVersion() ?? this.closedFiles.get(id);
  }

  /**
   * Files of builders whose window closed while the editor their Create or
   * Update opened may still be saved: that save is still the agent's version.
   */
  private closedFiles = new Map<string, { written: string[]; before: FileContent[] }>();

  async saved(id: string, task: Task): Promise<void> {
    await this.sessions.get(id)?.saved(task);
  }

  async restoredFrom(id: string): Promise<number | undefined> {
    return this.sessions.get(id)?.restoredFrom();
  }

  async loadVersion(id: string, n: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('The conversation with the agent was closed.');
    await s.loadVersion(n);
  }

  async isUnsaved(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.isUnsaved()) ?? false;
  }

  async discard(id: string): Promise<void> {
    await this.sessions.get(id)?.discard();
  }

  async undo(id: string): Promise<void> {
    await this.sessions.get(id)?.undo();
  }

  async redo(id: string): Promise<void> {
    await this.sessions.get(id)?.redo();
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.writeTerminal(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resizeTerminal(cols, rows);
  }

  terminalOutput(id: string): string {
    return this.sessions.get(id)?.terminalOutput() ?? '';
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.closedFiles.set(id, s.filesForVersion());
    await s.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
