import { useEffect, useMemo, type RefObject } from 'react';
import { GLIDE_MS, type View } from '../web/zoom';

export const transformOf = (v: View): string => `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;

export interface ZoomLayer {
  /** Shows `v` while the fingers move: written once a frame, straight to the element (nothing renders), on a layer of its own meanwhile. */
  move: (v: View) => void;
  /** Glides to `v` and resolves at its end; at once with Reduce Motion. */
  glide: (v: View, ms?: number) => Promise<void>;
  /** The gesture is over: `v` stays (null: no transform), and the element leaves its layer, so the browser draws it again sharp at its size. */
  rest: (v: View | null) => void;
}

/**
 * What a zoom moves under the fingers (an image, a PDF's pages): a transform
 * on the GPU while a pinch or a drag goes on, so it keeps up at 60 fps with no
 * rendering or layout, then a still element the viewer can draw sharp.
 */
export function useZoomLayer(ref: RefObject<HTMLElement | null>): ZoomLayer {
  const layer = useMemo(() => {
    let frame = 0;
    let next: View | null = null;
    let gliding: (() => void) | null = null;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      next = null;
      gliding?.();
      gliding = null;
    };
    const lift = (el: HTMLElement) => {
      el.style.willChange = 'transform';
    };
    return {
      stop,
      move: (v: View) => {
        next = v;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const el = ref.current;
          if (!el || !next) return;
          lift(el);
          el.style.transition = '';
          el.style.transform = transformOf(next);
          next = null;
        });
      },
      glide: (v: View, ms = GLIDE_MS) => {
        stop();
        const el = ref.current;
        if (!el) return Promise.resolve();
        lift(el);
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.style.transition = still ? '' : `transform ${ms}ms cubic-bezier(0.2, 0.9, 0.3, 1)`;
        el.style.transform = transformOf(v);
        if (still) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms + 60);
          function done() {
            clearTimeout(timer);
            el!.removeEventListener('transitionend', onEnd);
            if (gliding === done) gliding = null;
            resolve();
          }
          const onEnd = (e: TransitionEvent) => e.target === el && done();
          el.addEventListener('transitionend', onEnd);
          gliding = done;
        });
      },
      rest: (v: View | null) => {
        stop();
        const el = ref.current;
        if (!el) return;
        el.style.transition = '';
        el.style.transform = v ? transformOf(v) : '';
        el.style.willChange = '';
      },
    };
  }, [ref]);
  useEffect(() => layer.stop, [layer]);
  return layer;
}
