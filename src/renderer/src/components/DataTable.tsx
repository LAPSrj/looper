import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject, type UIEvent } from 'react';
import { Measured } from '../perf';
import { isPhone } from '../web/page-nav';
import { AddonSearchBox } from './AddonPane';
import { clickSelect, moveSelect, stepIndex, type MultiSelection } from './multi-select';
import { PhoneRows, useRowKeys, type PhoneRowModel, type Rows } from './RowList';
import { ResizableColumns, type TableCol } from './ui';

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
        <AddonSearchBox value={props.search.value} onChange={props.search.onChange} />
      </div>
    </div>
  );
}

/** From this many rows a desktop table draws only the rows in view, plus OVERSCAN on each side. */
const WINDOW_FROM = 200;
const OVERSCAN = 30;

/**
 * Which rows of a long table to draw: the ones the scroll position shows. The rows' height is measured
 * from the drawn ones (cells are one line), and a selected row out of view is scrolled to, since the
 * list keys find a row by its element.
 */
function useRowWindow(wrap: RefObject<HTMLDivElement | null>, spacer: RefObject<HTMLTableRowElement | null>, count: number, on: boolean, index: number) {
  const [view, setView] = useState({ top: 0, height: 1000 });
  const rowH = useRef(28);
  const base = useRef(0);
  const first = on ? Math.max(0, Math.floor((view.top - base.current) / rowH.current) - OVERSCAN) : 0;
  const last = on ? Math.min(count, Math.ceil((view.top - base.current + view.height) / rowH.current) + OVERSCAN) : count;
  // In steps of 10 rows, which OVERSCAN covers, so scrolling redraws the table only when the drawn rows change.
  const read = () => {
    const el = wrap.current;
    if (!el) return;
    const step = rowH.current * 10;
    const top = Math.floor(el.scrollTop / step) * step;
    setView((v) => (v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight }));
  };
  useLayoutEffect(() => {
    const el = wrap.current;
    const sp = spacer.current;
    if (!on || !el || !sp) return;
    const body = sp.parentElement!;
    const firstRow = sp.nextElementSibling as HTMLElement | null;
    const drawn = body.querySelectorAll<HTMLElement>(':scope > tr[data-row]');
    const lastRow = drawn[drawn.length - 1];
    const top = el.scrollTop - el.getBoundingClientRect().top;
    base.current = sp.getBoundingClientRect().top + top;
    if (firstRow && lastRow && last > first) rowH.current = (lastRow.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top) / (last - first) || rowH.current;
  });
  useEffect(() => {
    const el = wrap.current;
    if (!on || !el) return;
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => {
    const el = wrap.current;
    if (!on || !el || index < 0 || (index >= first && index < last)) return;
    const head = el.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const y = base.current + index * rowH.current;
    el.scrollTop = y < el.scrollTop + head ? y - head : y + rowH.current - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, on]);
  return { first, last, rowH: rowH.current, onScroll: read };
}

function DesktopTable<T>(props: DataTableProps<T>) {
  const { cols, rows, rowKey, idPrefix, selected, onOpen, onMenu, empty, note, label, groupOf, storageKey, rowClass, wrapClass, tableRef, onTableScroll, multiSelect } = props;
  const multi = useMultiSelect(props);
  const onSelect = multi?.select ?? props.onSelect;
  const { index, onKeyDown: listKeys } = useRowKeys({ ...props, onSelect });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!multi?.key(e, index)) listKeys(e);
  };
  const isSelected = (key: string) => (multiSelect ? multiSelect.keys.includes(key) : key === selected);
  const wrap = useRef<HTMLDivElement | null>(null);
  const spacer = useRef<HTMLTableRowElement | null>(null);
  const windowed = !groupOf && rows.length > WINDOW_FROM;
  const win = useRowWindow(wrap, spacer, rows.length, windowed, index);
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
          {windowed && gap(rows.length - win.last)}
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
