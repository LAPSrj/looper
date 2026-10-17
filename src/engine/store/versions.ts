import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../../shared/types';
import { changedFields, definitionOf, type TaskVersion, type VersionFile, type VersionSource } from '../../shared/versions';
import { ensureDir } from './fsutil';

/** A file's current content for a snapshot: null = it does not exist. */
export interface FileContent {
  path: string;
  content: Buffer | null;
}

export interface RecordOpts {
  source: VersionSource;
  restoredFrom?: number;
  /** The task before this change; undefined when it was just created. */
  previous?: Task;
  /** The task's files as they are now (every path the history knows, plus new ones). */
  files?: FileContent[];
  /** Files the task builder changed, as they were before it touched them. */
  before?: FileContent[];
}

/** Files past this size are not snapshotted: a task's scripts are small, and a big file would bloat every version. */
export const MAX_SNAPSHOT_BYTES = 1_048_576;

/**
 * A task's version history: one JSON line per version in
 * tasks/<id>/versions.jsonl, file contents stored once each under
 * tasks/<id>/versions/blobs/<sha1>. Status fields are never part of a
 * version (see STATUS_FIELDS), so a change to only those adds nothing.
 */
export class VersionStore {
  constructor(private readonly dataDir: string) {}

  private taskDir(taskId: string): string {
    return path.join(this.dataDir, 'tasks', taskId);
  }

  private file(taskId: string): string {
    return path.join(this.taskDir(taskId), 'versions.jsonl');
  }

  private blobDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'versions', 'blobs');
  }

  /** Every version, oldest first. */
  list(taskId: string): TaskVersion[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file(taskId), 'utf8');
    } catch {
      return [];
    }
    const out: TaskVersion[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TaskVersion);
      } catch {
        /* torn line */
      }
    }
    return out;
  }

  get(taskId: string, n: number): TaskVersion | undefined {
    return this.list(taskId).find((v) => v.n === n);
  }

  /** Newest version number per task, so stamping run records doesn't re-read the history. */
  private currentCache = new Map<string, number | undefined>();

  /** The newest version's number; undefined = the task has no history yet. */
  current(taskId: string): number | undefined {
    if (!this.currentCache.has(taskId)) this.currentCache.set(taskId, this.list(taskId).at(-1)?.n);
    return this.currentCache.get(taskId);
  }

  /**
   * A definition change will add a version once its files are read: count it
   * now, so a run that starts in the meantime is stamped with the new number.
   * record() appends exactly this number for the change.
   */
  expectChange(task: Task, previous: Task | undefined): void {
    const versions = this.list(task.id);
    const last = versions.at(-1);
    const base = last?.task ?? (previous ? definitionOf(previous) : undefined);
    if (!base || changedFields(base, definitionOf(task)).length === 0) return;
    this.currentCache.set(task.id, last ? last.n + 1 : 2);
  }

  /** Drop the cached number (a recording failed after expectChange counted it). */
  forget(taskId: string): void {
    this.currentCache.delete(taskId);
  }

  /** Every file path any version recorded, in first-seen order. */
  knownFiles(taskId: string): string[] {
    const seen = new Set<string>();
    for (const v of this.list(taskId)) {
      for (const f of [...(v.before ?? []), ...(v.files ?? [])]) seen.add(f.path);
    }
    return [...seen];
  }

  /**
   * What a file held at version `n`: the newest recording at or before `n`,
   * else the before-state of the first later version that changed it.
   * undefined = the history can't say (Looper never saw the file then).
   */
  fileStateAt(taskId: string, n: number, filePath: string): VersionFile | undefined {
    const versions = this.list(taskId);
    for (const v of [...versions].reverse()) {
      if (v.n > n) continue;
      const f = v.files?.find((x) => x.path === filePath);
      if (f) return f;
    }
    for (const v of versions) {
      if (v.n <= n) continue;
      const f = v.before?.find((x) => x.path === filePath);
      if (f) return f;
    }
    return undefined;
  }

  readBlob(taskId: string, blob: string): Buffer | null {
    if (!/^[0-9a-f]{40}$/.test(blob)) return null;
    try {
      return fs.readFileSync(path.join(this.blobDir(taskId), blob));
    } catch {
      return null;
    }
  }

  private storeBlob(taskId: string, content: Buffer): string {
    const sha = createHash('sha1').update(content).digest('hex');
    const file = path.join(this.blobDir(taskId), sha);
    if (!fs.existsSync(file)) {
      ensureDir(this.blobDir(taskId));
      fs.writeFileSync(file, content);
    }
    return sha;
  }

  private toVersionFiles(taskId: string, files: FileContent[] | undefined): VersionFile[] {
    const out: VersionFile[] = [];
    for (const f of files ?? []) {
      if (f.content && f.content.length > MAX_SNAPSHOT_BYTES) continue;
      out.push({ path: f.path, blob: f.content ? this.storeBlob(taskId, f.content) : null });
    }
    return out;
  }

  /**
   * Add a version when the definition or one of the task's files changed
   * since the newest version; returns it, or null when nothing changed. A
   * task changed before it had any history first gets its previous state as
   * version 1, so the change can be undone.
   */
  record(task: Task, opts: RecordOpts): TaskVersion | null {
    const versions = this.list(task.id);
    const def = definitionOf(task);
    const files = this.toVersionFiles(task.id, opts.files);
    const before = this.toVersionFiles(task.id, opts.before);
    const lines: TaskVersion[] = [];
    let last = versions.at(-1);
    if (!last && opts.previous) {
      // The files as they were then: a file the builder changed has its
      // before-state; any other is taken as unchanged by this save.
      const baseFiles = files.map((f) => before.find((b) => b.path === f.path) ?? f);
      last = {
        n: 1,
        ts: opts.previous.updatedAt ?? new Date().toISOString(),
        source: 'earlier',
        changed: [],
        task: definitionOf(opts.previous),
        ...(baseFiles.length > 0 ? { files: baseFiles } : {}),
      };
      lines.push(last);
    }
    const changed = last ? changedFields(last.task, def) : [];
    // Files whose content differs from what the history last recorded for them.
    const prior = [...versions, ...lines];
    const lastBlob = (p: string): string | null | undefined => {
      for (const v of [...prior].reverse()) {
        const f = v.files?.find((x) => x.path === p);
        if (f) return f.blob;
      }
      return before.find((x) => x.path === p)?.blob;
    };
    // The first version has nothing to differ from.
    const changedFiles = last ? files.filter((f) => lastBlob(f.path) !== f.blob).map((f) => f.path) : [];
    // No baseline is written either: it is only needed once there is a change to undo.
    if (last && changed.length === 0 && changedFiles.length === 0) return null;
    const version: TaskVersion = {
      n: (last?.n ?? 0) + 1,
      ts: new Date().toISOString(),
      source: opts.source,
      ...(opts.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
      changed: [...changed, ...changedFiles.map((p) => `file:${p}`)],
      task: def,
      ...(files.length > 0 ? { files } : {}),
      ...(before.length > 0 ? { before } : {}),
    };
    lines.push(version);
    ensureDir(this.taskDir(task.id));
    fs.appendFileSync(this.file(task.id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    this.currentCache.set(task.id, version.n);
    return version;
  }

  /** Delete the whole history (the task was deleted for good). */
  remove(taskId: string): void {
    this.currentCache.delete(taskId);
    fs.rmSync(this.file(taskId), { force: true });
    fs.rmSync(path.join(this.taskDir(taskId), 'versions'), { recursive: true, force: true });
  }
}
