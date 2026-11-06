import type { TaskFolder } from './types';

/** Something a list files in its folders: a task or a project. */
export interface Filed {
  id: string;
  folderId?: string;
}

/** Sibling order per container ('' = the top level): `folder:<id>` entries mixed with item ids. */
export type FolderLayout = Record<string, string[]>;

export function moveKey(keys: readonly string[], from: number, to: number): string[] {
  const next = [...keys];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The layout with `shown`, the members of `container` a list shows, in their new order; members it doesn't show keep their places. */
export function withSiblingsOrdered(order: Map<string, string[]>, container: string, shown: readonly string[]): FolderLayout {
  const moving = new Set(shown);
  const next = [...shown];
  const all = order.get(container) ?? [];
  return { ...Object.fromEntries(order), [container]: all.map((k) => (moving.has(k) ? next.shift()! : k)) };
}

/**
 * Sibling order per container ('' = top level): `folder:<id>` entries mixed
 * with item ids, in the layout's order, self-healed: members the layout
 * doesn't know append, and ones that don't exist or sit elsewhere drop. An
 * item filed in a deleted or unknown folder lists at the top level.
 */
export function siblingOrder(items: Filed[], folders: TaskFolder[], layout: FolderLayout, parents: Map<string, string> = folderParents(folders)): Map<string, string[]> {
  const containerOf = (t: Filed) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');
  const out = new Map<string, string[]>();
  for (const container of ['', ...folders.map((f) => f.id)]) {
    const valid = new Set<string>();
    for (const f of folders) if (parents.get(f.id) === container) valid.add(`folder:${f.id}`);
    for (const t of items) if (containerOf(t) === container) valid.add(t.id);
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

/** A stored layout: string lists by container, anything else dropped. */
export function sanitizeLayout(raw: unknown): FolderLayout {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: FolderLayout = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[key] = value.filter((e): e is string => typeof e === 'string');
  }
  return out;
}

/**
 * A folder's new parent, unless it's unknown or inside the folder's own
 * subtree (which would close a cycle): then null, and the folder stays where it is.
 */
export function validParent(folders: TaskFolder[], id: string, parentId: string | null): string | undefined | null {
  if (!parentId) return undefined;
  if (!folders.some((f) => f.id === parentId)) return null;
  const parents = folderParents(folders);
  for (let p: string | undefined = parentId; p; p = parents.get(p) || undefined) if (p === id) return null;
  return parentId;
}

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
