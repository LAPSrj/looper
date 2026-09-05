import type { TaskFolder } from './types';

/**
 * Effective container of each folder ('' = top level). A parent that doesn't
 * exist or would close a cycle lands the folder at the top level, so a broken
 * file never breaks the tree.
 */
export function folderParents(folders: TaskFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  for (const f of folders) {
    let parent = f.parentId && byId.has(f.parentId) ? f.parentId : '';
    const seen = new Set([f.id]);
    let p = parent;
    while (p) {
      if (seen.has(p)) {
        parent = '';
        break;
      }
      seen.add(p);
      const pf = byId.get(p);
      p = pf?.parentId && byId.has(pf.parentId) ? pf.parentId : '';
    }
    out.set(f.id, parent);
  }
  return out;
}

/** The folder plus every folder nested under it. */
export function folderSubtree(folders: TaskFolder[], id: string): Set<string> {
  const parents = folderParents(folders);
  const subtree = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      const p = parents.get(f.id);
      if (p && subtree.has(p) && !subtree.has(f.id)) {
        subtree.add(f.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** Depth-first walk in the given sibling order, for indented folder pickers. */
export function folderTree(folders: TaskFolder[]): { folder: TaskFolder; depth: number }[] {
  const parents = folderParents(folders);
  const out: { folder: TaskFolder; depth: number }[] = [];
  const walk = (container: string, depth: number) => {
    for (const f of folders) {
      if (parents.get(f.id) !== container) continue;
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}
