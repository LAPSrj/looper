import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import type { LooperApi } from '@shared/api';
import { FREEZE_MS, type PerfEntry } from '@shared/perf';
import { FrameMeter } from './perf-meter';

/** The frame watchdog of a page: one per desktop window, and one in a phone's top frame for all its window iframes. */
interface PerfHub {
  input(label: string, screen: string, from: Window): void;
  activity(): void;
  /** Times in performance.timeOrigin + performance.now(), which every frame shares. */
  span(name: string, start: number, end: number, ms: number): void;
  attach(frame: Window, api: LooperApi): () => void;
}

declare global {
  interface Window {
    __looperPerf?: PerfHub;
  }
}

const BEAT_MS = 10;

const clock = (w: Window = window): number => w.performance.timeOrigin + w.performance.now();

function hub(): PerfHub | undefined {
  try {
    return window.top?.__looperPerf ?? window.__looperPerf;
  } catch {
    return window.__looperPerf;
  }
}

function routeName(hash: string): string {
  const [a = '', b = ''] = hash.replace(/^#\/?/, '').split('/');
  return (a === 'view' || a === 'item' ? `${a}/${decodeURIComponent(b)}` : a) || 'main';
}

const screenOf = (w: Window): string => `${routeName(w.location.hash)} "${w.document.title}"`;

const CONTROL = 'button,a,input,select,textarea,label,[role=button],[role=menuitem],[role=tab],[role=option],[role=link],[role=row]';

function targetLabel(t: EventTarget | null): string {
  const el = t instanceof Element ? t : null;
  const c = el?.closest(CONTROL);
  if (!c) return el ? el.tagName.toLowerCase() + (el.classList[0] ? `.${el.classList[0]}` : '') : '';
  const name = c.getAttribute('aria-label') || c.getAttribute('title') || (c instanceof HTMLInputElement ? c.type : c.textContent) || c.tagName.toLowerCase();
  return `"${name.replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
}

/** Taps, keys and scrolls in `w` start the frame count; the hub may be in another frame. `screen` '': the hub's own fallback. */
function watchInput(w: Window, screen: () => string = () => screenOf(w)): void {
  const opts = { capture: true, passive: true };
  const input = (label: string) => hub()?.input(label, screen(), w);
  // A scroll the user started: momentum keeps it going after the finger lifts, and the page scrolling itself (to the newest message) isn't input.
  let scrolledAt = -Infinity;
  const scroll = () => {
    scrolledAt = performance.now();
    input('scroll');
  };
  w.addEventListener('pointerdown', (e) => input(`tap ${targetLabel(e.target)}`), opts);
  w.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) scrolledAt = performance.now();
    // Only named keys: the letters typed in a message stay out of the log.
    input(e.key.length > 1 ? `key ${e.key}` : 'key');
  }, opts);
  w.addEventListener('wheel', scroll, opts);
  w.addEventListener('touchmove', scroll, opts);
  w.document.addEventListener('scroll', () => performance.now() - scrolledAt < SCROLL_CHAIN_MS && scroll(), opts);
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const SCROLL_CHAIN_MS = 1000;

function createHub(send: (frameApi: LooperApi | undefined, e: PerfEntry) => void, screen?: () => string): PerfHub {
  const frames = new Map<Window, LooperApi>();
  let inputFrom: Window | null = null;
  const loaf = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  const meter = new FrameMeter({
    freezesFromFrames: !loaf,
    report: (e) => send((inputFrom && frames.get(inputFrom)) || [...frames.values()].pop(), e),
    // Before any input, a phone names the window that opened last.
    screen:
      screen ??
      (() => {
        const last = [...frames.keys()].pop();
        return last ? screenOf(last) : '';
      }),
  });
  let running = false;
  // A message posted in the frame callback runs once the browser has styled, laid out and painted that frame,
  // which no script timing covers. A task queued before it counts too, so the name says "about".
  const afterPaint = new MessageChannel();
  let paintFrom = 0;
  afterPaint.port1.onmessage = () => {
    const end = clock();
    if (end - paintFrom >= 4) meter.span('Style, layout and paint (about)', paintFrom, end, end - paintFrom);
  };
  const measurePaint = () => {
    paintFrom = clock();
    afterPaint.port2.postMessage(0);
  };
  const tick = (t: number) => {
    running = meter.frame(performance.timeOrigin + t);
    if (!running) return;
    requestAnimationFrame(tick);
    measurePaint();
  };
  // While frames are counted, a timer chain shows when the thread was free, which tells a block from the browser holding frames back.
  const beat = () => {
    if (!running) return;
    meter.beat(clock());
    setTimeout(beat, BEAT_MS);
  };
  const kick = () => {
    if (running || document.visibilityState !== 'visible') return;
    running = true;
    requestAnimationFrame(tick);
    setTimeout(beat, BEAT_MS);
  };
  document.addEventListener('visibilitychange', () => meter.reset(clock()));
  if (loaf) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & { scripts?: LoafScript[] };
        if (e.duration < FREEZE_MS) continue;
        const scripts = [...(e.scripts ?? [])]
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map((s) => `${s.invoker || s.invokerType}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ''} ${Math.round(s.duration)} ms`);
        meter.longFrame(performance.timeOrigin + e.startTime, e.duration, scripts);
      }
    }).observe({ type: 'long-animation-frame' });
  }
  return {
    input(label, screen, from) {
      inputFrom = from;
      meter.input(clock(), label, screen);
      kick();
    },
    activity() {
      meter.touch(clock());
      kick();
    },
    span(name, start, end, ms) {
      meter.span(name, start, end, ms);
      meter.touch(clock());
      kick();
    },
    attach(frame, api) {
      frames.set(frame, api);
      return () => {
        frames.delete(frame);
        if (inputFrom === frame) inputFrom = null;
      };
    },
  };
}

interface LoafScript {
  duration: number;
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
}

/** A desktop window measures itself and reports through its own `window.looper`. */
export function startDesktopPerf(): void {
  window.__looperPerf = createHub(
    (_api, e) => window.looper.reportPerf(e),
    () => screenOf(window),
  );
  watchInput(window);
}

/** A phone's top frame measures for every window iframe and reports through the one that took the last input. */
export function startWebTopPerf(): void {
  window.__looperPerf = createHub((api, e) => api?.reportPerf(e));
  // The phone's bars (Back, the tab bar, menus) are in the top frame; they act on the window that opened last.
  watchInput(window, () => '');
}

/** A phone's window iframe: its input and renders go to the top frame's watchdog. */
export function attachWebFramePerf(): void {
  const h = hub();
  const detach = h?.attach(window, window.looper);
  if (detach) window.addEventListener('pagehide', detach);
  // Loading the window's code shows up as a freeze with no render in it; naming it says why. From the page's arrival, so the network wait isn't counted.
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const start = performance.timeOrigin + (nav?.responseEnd ?? 0);
  const end = clock();
  h?.span(`Load window ${routeName(location.hash)}`, start, end, end - start);
  watchInput(window);
}

/** A message from the computer: frames are counted from its arrival, and its handling is timed. */
export function perfMessage(): ((name: string) => void) | undefined {
  const h = hub();
  if (!h) return undefined;
  const start = clock();
  h.activity();
  return (name) => {
    const end = clock();
    if (end - start >= 2) h.span(name, start, end, end - start);
  };
}

/** Runs `fn`, timed under `name` for the frame watchdog: work outside React (DOM walks, parsing). */
export function perfSpan<T>(name: string, fn: () => T): T {
  const start = clock();
  try {
    return fn();
  } finally {
    const end = clock();
    if (end - start >= 1) hub()?.span(name, start, end, end - start);
  }
}

const onRender: ProfilerOnRenderCallback = (id, _phase, actualMs, _baseMs, startTime, commitTime) => {
  if (actualMs < 1) return;
  const origin = performance.timeOrigin;
  hub()?.span(id, origin + startTime, origin + commitTime, actualMs);
};

/** Times React's renders of `children` for the frame watchdog, under `id`. */
export function Measured({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

export const windowRouteName = (): string => routeName(window.location.hash);
