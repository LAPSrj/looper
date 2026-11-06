import { Fragment, type ReactNode, type Ref, type UIEvent } from 'react';
import { dayGroups } from '../phone-lists';
import { isPhone } from '../web/page-nav';
import { useListNav } from './hooks';
import { EmptyRow, Group, Row } from './phone/PhoneList';
import { ResizableColumns, type TableCol } from './ui';

export interface DataCol<T> extends TableCol {
  cell: (row: T) => ReactNode;
  /** The cell's hover text. */
  title?: (row: T) => string | undefined;
  cellClass?: string;
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
}

interface Rows<T> {
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
  /** On a phone or tablet, list sections above the rows (a run's result). */
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

function useRowKeys<T>({ rows, rowKey, idPrefix, selected, onSelect, onOpen, onMenu, copyText }: Pick<Rows<T>, 'rows' | 'rowKey' | 'idPrefix' | 'selected' | 'onSelect' | 'onOpen' | 'onMenu' | 'copyText'>) {
  const index = selected == null ? -1 : rows.findIndex((r, i) => rowKey(r, i) === selected);
  const nav = useListNav({
    count: rows.length,
    index,
    onIndex: (i) => onSelect?.(rows[i], i),
    onActivate: onOpen && ((i) => onOpen(rows[i])),
    onMenu: onMenu && ((i) => onMenu(rows[i])),
    scrollToId: index >= 0 ? `${idPrefix}-${selected}` : null,
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'c' && copyText && index >= 0) {
      void navigator.clipboard.writeText(copyText(rows[index]));
      e.preventDefault();
      return;
    }
    nav(e);
  };
  return { index, onKeyDown };
}

/** A scrolling list of PhoneList rows in sections, for a phone or tablet: a tap opens, a long press shows the menu. */
function PhoneRows<T>({ rows, rowKey, selected, onSelect, onOpen, onMenu, empty, note, head, phoneRow, groupOf, dayOf, sectionTitle, onRowsScroll }: Rows<T> & { onRowsScroll?: (e: UIEvent<HTMLDivElement>) => void }) {
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
  const tappable = !!(onOpen || onSelect);
  return (
    <div className="pg-rows" onScroll={onRowsScroll}>
      {head}
      {note && <p className="pg-group-footer">{note}</p>}
      {rows.length === 0 ? (
        <Group title={sectionTitle?.('', 0)}>
          <EmptyRow>{empty}</EmptyRow>
        </Group>
      ) : (
        sections.map((s) => (
          <Group key={s.key} title={sectionTitle ? sectionTitle(s.title, sections.length) : s.title || undefined}>
            {s.items.map(({ row, index }) => {
              const m = phoneRow(row);
              const key = rowKey(row, index);
              return (
                <Row
                  key={key}
                  title={m.title}
                  sub={typeof m.sub === 'string' ? <span className="pg-oneline">{m.sub}</span> : m.sub}
                  value={m.value}
                  lead={m.lead}
                  tone={m.tone}
                  valueTone={m.valueTone}
                  chevron={tappable}
                  selected={key === selected}
                  onOpen={tappable ? () => (onOpen ? onOpen(row) : onSelect!(row, index)) : undefined}
                  onMenu={onMenu && (() => onMenu(row))}
                />
              );
            })}
          </Group>
        ))
      )}
    </div>
  );
}

export interface DataTableProps<T> extends Omit<Rows<T>, 'phoneRow'> {
  cols: readonly DataCol<T>[];
  /** Saves the dragged column widths under this key. */
  storageKey?: string;
  /** Rows' class beside `run-row` (a result's color). */
  rowClass?: (row: T) => string;
  /** The scrolling table's class, in place of the usual one. */
  wrapClass?: string;
  /** How a row reads on a phone or tablet. Without it: the first column is the title and the other columns' text the line under it. */
  phoneRow?: (row: T) => PhoneRowModel;
  tableRef?: Ref<HTMLDivElement>;
  onTableScroll?: (e: UIEvent<HTMLDivElement>) => void;
}

/**
 * A table of selectable rows. The desktop draws it with resizable columns, full
 * row selection and the list keys; a phone or tablet draws it as list rows
 * (scratch/platforms.md, Data table). No screen writes `.runlog-table` itself.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { cols, phoneRow } = props;
  const firstLine = (row: T): PhoneRowModel => ({
    title: cols[0].cell(row),
    sub: cols
      .slice(1)
      .map((c) => c.cell(row))
      .filter((v) => typeof v === 'string' && v)
      .join(' · '),
  });
  return isPhone ? <PhoneRows {...props} phoneRow={phoneRow ?? firstLine} /> : <DesktopTable {...props} />;
}

function DesktopTable<T>(props: DataTableProps<T>) {
  const { cols, rows, rowKey, idPrefix, selected, onSelect, onOpen, onMenu, empty, note, label, groupOf, storageKey, rowClass, wrapClass, tableRef, onTableScroll } = props;
  const { index, onKeyDown } = useRowKeys(props);
  return (
    <div
      className={wrapClass ?? 'runlog-table-wrap'}
      ref={tableRef}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-activedescendant={index >= 0 ? `${idPrefix}-${selected}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={onTableScroll}
    >
      <table className="runlog-table">
        <ResizableColumns cols={cols} storageKey={storageKey} />
        <tbody>
          {note && (
            <tr>
              <td colSpan={cols.length} className="muted">
                {note}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const key = rowKey(row, i);
            const group = groupOf?.(row);
            return (
              <Fragment key={key}>
                {group !== undefined && (i === 0 || groupOf!(rows[i - 1]) !== group) && (
                  <tr className="list-group">
                    <td colSpan={cols.length}>{group}</td>
                  </tr>
                )}
                <tr
                  id={`${idPrefix}-${key}`}
                  aria-selected={key === selected}
                  className={`run-row${rowClass ? ` ${rowClass(row)}` : ''}${key === selected ? ' selected' : ''}`}
                  onClick={onSelect && (() => onSelect(row, i))}
                  onDoubleClick={onOpen && (() => onOpen(row))}
                  onContextMenu={
                    onMenu &&
                    ((e) => {
                      e.preventDefault();
                      onSelect?.(row, i);
                      onMenu(row);
                    })
                  }
                >
                  {cols.map((c) => (
                    <td key={c.label} className={[c.num ? 'num' : '', c.cellClass ?? ''].filter(Boolean).join(' ') || undefined} title={c.title?.(row)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
          {rows.length === 0 && empty && (
            <tr>
              <td colSpan={cols.length} className="muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface RowListProps<T> extends Omit<Rows<T>, 'copyText'> {
  /** A desktop row's content. */
  row: (row: T) => ReactNode;
  /** The list's and a row's classes on the desktop. */
  listClass: string;
  rowClass: string;
  onListScroll?: (e: UIEvent<HTMLDivElement>) => void;
}

