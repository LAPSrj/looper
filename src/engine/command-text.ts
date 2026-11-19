import { Terminal, type IMarker } from '@xterm/headless';

/** Lines kept above the screen until they're read: far more than a pty chunk brings between two reads. */
const SCROLLBACK = 10_000;

/**
 * The text of a command run in a pseudo-terminal, as the terminal shows it:
 * ConPTY (Windows) redraws the screen on a resize and turns spaces into cursor
 * moves, and a progress line rewrites itself with "\r", so the stream is
 * emulated rather than stripped of its escapes. A line is final once it has
 * scrolled above the screen (nothing can move the cursor there), so those go
 * to `emit` as they come; the screen's own lines go at `end`. A line the
 * terminal wrapped is one line again, and blank lines at the start and the end
 * are left out.
 */
export class CommandText {
  private readonly term: Terminal;
  /** The first line not emitted yet; gone once xterm trimmed it or the command cleared the scrollback. */
  private next: IMarker | null = null;
  private started = false;
  /** Blank lines held back until a line with text follows them. */
  private blanks = 0;
  private pending = 0;
  private drained: (() => void) | null = null;

  constructor(
    cols: number,
    rows: number,
    private readonly emit: (text: string) => void,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  }

  write(data: string): void {
    this.pending++;
    this.term.write(data, () => {
      this.pending--;
      this.take(false);
      if (this.pending === 0) this.drained?.();
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(Math.max(2, cols), Math.max(2, rows));
  }

  /** Everything written so far is emitted, the screen's lines too. */
  async end(): Promise<void> {
    if (this.pending > 0) await new Promise<void>((r) => (this.drained = r));
    this.take(true);
    this.term.dispose();
  }

  private take(all: boolean): void {
    const buf = this.term.buffer.active;
    const from = this.next && !this.next.isDisposed ? this.next.line : 0;
    let to = all ? buf.length : buf.baseY;
    // A line that wraps onto the screen can still change: it waits for the next read.
    while (!all && to > from && buf.getLine(to)?.isWrapped) to--;
    if (to <= from) return;
    const out: string[] = [];
    let line: string | null = null;
    for (let y = from; y < to; y++) {
      const row = buf.getLine(y);
      const text = row?.translateToString(false) ?? '';
      if (line !== null && row?.isWrapped) line += text;
      else {
        if (line !== null) this.add(line.trimEnd(), out);
        line = text;
      }
    }
    if (line !== null) this.add(line.trimEnd(), out);
    if (out.length > 0) this.emit(out.join(''));
    if (all) return;
    this.next?.dispose();
    this.next = this.term.registerMarker(to - (buf.baseY + buf.cursorY)) ?? null;
  }

  private add(line: string, out: string[]): void {
    if (!line) {
      if (this.started) this.blanks++;
      return;
    }
    if (this.blanks > 0) out.push('\n'.repeat(this.blanks));
    this.blanks = 0;
    this.started = true;
    out.push(`${line}\n`);
  }
}
