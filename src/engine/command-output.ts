import fs from 'node:fs';
import path from 'node:path';
import { MAX_COMMAND_OUTPUT, OUTPUT_PREVIEW, type SavedOutput } from '../shared/bash-mode';

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
