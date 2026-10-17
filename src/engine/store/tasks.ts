import { EventEmitter } from 'node:events';
import { validateTask } from '../../shared/validate';
import { folderParents } from '../../shared/folders';
import { DEFINITION_VERSION, migrateDefinition, type Definition } from '../../shared/migrate';
import { TaskFolderSchema } from '../../shared/types';
import type { Environment, RecycleBinEntry, Task, TaskFolder, TaskInput } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Sibling display order per container ('' = top level, otherwise a folder
 * id): `folder:<id>` entries mixed with task ids.
 */
export type FolderLayout = Record<string, string[]>;

function sanitizeLayout(raw: unknown): FolderLayout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: FolderLayout = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[key] = value.filter((e): e is string => typeof e === 'string');
  }
  return out;
}

interface TasksFile {
  version: number;
  folders?: TaskFolder[];
  layout?: FolderLayout;
  tasks: Task[];
  recycleBin?: RecycleBinEntry[];
}

/** Recycle Bin entries whose deletion is older than the cutoff. An unparseable stamp never expires. */
export function expiredBinEntries(entries: RecycleBinEntry[], cutoffMs: number): RecycleBinEntry[] {
  return entries.filter((e) => {
    const at = Date.parse(e.deletedAt);
    return !Number.isNaN(at) && at <= cutoffMs;
  });
}

/**
 * The store file's definition-format version: missing = 1 (written before
 * versions were stamped). Newer than this build throws — loading nothing and
 * saving later would silently wipe the file.
 */
export function storeVersion(data: { version?: unknown }, file: string): number {
  const version = typeof data.version === 'number' ? data.version : 1;
  if (version > DEFINITION_VERSION) {
    throw new Error(
      `${file} was written by a newer Looper (format v${version}; this build reads up to v${DEFINITION_VERSION})`,
    );
  }
  return version;
}

export class TaskStore extends EventEmitter {
  private tasks = new Map<string, Task>();
  /** Deleted tasks by id. They never reach `list()`, so nothing schedules or shows them. */
  private bin = new Map<string, RecycleBinEntry>();
  private folders: TaskFolder[] = [];
  private layout: FolderLayout = {};

  constructor(
    private file: string,
    /** Current environments, so environment/harness references are checked on load and save. */
    private readonly environments?: () => Environment[],
    private readonly host?: string,
    /** The global folder completing tasks are moved into (Settings → General). */
    private readonly completedFolderId?: () => string | undefined,
  ) {
    super();
  }

  setFile(file: string): void {
    this.file = file;
    this.load();
  }

  load(): void {
    const data = readJson<TasksFile>(this.file, { version: DEFINITION_VERSION, tasks: [] });
    const version = storeVersion(data, this.file);
    this.tasks.clear();
    this.folders = [];
    this.layout = sanitizeLayout(data.layout);
    for (const raw of data.folders ?? []) {
      const f = TaskFolderSchema.safeParse(raw);
      if (f.success) this.folders.push(f.data);
    }
    for (let raw of data.tasks ?? []) {
      if (version < DEFINITION_VERSION && raw && typeof raw === 'object') {
        raw = migrateDefinition(raw as unknown as Definition, version) as unknown as Task;
      }
      const v = validateTask(raw, this.environments?.(), this.host);
      if (v.ok) this.tasks.set(v.task.id, v.task);
      else this.emit('invalid', raw, v.errors);
    }
    this.bin.clear();
    for (const entry of data.recycleBin ?? []) {
      let task: unknown = entry?.task;
      if (!task || typeof task !== 'object' || typeof (task as Task).id !== 'string' || typeof entry.deletedAt !== 'string') {
        continue;
      }
      if (version < DEFINITION_VERSION) task = migrateDefinition(task as Definition, version);
      this.bin.set((task as Task).id, { task: task as Task, deletedAt: entry.deletedAt });
    }
    this.syncLayout();
  }

