import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MenuItemSpec } from '../../../shared/remote-access';
import type { ShellController } from './controller';
import { AxisDrag, EDGE_WIDTH, LongPress } from './gestures';
import { editingIn, keyboardUp, tallestTracker } from './keyboard-up';
import { composeMore, type MoreMenu } from './more-menu';
import { BackStack, coversScreen, isTablet, presentation, type PhoneOs, type Presentation, type ScreenSize } from './nav-stack';
import { plainLabel } from './nav-bar-model';
import type { PageNav } from './page-nav';
import { childStack, mainWindow, useShellState, windowSrc, type ShellState, type WebWindow } from './store';
import './phone.css';

// ---------- the pages' navigation bars ----------

/** Each window's PageNav, as its page reports it through window.top.__looperFrame. */
function usePageNavs(): Map<string, PageNav> {
  const [navs, setNavs] = useState(() => new Map<string, PageNav>());
  useEffect(() => {
    window.__looperFrame = {
      setNav: (w, nav) =>
        setNavs((old) => {
          const next = new Map(old);
          if (nav) next.set(w, nav);
          else next.delete(w);
          return next;
        }),
    };
    return () => {
      delete window.__looperFrame;
    };
  }, []);
  return navs;
}

// ---------- screen, safe areas and the on-screen keyboard ----------

export interface Viewport extends ScreenSize {
  /** The on-screen keyboard is up (the visual viewport is much shorter than the window). */
  keyboard: boolean;
  safe: { top: number; bottom: number; left: number; right: number };
}

/** Reads env(safe-area-inset-*) through a hidden element: iframes see 0 there, so the frame passes them on. */
function readSafeArea(probe: HTMLElement | null): Viewport['safe'] {
  if (!probe) return { top: 0, bottom: 0, left: 0, right: 0 };
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
}

/**
 * The shell follows the visual viewport: with the keyboard up it shrinks to
 * what's left above it (and moves with it when iOS scrolls the page), so bars,
 * sheets and the page's bottom stay above the keyboard.
 */
function useViewport(probe: React.RefObject<HTMLDivElement | null>): Viewport {
  const [tallestAt] = useState(tallestTracker);
  const read = (): Viewport => {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const keyboard = keyboardUp(tallestAt(window.innerWidth, window.innerHeight), height, editingIn(document));
    return { width: vv?.width ?? window.innerWidth, height, keyboard, safe: readSafeArea(probe.current) };
  };
  const [vp, setVp] = useState<Viewport>(read);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    // On <html>, so layers portaled to <body> (alerts) follow the keyboard too.
    const html = document.documentElement;
    html.classList.add('ph-top');
    // A Home Screen app on iOS: the first keyboard leaves the whole viewport short by the status bar's height
    // (932 → 873 on a Pro Max) until the app quits. Hiding the page for one reflow makes WebKit measure it again.
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const tallest = new Map<number, number>();
    let keyboardSeen = false;
    let healTimer: ReturnType<typeof setTimeout> | undefined;
    const heal = () => {
      if (window.innerHeight >= (tallest.get(window.innerWidth) ?? 0) - 4) return;
      const scrolled = [...document.querySelectorAll<HTMLElement>('.ph-scroll')].map((el) => [el, el.scrollTop] as const);
      document.body.style.display = 'none';
      void document.body.offsetHeight;
      document.body.style.display = '';
      for (const [el, top] of scrolled) el.scrollTop = top;
      apply();
    };
    const apply = () => {
      if (vv) {
        html.style.setProperty('--vv-h', `${vv.height}px`);
        html.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      }
      // iOS scrolls the window to show a focused field; the shell is fixed, so it only needs to go back.
      if (window.scrollY !== 0 && !vv) window.scrollTo(0, 0);
      const n = read();
      if (standalone) {
        tallest.set(window.innerWidth, Math.max(tallest.get(window.innerWidth) ?? 0, window.innerHeight));
        if (n.keyboard) keyboardSeen = true;
        else if (keyboardSeen) {
          keyboardSeen = false;
          clearTimeout(healTimer);
          // After the keyboard's closing animation.
          healTimer = setTimeout(heal, 400);
        }
      }
      setVp((old) => (old.width === n.width && old.height === n.height && old.keyboard === n.keyboard && JSON.stringify(old.safe) === JSON.stringify(n.safe) ? old : n));
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      clearTimeout(healTimer);
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, [probe]);
  return vp;
}

