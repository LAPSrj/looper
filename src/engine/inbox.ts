import fs from 'node:fs';
import path from 'node:path';
import type { InboxCommand, Task } from '../shared/types';
import { slugify } from '../shared/validate';
import type { Logger } from './log';
import { errMsg } from './log';
import { ensureDir } from './store/fsutil';

export interface InboxHandlers {
  onTask: (input: unknown) => Task;
  onCommand: (cmd: InboxCommand) => Promise<void> | void;
}

const OPS = new Set(['run', 'pause', 'resume', 'stop', 'remove', 'enable', 'disable']);

/**
 * Drop-folder API: agents (from WSL, via /mnt/c/...) write JSON files here.
 * A file with `op` is a command; anything else is a task definition.
 */
export class Inbox {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    readonly dir: string,
    private readonly pollMs: number,
    private readonly handlers: InboxHandlers,
    private readonly log: Logger,
  ) {}

  start(): void {
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'processed'));
    ensureDir(path.join(this.dir, 'rejected'));
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let names: string[];
      try {
        names = fs.readdirSync(this.dir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const file = path.join(this.dir, name);
        try {
          if (!fs.statSync(file).isFile()) continue;
        } catch {
          continue;
        }
        await this.handleFile(file, name);
      }
    } finally {
      this.busy = false;
    }
  }

  private async handleFile(file: string, name: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      this.reject(file, name, `invalid JSON: ${errMsg(e)}`);
      return;
    }
    try {
      if (raw && typeof raw === 'object' && 'op' in raw) {
        const cmd = raw as InboxCommand;
        if (!OPS.has(cmd.op) || typeof cmd.taskId !== 'string') {
          throw new Error(`invalid command (op=${String(cmd.op)}, taskId=${String(cmd.taskId)})`);
        }
        await this.handlers.onCommand(cmd);
        this.log.info(`inbox: ${cmd.op} ${cmd.taskId} (${name})`);
      } else {
        const obj = (raw ?? {}) as Record<string, unknown>;
        if (!obj.id && typeof obj.name === 'string') obj.id = slugify(obj.name);
        const task = this.handlers.onTask(obj);
        this.log.info(`inbox: registered task ${task.id} (${name})`);
      }
      this.moveTo(file, 'processed', name);
    } catch (e) {
      this.reject(file, name, errMsg(e));
    }
  }

  private reject(file: string, name: string, reason: string): void {
    this.log.warn(`inbox: rejected ${name}: ${reason}`);
    const dest = this.moveTo(file, 'rejected', name);
    try {
      fs.writeFileSync(dest + '.error.txt', reason + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  }

  private moveTo(file: string, sub: string, name: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.dir, sub, `${stamp}-${name}`);
    try {
      fs.renameSync(file, dest);
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
    return dest;
  }
}
