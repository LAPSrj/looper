import fs from 'node:fs';
import { Terminal } from '@xterm/headless';

const DEBOUNCE_MS = 500;

/**
 * Maintains a virtual terminal and writes a human-readable `output.txt`
 * alongside the raw PTY `output.log`.
 *
 * When the terminal overwrites lines that were already flushed to the file,
 * a `[rewrite ↑N]` marker is emitted followed by the full current content of
 * every changed line — not a diff, the complete lines as they now read.
 */
export class CleanLog {
  private readonly term: Terminal;
  private readonly fd: number;
  private flushed: string[] = [];
  /** How many lines xterm has trimmed from the top of its buffer. */
  private trimmed = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrites = 0;
  private closing = false;
  private closed = false;
  private flushResolve: (() => void) | null = null;

  constructor(filePath: string, cols: number, rows: number) {
    this.fd = fs.openSync(filePath, 'w');
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  }

  write(data: string): void {
    if (this.closed || this.closing) return;
    this.pendingWrites++;
    this.term.write(data, () => {
      this.pendingWrites--;
      if (this.closing) {
        if (this.pendingWrites <= 0 && this.flushResolve) {
          this.flushResolve();
          this.flushResolve = null;
        }
      } else {
        this.scheduleDrain();
      }
    });
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(Math.max(2, cols), Math.max(2, rows));
    } catch { /* ignore */ }
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.drain(), DEBOUNCE_MS);
  }

  /** Read all content lines from the terminal buffer, trimming trailing empties. */
  private readLines(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private drain(): void {
    if (this.closed) return;
    this.timer = null;

    const current = this.readLines();

    // First drain — write everything.
    if (this.flushed.length === 0) {
      this.writeStr(current.join('\n') + '\n');
      this.flushed = [...current];
      return;
    }

    // Detect scrollback trim: buffer can hold at most scrollback + rows lines.
    // When it trims, line indices shift down. We need to discard the
    // corresponding flushed entries so comparisons stay aligned.
    const maxBuf = (this.term.options.scrollback ?? 5000) + this.term.rows;
    if (this.flushed.length > maxBuf && current.length <= maxBuf) {
      const lost = this.flushed.length - maxBuf;
      this.flushed = this.flushed.slice(lost);
      this.trimmed += lost;
    }

    // Screen clear: terminal has fewer lines than we've tracked (and fewer
    // than the scrollback limit, so it's not a trim). Emit a clear marker,
    // write the new content, and reset.
    if (current.length < this.flushed.length) {
      this.writeStr('[clear]\n');
      this.writeStr(current.join('\n') + '\n');
      this.flushed = [...current];
      return;
    }

    // Compare the overlap region for rewrites.
    // `flushed` entries correspond to buffer lines starting at index 0
    // (after accounting for any earlier trim adjustments above).
    let rewriteFrom = -1;
    let rewriteTo = -1;
    for (let i = 0; i < this.flushed.length; i++) {
      if (current[i] !== this.flushed[i]) {
        if (rewriteFrom === -1) rewriteFrom = i;
        rewriteTo = i;
      }
    }

    const parts: string[] = [];

    if (rewriteFrom !== -1) {
      const linesBack = this.flushed.length - rewriteFrom;
      parts.push(`[rewrite ↑${linesBack}]\n`);
      for (let i = rewriteFrom; i <= rewriteTo; i++) {
        parts.push(current[i] + '\n');
        this.flushed[i] = current[i];
      }
    }

    // Append lines beyond what we've flushed.
    if (current.length > this.flushed.length) {
      for (let i = this.flushed.length; i < current.length; i++) {
        parts.push(current[i] + '\n');
      }
      this.flushed = [...current];
    }

    if (parts.length > 0) this.writeStr(parts.join(''));
  }

  private writeStr(s: string): void {
    try {
      fs.writeSync(this.fd, s);
    } catch { /* never fatal */ }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingWrites > 0) {
      await new Promise<void>((r) => { this.flushResolve = r; });
    }
    this.drain();
    this.closed = true;
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
    this.term.dispose();
  }
}