// ---------- screens ----------

export interface Screen {
  win: WebWindow;
  pres: Presentation;
  /** Its place in the stack, from the main window (0) up. */
  depth: number;
  nav: PageNav | null;
  isTop: boolean;
  /** Drawn: the top screen, what shows around a sheet, and the one under the top (for the back swipe). */
  visible: boolean;
  /** Directly under a phone's page sheet: iOS shrinks it back. */
  behind: boolean;
  leaving: boolean;
  /** The screen it goes back to. */
  below?: WebWindow;
}

/** Long enough for iOS's leaving spring (ios.css, --spring-smooth) to come within a pixel of its end. */
const LEAVE_MS = 450;

/** Closed windows stay a moment, for their exit animation, at their place in the page (moving an iframe reloads it). */
function useScreens(s: ShellState, os: PhoneOs, size: ScreenSize, navs: Map<string, PageNav>): { screens: Screen[]; top: Screen | undefined } {
  const leaving = useRef(new Map<string, { win: WebWindow; pres: Presentation; depth: number; until: number }>());
  const domOrder = useRef<string[]>([]);
  const [, tick] = useState(0);
  const main = mainWindow(s);
  const stack = main ? [main, ...childStack(s)] : childStack(s);
  const live = new Set(s.windows.map((w) => w.w));
  const presOf = (win: WebWindow) => presentation(os, win, win === main, size);
  const last = useRef(new Map<string, { win: WebWindow; pres: Presentation; depth: number }>());

  const now = Date.now();
  for (const [w, info] of last.current) {
    if (!live.has(w) && !leaving.current.has(w)) leaving.current.set(w, { ...info, until: now + LEAVE_MS });
  }
  for (const [w, l] of leaving.current) if (l.until <= now || live.has(w)) leaving.current.delete(w);
  last.current = new Map(stack.map((win, depth) => [win.w, { win, pres: presOf(win), depth }]));

  useEffect(() => {
    if (!leaving.current.size) return;
    const t = setTimeout(() => tick((n) => n + 1), LEAVE_MS + 20);
    return () => clearTimeout(t);
  });

  const keep = new Set([...live, ...leaving.current.keys()]);
  domOrder.current = [...domOrder.current.filter((w) => keep.has(w)), ...s.windows.map((x) => x.w).filter((w) => !domOrder.current.includes(w))];

  const topIndex = stack.length - 1;
  // Drawn: from the top down to the first screen that covers everything, and always the one right under the top.
  const visible = new Set<string>();
  for (let i = topIndex; i >= 0; i--) {
    visible.add(stack[i].w);
    if (i < topIndex && coversScreen(presOf(stack[i]))) break;
  }
  if (topIndex > 0) visible.add(stack[topIndex - 1].w);
  const top = stack[topIndex];
  const topPres = top ? presOf(top) : 'root';
  const tablet = isTablet(size);

  const screens: Screen[] = [];
  for (const w of domOrder.current) {
    const depth = stack.findIndex((x) => x.w === w);
    if (depth >= 0) {
      const win = stack[depth];
      screens.push({
        win,
        pres: presOf(win),
        depth,
        nav: navs.get(w) ?? null,
        isTop: depth === topIndex,
        visible: visible.has(w),
        // iOS 27 only dims a screen under a page sheet; a page sheet under another narrows (the kit's stacked sheets).
        behind: os === 'ios' && !tablet && depth === topIndex - 1 && topPres === 'page-sheet' && presOf(win) === 'page-sheet',
        leaving: false,
        below: stack[depth - 1],
      });
      continue;
    }
    const l = leaving.current.get(w);
    if (l) screens.push({ win: l.win, pres: l.pres, depth: l.depth + 0.5, nav: null, isTop: false, visible: true, behind: false, leaving: true });
  }
  return { screens, top: screens.find((x) => x.isTop) };
}

// ---------- back ----------

/** One thing Back closes, bottom to top. */
export type BackLayer = () => void;

