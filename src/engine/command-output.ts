import fs from 'node:fs';
import path from 'node:path';
import type { Prompt } from '../addons/git/askpass';
import { MAX_COMMAND_OUTPUT, OUTPUT_PREVIEW, type CommandOutput, type CommandPrompt, type SavedOutput } from '../shared/bash-mode';
import { joinTarget } from './target/paths';
import { killHostTree } from './target/kill';
import { TerminalHost } from './terminal-host';
import { writeLauncher, type RunContext } from './steps/common';
import { spawnPty, type SessionProc } from './steps/session';
import { commandPrompt, type SudoAskpass, type SudoSetup } from './sudo-askpass';

/** Where in a conversation's folder the output of the user's "!" commands too long to send is saved. */
const COMMANDS_DIR = 'commands';
/** A running "!" command's output goes to the window at most this often. */
const COMMAND_OUTPUT_MS = 100;
/** The terminal a command starts in, until the window shows it at its own size. */
const COLS = 100;
const ROWS = 12;
/** What a window that opens a running command gets of its terminal's output so far: its newest part. */
const MAX_SCREEN = 200_000;

interface Running {
  proc: SessionProc;
  marker: string;
  stopped: boolean;
  /** The terminal's output so far (its newest MAX_SCREEN characters), for a window that shows it now. */
  screen: string;
  text: TerminalHost;
  /** What the command asks the user now (sudo's password), and the way to answer it. */
  ask?: { prompt: CommandPrompt; resolve: (answer: string | null) => void };
}

/**
 * The commands the user runs from a message box ("!"), in a conversation's
 * working directory on its target (a WSL or remote one runs them there),
 * through a launcher as the agent's own processes start. Each runs in a
 * terminal of its own, so a command that asks for something (sudo's or ssh's
 * password, a y/n) gets what the user types into it (`write`). The window
 * shows the terminal as it runs (`onOutput`, a batch at most every
 * COMMAND_OUTPUT_MS, and `screen` for one that opens it later); once it
 * ends, its output as text (CommandText, in the terminal worker) is what the
 * agent gets. A sudo in it asks for the password through a prompt of the
 * window's (`onPrompt`, `answer`; see sudo-askpass.ts) instead of the terminal. They run whatever the agent is doing. Each one's processes
 * carry a run marker of their own, so stopping it leaves the agent's alone.
 * `ctx` is the conversation's: its task's folder and target, and its folder
 * (`ctx.runDir`), where long output is saved.
 */
export class UserCommands {
  private readonly running = new Map<string, Running>();
  private seq = 0;
  private promptSeq = 0;
  /** The ids of the commands being set up, which aren't running yet. */
  /** Commands waiting for sudo's prompt to be set up, and whether Stop came meanwhile. */
  private readonly starting = new Map<string, { stopped: boolean }>();

  constructor(
    private readonly ctx: RunContext,
    private readonly o: {
      /** A command started or ended. */
      onChange: () => void;
      /** What the command's terminal printed since the last batch. */
      onOutput: (id: string, data: string) => void;
      /** Who runs them, in the log. */
      label: string;
      /** A command asks the user for something (sudo's password), or no longer does (null). */
      onPrompt?: (id: string, prompt: CommandPrompt | null) => void;
      /** What answers sudo's password prompts; without it they're asked in the terminal. */
      askpass?: SudoAskpass;
    },
  ) {}

  get size(): number {
    return this.running.size;
  }

