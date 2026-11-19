import { Fragment, useEffect, useRef, useState } from 'react';
import type { DragEvent, HTMLAttributes, KeyboardEvent, ReactNode, Ref, UIEvent } from 'react';
import type { MenuItemSpec } from '@shared/remote-access';
import { dayGroups } from '../phone-lists';
import { isPhone } from '../web/page-nav';
import { EmptyState } from './EmptyState';
import { useListNav } from './hooks';
import { listContextMenu } from './list-nav';
import { Group, Row, SwipeRow } from './phone/PhoneList';
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

/** A row on a phone or tablet: what PhoneList's Row shows of it. */
export interface PhoneRowModel {
  title: ReactNode;
  /** A string stays on one line, cut with an ellipsis. */
  sub?: ReactNode;
  value?: ReactNode;
  lead?: ReactNode;
  tone?: 'error' | 'warning' | 'muted';
  valueTone?: 'error' | 'warning';
  /** Under the row, across the list's width (a command's output while it's open). */
  detail?: ReactNode;
  /** Whether a tap pushes another screen; unset: whenever the row can be tapped. */
  chevron?: boolean;
}

/** What a list of selectable rows (RowList, DataTable) is given. */
export interface Rows<T> {
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  /** The rows' DOM ids start with this, for the keyboard to scroll them into view. */
  idPrefix: string;
  /** The selected row's key. */
  selected?: string | null;
  /** A click on the desktop. On a phone or tablet a tap does this when the row has no onOpen. */
  onSelect?: (row: T, index: number) => void;
  /** A double-click or Enter on the desktop, a tap on a phone or tablet. */
  onOpen?: (row: T) => void;
  /** A right-click (it selects the row first) or a long press (it doesn't). */
  onMenu?: (row: T) => void;
  /** What Ctrl+C copies. */
  copyText?: (row: T) => string;
  /** The list has nothing to show. */
  empty: ReactNode;
  /** A line above the rows. */
  note?: ReactNode;
  /** On a phone or tablet, list sections above the rows (a repository's state). */
  head?: ReactNode;
  /** Its name, for assistive technology. */
  label?: string;
  phoneRow: (row: T) => PhoneRowModel;
  /** A section title for each row (rows of one title are next to each other). */
  groupOf?: (row: T) => string;
  /** On a phone or tablet, sections by day. */
  dayOf?: (row: T) => number;
  /** A section's title from its day's name and how many days there are; 0 when there are no rows. */
  sectionTitle?: (day: string, days: number) => string;
}

const shown = (n: ReactNode) => n !== undefined && n !== null && n !== '' && n !== false;

/**
 * Shows a row's menu as every page menu shows (commands.popup: a native menu at the pointer, a phone's action sheet)
 * and runs what's picked. Not popupEntries: its module brings the whole command list into every dialog with a list.
 */
export function showRowMenu(items: ListMenuItem[]): void {
  const spec = items.flatMap((m, n): MenuItemSpec[] => [
    ...(m.separator ? [{ id: `-${n}`, type: 'separator' as const, enabled: true }] : []),
    { id: String(n), type: 'normal', label: m.label, enabled: m.enabled !== false, ...(m.destructive ? { destructive: true as const } : {}) },
  ]);
  if (spec.length) void window.looper.commands.popup(spec).then((id) => id && items[Number(id)]?.run());
}

/** The list keys of a desktop list of rows, Ctrl+C included. */
export function useRowKeys<T>({
  rows,
  rowKey,
  idPrefix,
  selected,
  onSelect,
  onOpen,
  onMenu,
  copyText,
  onDelete,
  onRename,
}: Pick<Rows<T>, 'rows' | 'rowKey' | 'idPrefix' | 'selected' | 'onSelect' | 'onOpen' | 'onMenu' | 'copyText'> & { onDelete?: (row: T) => void; onRename?: (row: T) => void }) {
  const index = selected == null ? -1 : rows.findIndex((r, i) => rowKey(r, i) === selected);
  const nav = useListNav({
    count: rows.length,
    index,
    onIndex: (i) => onSelect?.(rows[i], i),
    onActivate: onOpen && ((i) => onOpen(rows[i])),
    onDelete: onDelete && ((i) => onDelete(rows[i])),
    onRename: onRename && ((i) => onRename(rows[i])),
    onMenu: onMenu && ((i) => onMenu(rows[i])),
    scrollToId: index >= 0 ? `${idPrefix}-${selected}` : null,
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'c' && copyText && index >= 0) {
      void navigator.clipboard.writeText(copyText(rows[index]));
      e.preventDefault();
      return;
    }
    nav(e);
  };
  return { index, onKeyDown };
}

