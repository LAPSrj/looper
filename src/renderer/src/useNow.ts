import { useEffect, useRef, useState } from 'react';
import { createTickers } from './now-ticker';

export { MINUTE, SECOND, tickFor } from './now-ticker';

const tickers = createTickers({
  now: () => Date.now(),
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => tickers.resume());
}

/**
 * The current time in ms, refreshed every `intervalMs` on the clock (a minute
 * interval changes on the minute), for the one component that draws a ticking
 * time, so the rest of the window doesn't render with it. Nothing refreshes while
 * the page is hidden. `null` doesn't tick and returns the time of each render,
 * for a time that only counts while something is going on.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(Date.now);
  const first = useRef(true);
  useEffect(() => {
    const mounting = first.current;
    first.current = false;
    if (intervalMs === null) return;
    // The interval changed or began after the first render: what the state holds is old.
    if (!mounting) setNow(Date.now());
    return tickers.subscribe(intervalMs, setNow);
  }, [intervalMs]);
  return intervalMs === null ? Date.now() : now;
}