  async run(input: string, id: string): Promise<CommandOutput> {
    const command = input.trim();
    if (!command) throw new Error('There is no command to run.');
    // The window names it (its live output and its Stop find it by the name), within what a file name can hold.
    if (!/^[\w-]{1,64}$/.test(id) || this.running.has(id) || this.starting.has(id)) throw new Error('The command has no usable id.');
    const { ctx } = this;
    const n = ++this.seq;
    const marker = `${ctx.runId}-cmd${n}`;
    const pending = { stopped: false };
    this.starting.set(id, pending);
    // A sudo in it asks in the window; where that can't be set up, it asks in the terminal as it would in any.
    const sudo: SudoSetup | undefined = await this.o.askpass
      ?.setup(ctx.target, ctx.runDir, (prompt, retry) => this.ask(id, prompt, retry))
      .catch((e: unknown) => {
        ctx.log.warn(`[${ctx.task.id}] ${this.o.label}: sudo's prompts can't be answered in Looper: ${(e as Error).message}`);
        return undefined;
      });
    this.starting.delete(id);
    // Stopped (or its chat closed) before it started: it never runs.
    if (pending.stopped) {
      sudo?.done();
      return { id, input: command, stdout: '', stderr: '', exitCode: null, stopped: true };
    }
    const spec = writeLauncher({ ...ctx, runId: marker }, `command-${n}`, sudo ? `${sudo.prologue}\n${command}` : command).spec;
    // Output too long to send goes whole to a file in the folder, which the agent reads by its own path.
    const dirT = joinTarget(ctx.target.kind, ctx.target.toTargetPath(ctx.runDir), COMMANDS_DIR);
    const out = new CommandStream(path.join(ctx.runDir, COMMANDS_DIR, `${id}-stdout.txt`), joinTarget(ctx.target.kind, dirT, `${id}-stdout.txt`));
    let failed: string | undefined;
    const text = new TerminalHost({
      file: '',
      cols: COLS,
      rows: ROWS,
      screen: false,
      onText: (t) => out.push(t),
      onError: (e) => (failed = `Looper couldn't read the command's output: ${e.message}`),
    });
    return new Promise((resolve) => {
      const proc = spawnPty(spec, ctx.runDir, (e) => (failed = `Couldn't run the command: ${e.message}`));
      const entry: Running = { proc, marker, stopped: false, screen: '', text };
      this.running.set(id, entry);
      this.o.onChange();
      let batch = '';
      let timer: NodeJS.Timeout | null = null;
      const show = () => {
        timer = null;
        const d = batch;
        batch = '';
        if (d) this.o.onOutput(id, d);
      };
      proc.onStdout((d) => {
        entry.screen = keepNewest(entry.screen + d);
        text.write(d);
        batch += d;
        if (!timer) timer = setTimeout(show, COMMAND_OUTPUT_MS);
      });
      proc.onExit((code) => {
        void (async () => {
          if (timer) clearTimeout(timer);
          this.answer(id, null);
          sudo?.done();
          show();
          await text.close();
          const res = await out.finish();
          this.running.delete(id);
          this.o.onChange();
          resolve({
            id,
            input: command,
            stdout: res.text,
            stderr: failed ?? '',
            exitCode: entry.stopped ? null : code,
            ...(entry.stopped ? { stopped: true } : {}),
            ...(res.saved ? { saved: { stdout: res.saved } } : {}),
          });
        })();
      });
      ctx.log.info(`[${ctx.task.id}] ${this.o.label}: running the user's command ${id}`);
    });
  }

  /** A running command's terminal output so far, for a window that shows it; null once it has ended. */
  screen(id: string): string | null {
    return this.running.get(id)?.screen ?? null;
  }

  /** What the user typed into a running command's terminal. */
  write(id: string, data: string): void {
    this.running.get(id)?.proc.write(data);
  }

  /** What a running command asks the user now; null when it asks nothing. */
  prompt(id: string): CommandPrompt | null {
    return this.running.get(id)?.ask?.prompt ?? null;
  }

  /**
   * The user's answer to the command's prompt `promptId` (null: cancelled): it goes to the program that
   * asked, and isn't kept. An answer to a prompt that's no longer asked is dropped.
   */
  answer(id: string, promptId: string | null, answer: string | null = null): void {
    const entry = this.running.get(id);
    const ask = entry?.ask;
    if (!entry || !ask || (promptId !== null && ask.prompt.id !== promptId)) return;
    entry.ask = undefined;
    this.o.onPrompt?.(id, null);
    ask.resolve(answer);
  }

  /** Show the command's prompt; resolves with the answer, or null when the user cancels or the command ends. */
  private ask(id: string, p: Prompt, retry: boolean): Promise<string | null> {
    const entry = this.running.get(id);
    if (!entry) return Promise.resolve(null);
    this.answer(id, null);
    const prompt: CommandPrompt = { id: `p${++this.promptSeq}`, ...commandPrompt(p, retry) };
    return new Promise((resolve) => {
      entry.ask = { prompt, resolve };
      this.o.onPrompt?.(id, prompt);
    });
  }