function useBack(layers: BackLayer[]): { goBack: () => void } {
  const latest = useRef(layers);
  latest.current = layers;
  const stack = useMemo(
    () =>
      new BackStack(
        {
          depth: () => {
            const d = (history.state as { looperDepth?: number } | null)?.looperDepth;
            return typeof d === 'number' ? d : 0;
          },
          push: (depth) => history.pushState({ ...(history.state ?? {}), looperDepth: depth }, '', location.href),
          go: (n) => history.go(n),
        },
        () => Date.now(),
      ),
    [],
  );
  const runTop = useCallback((steps: number) => {
    for (let i = 0; i < steps; i++) latest.current[latest.current.length - 1 - i]?.();
  }, []);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const d = (e.state as { looperDepth?: number } | null)?.looperDepth;
      const steps = stack.popped(typeof d === 'number' ? d : 0);
      if (steps > 0) {
        runTop(Math.min(steps, latest.current.length));
        setTimeout(() => stack.sync(latest.current.length), stack.holdRemaining() + 10);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stack, runTop]);
  useEffect(() => stack.sync(layers.length));
  return { goBack: () => void (stack.back() || runTop(1)) };
}

// ---------- the pages' documents ----------

/**
 * Put into every window's page: no double-tap zoom, no iOS callout on what isn't text input, and text
 * selects only in a field or a message under Select Text, so a long press opens the menu and nothing else.
 */
const FRAME_CSS = `
html { touch-action: manipulation; -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
body { -webkit-touch-callout: none; overscroll-behavior: none; }
input, textarea, [contenteditable], [contenteditable] * { -webkit-touch-callout: default; }
body, body * { -webkit-user-select: none; user-select: none; }
body :is(input, textarea, [contenteditable], [contenteditable] *, [data-selecting], [data-selecting] *) { -webkit-user-select: text; user-select: text; }
[data-selecting], [data-selecting] * { -webkit-touch-callout: default; }
`;

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export interface FrameHooks {
  /** Whether the screen can go back by an edge swipe now (iOS). */
  canSwipeBack: (w: string) => boolean;
  swipe: (w: string, dx: number | null, commit?: boolean, speed?: number) => void;
}

