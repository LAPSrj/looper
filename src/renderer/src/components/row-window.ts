import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { windowGroups } from './list-window';

/** From this many rows a long list (DataTable, a RowList with `windowed`) draws only the rows in view, plus OVERSCAN on each side. */
export const WINDOW_FROM = 200;
const OVERSCAN = 30;

/**
 * Which rows of a long list to draw: the ones its scroller shows (list-window's windowGroups, for one group without a
 * header). The undrawn rows are two spacers, `top` before the drawn rows and `bottom` after them, and the rows' height
 * is measured between the two (the rows are of one height). A selected row out of view is scrolled to, since the list
 * keys find a row by its element.
 */
export function useRowWindow(
  scroller: RefObject<HTMLElement | null>,
  top: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
  count: number,
  on: boolean,
  index: number,
) {
  const [view, setView] = useState({ top: 0, height: 1000 });
  const rowH = useRef(28);
  const base = useRef(0);
  const range = on ? windowGroups([count], view.top, view.height, { base: base.current, headH: 0, rowH: rowH.current, overscan: OVERSCAN })[0] : null;
  const first = !on ? 0 : (range?.from ?? 0);
  const last = !on ? count : (range?.to ?? 0);
  // In steps of 10 rows, which OVERSCAN covers, so scrolling redraws the list only when the drawn rows change.
  const read = () => {
    const el = scroller.current;
    if (!el) return;
    const step = rowH.current * 10;
    const at = Math.floor(el.scrollTop / step) * step;
    setView((v) => (v.top === at && v.height === el.clientHeight ? v : { top: at, height: el.clientHeight }));
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = top.current;
    const b = bottom.current;
    if (!on || !el || !a) return;
    base.current = a.getBoundingClientRect().top + el.scrollTop - el.getBoundingClientRect().top;
    if (b && last > first) rowH.current = (b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) / (last - first) || rowH.current;
  });
  useEffect(() => {
    const el = scroller.current;
    if (!on || !el) return;
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => {
    const el = scroller.current;
    if (!on || !el || index < 0 || (index >= first && index < last)) return;
    const head = el.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    const y = base.current + index * rowH.current;
    el.scrollTop = y < el.scrollTop + head ? y - head : y + rowH.current - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, on]);
  return { first, last, rowH: rowH.current, onScroll: read };
}