  /**
   * Keep each container's sibling order consistent with the folders and
   * tasks: stale entries drop out, new members append at the end. Returns
   * whether anything changed.
   */
  private syncLayout(): boolean {
    const parents = folderParents(this.folders);
    // A task pointing at a deleted/unknown folder lists at the top level.
    const containerOf = (t: Task) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');
    const next: FolderLayout = {};
    for (const container of ['', ...this.folders.map((f) => f.id)]) {
      const valid = new Set<string>();
      for (const f of this.folders) if (parents.get(f.id) === container) valid.add(`folder:${f.id}`);
      for (const t of this.tasks.values()) if (containerOf(t) === container) valid.add(t.id);
      const list: string[] = [];
      for (const entry of this.layout[container] ?? []) {
        if (!valid.has(entry)) continue;
        valid.delete(entry);
        list.push(entry);
      }
      list.push(...valid);
      next[container] = list;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.layout);
    this.layout = next;
    return changed;
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Validate + persist. Throws with the joined error list on invalid input. */
  upsert(input: unknown): Task {
    const v = validateTask(input, this.environments?.(), this.host);
    if (!v.ok) throw new Error(v.errors.join('; '));
    const now = new Date().toISOString();
    const existing = this.tasks.get(v.task.id);
    const task: Task = {
      ...v.task,
      ...this.completionFields(v.task, existing, now),
      createdAt: existing?.createdAt ?? v.task.createdAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    const layoutChanged = this.syncLayout();
    this.save();
    this.emit('change', task, existing ? 'update' : 'create', existing);
    if (layoutChanged) this.emit('folders');
    return task;
  }

  /**
   * The completion invariant, applied wherever a task comes from (editor, JSON
   * tab, inbox, the engine itself): a completed task is never enabled, keeps
   * the stamp of when it first completed, and moves to the global completed
   * tasks folder as it completes. Reopening drops the stamp, the reason, and a
   * schedule end that has already passed — otherwise the next tick would just
   * complete it again.
   */
  private completionFields(task: Task, existing: Task | undefined, now: string): Partial<Task> {
    if (!task.completedAt) {
      if (!existing?.completedAt) return {};
      const stopOn = task.trigger.stopOn;
      // The date itself is kept, switched off: it is there to be edited, not to
      // complete the task again on the next tick.
      const stale = stopOn?.enabled && Date.parse(stopOn.at) <= Date.now();
      return {
        completedReason: undefined,
        ...(stale ? { trigger: { ...task.trigger, stopOn: { ...stopOn, enabled: false } } } : {}),
      };
    }
    const out: Partial<Task> = { enabled: false, completedAt: existing?.completedAt ?? task.completedAt };
    // The move happens once, as the task completes; reopening leaves it filed where it is.
    const folderId = this.completedFolderId?.();
    if (!existing?.completedAt && folderId && this.folders.some((f) => f.id === folderId)) {
      out.folderId = folderId;
    }
    return out;
  }

  patch(id: string, patch: Partial<TaskInput>): Task {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`unknown task ${id}`);
    return this.upsert({ ...existing, ...patch, id });
  }

  /**
   * Delete a task: it moves to the Recycle Bin. An older bin entry with the
   * same id (deleted before, then recreated) is replaced.
   */
  remove(id: string): boolean {
    const existing = this.tasks.get(id);
    if (!existing) return false;
    this.tasks.delete(id);
    this.bin.set(id, { task: existing, deletedAt: new Date().toISOString() });
    const layoutChanged = this.syncLayout();
    this.save();
    this.emit('change', existing, 'remove');
    this.emit('bin');
    if (layoutChanged) this.emit('folders');
    return true;
  }

  /** The Recycle Bin, most recently deleted first. */
  listBin(): RecycleBinEntry[] {
    return [...this.bin.values()].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /**
   * Put a task from the Recycle Bin back as it was when deleted. Throws when
   * a task with its id exists again or the definition no longer validates
   * (e.g. its environment was removed); the entry then stays in the bin.
   */
  restore(id: string): Task {
    const entry = this.bin.get(id);
    if (!entry) throw new Error('The task is no longer in the Recycle Bin.');
    if (this.tasks.has(id)) throw new Error(`A task with the id "${id}" already exists. Rename or delete it first.`);
    const v = validateTask(entry.task, this.environments?.(), this.host);
    if (!v.ok) throw new Error(`The task can't be restored: ${v.errors.join('; ')}`);
    // A folder deleted meanwhile: the task comes back at the top level.
    const folderGone = v.task.folderId && !this.folders.some((f) => f.id === v.task.folderId);
    const task: Task = { ...v.task, ...(folderGone ? { folderId: undefined } : {}), updatedAt: new Date().toISOString() };
    this.bin.delete(id);
    this.tasks.set(id, task);
    const layoutChanged = this.syncLayout();
    this.save();
    this.emit('change', task, 'create');
    this.emit('bin');
    if (layoutChanged) this.emit('folders');
    return task;
  }

  /** Delete a task in the Recycle Bin for good. Its run history is the caller's business. */
  purge(id: string): boolean {
    if (!this.bin.delete(id)) return false;
    this.save();
    this.emit('bin');
    return true;
  }

  /**
   * Persist a new task order (and optionally new folder assignments, a new
   * layout and new folder parents in the same write). Unknown ids are
   * ignored; known tasks missing from `ids` keep their relative order at the
   * end. A parent that doesn't exist or sits inside the folder's own subtree
   * is ignored. Emits `reorder`, not per-task `change` — neither ordering nor
   * foldering affects scheduling.
   */
  reorder(
    ids: string[],
    folderById?: Record<string, string | null>,
    layout?: FolderLayout,
    parentById?: Record<string, string | null>,
  ): void {
    const next = new Map<string, Task>();
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (t) next.set(id, t);
    }
    for (const [id, t] of this.tasks) if (!next.has(id)) next.set(id, t);
    this.tasks = next;
    for (const [id, folderId] of Object.entries(folderById ?? {})) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (folderId && !this.folders.some((f) => f.id === folderId)) continue;
      this.tasks.set(id, { ...t, folderId: folderId ?? undefined });
    }
    for (const [id, parentId] of Object.entries(parentById ?? {})) {
      const folder = this.folders.find((f) => f.id === id);
      if (!folder) continue;
      if (parentId) {
        if (!this.folders.some((f) => f.id === parentId)) continue;
        // Reject a parent inside the folder's own subtree (would close a cycle).
        const parents = folderParents(this.folders);
        let p: string | undefined = parentId;
        let cyclic = false;
        while (p) {
          if (p === id) {
            cyclic = true;
            break;
          }
          p = parents.get(p) || undefined;
        }
        if (cyclic) continue;
      }
      folder.parentId = parentId ?? undefined;
    }
    if (layout) this.layout = sanitizeLayout(layout);
    this.syncLayout();
    this.save();
    this.emit('reorder');
    this.emit('folders');
  }

