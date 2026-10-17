import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../../shared/types';
import { ensureDir } from './fsutil';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** YYYYMMDD-HHMMSS in local time: run ids and attachment names start with it, so they sort by age. */
function stampOf(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function newRunId(now = new Date()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stampOf(now)}-${rand}`;
}

export class RunStore {
  constructor(private readonly dataDir: string) {}

  taskDir(taskId: string): string {
    return path.join(this.dataDir, 'tasks', taskId);
  }

  runDir(taskId: string, runId: string): string {
    return path.join(this.taskDir(taskId), 'runs', runId);
  }

  /** Files attached to the task's chats and terminal sessions: each name starts with a run-id-like stamp. */
  attachmentsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'attachments');
  }

  /**
   * Copy a file into the task's attachments (bytes, or a host file to copy)
   * and return the copy's host path. The stamp in front keeps names apart
   * and dates the file for pruning; the rest is the file's own name.
   */
  saveAttachment(taskId: string, name: string, from: { data: Buffer } | { file: string }): string {
    const dir = this.attachmentsDir(taskId);
    ensureDir(dir);
    const safe = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'attachment';
    const file = path.join(dir, `${newRunId()}-${safe}`);
    if ('data' in from) fs.writeFileSync(file, from.data);
    else fs.copyFileSync(from.file, file);
    return file;
  }

  /** The file's own name, without the stamp saveAttachment put in front. */
  static attachmentName(file: string): string {
    return path.basename(file).replace(/^\d{8}-\d{6}-[a-z0-9]{4}-/, '');
  }

  /** Delete attachments older than `cutoffMs`; returns how many. */
  pruneAttachments(taskId: string, cutoffMs: number): number {
    const stamp = stampOf(new Date(cutoffMs));
    let names: string[];
    try {
      names = fs.readdirSync(this.attachmentsDir(taskId));
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!/^\d{8}-\d{6}/.test(name) || name >= stamp) continue;
      try {
        fs.rmSync(path.join(this.attachmentsDir(taskId), name), { force: true });
        n++;
      } catch {
        /* best effort */
      }
    }
    return n;
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

  /** Read the clean log when available, falling back to the raw terminal capture. */
  readOutput(taskId: string, runId: string, maxBytes = 262144, forceRaw = false): string {
    const dir = this.runDir(taskId, runId);
    const clean = path.join(dir, 'output.txt');
    const raw = path.join(dir, 'output.log');
    const file = !forceRaw && fs.existsSync(clean) ? clean : raw;
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      try {
        const start = Math.max(0, st.size - maxBytes);
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        if (start > 0) {
          const totalKB = Math.round(st.size / 1024);
          const shownKB = Math.round(maxBytes / 1024);
          return `--- truncated: showing last ${shownKB} KB of ${totalKB} KB ---\n${text}`;
        }
        return text;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /** Delete a task's whole run history: the record log and every run directory. */
  clear(taskId: string): void {
    fs.rmSync(this.logFile(taskId), { force: true });
    fs.rmSync(path.join(this.taskDir(taskId), 'runs'), { recursive: true, force: true });
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

  /** Every task id with run history on disk, including tasks that no longer exist. */
  listTaskIds(): string[] {
    try {
      return fs
        .readdirSync(path.join(this.dataDir, 'tasks'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Delete records and run directories older than `cutoffMs`, sparing `keep`
   * (the runs currently in progress).
   */
  pruneOlderThan(taskId: string, cutoffMs: number, keep: ReadonlySet<string> = new Set()): { records: number; dirs: number } {
    // Run ids start with a local-time stamp, so an id below the cutoff's stamp is older.
    const cutoffStamp = stampOf(new Date(cutoffMs));
    let dirs = 0;
    for (const id of this.listRunIds(taskId)) {
      if (keep.has(id) || !/^\d{8}-\d{6}/.test(id) || id >= cutoffStamp) continue;
      try {
        fs.rmSync(this.runDir(taskId, id), { recursive: true, force: true });
        dirs++;
      } catch {
        /* best effort */
      }
    }
    let text: string;
    try {
      text = fs.readFileSync(this.logFile(taskId), 'utf8');
    } catch {
      return { records: 0, dirs };
    }
    const lines = text.split('\n').filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const r = JSON.parse(line) as RunRecord;
        return keep.has(r.runId) || Date.parse(r.ts) >= cutoffMs;
      } catch {
        return false;
      }
    });
    if (kept.length === lines.length) return { records: 0, dirs };
    if (kept.length === 0) fs.rmSync(this.logFile(taskId), { force: true });
    else fs.writeFileSync(this.logFile(taskId), kept.join('\n') + '\n', 'utf8');
    return { records: lines.length - kept.length, dirs };
  }
}