/** Long press → contextmenu, and iOS's edge swipe, in a window's page. */
function attachTouch(win: Window, w: string, os: PhoneOs, hooks: React.RefObject<FrameHooks>): void {
  const doc = win.document;
  const ours = new WeakSet<Event>();
  let swallowClickUntil = 0;
  const press = new LongPress<Element>(
    { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    (x, y, target) => {
      const Mouse = (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
      const ev = new Mouse('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, view: win });
      ours.add(ev);
      const taken = !target.dispatchEvent(ev);
      // The page shows a menu: the text iOS started to select under the finger isn't wanted.
      if (taken) win.getSelection()?.removeAllRanges();
    },
  );
  const edge = new AxisDrag('x');
  let edgeOn = false;
  doc.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (!t || !target) return;
      // Text input, and a message being selected (Select Text): the system's own long press selects there.
      if (target.closest?.(`${EDITABLE}, [data-selecting]`)) press.cancel();
      else press.down(t.clientX, t.clientY, target, e.touches.length);
      edgeOn = os === 'ios' && e.touches.length === 1 && t.clientX <= EDGE_WIDTH && hooks.current.canSwipeBack(w);
      if (edgeOn) edge.begin(t.clientX, t.clientY, e.timeStamp);
    },
    { passive: true, capture: true },
  );
  doc.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      press.move(t.clientX, t.clientY);
      if (!edgeOn) return;
      const r = edge.move(t.clientX, t.clientY, e.timeStamp);
      if (r) {
        e.preventDefault();
        hooks.current.swipe(w, r.offset);
      } else if (!edge.active) edgeOn = edgeOn && t.clientX <= EDGE_WIDTH + 8;
    },
    { passive: false, capture: true },
  );
  const end = (e: TouchEvent) => {
    if (press.up()) {
      e.preventDefault();
      swallowClickUntil = Date.now() + 500;
    }
    if (edgeOn) {
      edgeOn = false;
      const speed = edge.speed;
      hooks.current.swipe(w, null, edge.end(win.innerWidth), speed);
    }
  };
  doc.addEventListener('touchend', end, { passive: false, capture: true });
  doc.addEventListener('touchcancel', () => {
    press.cancel();
    if (edgeOn) {
      edgeOn = false;
      edge.end(win.innerWidth);
      hooks.current.swipe(w, null, false);
    }
  }, { capture: true });
  win.addEventListener(
    'contextmenu',
    (e) => {
      if (ours.has(e)) return;
      if (press.nativeMenu()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  win.addEventListener(
    'click',
    (e) => {
      if (Date.now() < swallowClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

function preparePage(el: HTMLIFrameElement, w: string, os: PhoneOs, hooks: React.RefObject<FrameHooks>): void {
  const win = el.contentWindow;
  const doc = el.contentDocument;
  if (!win || !doc) return;
  const style = doc.createElement('style');
  style.dataset.looperFrame = '';
  style.textContent = FRAME_CSS;
  doc.head.appendChild(style);
  attachTouch(win, w, os, hooks);
}

/** A window's iframe; the controller's ref plus the phone's own setup of the page. */
function PhoneIframe({ controller, win, os, hooks, safeBottom }: { controller: ShellController; win: WebWindow; os: PhoneOs; hooks: React.RefObject<FrameHooks>; safeBottom: number }) {
  const base = controller.frameRef(win.w);
  const el = useRef<HTMLIFrameElement | null>(null);
  const ref = useCallback(
    (node: HTMLIFrameElement | null) => {
      base(node);
      el.current = node;
      if (node) node.addEventListener('load', () => preparePage(node, win.w, os, hooks));
    },
    [base, win.w, os, hooks],
  );
  // The page can't read the safe area itself (env() is 0 in an iframe): it gets it as a variable.
  useEffect(() => {
    const set = () => el.current?.contentDocument?.documentElement.style.setProperty('--looper-safe-bottom', `${safeBottom}px`);
    set();
    const node = el.current;
    node?.addEventListener('load', set);
    return () => node?.removeEventListener('load', set);
  }, [safeBottom, win.nonce]);
  return <iframe key={`${win.w}:${win.nonce}`} ref={ref} className="ph-frame" title={win.title} src={windowSrc(win)} allow="clipboard-read; clipboard-write" />;
}

// ---------- the frame's model ----------

export interface PhoneShell {
  s: ShellState;
  os: PhoneOs;
  vp: Viewport;
  tablet: boolean;
  screens: Screen[];
  top: Screen | undefined;
  rootRef: React.RefObject<HTMLDivElement | null>;
  probeRef: React.RefObject<HTMLDivElement | null>;
  hooks: React.RefObject<FrameHooks>;
  /** Back from the top screen: its page's deeper screen first, else the window closes. */
  goBack: () => void;
  /** Whether a window's large title has scrolled away (iOS shows the bar's title then). */
  scrolledPast: Set<string>;
  /** What's at the top of each window's page, under its bar. */
  edges: Map<string, TopEdge>;
}

export interface TopEdge {
  /** The page's background color along its top edge. */
  color: string;
  /** The page's content there has scrolled up, past the bar. */
  scrolled: boolean;
  /** iPad split view: the same over the detail column (the rest is the list column's). */
  detail?: { color: string; scrolled: boolean };
}

const isTransparent = (c: string) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
/** What's at `x` (the middle) of a page's top edge: the first background behind it, and whether a scroller there has moved. */
function readTopEdge(doc: Document, win: Window, x = win.innerWidth / 2): TopEdge | null {
  const hit = doc.elementFromPoint(x, 1);
  // Nothing hit (a hidden or inert page): keep the last reading.
  if (!hit || hit === doc.documentElement) return null;
  let color = '';
  let scrolled = (doc.scrollingElement?.scrollTop ?? 0) > 0;
  for (let el: Element | null = hit; el; el = el.parentElement) {
    const cs = win.getComputedStyle(el);
    if (!scrolled && el.scrollTop > 0 && /auto|scroll/.test(cs.overflowY)) scrolled = true;
    if (!color && !isTransparent(cs.backgroundColor)) color = cs.backgroundColor;
  }
  return { color: color || win.getComputedStyle(doc.documentElement).backgroundColor, scrolled };
}

/** Follows the top edge of every window's page: its scrolling, its tabs switching, the page loading again. */
function useTopEdges(controller: ShellController, screens: Screen[], enabled: boolean): Map<string, TopEdge> {
  const [edges, setEdges] = useState(() => new Map<string, TopEdge>());
  const live = screens.filter((sc) => !sc.leaving);
  // A page split in columns (PageNav split): its edge is the list column's, with the detail column's beside it.
  const splitWidth = useRef(new Map<string, { lead: number; inspector: number }>());
  splitWidth.current = new Map(
    live.flatMap((sc) => (sc.nav?.split ? [[sc.win.w, { lead: sc.nav.split.width, inspector: sc.nav.split.inspector?.width ?? 0 }] as const] : [])),
  );
  const key = live.map((sc) => `${sc.win.w}:${sc.win.nonce}`).join(' ');
  useEffect(() => {
    if (!enabled) return;
    const offs: (() => void)[] = [];
    for (const sc of live) {
      const w = sc.win.w;
      const frame = controller.frameOf(w);
      if (!frame) continue;
      let detach: (() => void) | null = null;
      const attach = () => {
        detach?.();
        detach = null;
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        if (!doc?.body || !win) return;
        let queued = false;
        const measure = () => {
          queued = false;
          const cols = splitWidth.current.get(w);
          const edge = readTopEdge(doc, win, cols ? cols.lead / 2 : undefined);
          if (!edge) return;
          if (cols) {
            const detail = readTopEdge(doc, win, cols.lead + (win.innerWidth - cols.lead - cols.inspector) / 2);
            if (detail) edge.detail = { color: detail.color, scrolled: detail.scrolled };
          }
          setEdges((old) => {
            const was = old.get(w);
            if (was && was.color === edge.color && was.scrolled === edge.scrolled && JSON.stringify(was.detail) === JSON.stringify(edge.detail)) return old;
            return new Map(old).set(w, edge);
          });
        };
        const schedule = () => {
          if (queued) return;
          queued = true;
          win.requestAnimationFrame(measure);
        };
        const mo = new MutationObserver(schedule);
        mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
        const scheme = win.matchMedia('(prefers-color-scheme: dark)');
        doc.addEventListener('scroll', schedule, { capture: true, passive: true });
        win.addEventListener('resize', schedule);
        scheme.addEventListener('change', schedule);
        measure();
        detach = () => {
          mo.disconnect();
          doc.removeEventListener('scroll', schedule, { capture: true });
          win.removeEventListener('resize', schedule);
          scheme.removeEventListener('change', schedule);
        };
      };
      attach();
      frame.addEventListener('load', attach);
      offs.push(() => {
        frame.removeEventListener('load', attach);
        detach?.();
      });
    }
    return () => offs.forEach((f) => f());
  }, [key, controller, enabled]);
  return edges;
}

/** A sheet dragged down, or a screen swiped back: the frame moves it under the finger. */
export function setDrag(root: HTMLElement | null, w: string, axis: 'x' | 'y', offset: number | null): void {
  const card = root?.querySelector<HTMLElement>(`.ph-win[data-w="${CSS.escape(w)}"] > .ph-card`);
  if (!card) return;
  const under = axis === 'x' ? root?.querySelector<HTMLElement>(`.ph-win[data-under="${CSS.escape(w)}"] > .ph-card`) : null;
  if (offset === null) {
    card.style.transition = '';
    card.style.transform = '';
    if (under) {
      under.style.transition = '';
      under.style.transform = '';
    }
    return;
  }
  card.style.transition = 'none';
  card.style.transform = axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`;
  if (under) {
    under.style.transition = 'none';
    under.style.transform = `translateX(${(offset - card.clientWidth) * 0.3}px)`;
  }
}

const SWIPE_FINISH_MS = 300;

/**
 * A back swipe let go past its threshold: the screen carries on to the right from where the finger
 * left it, at the finger's speed (px/ms), and the one under it comes into place, without waiting for
 * the history's back. The leave animation doesn't play over it (data-swiped).
 */
function finishBackSwipe(root: HTMLElement | null, w: string, speed: number): void {
  const card = root?.querySelector<HTMLElement>(`.ph-win[data-w="${CSS.escape(w)}"] > .ph-card`);
  if (!card) return;
  const under = root?.querySelector<HTMLElement>(`.ph-win[data-under="${CSS.escape(w)}"] > .ph-card`);
  const width = card.clientWidth;
  const left = Math.max(1, width - new DOMMatrixReadOnly(getComputedStyle(card).transform).m41);
  // The curve's first slope is the finger's speed over the distance left.
  const x1 = 0.2;
  const y1 = Math.min(1, Math.max(1.2, Math.min((Math.max(0, speed) * SWIPE_FINISH_MS) / left, 5)) * x1);
  const transition = `transform ${SWIPE_FINISH_MS}ms cubic-bezier(${x1}, ${y1}, 0.3, 1)`;
  card.dataset.swiped = '';
  card.style.transition = transition;
  card.style.transform = `translateX(${width}px)`;
  if (under) {
    under.style.transition = transition;
    under.style.transform = 'translateX(0px)';
    // Handed back to the stylesheet once it's the top screen, where the stylesheet puts it in the same place.
    const release = (tries: number) => {
      if (under.closest(`.ph-win[data-under="${CSS.escape(w)}"]`) && tries > 0) return void setTimeout(() => release(tries - 1), 100);
      under.style.transition = 'none';
      under.style.transform = '';
      requestAnimationFrame(() => (under.style.transition = ''));
    };
    setTimeout(() => release(30), SWIPE_FINISH_MS);
  }
  // A back that didn't happen leaves the screen where it was.
  setTimeout(() => {
    if (!card.isConnected || card.closest('.leaving')) return;
    delete card.dataset.swiped;
    card.style.transition = '';
    card.style.transform = '';
  }, LEAVE_MS + 1000);
}

export function usePhoneShell(controller: ShellController, os: PhoneOs, localLayers: BackLayer[]): PhoneShell {
  const s = useShellState(controller.store);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const vp = useViewport(probeRef);
  const navs = usePageNavs();
  const { screens, top } = useScreens(s, os, vp, navs);
  const [scrolledPast, setScrolledPast] = useState(() => new Set<string>());
  // Only iOS's bar takes the page's color; Android's top app bar has its own.
  const edges = useTopEdges(controller, screens, os === 'ios');

  // The keyboard goes with its screen: a window no longer on top (gone back from, hidden, under a new one) gives up the focus, or iOS keeps the keyboard up over the list.
  const topW = top?.win.w;
  useEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLIFrameElement)) return;
    const sc = screens.find((x) => controller.frameOf(x.win.w) === active);
    if (!sc || sc.win.w === topW) return;
    (active.contentDocument?.activeElement as HTMLElement | null | undefined)?.blur?.();
    active.blur();
    // The screens as they are when the top one changes.
  }, [topW]);

  // Back: bottom to top, the windows over the main one, the top page's own deeper screen, then what the shell has open.
  const layers: BackLayer[] = [];
  const live = screens.filter((x) => !x.leaving).sort((a, b) => a.depth - b.depth);
  for (const sc of live) if (sc.pres !== 'root') layers.push(() => controller.close(sc.win.w));
  const topNav = top?.nav;
  if (topNav?.back) layers.push(() => topNav.back?.());
  const firstOverlay = layers.length;
  layers.push(...localLayers);
  for (const p of s.paths) layers.push(() => controller.closePath(p.id));
  for (const d of s.dialogs) {
    layers.push(() =>
      d.kind === 'message'
        ? controller.answer(d.dialogId, { kind: 'message', response: d.spec.cancelId, checkboxChecked: !!d.spec.checkboxChecked })
        : controller.answer(d.dialogId, d.kind === 'open' ? { kind: 'open', canceled: true, filePaths: [] } : { kind: 'save', canceled: true }),
    );
  }
  for (const m of s.menus) layers.push(() => controller.dismissMenu(m.menuId));
  const { goBack: historyBack } = useBack(layers);

  // A hardware keyboard's Escape closes what the shell has open (a menu, a sheet, an alert), never a screen.
  const overlays = useRef<BackLayer[]>([]);
  overlays.current = layers.slice(firstOverlay);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const close = overlays.current[overlays.current.length - 1];
      if (!close) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hooks = useRef<FrameHooks>({ canSwipeBack: () => false, swipe: () => undefined });
  hooks.current = {
    canSwipeBack: (w) => {
      const sc = screens.find((x) => x.win.w === w);
      return !!sc?.isTop && (sc.pres === 'push' || !!sc.nav?.back) && s.dialogs.length === 0 && s.menus.length === 0;
    },
    swipe: (w, dx, commit, speed = 0) => {
      const sc = screens.find((x) => x.win.w === w);
      // A page's own deeper screen has nothing of the frame's under it to show.
      const moves = sc?.pres === 'push' && !sc.nav?.back;
      if (moves && dx === null && commit) finishBackSwipe(rootRef.current, w, speed);
      else if (moves) setDrag(rootRef.current, w, 'x', dx);
      if (dx === null && commit) historyBack();
    },
  };

  // The bar's title shows once the page's large title (data-large-title) has scrolled under it.
  useEffect(() => {
    const offs: (() => void)[] = [];
    for (const sc of screens) {
      if (!(sc.nav?.largeTitle || sc.nav?.split?.largeTitle) || sc.leaving) continue;
      const doc = controller.frameOf(sc.win.w)?.contentDocument;
      if (!doc) continue;
      const check = () => {
        const el = doc.querySelector('[data-large-title]');
        const past = !el || el.getBoundingClientRect().bottom <= 0;
        setScrolledPast((old) => {
          if (old.has(sc.win.w) === past) return old;
          const next = new Set(old);
          if (past) next.add(sc.win.w);
          else next.delete(sc.win.w);
          return next;
        });
      };
      check();
      doc.addEventListener('scroll', check, { capture: true, passive: true });
      offs.push(() => doc.removeEventListener('scroll', check, { capture: true }));
    }
    return () => offs.forEach((f) => f());
  });

  // A click in the shell needs its own press: lifting the finger of a long press in a page lands on the
  // menu that press opened (Chrome sends it as a click), and must not pick the item under it.
  useEffect(() => {
    let pressed = false;
    const down = () => (pressed = true);
    const click = (e: MouseEvent) => {
      if (!pressed && e.isTrusted && e.detail > 0) {
        e.preventDefault();
        e.stopPropagation();
      }
      pressed = false;
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('click', click, true);
    };
  }, []);

  // The shell itself never scrolls or bounces; lists inside it (menus, files) still do.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      if (!(e.target as Element | null)?.closest?.('.ph-scroll')) e.preventDefault();
    };
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => el.removeEventListener('touchmove', onMove);
  }, []);

  return { s, os, vp, tablet: isTablet(vp), screens, top, rootRef, probeRef, hooks, goBack: historyBack, scrolledPast, edges };
}

// ---------- the windows ----------

export interface WindowsProps {
  shell: PhoneShell;
  controller: ShellController;
  /** The bar at the top of a window's card (and the grabber or handle of a sheet). */
  renderBar: (sc: Screen) => ReactNode;
  /** Sheets that close when dragged down by their bar. */
  dragToDismiss: (p: Presentation) => boolean;
}

/** Every window, in creation order (an iframe that moved would reload), stacked by depth. */
export function PhoneWindows({ shell, controller, renderBar, dragToDismiss }: WindowsProps) {
  const { screens, os, vp, s, hooks } = shell;
  const blockedByShell = s.dialogs.length > 0 || s.paths.length > 0;
  const under = shell.top && shell.top.pres === 'push' ? shell.top.below?.w : undefined;
  return (
    <>
      {screens.map((sc) => {
        const sheet = sc.pres !== 'root' && sc.pres !== 'push';
        const ownsBottom = !!sc.nav?.ownsBottom;
        const safeBottom = !vp.keyboard && (sc.pres === 'root' || sc.pres === 'push' || sc.pres === 'full-dialog' || sc.pres === 'page-sheet' || sc.pres === 'bottom-sheet') ? vp.safe.bottom : 0;
        const style = { zIndex: 10 + Math.round(sc.depth * 2) } as React.CSSProperties;
        if (sc.pres === 'bottom-sheet') (style as Record<string, string>)['--sheet-h'] = `${sc.win.height}px`;
        if (sc.pres === 'dialog' || sc.pres === 'form-sheet') {
          (style as Record<string, string>)['--win-w'] = `${sc.win.width}px`;
          (style as Record<string, string>)['--win-h'] = `${sc.win.height}px`;
        }
        return (
          <div
            key={sc.win.w}
            data-w={sc.win.w}
            data-under={sc.win.w === under ? shell.top?.win.w : undefined}
            className={`ph-win pres-${sc.pres}${sc.visible ? '' : ' hidden'}${sc.leaving ? ' leaving' : ''}${sc.behind ? ' behind' : ''}${sc.isTop ? ' top' : ''}`}
            style={style}
            inert={!sc.isTop || sc.leaving || blockedByShell}
            aria-hidden={!sc.isTop || undefined}
          >
            {sheet && <Scrim className="ph-scrim" onTap={() => sc.pres !== 'full-dialog' && os === 'android' && controller.close(sc.win.w)} />}
            <div className={`ph-card${ownsBottom ? ' owns-bottom' : ''}`} role={sheet ? 'dialog' : undefined} aria-modal={sheet || undefined} aria-label={sc.nav?.title || sc.win.title}>
              <DragArea enabled={sheet && dragToDismiss(sc.pres) && !sc.nav?.modal} root={shell.rootRef} w={sc.win.w} onDismiss={() => controller.close(sc.win.w)}>
                {/* The page has a sheet of its own open: the bar is dimmed with its backdrop and out of reach. */}
                <div className={`ph-bar-slot${sc.nav?.modal ? ' page-modal' : ''}`} inert={!!sc.nav?.modal}>
                  {renderBar(sc)}
                </div>
              </DragArea>
              <div className="ph-body">
                <PhoneIframe controller={controller} win={sc.win} os={os} hooks={hooks} safeBottom={safeBottom} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A sheet's bar: drag it down to close the sheet. */
function DragArea({ enabled, root, w, onDismiss, children }: { enabled: boolean; root: React.RefObject<HTMLDivElement | null>; w: string; onDismiss: () => void; children: ReactNode }) {
  const drag = useRef(new AxisDrag('y'));
  if (!enabled) return <>{children}</>;
  return (
    <div
      className="ph-drag"
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button, input, a')) return;
        drag.current.begin(e.clientX, e.clientY, e.timeStamp);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const r = drag.current.move(e.clientX, e.clientY, e.timeStamp);
        if (r) setDrag(root.current, w, 'y', r.offset);
      }}
      onPointerUp={(e) => {
        const card = (e.currentTarget.closest('.ph-card') as HTMLElement | null)?.clientHeight ?? 600;
        const done = drag.current.end(card);
        setDrag(root.current, w, 'y', null);
        if (done) onDismiss();
      }}
      onPointerCancel={() => {
        drag.current.end(0);
        setDrag(root.current, w, 'y', null);
      }}
    >
      {children}
    </div>
  );
}

// ---------- small shared pieces ----------

/**
 * The dimmed backdrop of a sheet or dialog; a tap on it closes what's over it.
 * Only a tap that began on it counts: lifting the finger of the long press
 * that opened a menu lands here too, as a click.
 */
export function Scrim({ className, onTap }: { className: string; onTap?: () => void }) {
  const began = useRef(false);
  return (
    <div
      className={className}
      onPointerDown={(e) => (began.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (began.current && e.target === e.currentTarget) onTap?.();
        began.current = false;
      }}
    />
  );
}

/** The More menu open over a screen, and what its page's own items do. */
export interface OpenMore extends MoreMenu {
  w: string;
  anchor: DOMRect;
}

/** A screen's More menu (more-menu.ts). */
export function moreFor(sc: Screen): MoreMenu {
  const nav = sc.nav;
  return composeMore({ toolbar: nav?.toolbar, more: nav?.more });
}

/** A pick in the More menu: a command of the page's, or the computer's menu item. */
export function pickMore(controller: ShellController, more: OpenMore, item: MenuItemSpec): void {
  const own = more.run.get(item.id);
  if (own) own();
  else controller.pick(more.w, more.w, item);
}

/** Separator-free groups of a menu, for lists that draw separators as gaps. */
export function menuGroups(items: MenuItemSpec[]): MenuItemSpec[][] {
  const out: MenuItemSpec[][] = [[]];
  for (const it of items) {
    if (it.type === 'separator') {
      if (out[out.length - 1].length) out.push([]);
    } else out[out.length - 1].push(it);
  }
  return out.filter((g) => g.length);
}


/** Android: under 600 dp long menus open as a bottom sheet rather than a list at the finger; wider, a menu that scrolls (iOS always keeps the menu). */
export const isLongMenu = (items: MenuItemSpec[], width: number, height: number): boolean => {
  if (width >= 600) return false;
  const rows = items.filter((i) => i.type !== 'separator').length;
  return rows > 8 || rows * 48 > height * 0.6;
};

/** The device's own name for itself in "This iPhone" / "This Phone". */
export function deviceNoun(os: PhoneOs, tablet: boolean): string {
  if (os === 'ios') return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && tablet) || tablet ? 'iPad' : 'iPhone';
  return tablet ? 'Tablet' : 'Phone';
}

/** A pull-down or popup menu's state: the submenu path the user opened. */
export function useSubmenus(items: MenuItemSpec[]): { level: MenuItemSpec[]; title: string | null; open: (it: MenuItemSpec) => void; up: () => void } {
  const [path, setPath] = useState<MenuItemSpec[]>([]);
  useEffect(() => setPath([]), [items]);
  const last = path[path.length - 1];
  return {
    level: last?.submenu ?? items,
    title: last ? plainLabel(last.label) : null,
    open: (it) => setPath((p) => [...p, it]),
    up: () => setPath((p) => p.slice(0, -1)),
  };
}
