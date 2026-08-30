import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../../shared/types';
import { ensureDir } from './fsutil';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function newRunId(now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class RunStore {
  constructor(private readonly dataDir: string) {}

  taskDir(taskId: string): string {
    return path.join(this.dataDir, 'tasks', taskId);
  }

  runDir(taskId: string, runId: string): string {
    return path.join(this.taskDir(taskId), 'runs', runId);
  }

  createRunDir(taskId: string, runId: string): string {
    const dir = this.runDir(taskId, runId);
    ensureDir(path.join(dir, 'bin'));
    return dir;
  }

  private logFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'runs.jsonl');
  }

  append(record: RunRecord): void {
    ensureDir(this.taskDir(record.taskId));
    fs.appendFileSync(this.logFile(record.taskId), JSON.stringify(record) + '\n', 'utf8');
  }

  /** Last `limit` records, oldest first. */
  list(taskId: string, limit = 200): RunRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.logFile(taskId), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const slice = lines.slice(Math.max(0, lines.length - limit));
    const out: RunRecord[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as RunRecord);
      } catch {
        /* skip torn line */
      }
    }
    return out;
  }

  /** Tail of the raw terminal capture for a run. */
  readOutput(taskId: string, runId: string, maxBytes = 262144): string {
    const file = path.join(this.runDir(taskId, runId), 'output.log');
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      try {
        const start = Math.max(0, st.size - maxBytes);
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  listRunIds(taskId: string): string[] {
    try {
      return fs
        .readdirSync(path.join(this.taskDir(taskId), 'runs'))
        .filter((n) => !n.startsWith('.'))
        .sort();
    } catch {
      return [];
    }
  }

  /** Delete run directories beyond the newest `keep`. */
  prune(taskId: string, keep: number): number {
    const ids = this.listRunIds(taskId);
    const doomed = ids.slice(0, Math.max(0, ids.length - keep));
    for (const id of doomed) {
      try {
        fs.rmSync(this.runDir(taskId, id), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return doomed.length;
  }
}
