import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type UIEvent } from 'react';
import { Measured } from '../perf';
import { isPhone } from '../web/page-nav';
import { SearchBox } from './SearchBox';
import { clickSelect, moveSelect, stepIndex, type MultiSelection } from './multi-select';
import { PhoneRows, useRowKeys, type PhoneRowModel, type Rows } from './RowList';
import { fitColumns, shownWidth } from './fit-columns';
import { readStoredWidths, ResizableColumns, type TableCol } from './ui';
import { useRowWindow, WINDOW_FROM } from './row-window';

export { RowList, type PhoneRowModel, type RowListProps } from './RowList';

export interface DataCol<T> extends TableCol {
  cell: (row: T) => ReactNode;
  /** The cell's hover text. */
  title?: (row: T) => string | undefined;
  cellClass?: string;
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
  /** Text that narrows the rows. A phone or tablet types it in a search field under the rows; the desktop sets it through its own Filter command. */
  search?: { value: string; onChange: (value: string) => void };
  /**
   * The desktop: several rows can be selected, as in a Windows list view. Ctrl+click adds or takes out a row,
   * Shift+click and Shift with an arrow key, Home or End select the range from the last row clicked. `selected` is
   * then the row the keyboard is on, and `onSelect` isn't called.
   */
  multiSelect?: { keys: readonly string[]; onChange: (keys: string[], lead: string) => void };
  /** The desktop: a right-click on the table's empty space (below its rows) shows the list's View options. */
  onEmptyMenu?: () => void;
}

