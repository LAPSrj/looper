import fs from 'node:fs';
import path from 'node:path';
import { MAX_COMMAND_OUTPUT, OUTPUT_PREVIEW, type CommandOutput, type SavedOutput } from '../shared/bash-mode';
import { joinTarget } from './target/paths';
import { killHostTree } from './target/kill';
import { spawnOffThread, type OffThreadChild } from './exec-worker';
import { childEnv, stripShellNoise, writeLauncher, type RunContext } from './steps/common';

/** Where in a conversation's folder the output of the user's "!" commands too long to send is saved. */
const COMMANDS_DIR = 'commands';
/** A running "!" command's output goes to the window at most this often. */
const COMMAND_OUTPUT_MS = 100;

/**
 * The commands the user runs from a message box ("!"), in a conversation's
 * working directory on its target (a WSL or remote one runs them there),
 * through a launcher as the agent's own processes start: each one's stdout
 * and stderr once it ends, and its output as it comes (`onOutput`, a batch at
 * most every COMMAND_OUTPUT_MS). They run whatever the agent is doing. Each
 * one's processes carry a run marker of their own, so stopping it leaves the
 * agent's alone. `ctx` is the conversation's: its task's folder and target,
 * and its folder (`ctx.runDir`), where long output is saved.
 */
export class UserCommands {
  private readonly running = new Map<string, { child: OffThreadChild; marker: string; stopped: boolean }>();
  private seq = 0;

  constructor(
    private readonly ctx: RunContext,
    private readonly o: {
      /** A command started or ended. */
      onChange: () => void;
      onOutput: (id: string, stdout: string, stderr: string) => void;
      /** Who runs them, in the log. */
      label: string;
    },
  ) {}

  get size(): number {
    return this.running.size;
  }

  run(input: string, id: string): Promise<CommandOutput> {
    const command = input.trim();
    if (!command) return Promise.reject(new Error('There is no command to run.'));
    // The window names it (its live output and its Stop find it by the name), within what a file name can hold.
    if (!/^[\w-]{1,64}$/.test(id) || this.running.has(id)) return Promise.reject(new Error('The command has no usable id.'));
    const { ctx } = this;
    const n = ++this.seq;
    const marker = `${ctx.runId}-cmd${n}`;
    const spec = writeLauncher({ ...ctx, runId: marker }, `command-${n}`, command).spec;
    // Output too long to send goes whole to a file in the folder, which the agent reads by its own path.
    const dirT = joinTarget(ctx.target.kind, ctx.target.toTargetPath(ctx.runDir), COMMANDS_DIR);
    const stream = (name: 'stdout' | 'stderr', clean?: (s: string) => string) =>
      new CommandStream(path.join(ctx.runDir, COMMANDS_DIR, `${id}-${name}.txt`), joinTarget(ctx.target.kind, dirT, `${id}-${name}.txt`), clean);
    const stdout = stream('stdout');
    // The launcher's interactive bash warns that it has no job control: that's the shell's, not the command's.
    const stderr = stream('stderr', stripShellNoise);
    return new Promise((resolve) => {
      const child = spawnOffThread(spec.command, spec.args, { cwd: ctx.runDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const entry = { child, marker, stopped: false };
      this.running.set(id, entry);
      this.o.onChange();
      let timer: NodeJS.Timeout | null = null;
      const show = () => {
        timer = null;
        this.o.onOutput(id, stdout.live(), stderr.live());
      };
      const took = () => {
        if (!timer) timer = setTimeout(show, COMMAND_OUTPUT_MS);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        stdout.push(d);
        took();
      });
      child.stderr?.on('data', (d: string) => {
        stderr.push(d);
        took();
      });
      let done = false;
      const end = async (exitCode: number | null, error?: string) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
        this.running.delete(id);
        this.o.onChange();
        const errText = error ? (err.text ? `${err.text}\n${error}` : error) : err.text;
        const saved = out.saved || err.saved ? { ...(out.saved ? { stdout: out.saved } : {}), ...(err.saved ? { stderr: err.saved } : {}) } : undefined;
        resolve({
          id,
          input: command,
          stdout: out.text,
          stderr: errText,
          exitCode: entry.stopped ? null : exitCode,
          ...(entry.stopped ? { stopped: true } : {}),
          ...(saved ? { saved } : {}),
        });
      };
      child.on('error', (e) => void end(null, `Couldn't run the command: ${e.message}`));
      child.on('close', (code) => void end(code));
      ctx.log.info(`[${ctx.task.id}] ${this.o.label}: running the user's command ${id}`);
    });
  }

  /** Stop: the commands still running end (`id`: that one alone), with what they printed so far. */
  async stop(id?: string): Promise<void> {
    await Promise.all(
      [...this.running.entries()]
        .filter(([key]) => id === undefined || key === id)
        .map(async ([, c]) => {
          c.stopped = true;
          // The launcher's shell first, and for good: an interactive bash ignores SIGTERM, and would go on to the command's next line.
          const pid = await c.child.spawned;
          if (pid) await killHostTree(pid, 'SIGKILL').catch(() => undefined);
          await this.ctx.target.killLeftovers(c.marker).catch(() => undefined);
        }),
    );
  }
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
