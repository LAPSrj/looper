import fs from 'node:fs';
import path from 'node:path';
import type { InboxChat, InboxCommand, Task } from '../shared/types';
import { slugify } from '../shared/validate';
import type { Logger } from './log';
import { errMsg } from './log';
import { ensureDir } from './store/fsutil';

export interface InboxHandlers {
  onTask: (input: unknown) => Task;
  onCommand: (cmd: InboxCommand) => Promise<void> | void;
  /** The text the CLI prints: written to `<processed file>.result.txt`. */
  onChat?: (cmd: InboxChat) => Promise<string> | string;
}

/** Where a processed file's result goes, which `looper chat` reads once the file has left the inbox. */
export const RESULT_EXT = '.result.txt';

function checkChat(raw: Record<string, unknown>): InboxChat {
  const str = (k: string) => raw[k] === undefined || typeof raw[k] === 'string';
  if (typeof raw.folder !== 'string' || !raw.folder.trim()) throw new Error('invalid chat command: folder must be a folder');
  if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('invalid chat command: text must be the first message');
  if (!str('title') || !str('model') || !str('effort') || (raw.open !== undefined && typeof raw.open !== 'boolean')) {
    throw new Error('invalid chat command: title, model and effort must be strings, open a boolean');
  }
  return raw as unknown as InboxChat;
}

const OPS = new Set(['run', 'pause', 'resume', 'stop', 'remove', 'enable', 'disable', 'complete', 'reopen', 'guide']);

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
      if (raw && typeof raw === 'object' && (raw as { op?: unknown }).op === 'chat') {
        const cmd = checkChat(raw as Record<string, unknown>);
        if (!this.handlers.onChat) throw new Error('this Looper starts no chats');
        const result = await this.handlers.onChat(cmd);
        this.log.info(`inbox: chat in ${cmd.folder} (${name})`);
        this.moveTo(file, 'processed', name, result);
        return;
      }
      if (raw && typeof raw === 'object' && 'op' in raw) {
        const cmd = raw as InboxCommand;
        if (!OPS.has(cmd.op) || typeof cmd.taskId !== 'string') {
          throw new Error(`invalid command (op=${String(cmd.op)}, taskId=${String(cmd.taskId)})`);
        }
        if (cmd.op === 'guide' && (typeof cmd.text !== 'string' || (cmd.runId !== undefined && typeof cmd.runId !== 'string'))) {
          throw new Error('invalid guide command: text must be a string, runId a string when given');
        }
        if (cmd.op === 'run' && cmd.event !== undefined && typeof cmd.event !== 'string') {
          throw new Error('invalid run command: event must be a string');
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

  /** `result`: written beside the moved file before the move, so whoever waits for the file to leave finds it. */
  private moveTo(file: string, sub: string, name: string, result?: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.dir, sub, `${stamp}-${name}`);
    if (result !== undefined) {
      try {
        fs.writeFileSync(dest + RESULT_EXT, result.endsWith('\n') ? result : result + '\n', 'utf8');
      } catch (e) {
        this.log.warn(`inbox: cannot write the result of ${name}: ${errMsg(e)}`);
      }
    }
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
