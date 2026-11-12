// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import { folderParents, folderSubtree, siblingOrder } from '../../shared/folders';
import type { Task, TaskFolder } from '../../shared/types';

/** An item a folder can hold: a task, or a project in the Projects tab's folders. */
type Filed = { id: string; folderId?: string };

/** One row of a phone's Tasks or Projects screen: a folder (it opens its own screen) or an item. */
export type TaskEntry<T extends Filed = Task> =
  | {
      kind: 'folder';
      folder: TaskFolder;
      /** The items in the folder and every folder under it that the list shows. */
      count: number;
    }
  | { kind: 'task'; task: T };

export interface TaskTree<T extends Filed = Task> {
  tasks: T[];
  folders: TaskFolder[];
  layout: Record<string, string[]>;
  /** The list's filters: whether an item shows. */
  passes: (t: T) => boolean;
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
export function taskEntries<T extends Filed>(container: string, tree: TaskTree<T>): TaskEntry<T>[] {
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
    const out: TaskEntry<T>[] = [];
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

  const out: TaskEntry<T>[] = [];
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