/** A list of selectable multi-line rows: a listbox on the desktop, list rows on a phone or tablet. */
export function RowList<T>(props: RowListProps<T>) {
  return isPhone ? <PhoneRows {...props} onRowsScroll={props.onListScroll} /> : <DesktopRowList {...props} />;
}

function DesktopRowList<T>(props: RowListProps<T>) {
  const { rows, rowKey, idPrefix, selected, onSelect, onMenu, label, row, listClass, rowClass, onListScroll } = props;
  const { index, onKeyDown } = useRowKeys(props);
  return (
    <div className={listClass} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={index >= 0 ? `${idPrefix}-${selected}` : undefined} onKeyDown={onKeyDown} onScroll={onListScroll}>
      {rows.map((r, i) => {
        const key = rowKey(r, i);
        return (
          <div
            key={key}
            id={`${idPrefix}-${key}`}
            role="option"
            aria-selected={key === selected}
            className={`${rowClass}${key === selected ? ' selected' : ''}`}
            onClick={onSelect && (() => onSelect(r, i))}
            onContextMenu={
              onMenu &&
              ((e) => {
                e.preventDefault();
                onSelect?.(r, i);
                onMenu(r);
              })
            }
          >
            {row(r)}
          </div>
        );
      })}
    </div>
  );
}
