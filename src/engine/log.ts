import fs from 'node:fs';
import type { LogLine } from '../shared/types';

export type LogListener = (line: LogLine) => void;

export class Logger {
  private stream: fs.WriteStream | null = null;
  private listeners = new Set<LogListener>();

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

  onLine(fn: LogListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  log(level: LogLine['level'], message: string): void {
    const line: LogLine = { ts: new Date().toISOString(), level, message };
    const text = `${line.ts} [${level}] ${message}`;
    if (this.stream) this.stream.write(text + '\n');
    if (this.echo) {
      if (level === 'error' || level === 'warn') console.error(text);
      else console.log(text);
    }
    for (const fn of this.listeners) {
      try {
        fn(line);
      } catch {
        /* listener errors never propagate */
      }
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
