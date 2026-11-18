import { useEffect, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { folderParents, folderSubtree, itemsInside, itemsInTreeOrder, siblingOrder, type Filed, type FolderLayout } from '@shared/folders';
import type { TaskFolder } from '@shared/types';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { useGroupedTree, type TreeRow } from './GroupedTree';

/** What a list's drag and drop sends its store: the new order, items' new folders (null: the top level), the layout and folders' new parents. */
export type FolderReorder = (
  ids: string[],
  folderById?: Record<string, string | null>,
  layout?: FolderLayout,
  parentById?: Record<string, string | null>,
) => void;

export interface FolderTreeProps<T extends Filed> {
  /** Every item, in the store's order. */
  items: T[];
  folders: TaskFolder[];
  /** Sibling display order per container ('' = top level): `folder:<id>` entries mixed with item ids. */
  layout: FolderLayout;
  /** The list's accessible name. */
  label: string;
  /** Row ids start with it, so they stay unique when an item is listed twice in a window. */
  idPrefix: string;
  selected: string | null;
  /** null = nothing selected (a click on the list's empty space). */
  onSelect: (id: string | null) => void;
  /** The rows without their second line. */
  compact: boolean;
  /** The list's filters: whether an item shows. */
  passes: (item: T) => boolean;
  /** The list sorts its items itself (a pane by due time): folders keep their order, and a drop only moves an item into a folder. */
  sortItems?: (a: T, b: T) => number;
  /** Off: the items show straight, without folder rows. */
  showFolders: boolean;
  /** Whether a folder shows, from the items in it and in the folders under it. */
  folderShown: (inside: T[]) => boolean;
  /** On: folders start open and opening one opens its whole subtree. Off: folders start closed. */
  autoOpenFolders: boolean;
  /** A row's content, inside its list item. */
  renderItem: (item: T) => ReactNode;
  /** Extra classes for an item's row. */
  itemClass?: (item: T) => string;
  /** A double-click or Enter on an item. */
  onActivate: (item: T) => void;
  /** Delete on an item (the selected one: its own command asks first). */
  onDelete: (item: T) => void;
  onItemMenu: (item: T) => void;
  /** F2 and Delete on a folder. */
  onFolderCommand: (folderId: string, command: 'rename' | 'delete') => void;
  onFolderMenu: (folderId: string) => void;
  /** The menu of the empty space below the rows. */
  onEmptyMenu: () => void;
  onReorder: FolderReorder;
}

/** What is being dragged: an item's row or a folder header. */
type DragItem = { kind: 'item' | 'folder'; id: string };

/**
 * Where the drag would land: before/after an item (in that item's container),
 * into a folder (at its end), before/after a folder (in the folder's parent
 * container), or at the top level's end.
 */
type DropTarget =
  | { kind: 'item'; itemId: string; pos: 'before' | 'after' }
  | { kind: 'folder'; folderId: string; pos: 'before' | 'into' | 'after' }
  | { kind: 'root' };

/** One rendered row, flattened out of the folder tree. An item row marks whether it closes its container's subtree. */
type Row<T> = TreeRow<{ f: TaskFolder; showChildren: boolean; count: number }, { t: T; container: string; popOut: boolean }>;

const INDENT = GROUP_INDENT;

/**
 * A list of items in nested folders, the task list's and the Projects tab's:
 * folders and items share one order in each folder (the layout), folders open
 * and close, the keyboard walks every row, and dragging moves an item or a
 * folder before or after another row, into a folder, out of one past its last
 * row, or to the top level's end below the rows.
 */
export function FolderTree<T extends Filed>(p: FolderTreeProps<T>) {
  const { items, folders, layout, selected, onSelect, passes, showFolders, autoOpenFolders } = p;
  const sorted = !!p.sortItems;
  const rowId = (id: string) => `${p.idPrefix}${id}`;
  const parents = folderParents(folders);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // An item filed in a deleted or unknown folder lists at the top level.
  const containerOf = (t: T) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');

  // Sibling order per container, self-healed: the folders and items can
  // outrun the layout event, so members the layout doesn't know append.
  const entriesOf = siblingOrder(items, folders, layout, parents);

  // Folder open state lives per session; the setting decides the default.
  // `marked` holds the exceptions: closed folders when auto-open is on, open
  // folders when it's off. Flipping the setting resets everything to its
  // default (all open / all closed).
  const [marked, setMarked] = useState<Set<string>>(new Set());
  useEffect(() => setMarked(new Set()), [autoOpenFolders]);
  const isOpen = (id: string) => (autoOpenFolders ? !marked.has(id) : marked.has(id));
  const toggleFolder = (id: string) => {
    setMarked((prev) => {
      const next = new Set(prev);
      const opening = autoOpenFolders ? next.has(id) : !next.has(id);
      if (autoOpenFolders) {
        // Opening a folder re-opens its whole subtree, however it was left.
        if (opening) for (const sub of folderSubtree(folders, id)) next.delete(sub);
        else next.add(id);
      } else if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Flatten the tree into rows. A closing row's bottom edge doubles as "after that folder".
  const rows: Row<T>[] = [];
  const itemById = new Map(items.map((t) => [t.id, t]));
  const itemRowOf = (t: T, depth: number, container: string, popOut: boolean): Row<T> => ({ kind: 'item', key: t.id, id: rowId(t.id), depth, item: { t, container, popOut } });
  const build = (container: string, depth: number) => {
    let entries = entriesOf.get(container) ?? [];
    if (p.sortItems) {
      // Folders keep their order, ahead of the sorted items.
      const inOrder = entries.flatMap((e) => (e.startsWith('folder:') ? [] : (itemById.get(e) ?? [])));
      entries = [...entries.filter((e) => e.startsWith('folder:')), ...inOrder.sort(p.sortItems).map((t) => t.id)];
    }
    entries.forEach((entry, i) => {
      const lastHere = i === entries.length - 1;
      if (entry.startsWith('folder:')) {
        const f = folderById.get(entry.slice(7));
        if (!f) return;
        const inside = itemsInside(items, folders, f.id);
        if (!p.folderShown(inside)) return;
        const open = isOpen(f.id);
        const children = entriesOf.get(f.id) ?? [];
        rows.push({ kind: 'group', key: f.id, id: rowId(`folder-${f.id}`), depth, open, group: { f, showChildren: open && children.length > 0, count: inside.filter(passes).length } });
        if (open) build(f.id, depth + 1);
      } else {
        const t = itemById.get(entry);
        if (t && passes(t)) rows.push(itemRowOf(t, depth, container, container !== '' && lastHere));
      }
    });
  };
  if (showFolders) build('', 0);
  else {
    // Folders off: every item the list shows, in tree order (folders open or not), at the top level.
    const inOrder = itemsInTreeOrder(items, entriesOf).filter(passes);
    if (p.sortItems) inOrder.sort(p.sortItems);
    for (const t of inOrder) rows.push(itemRowOf(t, 0, containerOf(t), false));
  }

  // The keyboard walks every row, folder headers included.
  const tree = useGroupedTree({
    rows,
    selected,
    onSelect: ({ t }) => onSelect(t.id),
    onDeselect: () => onSelect(null),
    tree: showFolders,
    toggle: ({ f }) => toggleFolder(f.id),
    onOpen: ({ t }) => p.onActivate(t),
    onDelete: (r) => (r.kind === 'group' ? p.onFolderCommand(r.group.f.id, 'delete') : p.onDelete(r.item.t)),
    onRename: (r) => {
      if (r.kind === 'group') p.onFolderCommand(r.group.f.id, 'rename');
    },
    itemMenu: ({ t }) => p.onItemMenu(t),
    groupMenu: ({ f }) => p.onFolderMenu(f.id),
    emptyMenu: p.onEmptyMenu,
  });

  const [drag, setDrag] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  /** Containers a dragged folder must not land in: itself and its subtree. */
  const forbidden = drag?.kind === 'folder' ? folderSubtree(folders, drag.id) : new Set<string>();

  /** The layout with `entry` removed everywhere (lists copied). */
  const stripped = (entry: string): FolderLayout => Object.fromEntries([...entriesOf].map(([k, v]) => [k, v.filter((x) => x !== entry)]));

  /** Place `entry` next to `anchor` inside `container`. */
  const placed = (entry: string, container: string, anchor: string, pos: 'before' | 'after') => {
    const map = stripped(entry);
    const list = map[container] ?? [];
    const i = list.indexOf(anchor);
    if (i < 0) list.push(entry);
    else list.splice(i + (pos === 'after' ? 1 : 0), 0, entry);
    map[container] = list;
    return map;
  };

  /** Place `entry` at the end of `container`. */
  const appended = (entry: string, container: string) => {
    const map = stripped(entry);
    map[container] = [...(map[container] ?? []), entry];
    return map;
  };

  const completeDrop = (target: DropTarget) => {
    const d = drag;
    clearDrag();
    if (!d) return;
    const ids = items.map((t) => t.id);
    if (d.kind === 'folder') {
      const entry = `folder:${d.id}`;
      if (target.kind === 'root') {
        p.onReorder(ids, undefined, appended(entry, ''), { [d.id]: null });
      } else if (target.kind === 'item') {
        const anchor = items.find((t) => t.id === target.itemId);
        if (!anchor) return;
        const c = containerOf(anchor);
        p.onReorder(ids, undefined, placed(entry, c, anchor.id, target.pos), { [d.id]: c || null });
      } else if (target.pos === 'into') {
        p.onReorder(ids, undefined, appended(entry, target.folderId), { [d.id]: target.folderId });
      } else {
        const c = parents.get(target.folderId) ?? '';
        p.onReorder(ids, undefined, placed(entry, c, `folder:${target.folderId}`, target.pos), { [d.id]: c || null });
      }
      return;
    }

    const dragged = items.find((t) => t.id === d.id);
    if (!dragged) return;
    let folderId: string | null = null;
    let nextLayout: FolderLayout;
    if (target.kind === 'item') {
      const anchor = items.find((t) => t.id === target.itemId);
      if (!anchor) return;
      const c = containerOf(anchor);
      folderId = c || null;
      nextLayout = placed(dragged.id, c, anchor.id, target.pos);
    } else if (target.kind === 'folder') {
      if (target.pos === 'into') {
        folderId = target.folderId;
        nextLayout = appended(dragged.id, target.folderId);
      } else {
        const c = parents.get(target.folderId) ?? '';
        folderId = c || null;
        nextLayout = placed(dragged.id, c, `folder:${target.folderId}`, target.pos);
      }
    } else {
      nextLayout = appended(dragged.id, '');
    }
    const changedFolder = folderId !== (containerOf(dragged) || null);
    p.onReorder(ids, changedFolder ? { [dragged.id]: folderId } : undefined, nextLayout);
  };

  const allowDrop = (e: DragEvent, target: DropTarget) => {
    if (!drag) return;
    if (drag.kind === 'item' && target.kind === 'item' && target.itemId === drag.id) return;
    if (!showFolders) {
      // Without folder rows, a drop only reorders an item among its own folder's items.
      if (sorted || drag.kind !== 'item' || target.kind !== 'item') return;
      const dragged = items.find((t) => t.id === drag.id);
      const anchor = items.find((t) => t.id === target.itemId);
      if (!dragged || !anchor || containerOf(dragged) !== containerOf(anchor)) return;
    }
    if (drag.kind === 'folder') {
      // Never into (or next to anything inside) the dragged folder's own subtree.
      if (target.kind === 'folder' && forbidden.has(target.folderId)) return;
      if (target.kind === 'item') {
        const anchor = items.find((t) => t.id === target.itemId);
        if (!anchor || forbidden.has(containerOf(anchor))) return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDrop(target);
  };

  const itemRow = (r: Extract<Row<T>, { kind: 'item' }>) => {
    const { depth } = r;
    const { t, container, popOut } = r.item;
    // "After the folder" on its closing row shows a line one indent step out.
    const dropClass =
      drop?.kind === 'item' && drop.itemId === t.id
        ? ` drop-${drop.pos}`
        : drop?.kind === 'folder' && drop.pos === 'after' && popOut && drop.folderId === container
          ? ' drop-after-out'
          : '';
    return (
      <li
        key={t.id}
        {...tree.itemProps(r)}
        role={showFolders ? 'treeitem' : 'option'}
        aria-level={showFolders ? depth + 1 : undefined}
        className={`task-item${selected === t.id ? ' selected' : ''}${p.itemClass ? ` ${p.itemClass(t)}` : ''}${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        // A flat list that sorts itself has nowhere to drop an item.
        draggable={showFolders || !sorted}
        onDragStart={(e) => {
          setDrag({ kind: 'item', id: t.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', t.id);
        }}
        onDragEnd={clearDrag}
        onDragOver={(e) => {
          if (!drag) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - rect.top;
          if (sorted) {
            // The list sorts itself: a drop on an item only moves into that item's folder.
            allowDrop(e, container ? { kind: 'folder', folderId: container, pos: 'into' } : { kind: 'root' });
          } else if (popOut && y >= rect.height * 0.75) {
            // Bottom quarter of a folder's closing row: leave it, land right after it.
            allowDrop(e, { kind: 'folder', folderId: container, pos: 'after' });
          } else {
            allowDrop(e, { kind: 'item', itemId: t.id, pos: y < rect.height / 2 ? 'before' : 'after' });
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (drop) completeDrop(drop);
        }}
      >
        {p.renderItem(t)}
      </li>
    );
  };

  const folderRow = (r: Extract<Row<T>, { kind: 'group' }>) => {
    const { depth } = r;
    const { f, showChildren, count } = r.group;
    const dropHere = drop?.kind === 'folder' && drop.folderId === f.id ? drop.pos : null;
    // With children visible, the "after the folder" line renders on its closing row instead.
    const dropClass =
      dropHere === 'into' ? ' drop-into' : dropHere === 'before' ? ' drop-before' : dropHere === 'after' && !showChildren ? ' drop-after' : '';
    return (
      <GroupHeader
        key={`folder-${f.id}`}
        {...tree.groupProps(r)}
        as="li"
        name={f.name}
        count={count}
        level={depth + 1}
        className={`task-folder${tree.activeGroup === f.id ? ' active' : ''}${dropClass}`}
        style={depth > 0 ? { marginLeft: depth * INDENT } : undefined}
        draggable
        onDragStart={(e) => {
          setDrag({ kind: 'folder', id: f.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `folder:${f.id}`);
        }}
        onDragEnd={clearDrag}
        onDragOver={(e) => {
          if (!drag) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - rect.top;
          // Top edge = before the folder; bottom edge (nothing visible inside) =
          // after it; the rest = into the folder (a dragged folder nests).
          const pos = y < rect.height * 0.25 ? 'before' : !showChildren && y >= rect.height * 0.75 ? 'after' : 'into';
          allowDrop(e, { kind: 'folder', folderId: f.id, pos });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (drop) completeDrop(drop);
        }}
      />
    );
  };

  return (
    <ul
      className={`task-list${p.compact ? ' compact' : ''}`}
      role={showFolders ? 'tree' : 'listbox'}
      aria-label={p.label}
      {...tree.listProps}
      onDragOver={(e) => {
        if (e.target === e.currentTarget) allowDrop(e, { kind: 'root' });
      }}
      onDrop={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        completeDrop({ kind: 'root' });
      }}
    >
      {rows.map((r) => (r.kind === 'item' ? itemRow(r) : folderRow(r)))}
    </ul>
  );
}