  listFolders(): TaskFolder[] {
    return this.folders.map((f) => ({ ...f }));
  }

  /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with task ids. */
  listLayout(): FolderLayout {
    return Object.fromEntries(Object.entries(this.layout).map(([k, v]) => [k, [...v]]));
  }

  addFolder(name: string, parentId?: string): TaskFolder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('folder name is empty');
    if (parentId && !this.folders.some((f) => f.id === parentId)) throw new Error(`unknown folder ${parentId}`);
    const folder: TaskFolder = { id: Math.random().toString(36).slice(2, 10), name: trimmed, parentId };
    this.folders.push(folder);
    this.syncLayout();
    this.save();
    this.emit('folders');
    return folder;
  }

  renameFolder(id: string, name: string): TaskFolder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('folder name is empty');
    const folder = this.folders.find((f) => f.id === id);
    if (!folder) throw new Error(`unknown folder ${id}`);
    folder.name = trimmed;
    this.save();
    this.emit('folders');
    return { ...folder };
  }

  /** Delete a folder; its tasks and subfolders move to its parent. */
  removeFolder(id: string): boolean {
    const index = this.folders.findIndex((f) => f.id === id);
    if (index < 0) return false;
    const removed = this.folders[index];
    this.folders.splice(index, 1);
    const parent = removed.parentId && this.folders.some((f) => f.id === removed.parentId) ? removed.parentId : undefined;
    for (const f of this.folders) if (f.parentId === id) f.parentId = parent;
    let moved = false;
    for (const [taskId, t] of this.tasks) {
      if (t.folderId !== id) continue;
      this.tasks.set(taskId, { ...t, folderId: parent });
      moved = true;
    }
    this.syncLayout();
    this.save();
    this.emit('folders');
    if (moved) this.emit('reorder');
    return true;
  }

  private save(): void {
    const data: TasksFile = {
      version: DEFINITION_VERSION,
      folders: this.folders,
      layout: this.layout,
      tasks: this.list(),
      recycleBin: [...this.bin.values()],
    };
    writeJsonAtomic(this.file, data);
  }
}
