import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { columnName } from '@shared/preview';
import { isPhone } from '../../web/page-nav';
import { DataTable, type DataCol } from '../DataTable';
import { NOTE } from './note';

interface SheetRow {
  n: number;
  cells: string[];
}

const COL_WIDTH = 140;

/**
 * A table's cells: `header` takes the first row as the columns' names (a CSV's), otherwise the columns are
 * lettered and the rows numbered as a spreadsheet's are. The desktop draws a list view (DataTable, which draws
 * only the rows in view); a phone a grid, since a sheet's columns are what it's read by.
 */
export function SheetTable({ rows, header, name }: { rows: string[][]; header: boolean; name: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const { labels, body } = useMemo(() => {
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const names = header ? (rows[0] ?? []) : [];
    // DataTable keys its columns by label, so a name used twice (or none) gets the column's letter.
    const seen = new Set<string>();
    const labels = Array.from({ length: width }, (_, i) => {
      const own = (names[i] ?? '').trim();
      const l = own && !seen.has(own) ? own : columnName(i);
      seen.add(l);
      return l;
    });
    return { labels, body: (header ? rows.slice(1) : rows).map((cells, i) => ({ n: i + (header ? 2 : 1), cells })) };
  }, [rows, header]);
  const cols = useMemo<DataCol<SheetRow>[]>(() => {
    const lettered: DataCol<SheetRow>[] = labels.map((label, i) => ({
      label,
      width: COL_WIDTH,
      min: 40,
      cell: (r: SheetRow) => r.cells[i] ?? '',
      title: (r: SheetRow) => r.cells[i] || undefined,
    }));
    return header ? lettered : [{ label: '#', width: 56, min: 40, num: true, cell: (r) => String(r.n), cellClass: 'muted' }, ...lettered];
  }, [labels, header]);
  const empty = <div style={NOTE}>{header ? 'This file has no rows.' : 'This sheet is empty.'}</div>;
  if (isPhone) return body.length ? <PhoneGrid labels={labels} body={body} numbered={!header} name={name} /> : empty;
  return (
    <DataTable
      rows={body}
      cols={cols}
      rowKey={(r) => String(r.n)}
      idPrefix="sheet-row"
      label={name}
      selected={selected}
      onSelect={(r) => setSelected(String(r.n))}
      copyText={(r) => r.cells.join('\t')}
      empty={empty}
    />
  );
}

const ROW_H = 36;
const PHONE_COL = 120;
const NUM_COL = 44;
/** Rows drawn above and below the screen, and the step the drawn rows move by, so a scroll redraws only every few rows. */
const OVERSCAN = 20;
const STEP = 10;

const LINE = '1px solid rgba(128, 128, 128, 0.3)';
const cell = (width: number, extra?: React.CSSProperties): React.CSSProperties => ({
  width,
  flex: 'none',
  boxSizing: 'border-box',
  padding: '0 8px',
  lineHeight: `${ROW_H}px`,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  borderRight: LINE,
  ...extra,
});

/** A sheet on a phone: a grid that scrolls both ways under its column names, drawing only the rows on screen. Styled inline: the phone frames have their own stylesheets. */
function PhoneGrid({ labels, body, numbered, name }: { labels: string[]; body: SheetRow[]; numbered: boolean; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const top = Math.floor(el.scrollTop / (ROW_H * STEP)) * ROW_H * STEP;
      setView((v) => (v.top === top && v.height === el.clientHeight ? v : { top, height: el.clientHeight }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    el.addEventListener('scroll', read, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', read);
    };
  }, []);
  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const last = Math.min(body.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN + STEP);
  const width = labels.length * PHONE_COL + (numbered ? NUM_COL : 0);
  const num = (text: string) => numbered && <div style={cell(NUM_COL, { textAlign: 'right', opacity: 0.6 })}>{text}</div>;
  return (
    <div ref={box} role="table" aria-label={name} style={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
      <div style={{ width, minWidth: '100%' }}>
        <div role="row" style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', height: ROW_H, background: 'Canvas', fontWeight: 600, borderBottom: LINE }}>
          {num('')}
          {labels.map((l) => (
            <div key={l} role="columnheader" style={cell(PHONE_COL)}>
              {l}
            </div>
          ))}
        </div>
        <div style={{ position: 'relative', height: body.length * ROW_H }}>
          {body.slice(first, last).map((r, i) => (
            <div key={r.n} role="row" style={{ position: 'absolute', top: (first + i) * ROW_H, left: 0, display: 'flex', height: ROW_H, borderBottom: LINE }}>
              {num(String(r.n))}
              {labels.map((l, c) => (
                <div key={l} role="cell" style={cell(PHONE_COL)}>
                  {r.cells[c] ?? ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
