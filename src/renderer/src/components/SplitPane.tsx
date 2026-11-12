import { useRef, useState, type ReactNode } from 'react';
import { useDragResize } from './hooks';

const DIVIDER = 5;
const MIN_PX = 60;
const KEY_STEP = { px: 16, '%': 2 };

export interface PaneSize {
  /** x: side by side; y: one over the other. */
  axis: 'x' | 'y';
  /** The first pane's size; the second takes the rest. */
  initial: number;
  unit?: 'px' | '%';
  /** The first pane's limits, in its unit. */
  min?: number;
  max?: number;
  /** The first pane's largest share of the room (0.5: half the window), past `max`. */
  maxShare?: number;
  /** Where the first pane's size is kept, so the panes open as they were left. */
  storageKey?: string;
}

/** A size kept under `key`, when there is one at least `min`. */
function savedSize(key: string | undefined, min: number): number | null {
  if (!key) return null;
  const saved = Number(localStorage.getItem(key));
  return saved > 0 && saved >= min ? saved : null;
}

/** Two panes with a splitter between them: dragged with the mouse, or moved with the arrow keys once it has the focus. */
export function SplitPane({ axis, initial, unit = 'px', min, max, maxShare, storageKey, first, second }: PaneSize & { first: ReactNode; second: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const low = min ?? (unit === '%' ? 0 : MIN_PX);
  const [size, setSize] = useState(() => savedSize(storageKey, low) ?? initial);
  const resize = (next: number) => {
    setSize(next);
    if (storageKey) localStorage.setItem(storageKey, String(Math.round(next)));
  };
  const total = () => {
    const rect = ref.current?.getBoundingClientRect();
    return (axis === 'x' ? rect?.width : rect?.height) ?? 0;
  };
  const clamp = (value: number, room: number) => {
    let high = max ?? (unit === '%' ? 100 : Math.max(low, room - DIVIDER - MIN_PX));
    if (maxShare !== undefined) high = Math.min(high, unit === '%' ? maxShare * 100 : room * maxShare);
    return Math.round(Math.max(low, Math.min(high, value)) * 100) / 100;
  };
  const onMouseDown = useDragResize({
    axis,
    containerRef: ref,
    onDrag: (pos, rect) => {
      const room = axis === 'x' ? rect.width : rect.height;
      resize(clamp(unit === '%' ? (pos / room) * 100 : pos - DIVIDER / 2, room));
    },
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (e.key !== less && e.key !== more) return;
    e.preventDefault();
    resize(clamp(size + (e.key === more ? KEY_STEP[unit] : -KEY_STEP[unit]), total()));
  };
  return (
    <div ref={ref} className={`split-pane ${axis}`}>
      <div className="split-cell" style={{ flex: `0 1 ${size}${unit}` }}>
        {first}
      </div>
      <div
        className={`split-divider ${axis}`}
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        tabIndex={0}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
      />
      <div className="split-cell" style={{ flex: '1 1 0' }}>
        {second}
      </div>
    </div>
  );
}

export interface SideWidth {
  initial: number;
  min: number;
  max: number;
}

/** The list's and the Activity pane's widths in a three-pane window, as last dragged (saved under `key`). */
export function useSideWidths(key: string, left: SideWidth, right: SideWidth, containerRef: React.RefObject<HTMLElement | null>) {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '') as { left: number; right: number };
      if (saved.left > 0 && saved.right > 0) return saved;
    } catch {
      /* the defaults */
    }
    return { left: left.initial, right: right.initial };
  });
  const save = (w: { left: number; right: number }) => {
    setWidths(w);
    localStorage.setItem(key, JSON.stringify(w));
  };
  const dragLeft = useDragResize({
    axis: 'x',
    containerRef,
    onDrag: (pos) => save({ ...widths, left: Math.min(left.max, Math.max(left.min, pos)) }),
  });
  const dragRight = useDragResize({
    axis: 'x',
    containerRef,
    onDrag: (pos, rect) => save({ ...widths, right: Math.min(right.max, Math.max(right.min, rect.width - pos)) }),
  });
  return { widths, dragLeft, dragRight };
}
