import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { isPhone } from '../web/page-nav';
import { Group, Row } from './phone/PhoneList';
import { RowList, type ListMenuItem } from './RowList';

export type { ListMenuItem };

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

const EMPTY_ROW = { className: 'env-item muted', style: { textAlign: 'center', cursor: 'default' } as const };

/**
 * A list of items, adapted to the platform from the same props: a RowList of a name and a line under it. On a
 * desktop, the classic list-then-window listbox: click selects, double-click/Enter opens. On a phone, a list
 * section: a list with a `menu` has rows a tap opens (or shows the menu of, with no `onOpen`), a long press
 * shows the menu of, and a swipe offers the menu's destructive command; one without is a choice of one, with a
 * check on the chosen row.
 */
export function SelectList<T>({ items, label, idPrefix, selectedKey, itemKey, itemName, itemSub, onSelect, onOpen, onReorder, menu, onDelete, onRename, autoFocus, empty }: SelectListProps<T>) {
  const rows = items.map((item, i) => ({ item, i }));
  return (
    <RowList
      section
      rows={rows}
      rowKey={({ item, i }) => itemKey(item, i)}
      idPrefix={idPrefix}
      label={label}
      selected={selectedKey}
      onSelect={({ item, i }) => onSelect(item, i)}
      onOpen={onOpen && (({ item, i }) => onOpen(item, i))}
      menu={menu && (({ item, i }) => menu(item, i))}
      onDelete={onDelete && (({ item, i }) => onDelete(item, i))}
      onRename={onRename && (({ item, i }) => onRename(item, i))}
      onReorder={onReorder}
      autoFocus={autoFocus}
      empty={empty}
      emptyRow={EMPTY_ROW}
      listClass="env-list boxed"
      rowClass="env-item"
      row={({ item, i }) => {
        const sub = itemSub?.(item, i);
        return (
          <>
            <div className="env-item-name">{itemName(item, i)}</div>
            {sub !== undefined && sub !== null && sub !== '' && <div className="env-item-sub">{sub}</div>}
          </>
        );
      }}
      phoneRow={({ item, i }) => ({ title: itemName(item, i), sub: itemSub?.(item, i) || undefined, chevron: !!menu && !!onOpen })}
    />
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
