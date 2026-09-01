import type { ReactNode } from 'react';
import { useListNav } from './hooks';

interface SelectListProps<T> {
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
  /** Shown as a single muted row when there are no items. */
  empty?: ReactNode;
}

/** The classic list-then-window listbox: click selects, double-click/Enter opens. */
export function SelectList<T>({ items, label, idPrefix, selectedKey, itemKey, itemName, itemSub, onSelect, onOpen, empty }: SelectListProps<T>) {
  const index = selectedKey === null ? -1 : items.findIndex((it, i) => itemKey(it, i) === selectedKey);
  const nav = useListNav({
    count: items.length,
    index,
    onIndex: (i) => onSelect(items[i], i),
    onActivate: onOpen ? (i) => onOpen(items[i], i) : undefined,
  });
  return (
    <ul
      className="env-list boxed"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onKeyDown={nav}
      aria-activedescendant={index >= 0 ? `${idPrefix}-${selectedKey}` : undefined}
    >
      {items.length === 0 && empty !== undefined && (
        <li className="env-item muted" style={{ textAlign: 'center', cursor: 'default' }}>
          {empty}
        </li>
      )}
      {items.map((item, i) => {
        const key = itemKey(item, i);
        const sub = itemSub?.(item, i);
        return (
          <li
            key={key}
            id={`${idPrefix}-${key}`}
            role="option"
            aria-selected={key === selectedKey}
            className={`env-item ${key === selectedKey ? 'selected' : ''}`}
            onClick={() => onSelect(item, i)}
            onDoubleClick={onOpen ? () => onOpen(item, i) : undefined}
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
}

/** The Add/Edit/Duplicate/Remove button row under a SelectList. */
export function ListActions({ onAdd, onEdit, editDisabled, onDuplicate, duplicateDisabled, onRemove, removeDisabled, removeTitle }: ListActionsProps) {
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
    </div>
  );
}
