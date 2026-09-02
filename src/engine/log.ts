import fs from 'node:fs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private stream: fs.WriteStream | null = null;
  private readonly file?: string;

  constructor(file?: string, private readonly echo = false) {
    this.file = file;
    if (file) this.open();
  }

  private open(): void {
    if (!this.file) return;
    try {
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  log(level: LogLevel, message: string): void {
    const text = `${new Date().toISOString()} [${level}] ${message}`;
    if (this.stream) this.stream.write(text + '\n');
    if (this.echo) {
      if (level === 'error' || level === 'warn') console.error(text);
      else console.log(text);
    }
  }

  debug(m: string): void {
    this.log('debug', m);
  }
  info(m: string): void {
    this.log('info', m);
  }
  warn(m: string): void {
    this.log('warn', m);
  }
  error(m: string): void {
    this.log('error', m);
  }

  /**
   * Rewrite the log file dropping entries older than cutoffMs. Untimestamped
   * lines (stack traces) follow their entry's fate. Returns dropped line count.
   * The write stream is flushed and closed around the rewrite, then reopened.
   */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    if (!this.file) return 0;
    if (this.stream) {
      const s = this.stream;
      this.stream = null;
      await new Promise<void>((resolve) => s.end(resolve));
    }
    try {
      if (!fs.existsSync(this.file)) return 0;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      // Drop the trailing empty string of a newline-terminated file.
      if (lines[lines.length - 1] === '') lines.pop();
      let keepCurrent = true;
      const kept = lines.filter((line) => {
        const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /.exec(line);
        if (m) keepCurrent = Date.parse(m[1]) >= cutoffMs;
        return keepCurrent;
      });
      const dropped = lines.length - kept.length;
      if (dropped > 0) {
        fs.writeFileSync(this.file, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
      }
      return dropped;
    } finally {
      this.open();
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
