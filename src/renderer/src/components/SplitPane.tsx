import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { useDragResize } from './hooks';

const DIVIDER = 5;
const MIN_PX = 60;
const KEY_STEP = { px: 16, '%': 2 };

export interface SplitterProps {
  /** Its look: split-divider, sidebar-divider or pane-sash. */
  className: string;
  /** x: between panes side by side, so it moves left and right. */
  axis: 'x' | 'y';
  label?: string;
  /** Where it stands, for a screen reader. */
  value?: { now: number; min?: number; max?: number };
  containerRef: RefObject<HTMLElement | null>;
  /** The pointer's position in the container, while it's dragged. */
  onDrag: (pos: number, rect: DOMRect) => void;
  /** A drag starts; false keeps it from starting. */
  onDragStart?: (e: ReactMouseEvent) => boolean | void;
  onDragEnd?: () => void;
  /** An arrow key once it has the focus: -1 left or up, 1 right or down. */
  onStep: (dir: -1 | 1) => void;
}

/** A window splitter: dragged with the mouse, or moved with the arrow keys once it has the focus. */
export function Splitter({ className, axis, label, value, containerRef, onDrag, onDragStart, onDragEnd, onStep }: SplitterProps) {
  const drag = useDragResize({ axis, containerRef, onDrag, onEnd: onDragEnd });
  return (
    <div
      className={className}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value && Math.round(value.now)}
      aria-valuemin={value?.min}
      aria-valuemax={value?.max}
      tabIndex={0}
      onMouseDown={(e) => {
        if (onDragStart?.(e) !== false) drag(e);
      }}
      onKeyDown={(e) => {
        const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (e.key !== less && e.key !== more) return;
        e.preventDefault();
        onStep(e.key === more ? 1 : -1);
      }}
    />
  );
}

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

/** Two panes with a splitter between them. */
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
  // A pixel pane's largest size depends on the room, so it's only stated when `max` is.
  const high = unit === '%' ? Math.min(max ?? 100, (maxShare ?? 1) * 100) : max;
  return (
    <div ref={ref} className={`split-pane ${axis}`}>
      <div className="split-cell" style={{ flex: `0 1 ${size}${unit}` }}>
        {first}
      </div>
      <Splitter
        className={`split-divider ${axis}`}
        axis={axis}
        value={{ now: size, min: low, max: high }}
        containerRef={ref}
        onDrag={(pos, rect) => {
          const room = axis === 'x' ? rect.width : rect.height;
          resize(clamp(unit === '%' ? (pos / room) * 100 : pos - DIVIDER / 2, room));
        }}
        onStep={(dir) => resize(clamp(size + dir * KEY_STEP[unit], total()))}
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

/** What a side's splitter needs, apart from its look. */
export type SideSplitter = Pick<SplitterProps, 'value' | 'containerRef' | 'onDrag' | 'onStep'>;

/** The list's and the Activity pane's widths in a three-pane window, as last dragged or moved (saved under `key`), and their splitters. */
export function useSideWidths(key: string, left: SideWidth, right: SideWidth, containerRef: RefObject<HTMLElement | null>) {
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
  /** `sign`: 1 when the side grows as its splitter moves right (the list), -1 when it shrinks (the Activity pane). */
  const side = (which: 'left' | 'right', limits: SideWidth, sign: 1 | -1): SideSplitter => {
    const set = (width: number) => save({ ...widths, [which]: Math.min(limits.max, Math.max(limits.min, width)) });
    return {
      value: { now: widths[which], min: limits.min, max: limits.max },
      containerRef,
      onDrag: (pos, rect) => set(sign === 1 ? pos : rect.width - pos),
      onStep: (dir) => set(widths[which] + dir * sign * KEY_STEP.px),
    };
  };
  return { widths, left: side('left', left, 1), right: side('right', right, -1) };
}
