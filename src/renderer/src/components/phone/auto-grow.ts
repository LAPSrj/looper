import { useLayoutEffect, type RefObject } from 'react';

/**
 * A text box that grows with what it holds, up to `maxPx`, then scrolls: one
 * line at rest. `enabled` false leaves the box at its own size.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx: number, enabled = true): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
  }, [ref, value, maxPx, enabled]);
}
