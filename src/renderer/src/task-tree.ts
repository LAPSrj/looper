// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import { folderParents, folderSubtree } from '../../shared/folders';
import type { Task, TaskFolder } from '../../shared/types';

/**
 * Sibling order per container ('' = top level): `folder:<id>` entries mixed with
 * task ids, in the layout's order, self-healed: the folders and tasks can outrun
 * the layout event, so members the layout doesn't know append, and ones that
 * don't exist or sit elsewhere drop.
 */
export function siblingOrder(
  tasks: Task[],
  folders: TaskFolder[],
  layout: Record<string, string[]>,
  parents: Map<string, string> = folderParents(folders),
): Map<string, string[]> {
  // A task pointing at a deleted or unknown folder lists at the top level.
  const containerOf = (t: Task) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');
  const out = new Map<string, string[]>();
  for (const container of ['', ...folders.map((f) => f.id)]) {
    const valid = new Set<string>();
    for (const f of folders) if (parents.get(f.id) === container) valid.add(`folder:${f.id}`);
    for (const t of tasks) if (containerOf(t) === container) valid.add(t.id);
    const list: string[] = [];
    for (const entry of layout[container] ?? []) {
      if (!valid.has(entry)) continue;
      valid.delete(entry);
      list.push(entry);
    }
    list.push(...valid);
    out.set(container, list);
  }
  return out;
}

/** One row of a phone's Tasks screen: a folder (it opens its own screen) or a task. */
export type TaskEntry =
  | {
      kind: 'folder';
      folder: TaskFolder;
      /** The tasks in the folder and every folder under it that the list shows. */
      count: number;
    }
  | { kind: 'task'; task: Task };

export interface TaskTree {
  tasks: Task[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  /** The list's filters: whether a task shows. */
  passes: (t: Task) => boolean;
  /** Off: the list shows its tasks straight, without folder rows. */
  showFolders: boolean;
  /** Hide a folder none of whose tasks the list shows. */
  hideEmptyFolders: boolean;
}

/**
 * What a phone's Tasks screen lists for one container ('' = the top level, else a
 * folder's id): its subfolders and tasks in the desktop list's order, each folder
 * with its subtree's task count. With folders off, the top level is every shown
 * task in tree order.
 */
export function taskEntries(container: string, tree: TaskTree): TaskEntry[] {
  const { tasks, folders, layout, passes } = tree;
  const parents = folderParents(folders);
  const order = siblingOrder(tasks, folders, layout, parents);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const count = (id: string): number => {
    const ids = folderSubtree(folders, id);
    return tasks.filter((t) => t.folderId && ids.has(t.folderId) && passes(t)).length;
  };

  if (!tree.showFolders) {
    if (container !== '') return [];
    const out: TaskEntry[] = [];
    const walk = (c: string) => {
      for (const entry of order.get(c) ?? []) {
        if (entry.startsWith('folder:')) walk(entry.slice(7));
        else {
          const t = taskById.get(entry);
          if (t && passes(t)) out.push({ kind: 'task', task: t });
        }
      }
    };
    walk('');
    return out;
  }

  const out: TaskEntry[] = [];
  for (const entry of order.get(container) ?? []) {
    if (entry.startsWith('folder:')) {
      const folder = folderById.get(entry.slice(7));
      if (!folder) continue;
      const n = count(folder.id);
      if (tree.hideEmptyFolders && n === 0) continue;
      out.push({ kind: 'folder', folder, count: n });
    } else {
      const t = taskById.get(entry);
      if (t && passes(t)) out.push({ kind: 'task', task: t });
    }
  }
  return out;
}
