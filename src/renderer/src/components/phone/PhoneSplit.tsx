import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { platform } from '../../platform';
import { columnCopy, swapColumns } from '../../web/motion';
import { splitLayout, type ScreenSize, type SplitLayout } from '../../web/nav-stack';

const sameSplit = (a: SplitLayout | null, b: SplitLayout | null) => a?.lead === b?.lead && a?.inspector === b?.inspector;

/** The whole page's size: a window's iframe may be narrower than the screen. */
function topSize(): ScreenSize {
  try {
    const top = window.top ?? window;
    return { width: top.innerWidth, height: top.innerHeight };
  } catch {
    return { width: window.innerWidth, height: window.innerHeight };
  }
}

/** This page's split view on a tablet (nav-stack.ts splitLayout), following the screen as it rotates; null on a phone. */
export function useSplit(enabled = true): SplitLayout | null {
  const read = (): SplitLayout | null => {
    if (!enabled || (platform !== 'ios' && platform !== 'android') || typeof window === 'undefined') return null;
    return splitLayout(window.innerWidth, topSize(), platform);
  };
  const [split, setSplit] = useState(read);
  useEffect(() => {
    const update = () => setSplit((old) => {
      const next = read();
      return sameSplit(old, next) ? old : next;
    });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return split;
}

/** This page's width, as the screen rotates. */
export function usePageWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

/** Whether what's in `ref` is wide enough for a list beside its detail, as it's resized; null while it isn't, on a phone, or with `enabled` off. */
export function useContainerSplit(ref: RefObject<HTMLElement | null>, enabled: boolean): SplitLayout | null {
  const [split, setSplit] = useState<SplitLayout | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setSplit(null);
      return;
    }
    const os = platform === 'android' ? 'android' : 'ios';
    const measure = () => {
      const next = splitLayout(el.clientWidth, topSize(), os);
      setSplit((old) => (sameSplit(old, next) ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return split;
}

/** The column a push leaves (the list), over the one it shows until the motion ends. */
const LEAVING: CSSProperties = { position: 'absolute', inset: 0 };

/**
 * The list in a leading column, what a row opens in the detail column, and
 * optionally an inspector at the trailing edge. With `split` null there's one
 * column: `shows` says which, and the other stays mounted out of sight, so the
 * list keeps its place and rotating doesn't start it over. Going from one to the
 * other pushes or pops as the phone's screens do (motion.ts swapColumns).
 */
export function SplitView({
  split,
  shows,
  lead,
  detail,
  inspector,
  stacked = false,
}: {
  split: SplitLayout | null;
  shows: 'lead' | 'detail';
  /** The detail under the list on one screen, whatever the width: nothing is pushed or hidden. */
  stacked?: boolean;
  lead: ReactNode;
  detail: ReactNode;
  inspector?: ReactNode;
}) {
  const one = !split && !stacked;
  // The column shown, and the one a push or pop is leaving while it moves.
  const [view, setView] = useState<{ shows: 'lead' | 'detail'; leaving: 'lead' | 'detail' | null }>({ shows, leaving: null });
  const box = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  // A pop empties the detail column as it starts: what it showed leaves as a copy, taken before React changes it.
  const leavingCopy = useRef<ReturnType<typeof columnCopy> | null>(null);
  if (view.shows !== shows) {
    leavingCopy.current = one && view.shows === 'detail' && detailRef.current ? columnCopy(detailRef.current) : null;
    setView({ shows, leaving: one ? view.shows : null });
  } else if (!one && view.leaving) setView({ shows, leaving: null });
  useLayoutEffect(() => {
    const from = view.leaving;
    if (!from || !box.current || !leadRef.current || !detailRef.current) return;
    let old: HTMLElement | null = leadRef.current;
    let fresh = detailRef.current;
    const copy = from === 'detail' ? leavingCopy.current : null;
    leavingCopy.current = null;
    if (from === 'detail') {
      fresh = leadRef.current;
      old = copy?.copy ?? null;
      if (copy) {
        Object.assign(copy.copy.style, LEAVING);
        box.current.append(copy.copy);
        copy.rescroll();
      }
    }
    if (!old) {
      setView((v) => ({ ...v, leaving: null }));
      return;
    }
    const motion = swapColumns(old, fresh, from === 'detail');
    let live = true;
    void motion.done.then(() => live && setView((v) => (v.leaving === from ? { ...v, leaving: null } : v)));
    return () => {
      live = false;
      motion.cancel();
      copy?.copy.remove();
    };
  }, [view.leaving]);
  const style = (column: 'lead' | 'detail') => (!one || view.shows === column ? undefined : view.leaving === column && column === 'lead' ? LEAVING : { display: 'none' });
  const vars = split ? ({ '--split-lead': `${split.lead}px`, '--split-inspector': `${split.inspector}px` } as CSSProperties) : undefined;
  return (
    <div ref={box} className={`pg-split${stacked ? ' stacked' : split ? '' : ' one-column'}`} style={view.leaving ? { ...vars, position: 'relative', overflow: 'clip' } : vars}>
      <div ref={leadRef} className="pg-split-lead" style={style('lead')} inert={view.leaving === 'lead' || undefined}>
        {lead}
      </div>
      <div ref={detailRef} className="pg-split-detail" style={style('detail')} inert={view.leaving === 'detail' || undefined}>
        {detail}
      </div>
      {inspector}
    </div>
  );
}
