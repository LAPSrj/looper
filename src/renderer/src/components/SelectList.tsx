import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, LiHTMLAttributes, ReactNode } from 'react';
import { useListNav } from './hooks';
import { listContextMenu } from './list-nav';

/** One command of a row's context menu: the same as the button of that name under the list. */
export interface ListMenuItem {
  label: string;
  enabled?: boolean;
  run: () => void;
}

interface SelectListProps<T> {
  /** The row's right-click menu (and Shift+F10, the Menu key): its commands, in the order of the buttons under the list. */
  menu?: (item: T, i: number) => ListMenuItem[];
  /** Delete on the selected row: its Remove command. */
  onDelete?: (item: T, i: number) => void;
  /** F2 on the selected row: its Rename command. */
  onRename?: (item: T, i: number) => void;
  /** Focus the list when the window opens, so the keys work at once. */
  autoFocus?: boolean;
  items: T[];
  /** aria-label of the listbox. */
  label: string;
  /** DOM ids are `${idPrefix}-${key}`. */
  idPrefix: string;
  selectedKey: string | null;
  itemKey: (item: T, i: number) => string;
  itemName: (item: T, i: number) => ReactNode;
  itemSub?: (item: T, i: number) => ReactNode;
  onSelect: (item: T, i: number) => void;
  /** Double-click or Enter opens the item's editor window. */
  onOpen?: (item: T, i: number) => void;
  /** Makes rows draggable; called with the full key list in its new order. */
  onReorder?: (keys: string[]) => void;
  /** Right-click: the row is selected first. */
  onContextMenu?: (item: T, i: number) => void;
  /** Shown as a single muted row when there are no items. */
  empty?: ReactNode;
}

/** The classic list-then-window listbox: click selects, double-click/Enter opens. */
export function SelectList<T>({ items, label, idPrefix, selectedKey, itemKey, itemName, itemSub, onSelect, onOpen, onReorder, onContextMenu, menu, onDelete, onRename, autoFocus, empty }: SelectListProps<T>) {
  const index = selectedKey === null ? -1 : items.findIndex((it, i) => itemKey(it, i) === selectedKey);

  // The menu is the main process's; a pick comes back as an event carrying this list's token.
  const token = useId();
  const shown = useRef<ListMenuItem[]>([]);
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'list-menu' && e.token === token) shown.current[Number(e.id)]?.run();
      }),
    [token],
  );
  const openMenu = (item: T, i: number) => {
    if (menu) {
      shown.current = menu(item, i);
      window.looper.showListContextMenu(
        token,
        shown.current.map((m, n) => ({ id: String(n), label: m.label, enabled: m.enabled })),
      );
    } else onContextMenu?.(item, i);
  };
  const hasMenu = !!(menu || onContextMenu);

  const nav = useListNav({
    count: items.length,
    index,
    onIndex: (i) => onSelect(items[i], i),
    onActivate: onOpen ? (i) => onOpen(items[i], i) : undefined,
    onDelete: onDelete ? (i) => onDelete(items[i], i) : undefined,
    onRename: onRename ? (i) => onRename(items[i], i) : undefined,
    onMenu: hasMenu ? (i) => openMenu(items[i], i) : undefined,
  });
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ key: string; pos: 'before' | 'after' } | null>(null);

  const dragProps = (key: string): LiHTMLAttributes<HTMLLIElement> => {
    if (!onReorder) return {};
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLLIElement>) => {
        setDragKey(key);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);
      },
      onDragEnd: () => {
        setDragKey(null);
        setDropAt(null);
      },
      onDragOver: (e: DragEvent<HTMLLIElement>) => {
        if (!dragKey || dragKey === key) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        setDropAt({ key, pos: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
      },
      onDrop: (e: DragEvent<HTMLLIElement>) => {
        e.preventDefault();
        if (!dragKey || !dropAt) return;
        const keys = items.map((it, i) => itemKey(it, i)).filter((k) => k !== dragKey);
        keys.splice(keys.indexOf(dropAt.key) + (dropAt.pos === 'after' ? 1 : 0), 0, dragKey);
        setDragKey(null);
        setDropAt(null);
        onReorder(keys);
      },
    };
  };

  return (
    <ul
      className="env-list boxed"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      autoFocus={autoFocus}
      onKeyDown={nav}
      onContextMenu={hasMenu ? (e) => listContextMenu(e, index, (i) => openMenu(items[i], i)) : undefined}
      aria-activedescendant={index >= 0 ? `${idPrefix}-${selectedKey}` : undefined}
    >
      {items.length === 0 && empty !== undefined && (
        <li role="option" aria-disabled="true" aria-selected={false} className="env-item muted" style={{ textAlign: 'center', cursor: 'default' }}>
          {empty}
        </li>
      )}
      {items.map((item, i) => {
        const key = itemKey(item, i);
        const sub = itemSub?.(item, i);
        const drop = dropAt?.key === key ? ` drop-${dropAt.pos}` : '';
        return (
          <li
            key={key}
            id={`${idPrefix}-${key}`}
            role="option"
            aria-selected={key === selectedKey}
            className={`env-item ${key === selectedKey ? 'selected' : ''}${drop}`}
            onClick={() => onSelect(item, i)}
            onDoubleClick={onOpen ? () => onOpen(item, i) : undefined}
            onContextMenu={
              hasMenu
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(item, i);
                    openMenu(item, i);
                  }
                : undefined
            }
            {...dragProps(key)}
          >
            <div className="env-item-name">{itemName(item, i)}</div>
            {sub !== undefined && sub !== null && sub !== '' && <div className="env-item-sub">{sub}</div>}
          </li>
        );
      })}
    </ul>
  );
}

interface ListActionsProps {
  onAdd: () => void;
  onEdit: () => void;
  editDisabled?: boolean;
  /** Omit to hide the Duplicate button. */
  onDuplicate?: () => void;
  duplicateDisabled?: boolean;
  onRemove: () => void;
  removeDisabled?: boolean;
  removeTitle?: string;
  /** Extra buttons appended after Remove. */
  children?: ReactNode;
}

/** The Add/Edit/Duplicate/Remove button row under a SelectList. */
export function ListActions({ onAdd, onEdit, editDisabled, onDuplicate, duplicateDisabled, onRemove, removeDisabled, removeTitle, children }: ListActionsProps) {
  return (
    <div className="env-actions">
      <button className="btn" onClick={onAdd}>
        Add…
      </button>
      <button className="btn" disabled={editDisabled} onClick={onEdit}>
        Edit…
      </button>
      {onDuplicate && (
        <button className="btn" disabled={duplicateDisabled} onClick={onDuplicate}>
          Duplicate
        </button>
      )}
      <button className="btn danger" disabled={removeDisabled} title={removeTitle} onClick={onRemove}>
        Remove
      </button>
      {children}
    </div>
  );
}
