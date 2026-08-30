import { Terminal } from '@xterm/headless';

/**
 * A headless terminal fed with the agent's pty stream, so the engine can ask
 * "what is on screen right now?" instead of guessing from raw bytes. Claude's
 * TUI re-renders partially and toggles modes constantly; only the screen
 * state is trustworthy for detecting a prompt that is still waiting.
 */
export class ScreenModel {
  private readonly term: Terminal;

  constructor(cols = 120, rows = 32) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  /** Feed pty output. Parsing is asynchronous; `flushed` resolves once it is applied. */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      /* ignore */
    }
  }

  /** Visible viewport as plain text, one line per row. */
  text(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }

  contains(re: RegExp): boolean {
    return re.test(this.text());
  }

  dispose(): void {
    this.term.dispose();
  }
}
