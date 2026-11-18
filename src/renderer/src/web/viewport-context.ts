import { createContext, useContext } from 'react';
import type { Viewport } from './phone-shell';

/** The phone frame's viewport (the visual viewport, its safe areas, the keyboard), for what the frame places to fit in. */
export const ViewportContext = createContext<Viewport | null>(null);

/** The frame's viewport; outside one, the window's, with no safe areas. */
export function useViewport(): Viewport {
  const vp = useContext(ViewportContext);
  if (vp) return vp;
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight, keyboard: false, safe: { top: 0, bottom: 0, left: 0, right: 0 } };
}
