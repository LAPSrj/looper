import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { AxisDrag, dragCompletes, type DragRelease } from './gestures';

export interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}

/** A card moved `offset` px along `axis` under the finger, or back to where its stylesheet puts it (null). */
export function slideCard(el: HTMLElement | null | undefined, offset: number | null, axis: 'x' | 'y' = 'y'): void {
  if (!el) return;
  el.style.transition = offset === null ? '' : 'none';
  el.style.transform = offset === null ? '' : axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`;
}

/**
 * The pointer handlers of a sheet's bar or handle, dragged along y (AxisDrag): `onMove` follows the finger and
 * gets null once it lifts or the drag is cancelled; `onEnd` gets where the drag got to, null for a tap.
 * A press on `skip` (the bar's buttons) is left to them.
 */
export function useSheetDrag({
  twoWay = false,
  skip,
  onMove,
  onEnd,
}: {
  twoWay?: boolean;
  skip?: string;
  onMove: (offset: number | null) => void;
  onEnd: (r: DragRelease | null, el: HTMLElement) => void;
}): DragHandlers {
  const drag = useRef<AxisDrag | null>(null);
  drag.current ??= new AxisDrag('y', 1, twoWay);
  const d = drag.current;
  return {
    onPointerDown: (e) => {
      if (skip && (e.target as Element).closest(skip)) return;
      d.begin(e.clientX, e.clientY, e.timeStamp);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      const r = d.move(e.clientX, e.clientY, e.timeStamp);
      if (r) onMove(r.offset);
    },
    onPointerUp: (e) => {
      const r = d.release();
      onMove(null);
      onEnd(r, e.currentTarget);
    },
    onPointerCancel: () => {
      d.release();
      onMove(null);
    },
  };
}

/** A sheet that closes when dragged down past a third of `extent` (its card's height) or flicked. */
export function useDragToDismiss({
  skip,
  extent,
  onMove,
  onDismiss,
}: {
  skip?: string;
  extent: (handle: HTMLElement) => number;
  onMove: (offset: number | null) => void;
  onDismiss: () => void;
}): DragHandlers {
  return useSheetDrag({ skip, onMove, onEnd: (r, el) => r && dragCompletes(r, extent(el)) && onDismiss() });
}
