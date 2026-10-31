import { useEffect, useState, type ReactNode } from 'react';
import { platform } from '../../platform';
import { splitLayout, type SplitLayout } from '../../web/nav-stack';

/** This page's split view on an iPad (nav-stack.ts splitLayout), following the screen as it rotates; null on a phone. */
export function useSplit(enabled = true): SplitLayout | null {
  const read = (): SplitLayout | null => {
    if (!enabled || platform !== 'ios' || typeof window === 'undefined') return null;
    let screen = { width: window.innerWidth, height: window.innerHeight };
    try {
      const top = window.top ?? window;
      screen = { width: top.innerWidth, height: top.innerHeight };
    } catch {
      /* the page's own size */
    }
    return splitLayout(window.innerWidth, screen);
  };
  const [split, setSplit] = useState(read);
  useEffect(() => {
    const update = () => setSplit((old) => {
      const next = read();
      return old?.lead === next?.lead && old?.inspector === next?.inspector ? old : next;
    });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return split;
}

/**
 * iPad's split view: the list in a leading column, what a row opens in the
 * detail column, and optionally an inspector at the trailing edge. The frame's
 * bar splits at the same width (PageNav `split`).
 */
export function SplitView({ split, lead, detail, inspector }: { split: SplitLayout; lead: ReactNode; detail: ReactNode; inspector?: ReactNode }) {
  return (
    <div className="pg-split" style={{ '--split-lead': `${split.lead}px`, '--split-inspector': `${split.inspector}px` } as React.CSSProperties}>
      <div className="pg-split-lead">{lead}</div>
      <div className="pg-split-detail">{detail}</div>
      {inspector && <aside className="pg-split-inspector">{inspector}</aside>}
    </div>
  );
}

/** The detail column with nothing chosen yet. */
export function SplitEmpty({ children }: { children: ReactNode }) {
  return <div className="pg-split-empty">{children}</div>;
}
