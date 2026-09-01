import fs from 'node:fs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(file?: string, private readonly echo = false) {
    if (file) {
      try {
        this.stream = fs.createWriteStream(file, { flags: 'a' });
        this.stream.on('error', () => {
          this.stream = null;
        });
      } catch {
        this.stream = null;
      }
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

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