export interface RowListProps<T> extends Rows<T> {
  /** A desktop row's content. */
  row: (row: T) => ReactNode;
  /** The list's and a row's classes on the desktop. */
  listClass: string;
  rowClass: string;
  onListScroll?: (e: UIEvent<HTMLDivElement>) => void;
  /** Only the rows, for a Section around them: on a phone, its section's rows; the desktop's listbox is the same. Its `empty` shows nothing. */
  bare?: boolean;
  /** A click on the desktop opens the row (a list to pick from); the arrow keys still only select. */
  activateOnClick?: boolean;
  /** The desktop's list takes the focus when it shows. */
  autoFocus?: boolean;
  /**
   * The row's commands, in the order of the buttons under the list, in place of onMenu: a right-click, Shift+F10 or a
   * long press selects the row and shows them, and a phone's swipe offers the destructive one.
   */
  menu?: (row: T) => ListMenuItem[];
  /** Delete on the selected row: its Remove command. */
  onDelete?: (row: T) => void;
  /** F2 on the selected row: its Rename command. */
  onRename?: (row: T) => void;
  /** Makes the desktop's rows draggable and gives a phone a Reorder row; called with every key in the new order. */
  onReorder?: (keys: string[]) => void;
  /**
   * On a phone, the rows are one section among the screen's others (a dialog's list), whose second lines wrap. Without
   * a `menu` it's a choice of one: a tap selects, and the selected row has a check.
   */
  section?: boolean;
  /** A heading for the list among a window's other parts: a phone section's header, a label above the desktop's listbox. */
  title?: string;
}

/** A list of selectable multi-line rows: a listbox on the desktop, list rows on a phone or tablet. */
export function RowList<T>(props: RowListProps<T>) {
  if (!isPhone) return <DesktopRowList {...props} />;
  if (props.section) return <PhoneSection {...props} />;
  if (props.bare) return <PhoneRowItems {...props} items={props.rows.map((row, index) => ({ row, index }))} />;
  return <PhoneRows {...props} onRowsScroll={props.onListScroll} />;
}

/** The drag that moves a desktop row before or after another. */
function useRowDrag<T>(rows: readonly T[], rowKey: (row: T, index: number) => string, onReorder?: (keys: string[]) => void) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ key: string; pos: 'before' | 'after' } | null>(null);
  const end = () => {
    setDragKey(null);
    setDropAt(null);
  };
  return {
    dropClass: (key: string) => (dropAt?.key === key ? ` drop-${dropAt.pos}` : ''),
    props: (key: string): HTMLAttributes<HTMLDivElement> => {
      if (!onReorder) return {};
      return {
        draggable: true,
        onDragStart: (e: DragEvent<HTMLDivElement>) => {
          setDragKey(key);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', key);
        },
        onDragEnd: end,
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!dragKey || dragKey === key) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = e.currentTarget.getBoundingClientRect();
          setDropAt({ key, pos: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          if (!dragKey || !dropAt) return;
          const keys = rows.map((r, i) => rowKey(r, i)).filter((k) => k !== dragKey);
          keys.splice(keys.indexOf(dropAt.key) + (dropAt.pos === 'after' ? 1 : 0), 0, dragKey);
          end();
          onReorder(keys);
        },
      };
    },
  };
}

