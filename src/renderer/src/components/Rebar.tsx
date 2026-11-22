import { useLayoutEffect, useRef, useState } from 'react';
import { moveToolbar, resizeToolbar, type ToolbarDrop, type ToolbarPlace, type ToolbarRows } from '@shared/toolbars';
import { uiHere } from '../web/page-nav';
import { ICON_STROKE } from './icons';
import { Toolbar } from './Toolbar';
import { toolbarFor, toolbarKey, type ToolbarGroup } from './toolbar-model';

/** A toolbar the main window shows: its id (shared/toolbars.ts), its name and its buttons. */
export interface RebarBand {
  id: string;
  label: string;
  groups: ToolbarGroup[];
}

/** The narrowest a toolbar gets: its grip, a button, its chevron and its edge (styles.css .rebar-band's min-width). */
const MIN_WIDTH = 64;
/** How far a grip moves before it drags. */
const DRAG_START = 4;

type Drag =
  | { kind: 'move'; id: string; x0: number; y0: number; dx: number; dy: number; drop: ToolbarDrop | null }
  | { kind: 'size'; id: string; x0: number; w0: number; width: number };

/** The double chevron of a toolbar too narrow for its buttons, in the icons' 16 px box. */
const CHEVRONS = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 4.5 7.5 8 4 11.5M8.5 4.5 12 8l-3.5 3.5" />
  </svg>
);

/**
 * The main window's toolbars, as a Win32 rebar's bands: each has a grip that
 * drags it to another place in its row or to another row (above the first or
 * below the last makes a new one), and an edge that drags its width; a double
 * click on the edge gives it its buttons' width again. A toolbar narrower than
 * its buttons ends in a chevron, which lists the ones that don't fit.
 * `rows`: the saved layout with every toolbar in it (shared/toolbars.ts
 * toolbarRows), of which only `bands` show; `onLayout` saves a new one.
 * `end`: what stays at the first row's right end (a Search box).
 */
export function Rebar({
  bands,
  rows,
  onLayout,
  onOverflow,
  end,
  onContextMenu,
}: {
  bands: RebarBand[];
  rows: ToolbarRows;
  onLayout: (rows: ToolbarRows) => void;
  /** A chevron's click: the buttons that don't fit (null between groups), and where its menu goes. */
  onOverflow: (ids: (string | null)[], at: { x: number; y: number }) => void;
  end?: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const byId = new Map(bands.map((b) => [b.id, b]));
  const shown = rows.map((r, row) => ({ row, places: r.filter((p) => byId.has(p.id)) })).filter((r) => r.places.length);
  const [drag, setDrag] = useState<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const bandEls = useRef(new Map<string, HTMLDivElement>());
  const rectOf = (id: string) => bandEls.current.get(id)?.getBoundingClientRect();

  /** Where a toolbar dragged to (x, y) lands: a row under the point, or a new row above or below them all. */
  const dropAt = (id: string, x: number, y: number): ToolbarDrop | null => {
    const rects = shown.map((_, i) => rowEls.current[i]?.getBoundingClientRect());
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return null;
    if (y < first.top) return { newRow: shown[0].row };
    if (y > last.bottom) return { newRow: shown[shown.length - 1].row + 1 };
    let at = rects.findIndex((r) => !!r && y >= r.top && y <= r.bottom);
    if (at < 0) at = rects.reduce((best, r, i) => (r && Math.abs(y - (r.top + r.bottom) / 2) < Math.abs(y - ((rects[best]!.top + rects[best]!.bottom) / 2)) ? i : best), 0);
    const target = shown[at];
    const before = target.places.find((p) => {
      if (p.id === id) return false;
      const r = rectOf(p.id);
      return !!r && x < r.left + r.width / 2;
    });
    return { row: target.row, before: before?.id ?? null };
  };

  const startMove = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: 'move', id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, drop: null });
  };
  const startSize = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const w0 = bandEls.current.get(id)?.offsetWidth ?? MIN_WIDTH;
    setDrag({ kind: 'size', id, x0: e.clientX, w0, width: w0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'size') {
      setDrag({ ...drag, width: Math.max(MIN_WIDTH, drag.w0 + e.clientX - drag.x0) });
      return;
    }
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    const moving = drag.drop !== null || Math.abs(dx) + Math.abs(dy) >= DRAG_START;
    setDrag({ ...drag, dx, dy, drop: moving ? dropAt(drag.id, e.clientX, e.clientY) : null });
  };
  const onUp = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === 'size') {
      if (drag.width !== drag.w0) onLayout(resizeToolbar(rows, drag.id, drag.width));
    } else if (drag.drop) onLayout(moved(rows, drag.id, drag.drop));
  };

  const marker = drag?.kind === 'move' && drag.drop ? markerAt(drag.drop, drag.id, shown, rowEls.current, rectOf, root.current) : null;

  return (
    <div className="rebar" ref={root} onContextMenu={onContextMenu} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      {shown.map((r, i) => (
        <div key={r.row} className="rebar-row" ref={(el) => void (rowEls.current[i] = el)}>
          {r.places.map((p, at) => {
            const moving = drag?.kind === 'move' && drag.id === p.id && drag.drop ? drag : null;
            const width = drag?.kind === 'size' && drag.id === p.id ? drag.width : p.width;
            return (
              <Band
                key={p.id}
                band={byId.get(p.id)!}
                place={{ ...p, width }}
                shrink={10 ** at}
                bandRef={(el) => void (el ? bandEls.current.set(p.id, el) : bandEls.current.delete(p.id))}
                moving={moving ? { dx: moving.dx, dy: moving.dy } : null}
                onGrip={(e) => startMove(e, p.id)}
                onEdge={(e) => startSize(e, p.id)}
                onFit={() => p.width && onLayout(resizeToolbar(rows, p.id, 0))}
                onOverflow={onOverflow}
              />
            );
          })}
          {i === 0 && end}
        </div>
      ))}
      {!shown.length && end && <div className="rebar-row">{end}</div>}
      {marker && <div className={`rebar-marker ${marker.across ? 'across' : 'down'}`} style={marker.style} />}
    </div>
  );
}

