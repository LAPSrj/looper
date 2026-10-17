import type { Task } from './types';
import { fieldLabel } from './validate';

/**
 * Who changed a task's definition: the editor, the task builder, the
 * CLI/inbox, a restore, or Looper itself. 'earlier' marks the state a task had
 * before its first recorded change (it was saved before Looper kept history).
 */
export type VersionSource = 'user' | 'agent' | 'cli' | 'restore' | 'looper' | 'earlier';

/**
 * A file's content at a version: `blob` names the stored content (its sha1),
 * null = the file did not exist. `path` is target-native, as the task's
 * environment sees it.
 */
export interface VersionFile {
  path: string;
  blob: string | null;
}

/** One entry of a task's version history (tasks/<id>/versions.jsonl). */
export interface TaskVersion {
  /** 1, 2, 3… in the order the versions were saved. */
  n: number;
  ts: string;
  source: VersionSource;
  /** source 'restore': the version that was restored. */
  restoredFrom?: number;
  /** Dotted paths of the definition fields that differ from the previous version. */
  changed: string[];
  /** The definition, without the status fields. */
  task: Task;
  /** The task's files as they were when this version was saved. */
  files?: VersionFile[];
  /**
   * Files the task builder changed for this version, as they were before it
   * touched them: what restoring an earlier version puts back when no earlier
   * version recorded them.
   */
  before?: VersionFile[];
}

/** One version as the Version History list shows it: the definition and files stay engine-side. */
export interface VersionSummary {
  n: number;
  ts: string;
  source: VersionSource;
  restoredFrom?: number;
  changed: string[];
  /** Paths of the files this version recorded. */
  files: string[];
}

/** One field that differs between two definitions. */
export interface FieldDiff {
  path: string;
  /** undefined = the field is unset on that side. */
  a?: unknown;
  b?: unknown;
}

/** Version History's View and Compare windows. */
export interface VersionDetail {
  version: VersionSummary;
  /** It is the newest version: restoring it would change nothing. */
  isCurrent: boolean;
  task: Task;
  /** Compare only: the current task's definition. */
  current?: Task;
  /** Compare only: the fields that differ from the current task (a = the version, b = current). */
  diff?: FieldDiff[];
  /** Compare only: the files that differ from the newest version, as each recorded them (null = the file didn't exist). */
  fileDiff?: { path: string; a: string | null; b: string | null }[];
  /** The version's files: content as recorded (null when the file did not exist) and whether the file on disk still matches. */
  files: {
    path: string;
    content: string | null;
    matchesDisk: boolean | null;
  }[];
}

/**
 * Fields that track a task's status rather than define it. Changing only
 * these adds no version, and a restore keeps their current values.
 */
export const STATUS_FIELDS = ['enabled', 'completedAt', 'completedReason', 'folderId', 'note', 'createdAt', 'updatedAt'] as const;

/** The task's definition: everything except the status fields. */
export function definitionOf(task: Task): Task {
  const out = { ...task } as Record<string, unknown>;
  for (const k of STATUS_FIELDS) delete out[k];
  return out as unknown as Task;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Leaf-level differences between two definitions, as dotted paths with both
 * values. Arrays compare as whole values; status fields are ignored.
 */
export function diffDefinitions(a: unknown, b: unknown): FieldDiff[] {
  const out: FieldDiff[] = [];
  const skip = new Set<string>(STATUS_FIELDS);
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) {
        if (!path && skip.has(k)) continue;
        walk(x[k], y[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    out.push({ path, ...(x !== undefined ? { a: x } : {}), ...(y !== undefined ? { b: y } : {}) });
  };
  walk(a, b, '');
  return out;
}

/** A definition's fields one by one, in its own order: nested objects by their leaves, arrays as whole values; status fields skipped. */
export function definitionFields(def: unknown): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const skip = new Set<string>(STATUS_FIELDS);
  const walk = (v: unknown, path: string): void => {
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (!path && skip.has(k)) continue;
        walk(x, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (v !== undefined) out.push({ path, value: v });
  };
  walk(def, '');
  return out;
}

/** Dotted paths of the definition fields that differ. */
export function changedFields(a: unknown, b: unknown): string[] {
  return diffDefinitions(a, b).map((d) => d.path);
}

/** One line of a line diff: kept, only in the old text, or only in the new one. */
export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/** Line diff of two texts by longest common subsequence (prompts and scripts are short). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', text: x[i++] });
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}

/** A changed field's name in the editor's words; the schedule reads as words, so its label does too. */
export function changeLabel(path: string): string {
  return path === 'trigger.schedule.cron' ? 'Schedule' : fieldLabel(path.split('.'));
}

/** A file path's last segment, for lists that name a task's files. */
export function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Changed paths as the editor's field labels (files by name), each once. */
export function changeLabels(changed: string[]): string[] {
  const out: string[] = [];
  for (const c of changed) {
    // A summary line: the notification settings count as one change.
    const label = c.startsWith('file:') ? fileName(c.slice(5)) : c.startsWith('notifications.') ? 'Notifications' : changeLabel(c);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** The Version History label of a change's source. */
export function sourceLabel(source: VersionSource, restoredFrom?: number): string {
  switch (source) {
    case 'user':
      return 'You';
    case 'agent':
      return 'Agent';
    case 'cli':
      return 'CLI';
    case 'restore':
      return restoredFrom !== undefined ? `Restored version ${restoredFrom}` : 'Restore';
    case 'looper':
      return 'Looper';
    case 'earlier':
      return 'Before history';
  }
}
