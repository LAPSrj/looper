import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { platform } from '../../platform';
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

/**
 * The list in a leading column, what a row opens in the detail column, and
 * optionally an inspector at the trailing edge. With `split` null there's one
 * column: `shows` says which, and the other stays mounted out of sight, so the
 * list keeps its place and rotating doesn't start it over.
 */
export function SplitView({
  split,
  shows,
  lead,
  detail,
  inspector,
}: {
  split: SplitLayout | null;
  shows: 'lead' | 'detail';
  lead: ReactNode;
  detail: ReactNode;
  inspector?: ReactNode;
}) {
  const hidden = (column: 'lead' | 'detail') => (!split && shows !== column ? { display: 'none' } : undefined);
  return (
    <div className={`pg-split${split ? '' : ' one-column'}`} style={split ? ({ '--split-lead': `${split.lead}px`, '--split-inspector': `${split.inspector}px` } as React.CSSProperties) : undefined}>
      <div className="pg-split-lead" style={hidden('lead')}>
        {lead}
      </div>
      <div className="pg-split-detail" style={hidden('detail')}>
        {detail}
      </div>
      {inspector}
    </div>
  );
}