/** moveToolbar, unless it would leave the rows as they are. */
function moved(rows: ToolbarRows, id: string, drop: ToolbarDrop): ToolbarRows {
  const row = rows.findIndex((r) => r.some((p) => p.id === id));
  if ('row' in drop && drop.row === row) {
    const r = rows[row];
    const at = r.findIndex((p) => p.id === id);
    if (drop.before === (r[at + 1]?.id ?? null)) return rows;
  }
  if ('newRow' in drop && rows[row]?.length === 1 && (drop.newRow === row || drop.newRow === row + 1)) return rows;
  return moveToolbar(rows, id, drop);
}

/** Where the line that shows a drop goes, in the rebar's own coordinates. */
function markerAt(
  drop: ToolbarDrop,
  id: string,
  shown: { row: number; places: ToolbarPlace[] }[],
  rowEls: (HTMLDivElement | null)[],
  rectOf: (id: string) => DOMRect | undefined,
  root: HTMLDivElement | null,
): { across: boolean; style: React.CSSProperties } | null {
  if (!root) return null;
  const box = root.getBoundingClientRect();
  if ('newRow' in drop) {
    const top = drop.newRow <= shown[0].row ? 0 : box.height;
    return { across: true, style: { top: top - 1, left: 0, right: 0 } };
  }
  const at = shown.findIndex((r) => r.row === drop.row);
  const row = rowEls[at]?.getBoundingClientRect();
  if (!row) return null;
  const others = shown[at].places.filter((p) => p.id !== id);
  const before = drop.before ? rectOf(drop.before) : undefined;
  const lastRect = others.length ? rectOf(others[others.length - 1].id) : undefined;
  const x = before ? before.left - 3 : lastRect ? lastRect.right + 2 : row.left;
  return { across: false, style: { left: x - box.left, top: row.top - box.top + 2, height: row.height - 4 } };
}

/** One toolbar: its grip, its buttons, its chevron when they don't all fit, and its edge. */
function Band({
  band,
  place,
  shrink,
  bandRef,
  moving,
  onGrip,
  onEdge,
  onFit,
  onOverflow,
}: {
  band: RebarBand;
  place: ToolbarPlace;
  /** How much sooner than the others it gets narrower when the row doesn't fit: the last one first, as a rebar does. */
  shrink: number;
  bandRef: (el: HTMLDivElement | null) => void;
  moving: { dx: number; dy: number } | null;
  onGrip: (e: React.PointerEvent) => void;
  onEdge: (e: React.PointerEvent) => void;
  onFit: () => void;
  onOverflow: (ids: (string | null)[], at: { x: number; y: number }) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<(string | null)[]>([]);
  const key = toolbarKey(band.groups);

  // What ToolbarButtons draws, child by child: a separator (null) before each group after the first, then its buttons.
  const children = toolbarFor(band.groups, uiHere).flatMap((g, i) => [...(i ? [null] : []), ...g.items.map((it) => it.id)]);

  useLayoutEffect(() => {
    const strip = body.current?.querySelector<HTMLElement>('.rebar-toolbar');
    if (!strip) return;
    const measure = () => {
      const limit = strip.clientWidth + 0.5;
      const out: (string | null)[] = [];
      Array.from(strip.children).forEach((el, i) => {
        const over = (el as HTMLElement).offsetLeft + (el as HTMLElement).offsetWidth > limit;
        el.toggleAttribute('data-clipped', over);
        if (over && i < children.length) out.push(children[i]);
      });
      while (out[0] === null) out.shift();
      setCut((was) => (was.length === out.length && was.every((id, i) => id === out[i]) ? was : out));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(strip);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, place.width, cut.length]);

  const style: React.CSSProperties = { flexShrink: shrink, ...(place.width ? { flexBasis: place.width, width: place.width } : {}) };
  if (moving) style.transform = `translate(${moving.dx}px, ${moving.dy}px)`;
  return (
    <div
      className={`rebar-band${moving ? ' moving' : ''}${place.width ? ' sized' : ''}`}
      ref={(el) => {
        body.current = el;
        bandRef(el);
      }}
      style={style}
    >
      <span className="rebar-grip" onPointerDown={onGrip} aria-hidden="true" />
      <Toolbar groups={band.groups} label={band.label} className="rebar-toolbar" />
      {cut.length > 0 && (
        <button
          className="rebar-chevron"
          title="More Buttons"
          aria-label={`More ${band.label} buttons`}
          aria-haspopup="menu"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            onOverflow(cut, { x: box.left, y: box.bottom });
          }}
        >
          {CHEVRONS}
        </button>
      )}
      <span className="rebar-edge" onPointerDown={onEdge} onDoubleClick={onFit} aria-hidden="true" />
    </div>
  );
}
