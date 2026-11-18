import { useState, type MouseEvent, type ReactNode } from 'react';
import { useListNav } from './hooks';
import { listContextMenu, parentIndex } from './list-nav';
import { selectsOnMenu } from './ListDetail';

/** A row of a list in groups, as it shows: a group's header or an item. */
export type TreeRow<G, I> =
  | { kind: 'group'; key: string; id: string; depth: number; open: boolean; group: G }
  | { kind: 'item'; key: string; id: string; depth: number; item: I };

export interface GroupedTreeModel<G, I> {
  /** The rows that show, top to bottom: a closed group's items are left out. */
  rows: TreeRow<G, I>[];
  /** The selected item's key. */
  selected: string | null;
  onSelect: (item: I) => void;
  /** A click on the list's empty space. */
  onDeselect?: () => void;
  /** Off: a flat list, which the keys that open and close groups leave alone. */
  tree?: boolean;
  toggle: (group: G) => void;
  /** A double-click or Enter on an item. */
  onOpen: (item: I) => void;
  onDelete?: (row: TreeRow<G, I>) => void;
  onRename?: (row: TreeRow<G, I>) => void;
  itemMenu?: (item: I) => void;
  groupMenu?: (group: G) => void;
  /** The menu of the empty space below the rows. */
  emptyMenu?: () => void;
}

/**
 * The selection, keys and menus of a list in groups (task folders, project groups,
 * addon pane groups, History, Chats): the active row is the selected item, or the header the
 * keyboard last stopped on, while the item stays selected. Each list draws its own rows
 * and spreads these props on them, with its own roles and classes.
 */
export function useGroupedTree<G, I>(m: GroupedTreeModel<G, I>) {
  const { rows, selected, onSelect, toggle, onOpen, itemMenu, groupMenu } = m;
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.key === activeGroup);
  const index = groupAt >= 0 ? groupAt : selected === null ? -1 : rows.findIndex((r) => r.kind === 'item' && r.key === selected);
  const pick = (item: I) => {
    setActiveGroup(null);
    onSelect(item);
  };
  const depths = rows.map((r) => r.depth);
  const rowMenu = (r: TreeRow<G, I>) => (r.kind === 'item' ? itemMenu?.(r.item) : groupMenu?.(r.group));
  const onKeyDown = useListNav({
    count: rows.length,
    index,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'group') return setActiveGroup(r.key);
      setActiveGroup(null);
      if (r.key !== selected) onSelect(r.item);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'group') toggle(r.group);
      else onOpen(r.item);
    },
    onDelete: m.onDelete && ((i) => m.onDelete!(rows[i])),
    onRename: m.onRename && ((i) => m.onRename!(rows[i])),
    onMenu: itemMenu || groupMenu ? (i) => rowMenu(rows[i]) : undefined,
    tree:
      m.tree === false
        ? undefined
        : {
            expanded: (i) => {
              const r = rows[i];
              return r.kind === 'group' ? r.open : undefined;
            },
            set: (i, open) => {
              const r = rows[i];
              if (r.kind === 'group' && r.open !== open) toggle(r.group);
            },
            parent: (i) => parentIndex(depths, i),
          },
    scrollToId: index >= 0 ? rows[index].id : null,
  });

  return {
    index,
    activeGroup,
    pick,
    /** The list element's: it takes the focus and the keys, and answers the keyboard's menu request. */
    listProps: {
      tabIndex: 0,
      'aria-activedescendant': index >= 0 ? rows[index].id : undefined,
      onKeyDown,
      onClick: m.onDeselect
        ? (e: MouseEvent<HTMLElement>) => {
            if (e.target !== e.currentTarget) return;
            setActiveGroup(null);
            m.onDeselect!();
          }
        : undefined,
      onContextMenu: (e: MouseEvent<HTMLElement>) => listContextMenu(e, index, (i) => rowMenu(rows[i]), m.emptyMenu),
    },
    /** An item row's. A right-click selects the item first where a selection doesn't open it. */
    itemProps: (r: Extract<TreeRow<G, I>, { kind: 'item' }>) => ({
      id: r.id,
      'aria-selected': r.key === selected,
      onClick: () => pick(r.item),
      onDoubleClick: () => onOpen(r.item),
      onContextMenu: itemMenu
        ? (e: MouseEvent<HTMLElement>) => {
            e.preventDefault();
            e.stopPropagation();
            if (selectsOnMenu) pick(r.item);
            itemMenu(r.item);
          }
        : undefined,
    }),
    /** A group header's (GroupHeader): a click opens or closes it and makes it the active row. */
    groupProps: (r: Extract<TreeRow<G, I>, { kind: 'group' }>) => ({
      id: r.id,
      open: r.open,
      onToggle: () => {
        setActiveGroup(r.key);
        toggle(r.group);
      },
      onContextMenu: groupMenu
        ? (e: MouseEvent<HTMLElement>) => {
            e.preventDefault();
            e.stopPropagation();
            groupMenu(r.group);
          }
        : undefined,
    }),
  };
}

/** A tree row's text: the item's name, then its second line (`sub`, or the row's own in `children`). */
export function ItemText({ name, sub, subClass, children }: { name: ReactNode; sub?: string; subClass?: string; children?: ReactNode }) {
  return (
    <>
      <div className="task-item-row">
        <span className="task-name">{name}</span>
      </div>
      {sub && (
        <div className={`task-item-sub${subClass ? ` ${subClass}` : ''}`} title={sub}>
          {sub}
        </div>
      )}
      {children}
    </>
  );
}