  /** The window shows a running command's terminal at this size. */
  resize(id: string, cols: number, rows: number): void {
    const c = this.running.get(id);
    if (!c || !(cols > 0 && rows > 0)) return;
    const size = [Math.min(500, Math.floor(cols)), Math.min(200, Math.floor(rows))] as const;
    c.proc.resize(...size);
    c.text.resize(...size);
  }

  /** Stop: the commands still running end (`id`: that one alone), with what they printed so far. */
  async stop(id?: string): Promise<void> {
    for (const [key, s] of this.starting) if (id === undefined || key === id) s.stopped = true;
    await Promise.all(
      [...this.running.entries()]
        .filter(([key]) => id === undefined || key === id)
        .map(async ([, c]) => {
          c.stopped = true;
          // The launcher's shell first, and for good: an interactive bash ignores SIGTERM, and would go on to the command's next line.
          const pid = await c.proc.spawned;
          if (pid) await killHostTree(pid, 'SIGKILL').catch(() => undefined);
          c.proc.kill();
          await this.ctx.target.killLeftovers(c.marker).catch(() => undefined);
        }),
    );
  }
}

/** The newest MAX_SCREEN characters of a terminal's output, from the start of a line so it doesn't begin inside an escape. */
function keepNewest(s: string): string {
  if (s.length <= MAX_SCREEN) return s;
  const cut = s.length - MAX_SCREEN;
  const nl = s.indexOf('\n', cut);
  return nl === -1 ? s.slice(cut) : s.slice(nl + 1);
}

/**
 * One stream (stdout or stderr) of a command the user ran from a chat's
 * message box. It's kept whole while it's short. Once it passes
 * MAX_COMMAND_OUTPUT it goes whole to `file` (a host path in the chat's
 * folder), as Claude Code saves a large tool output, and only its start (the
 * preview the agent gets) and its end (what the window shows while it runs)
 * stay in memory. `targetPath` is the same file as the agent's target names
 * it; `clean` tidies the text shown and sent (the launcher shell's own noise).
 */
export class CommandStream {
  private text = '';
  private bytes = 0;
  private out: fs.WriteStream | null = null;
  private failed = false;
  private head = '';
  private tail = '';

  constructor(
    private readonly file: string,
    private readonly targetPath: string,
    private readonly clean: (s: string) => string = (s) => s,
  ) {}

  push(d: string): void {
    this.bytes += Buffer.byteLength(d);
    if (this.out || this.failed) {
      if (this.out && !this.failed) this.out.write(d);
      this.tail = (this.tail + d).slice(-MAX_COMMAND_OUTPUT);
      return;
    }
    this.text += d;
    if (this.text.length <= MAX_COMMAND_OUTPUT) return;
    this.head = this.text.slice(0, OUTPUT_PREVIEW);
    this.tail = this.text.slice(-MAX_COMMAND_OUTPUT);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.out = fs.createWriteStream(this.file);
      this.out.on('error', () => (this.failed = true));
      this.out.write(this.text);
    } catch {
      this.failed = true;
      this.out = null;
    }
    this.text = '';
    if (this.failed) this.out = null;
  }

  /** What the window shows while the command runs: all of it, or once it's long, its newest part. */
  live(): string {
    if (this.out || this.failed) return `…\n${this.tail}`;
    return this.clean(this.text);
  }

  /** The stream once the command has ended: its text, or its preview and the file it was saved to. */
  async finish(): Promise<{ text: string; saved?: SavedOutput }> {
    if (this.failed) return { text: `${this.clean(this.head)}\n…\n${this.tail}` };
    if (!this.out) return { text: this.clean(this.text) };
    const out = this.out;
    await new Promise<void>((resolve) => out.end(() => resolve()));
    if (this.failed) return { text: `${this.clean(this.head)}\n…\n${this.tail}` };
    return { text: this.clean(this.head), saved: { path: this.targetPath, bytes: this.bytes } };
  }
}