/**
 * A table of selectable rows. The desktop draws it with resizable columns, full
 * row selection and the list keys; a phone or tablet draws it as list rows
 * (scratch/platforms.md, Data table). No screen writes `.runlog-table` itself.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  return (
    <Measured id="Table">
      <TableBody {...props} />
    </Measured>
  );
}

function TableBody<T>(props: DataTableProps<T>) {
  const { cols, phoneRow } = props;
  const firstLine = (row: T): PhoneRowModel => ({
    title: cols[0].cell(row),
    sub: cols
      .slice(1)
      .map((c) => c.cell(row))
      .filter((v) => typeof v === 'string' && v)
      .join(' · '),
  });
  if (!isPhone) return <DesktopTable {...props} />;
  const list = <PhoneRows {...props} phoneRow={phoneRow ?? firstLine} rowsRef={props.tableRef} onRowsScroll={props.onTableScroll} />;
  if (!props.search) return list;
  return (
    <div className="pg-rows-search">
      {list}
      <div className="addon-search-bar">
        <SearchBox value={props.search.value} onChange={props.search.onChange} />
      </div>
    </div>
  );
}

function DesktopTable<T>(props: DataTableProps<T>) {
  const { cols: allCols, rows, rowKey, idPrefix, selected, onOpen, onMenu, onEmptyMenu, empty, note, label, groupOf, storageKey, rowClass, wrapClass, tableRef, onTableScroll, multiSelect } = props;
  const multi = useMultiSelect(props);
  const onSelect = multi?.select ?? props.onSelect;
  const { index, onKeyDown: listKeys } = useRowKeys({ ...props, onSelect });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!multi?.key(e, index)) listKeys(e);
  };
  const isSelected = (key: string) => (multiSelect ? multiSelect.keys.includes(key) : key === selected);
  const wrap = useRef<HTMLDivElement | null>(null);
  const spacer = useRef<HTMLTableRowElement | null>(null);
  const after = useRef<HTMLTableRowElement | null>(null);
  // A pane too narrow for every column loses the ones at the right, so the table never scrolls sideways.
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setRoom(el.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Which columns fit counts the widths shown, the dragged ones too; `saved` reads them again after a drag.
  const [saved, setSaved] = useState(0);
  const stored = useMemo(() => readStoredWidths(storageKey), [storageKey, saved]);
  const cols = fitColumns(
    allCols.map((col) => ({ col, width: shownWidth(col, stored), percent: col.percent })),
    room,
  ).map((c) => c.col);
  const windowed = !groupOf && rows.length > WINDOW_FROM;
  const win = useRowWindow(wrap, spacer, after, rows.length, windowed, index);
  const setWrap = (el: HTMLDivElement | null) => {
    wrap.current = el;
    if (typeof tableRef === 'function') tableRef(el);
    else if (tableRef) (tableRef as { current: HTMLDivElement | null }).current = el;
  };
  const gap = (n: number, ref?: Ref<HTMLTableRowElement>) => (
    <tr ref={ref} aria-hidden style={{ height: n * win.rowH }}>
      <td colSpan={cols.length} style={{ padding: 0, border: 0, background: 'none' }} />
    </tr>
  );
  return (
    <div
      className={wrapClass ?? 'runlog-table-wrap'}
      ref={setWrap}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-multiselectable={multiSelect ? true : undefined}
      aria-activedescendant={index >= 0 ? `${idPrefix}-${selected}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        if (windowed) win.onScroll();
        onTableScroll?.(e);
      }}
      onContextMenu={
        onEmptyMenu &&
        ((e) => {
          // A row has its own menu, and the keyboard's menu request (button 0) is the active row's.
          if (e.button !== 2 || (e.target as Element).closest('tr[data-row]')) return;
          e.preventDefault();
          onEmptyMenu();
        })
      }
    >
      <table className="runlog-table">
        <ResizableColumns key={cols.map((c) => c.label).join('|')} cols={cols} storageKey={storageKey} onSaved={() => setSaved((n) => n + 1)} />
        <tbody>
          {note && (
            <tr>
              <td colSpan={cols.length} className="muted">
                {note}
              </td>
            </tr>
          )}
          {windowed && gap(win.first, spacer)}
          {(windowed ? rows.slice(win.first, win.last) : rows).map((row, j) => {
            const i = windowed ? win.first + j : j;
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
                  data-row
                  id={`${idPrefix}-${key}`}
                  aria-selected={isSelected(key)}
                  className={`run-row${rowClass ? ` ${rowClass(row)}` : ''}${isSelected(key) ? ' selected' : ''}`}
                  onClick={multi ? (e) => multi.click(key, e) : onSelect && (() => onSelect(row, i))}
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
          {windowed && gap(rows.length - win.last, after)}
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

/**
 * A desktop table's several selected rows: clicks with Ctrl and Shift, and Shift with the list's moving keys. The
 * other keys stay the list's (useRowKeys), whose moves select only the row moved to.
 */
function useMultiSelect<T>({ rows, rowKey, selected, multiSelect }: DataTableProps<T>) {
  const anchor = useRef<string | null>(null);
  if (!multiSelect) return null;
  const order = () => rows.map((r, i) => rowKey(r, i));
  const current = (): MultiSelection => ({ keys: [...multiSelect.keys], lead: selected ?? null, anchor: anchor.current ?? selected ?? null });
  const apply = (next: MultiSelection) => {
    anchor.current = next.anchor;
    if (next.lead !== null) multiSelect.onChange(next.keys, next.lead);
  };
  return {
    /** A move of the list's keys (no Shift): only that row. */
    select: (row: T, i: number) => apply(moveSelect(order(), current(), rowKey(row, i), false)),
    click: (key: string, e: React.MouseEvent) => {
      // Shift+click selects rows, not the text between them.
      if (e.shiftKey) window.getSelection()?.removeAllRanges();
      apply(clickSelect(order(), current(), key, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
    },
    /** Shift with Up, Down, Home or End; true when it took the key. */
    key: (e: React.KeyboardEvent, index: number): boolean => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
      const to = stepIndex(e.key, index, rows.length);
      if (to === null) return false;
      e.preventDefault();
      apply(moveSelect(order(), current(), rowKey(rows[to], to), true));
      return true;
    },
  };
}