function DesktopRowList<T>(props: RowListProps<T>) {
  const { rows, rowKey, idPrefix, selected, onSelect, onOpen, label, row, listClass, rowClass, onListScroll, activateOnClick, autoFocus, empty, menu } = props;
  const onMenu = menu ? (r: T) => showRowMenu(menu(r)) : props.onMenu;
  const { index, onKeyDown } = useRowKeys({ ...props, onMenu });
  const drag = useRowDrag(rows, rowKey, props.onReorder);
  // React's autoFocus focuses only form controls, so a listbox is focused here.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (props.bare && rows.length === 0) return null;
  const list = (
    <div
      ref={ref}
      className={listClass}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={index >= 0 ? `${idPrefix}-${selected}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={onListScroll}
      onContextMenu={onMenu && ((e) => listContextMenu(e, index, (i) => onMenu(rows[i])))}
    >
      {rows.length === 0 && shown(empty) && <EmptyState at="row">{empty}</EmptyState>}
      {rows.map((r, i) => {
        const key = rowKey(r, i);
        const click = activateOnClick && onOpen ? () => onOpen(r) : onSelect && (() => onSelect(r, i));
        return (
          <div
            key={key}
            id={`${idPrefix}-${key}`}
            role="option"
            aria-selected={key === selected}
            className={`${rowClass}${key === selected ? ' selected' : ''}${drag.dropClass(key)}`}
            onClick={click}
            onDoubleClick={activateOnClick || !onOpen ? undefined : () => onOpen(r)}
            onContextMenu={
              onMenu &&
              ((e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect?.(r, i);
                onMenu(r);
              })
            }
            {...drag.props(key)}
          >
            {row(r)}
          </div>
        );
      })}
    </div>
  );
  if (!props.title) return list;
  return (
    <>
      <div className="field-label list-title" aria-hidden="true">
        {props.title}
      </div>
      {list}
    </>
  );
}

/** A scrolling list of PhoneList rows in sections, for a phone or tablet: a tap opens, a long press shows the menu. */
export function PhoneRows<T>(props: RowsOnPhone<T> & Pick<Rows<T>, 'empty' | 'note' | 'head' | 'groupOf' | 'dayOf' | 'sectionTitle'> & { onRowsScroll?: (e: UIEvent<HTMLDivElement>) => void; rowsRef?: Ref<HTMLDivElement> }) {
  const { rows, empty, note, head, groupOf, dayOf, sectionTitle, onRowsScroll, rowsRef } = props;
  const keyed = rows.map((row, index) => ({ row, index }));
  const sections: { key: string; title: string; items: typeof keyed }[] = dayOf
    ? dayGroups(keyed, (k) => dayOf(k.row), Date.now())
    : groupOf
      ? keyed.reduce<{ key: string; title: string; items: typeof keyed }[]>((all, k) => {
          const title = groupOf(k.row);
          const last = all[all.length - 1];
          if (last?.title === title) last.items.push(k);
          else all.push({ key: title, title, items: [k] });
          return all;
        }, [])
      : [{ key: 'all', title: '', items: keyed }];
  return (
    <div className="pg-rows" onScroll={onRowsScroll} ref={rowsRef}>
      {head}
      {note && <p className="pg-group-footer">{note}</p>}
      {rows.length === 0 ? (
        <Group title={sectionTitle?.('', 0)}>
          <EmptyState at="section">{empty}</EmptyState>
        </Group>
      ) : (
        sections.map((s) => (
          <Group key={s.key} title={sectionTitle ? sectionTitle(s.title, sections.length) : s.title || undefined}>
            <PhoneRowItems {...props} items={s.items} />
          </Group>
        ))
      )}
    </div>
  );
}

/** A section of a dialog's rows on a phone: a choice of one, or rows with their commands, and a Reorder row. */
function PhoneSection<T>(props: RowListProps<T>) {
  const { rows, rowKey, label, empty, onReorder, phoneRow, menu, title } = props;
  const [reordering, setReordering] = useState(false);
  return (
    <div role={menu ? undefined : props.onSelect ? 'radiogroup' : 'group'} aria-label={label}>
      <Group title={title}>
        {rows.length === 0 && shown(empty) && <EmptyState at="section">{empty}</EmptyState>}
        <PhoneRowItems {...props} items={rows.map((row, index) => ({ row, index }))} />
        {onReorder && rows.length > 1 && <Row title="Reorder" tone="action" onOpen={() => setReordering(true)} />}
      </Group>
      {reordering && onReorder && (
        <ReorderSheet
          title={`Reorder ${label}`}
          sections={[
            {
              key: 'list',
              items: rows.map((r, i) => {
                const m = phoneRow(r);
                return { key: rowKey(r, i), title: m.title, sub: m.sub || undefined };
              }),
            },
          ]}
          onReorder={(_section, keys) => onReorder(keys)}
          onClose={() => setReordering(false)}
        />
      )}
    </div>
  );
}

type RowsOnPhone<T> = Pick<Rows<T>, 'rows' | 'rowKey' | 'selected' | 'onSelect' | 'onOpen' | 'onMenu' | 'phoneRow'> & Pick<RowListProps<T>, 'menu' | 'section'>;

/** The Rows of a phone list, without a section around them. */
function PhoneRowItems<T>({ items, rowKey, selected, onSelect, onOpen, onMenu, menu, section, phoneRow }: RowsOnPhone<T> & { items: { row: T; index: number }[] }) {
  return (
    <>
      {items.map(({ row, index }) => {
        const m = phoneRow(row);
        const key = rowKey(row, index);
        const commands = menu?.(row);
        const longPress = commands
          ? () => {
              onSelect?.(row, index);
              showRowMenu(commands);
            }
          : onMenu && (() => onMenu(row));
        const choice = section && !menu;
        const tap =
          choice || (!onOpen && !commands)
            ? onSelect && (() => onSelect(row, index))
            : onOpen
              ? () => {
                  if (commands) onSelect?.(row, index);
                  onOpen(row);
                }
              : longPress;
        const el = (
          <Row
            title={m.title}
            sub={typeof m.sub === 'string' && !section ? <span className="pg-oneline">{m.sub}</span> : m.sub}
            value={m.value}
            lead={m.lead}
            tone={m.tone}
            valueTone={m.valueTone}
            chevron={m.chevron ?? !!tap}
            selected={section ? undefined : key === selected}
            checked={choice ? key === selected : undefined}
            onOpen={tap}
            onMenu={longPress}
          />
        );
        if (section) {
          const destroy = commands?.find((c) => c.destructive && c.enabled !== false);
          return (
            <SwipeRow key={key} action={destroy && { label: destroy.label, run: destroy.run }}>
              {el}
            </SwipeRow>
          );
        }
        return (
          <Fragment key={key}>
            {el}
            {m.detail && <div className="pg-row-detail">{m.detail}</div>}
          </Fragment>
        );
      })}
    </>
  );
}
