import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';

interface DialogKeysOpts<T extends string> {
  onSave?: () => void | Promise<void>;
  onCancel?: () => void;
  /** Fire onSave on a plain Enter anywhere, not just Ctrl+Enter / Enter on an input. */
  enterAnywhere?: boolean;
  tabs?: readonly T[];
  tab?: T;
  onTab?: (id: T) => void;
}

/**
 * Dialog keyboard semantics: Esc = cancel, Enter on a single-line input or
 * Ctrl+Enter anywhere = save, Ctrl+Tab / Ctrl+PageDown|PageUp = cycle tabs.
 * Handlers are read fresh on every keystroke, so callers can pass plain closures.
 */
export function useDialogKeys<T extends string = string>(opts: DialogKeysOpts<T>): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const o = ref.current;
      if (e.key === 'Escape' && o.onCancel) {
        e.preventDefault();
        o.onCancel();
        return;
      }
      if (e.key === 'Enter' && o.onSave && (o.enterAnywhere || e.ctrlKey || e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void o.onSave();
        return;
      }
      if (!o.tabs || o.tab === undefined || !o.onTab) return;
      const order = o.tabs;
      const cycle = (dir: number) => o.onTab!(order[(order.indexOf(o.tab!) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

interface ListNavOpts {
  count: number;
  /** Current selection, -1 when nothing is selected. */
  index: number;
  onIndex: (i: number) => void;
  /** Enter activates the selected item (preventDefault + stopPropagation). */
  onActivate?: (i: number) => void;
  /** DOM id of the selected item; scrolled into view when it changes. */
  scrollToId?: string | null;
}

/** ArrowUp/ArrowDown/Home/End selection movement and Enter activation for a listbox. */
export function useListNav({ count, index, onIndex, onActivate, scrollToId }: ListNavOpts): (e: ReactKeyboardEvent) => void {
  useEffect(() => {
    if (!scrollToId) return;
    document.getElementById(scrollToId)?.scrollIntoView({ block: 'nearest' });
  }, [scrollToId]);
  return (e: ReactKeyboardEvent) => {
    if (!count) return;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : Math.min(count - 1, index + 1);
        break;
      case 'ArrowUp':
        next = index < 0 ? 0 : Math.max(0, index - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Enter':
        if (!onActivate) return;
        e.preventDefault();
        e.stopPropagation();
        if (index >= 0) onActivate(index);
        return;
      default:
        return;
    }
    e.preventDefault();
    onIndex(next);
  };
}

interface DragResizeOpts {
  axis: 'x' | 'y';
  containerRef: RefObject<HTMLElement | null>;
  /** Pointer position relative to the container's left/top edge, on every move. */
  onDrag: (pos: number, rect: DOMRect) => void;
}

/** Mouse-drag handler for a splitter; returns the divider's onMouseDown. */
export function useDragResize({ axis, containerRef, onDrag }: DragResizeOpts): (e: ReactMouseEvent) => void {
  const dragging = useRef(false);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  return useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      const onMove = (me: MouseEvent) => {
        if (!dragging.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        onDragRef.current(axis === 'x' ? me.clientX - rect.left : me.clientY - rect.top, rect);
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [axis, containerRef],
  );
}
