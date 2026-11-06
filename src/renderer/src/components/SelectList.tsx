import { Children, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, LiHTMLAttributes, ReactNode } from 'react';
import { isPhone } from '../web/page-nav';
import { useListNav } from './hooks';
import { listContextMenu } from './list-nav';
import { EmptyRow, Group, Row, SwipeRow } from './phone/PhoneList';
import { ReorderSheet } from './phone/ReorderSheet';

/** One command of a row's context menu: the same as the button of that name under the list. */
export interface ListMenuItem {
  label: string;
  enabled?: boolean;
  /** It destroys or cuts something off (Remove): a phone draws it red, last, and a swipe on the row offers it. */
  destructive?: true;
  /** A separator above it. */
  separator?: true;
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
  /** Shown as a single muted row when there are no items. */
  empty?: ReactNode;
}

/** Opens a row's menu: the main process's, whose pick comes back as an event carrying this list's token. */
function useRowMenu() {
  const token = useId();
  const shown = useRef<ListMenuItem[]>([]);
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'list-menu' && e.token === token) shown.current[Number(e.id)]?.run();
      }),
    [token],
  );
  return (items: ListMenuItem[]) => {
    shown.current = items;
    window.looper.showListContextMenu(
      token,
      items.map((m, n) => ({
        id: String(n),
        label: m.label,
        enabled: m.enabled,
        ...(m.destructive ? { destructive: true as const } : {}),
        ...(m.separator ? { separator: true as const } : {}),
      })),
    );
  };
}

/**
 * A list of items, adapted to the platform from the same props. On a desktop, the classic
 * list-then-window listbox: click selects, double-click/Enter opens. On a phone, a list section:
 * a list with a `menu` has rows a tap opens (or shows the menu of, with no `onOpen`), a long press
 * shows the menu of, and a swipe offers the menu's destructive command; one without is a choice of
 * one, with a check on the chosen row.
 */
export function SelectList<T>(props: SelectListProps<T>) {
  return isPhone ? <PhoneSelectList {...props} /> : <DesktopSelectList {...props} />;
}

function PhoneSelectList<T>({ items, label, selectedKey, itemKey, itemName, itemSub, onSelect, onOpen, onReorder, menu, empty }: SelectListProps<T>) {
  const openMenu = useRowMenu();
  const [reordering, setReordering] = useState(false);
  return (
    <div role={menu ? undefined : 'radiogroup'} aria-label={label}>
      <Group>
        {items.length === 0 && empty !== undefined && <EmptyRow>{empty}</EmptyRow>}
        {items.map((item, i) => {
          const key = itemKey(item, i);
          const commands = menu?.(item, i);
          const destroy = commands?.find((m) => m.destructive && m.enabled !== false);
          const showMenu = commands && (() => {
            onSelect(item, i);
            openMenu(commands);
          });
          return (
            <SwipeRow key={key} action={destroy && { label: destroy.label, run: destroy.run }}>
              <Row
                title={itemName(item, i)}
                sub={itemSub?.(item, i) || undefined}
                chevron={!!commands && !!onOpen}
                checked={commands ? undefined : key === selectedKey}
                onMenu={showMenu}
                onOpen={() => {
                  if (!commands) onSelect(item, i);
                  else if (onOpen) {
                    onSelect(item, i);
                    onOpen(item, i);
                  } else showMenu?.();
                }}
              />
            </SwipeRow>
          );
        })}
        {onReorder && items.length > 1 && <Row title="Reorder" tone="action" onOpen={() => setReordering(true)} />}
      </Group>
      {reordering && onReorder && (
        <ReorderSheet
          title={`Reorder ${label}`}
          sections={[{ key: 'list', items: items.map((item, i) => ({ key: itemKey(item, i), title: itemName(item, i), sub: itemSub?.(item, i) || undefined })) }]}
          onReorder={(_section, keys) => onReorder(keys)}
          onClose={() => setReordering(false)}
        />
      )}
    </div>
  );
}

function DesktopSelectList<T>({ items, label, idPrefix, selectedKey, itemKey, itemName, itemSub, onSelect, onOpen, onReorder, menu, onDelete, onRename, autoFocus, empty }: SelectListProps<T>) {
  const index = selectedKey === null ? -1 : items.findIndex((it, i) => itemKey(it, i) === selectedKey);

  const showMenu = useRowMenu();
  const openMenu = (item: T, i: number) => {
    if (menu) showMenu(menu(item, i));
  };
  const hasMenu = !!menu;

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

/**
 * One of a list's own buttons (Install…, Restore, Empty Recycle Bin). `row`: it acts on the selected row, so a phone,
 * which has no selected row, leaves it to the row's menu; any other is a command row of its own under the list there.
 */
export function ListButton({ row, danger, disabled, onClick, children }: { row?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  if (!isPhone) {
    return (
      <button className={`btn${danger ? ' danger' : ''}`} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }
  return row ? null : <Row title={children} tone={danger ? 'destructive' : 'action'} disabled={disabled} onOpen={onClick} />;
}

interface ListActionsProps {
  /** What the list holds, one of them ("Harness"): a phone's Add row says "Add Harness…". */
  item?: string;
  /** Each standard button shows only when its handler is given. */
  onAdd?: () => void;
  onEdit?: () => void;
  editDisabled?: boolean;
  onDuplicate?: () => void;
  duplicateDisabled?: boolean;
  onRemove?: () => void;
  removeDisabled?: boolean;
  removeTitle?: string;
  /** The list's own ListButtons, after the standard ones (Update…, Restore, Pair Device…). */
  children?: ReactNode;
}

/**
 * The button row under a SelectList: Add…, Edit…, Duplicate, Remove, then the list's own.
 * On a phone, Edit, Duplicate and Remove are the rows' own commands; the rest are command rows in a section under the list.
 */
export function ListActions({ item, onAdd, onEdit, editDisabled, onDuplicate, duplicateDisabled, onRemove, removeDisabled, removeTitle, children }: ListActionsProps) {
  if (isPhone) {
    const own = Children.toArray(children).filter((c) => isValidElement<{ row?: boolean }>(c) && !c.props.row);
    if (!onAdd && own.length === 0) return null;
    return (
      <Group>
        {onAdd && <Row title={`Add${item ? ` ${item}` : ''}…`} tone="action" onOpen={onAdd} />}
        {own}
      </Group>
    );
  }
  return (
    <div className="env-actions">
      {onAdd && (
        <button className="btn" onClick={onAdd}>
          Add…
        </button>
      )}
      {onEdit && (
        <button className="btn" disabled={editDisabled} onClick={onEdit}>
          Edit…
        </button>
      )}
      {onDuplicate && (
        <button className="btn" disabled={duplicateDisabled} onClick={onDuplicate}>
          Duplicate
        </button>
      )}
      {onRemove && (
        <button className="btn danger" disabled={removeDisabled} title={removeTitle} onClick={onRemove}>
          Remove
        </button>
      )}
      {children}
    </div>
  );
}
