import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject, type UIEvent } from 'react';
import { Measured } from '../perf';
import { dayGroups } from '../phone-lists';
import { isPhone } from '../web/page-nav';
import { AddonSearchBox } from './AddonPane';
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
  /** Under the row, across the list's width (a command's output while it's open). */
  detail?: ReactNode;
  /** Whether a tap pushes another screen; unset: whenever the row can be tapped. */
  chevron?: boolean;
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
function PhoneRows<T>({
  rows,
  rowKey,
  selected,
  onSelect,
  onOpen,
  onMenu,
  empty,
  note,
  head,
  phoneRow,
  groupOf,
  dayOf,
  sectionTitle,
  onRowsScroll,
  rowsRef,
}: Rows<T> & { onRowsScroll?: (e: UIEvent<HTMLDivElement>) => void; rowsRef?: Ref<HTMLDivElement> }) {
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
          <EmptyRow>{empty}</EmptyRow>
        </Group>
      ) : (
        sections.map((s) => (
          <Group key={s.key} title={sectionTitle ? sectionTitle(s.title, sections.length) : s.title || undefined}>
            <PhoneRowItems items={s.items} rowKey={rowKey} selected={selected} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} phoneRow={phoneRow} />
          </Group>
        ))
      )}
    </div>
  );
}

/** The Rows of a phone list, without a section around them. */
function PhoneRowItems<T>({
  items,
  rowKey,
  selected,
  onSelect,
  onOpen,
  onMenu,
  phoneRow,
}: Pick<Rows<T>, 'rowKey' | 'selected' | 'onSelect' | 'onOpen' | 'onMenu' | 'phoneRow'> & { items: { row: T; index: number }[] }) {
  const tappable = !!(onOpen || onSelect);
  return (
    <>
      {items.map(({ row, index }) => {
        const m = phoneRow(row);
        const key = rowKey(row, index);
        return (
          <Fragment key={key}>
            <Row
              title={m.title}
              sub={typeof m.sub === 'string' ? <span className="pg-oneline">{m.sub}</span> : m.sub}
              value={m.value}
              lead={m.lead}
              tone={m.tone}
              valueTone={m.valueTone}
              chevron={m.chevron ?? tappable}
              selected={key === selected}
              onOpen={tappable ? () => (onOpen ? onOpen(row) : onSelect!(row, index)) : undefined}
              onMenu={onMenu && (() => onMenu(row))}
            />
            {m.detail && <div className="pg-row-detail">{m.detail}</div>}
          </Fragment>
        );
      })}
    </>
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
  /** Text that narrows the rows. A phone or tablet types it in a search field under the rows; the desktop sets it through its own Filter command. */
  search?: { value: string; onChange: (value: string) => void };
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
  const { cols, rows, rowKey, idPrefix, selected, onSelect, onOpen, onMenu, empty, note, label, groupOf, storageKey, rowClass, wrapClass, tableRef, onTableScroll } = props;
  const { index, onKeyDown } = useRowKeys(props);
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

export interface RowListProps<T> extends Omit<Rows<T>, 'copyText'> {
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
}

/** A list of selectable multi-line rows: a listbox on the desktop, list rows on a phone or tablet. */
export function RowList<T>(props: RowListProps<T>) {
  if (!isPhone) return <DesktopRowList {...props} />;
  if (props.bare) return <PhoneRowItems {...props} items={props.rows.map((row, index) => ({ row, index }))} />;
  return <PhoneRows {...props} onRowsScroll={props.onListScroll} />;
}

function DesktopRowList<T>(props: RowListProps<T>) {
  const { rows, rowKey, idPrefix, selected, onSelect, onOpen, onMenu, label, row, listClass, rowClass, onListScroll, activateOnClick, autoFocus } = props;
  const { index, onKeyDown } = useRowKeys(props);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (props.bare && rows.length === 0) return null;
  return (
    <div ref={ref} className={listClass} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={index >= 0 ? `${idPrefix}-${selected}` : undefined} onKeyDown={onKeyDown} onScroll={onListScroll}>
      {rows.map((r, i) => {
        const key = rowKey(r, i);
        const click = activateOnClick && onOpen ? () => onOpen(r) : onSelect && (() => onSelect(r, i));
        return (
          <div
            key={key}
            id={`${idPrefix}-${key}`}
            role="option"
            aria-selected={key === selected}
            className={`${rowClass}${key === selected ? ' selected' : ''}`}
            onClick={click}
            onDoubleClick={activateOnClick || !onOpen ? undefined : () => onOpen(r)}
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
