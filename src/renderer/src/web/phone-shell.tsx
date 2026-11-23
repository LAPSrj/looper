import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MenuItemSpec } from '../../../shared/remote-access';
import { appleDevice } from './device-name';
import { useOverlay, type ShellController } from './controller';
import { AxisDrag, EDGE_WIDTH, LongPress } from './gestures';
import { DEFAULT_SPRING } from './menu-motion';
import { editingIn, keyboardUp, tallestTracker } from './keyboard-up';
import { actionMenu, composeMore, type MoreMenu } from './more-menu';
import { BackStack, drawnScreens, isTablet, presentation, type PhoneOs, type Presentation, type ScreenSize } from './nav-stack';
import { noMnemonic } from '../../../shared/commands/command';
import { barModel, dismissFor, type BarModel, type PageNavAction } from './nav-bar-model';
import { slideCard, useDragToDismiss } from './sheet-drag';
import { discardQuestion } from './dialog-flows';
import type { PageNav } from './page-nav';
import { childStack, mainWindow, useShellState, windowSrc, type ShellState, type WebWindow } from './store';
import type { TopEdgeReading } from './top-bar';
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
  /** Drawn: the top screen, what shows around a sheet, and the one under the top while the top slides in. */
  visible: boolean;
  /** Under a screen that covers it: drawn only while a back swipe uncovers it (the root's data-peek, setDrag). */
  covered: boolean;
  /** Directly under a phone's page sheet: iOS shrinks it back. */
  behind: boolean;
  leaving: boolean;
  /** The screen it goes back to. */
  below?: WebWindow;
}

/** Long enough for iOS's leaving spring (ios.css, --spring-smooth) to come within a pixel of its end. */
const LEAVE_MS = 450;
/** How long a new top screen takes to slide in (iOS's default spring; Android's is 0.3 s), with the screen under it drawn. */
const ARRIVE_MS = DEFAULT_SPRING.ms + 50;

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
  const arrived = useRef<{ w: string; at: number } | null>(null);

  const now = Date.now();
  for (const [w, info] of last.current) {
    if (!live.has(w) && !leaving.current.has(w)) leaving.current.set(w, { ...info, until: now + LEAVE_MS });
  }
  for (const [w, l] of leaving.current) if (l.until <= now || live.has(w)) leaving.current.delete(w);
  last.current = new Map(stack.map((win, depth) => [win.w, { win, pres: presOf(win), depth }]));

  const topIndex = stack.length - 1;
  const top = stack[topIndex];
  if (top && arrived.current?.w !== top.w) arrived.current = { w: top.w, at: now };
  const arriving = !!top && now - (arrived.current?.at ?? 0) < ARRIVE_MS;

  useEffect(() => {
    const waits = [leaving.current.size ? LEAVE_MS + 20 : 0, arriving ? (arrived.current?.at ?? now) + ARRIVE_MS - Date.now() + 20 : 0].filter((ms) => ms > 0);
    if (!waits.length) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(...waits));
    return () => clearTimeout(t);
  });

  const keep = new Set([...live, ...leaving.current.keys()]);
  domOrder.current = [...domOrder.current.filter((w) => keep.has(w)), ...s.windows.map((x) => x.w).filter((w) => !domOrder.current.includes(w))];

  // Drawn: from the top down to the first screen that covers everything. A full screen hides what's under it (a chat
  // over the main window's tab bar and its glass kept every frame of the chat waiting on WebKit's blur): what's under it
  // is drawn while it slides in, and while a back swipe uncovers it, from the one right under it down to the first
  // that covers everything again.
  const drawn = drawnScreens(stack.map(presOf), arriving);
  const visible = new Set(stack.filter((_, i) => drawn.visible[i]).map((x) => x.w));
  const covered = new Set(stack.filter((_, i) => drawn.covered[i]).map((x) => x.w));
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
        covered: covered.has(w),
        // iOS 27 only dims a screen under a page sheet; a page sheet under another narrows (the kit's stacked sheets).
        behind: os === 'ios' && !tablet && depth === topIndex - 1 && topPres === 'page-sheet' && presOf(win) === 'page-sheet',
        leaving: false,
        below: stack[depth - 1],
      });
      continue;
    }
    const l = leaving.current.get(w);
    if (l) screens.push({ win: l.win, pres: l.pres, depth: l.depth + 0.5, nav: null, isTop: false, visible: true, covered: false, behind: false, leaving: true });
  }
  return { screens, top: screens.find((x) => x.isTop) };
}

// ---------- back ----------

/** One thing Back closes, bottom to top. */
export type BackLayer = () => void;

/**
 * `browserBack`: a back the browser did on its own (its back gesture or button, not the frame's Back) closes layers
 * through it instead of the usual way.
 */
function useBack(layers: BackLayer[], browserBack?: (close: () => void, e: PopStateEvent) => void): { goBack: () => void } {
  const latest = useRef(layers);
  latest.current = layers;
  const viaBrowser = useRef(browserBack);
  viaBrowser.current = browserBack;
  /** The frame's own Back went through the history: the popstate it brings is ours. */
  const ours = useRef(false);
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
        const close = () => runTop(Math.min(steps, latest.current.length));
        const browser = !ours.current && viaBrowser.current;
        ours.current = false;
        if (browser) browser(close, e);
        else close();
        setTimeout(() => stack.sync(latest.current.length), stack.holdRemaining() + 10);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stack, runTop]);
  useEffect(() => stack.sync(layers.length));
  return {
    goBack: () => {
      if (stack.back()) ours.current = true;
      else runTop(1);
    },
  };
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
function PhoneIframe({ controller, win, os, hooks, safeBottom, lifted }: { controller: ShellController; win: WebWindow; os: PhoneOs; hooks: React.RefObject<FrameHooks>; safeBottom: number; lifted: boolean }) {
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
  // iOS: the bar floats over the page, which runs under it to the screen's top ("extend the scroll view fully under the
  // navigationBar", WWDC25 284): the page gets the bar's height (--looper-bar-h, data-under-bar) to start its content
  // below it (phone.css). While the page shows a sheet of its own (PageNav modal), the iframe rises over the bar to the
  // status bar, so the sheet can start there (ios.md: Sheets), and the page pads its top by the rest of the bar, so what
  // it shows stays in place and the bar shows through that band under the sheet's backdrop. The bar's own dimming keeps
  // to the status bar.
  useLayoutEffect(() => {
    const frame = el.current;
    const body = frame?.parentElement;
    const slot = body?.parentElement?.querySelector<HTMLElement>(':scope > .ph-bar-slot, :scope > .ph-drag > .ph-bar-slot');
    if (!frame || !body || !slot) return;
    const floats = os === 'ios';
    const apply = () => {
      const header = slot.querySelector('header');
      const status = header ? parseFloat(getComputedStyle(header).paddingTop) || 0 : 0;
      const bar = slot.offsetHeight;
      const lift = lifted ? Math.max(0, bar - status) : 0;
      const root = frame.contentDocument?.documentElement;
      if (root) {
        root.style.setProperty('--looper-lift', `${lift}px`);
        root.toggleAttribute('data-lifted', lift > 0);
        if (floats) {
          root.style.setProperty('--looper-bar-h', `${bar}px`);
          root.setAttribute('data-under-bar', '');
        }
      }
      // Lifted, the page starts under the status bar: from the card's top on iOS (the bar floats), or the bar's height
      // up from where it starts below the bar elsewhere.
      const top = floats ? (lift ? `${status}px` : '') : lift ? `${-lift}px` : '';
      if (body.style.marginTop !== top) body.style.marginTop = top;
      body.classList.toggle('lifted', lift > 0);
      slot.style.setProperty('--lift', `${lift}px`);
    };
    apply();
    // The bar changes height with a subtitle, the offline banner or an iPad's tab bar.
    const watch = floats ? new ResizeObserver(apply) : null;
    watch?.observe(slot);
    frame.addEventListener('load', apply);
    return () => {
      watch?.disconnect();
      frame.removeEventListener('load', apply);
    };
  }, [lifted, win.nonce, os]);
  return <iframe key={`${win.w}:${win.nonce}`} ref={ref} className="ph-frame" title={win.title} src={windowSrc(win)} allow="clipboard-read; clipboard-write" />;
}

// ---------- the frame's model ----------

/** The More menu (or a bar button's own menu) open over a screen. */
export interface MoreState<P extends MenuPlace> {
  more: (OpenMore & P) | null;
  setMore: React.Dispatch<React.SetStateAction<(OpenMore & P) | null>>;
}

export interface PhoneShell {
  /** Opens a screen's More menu from its bar's button. */
  openMore: (sc: Screen, button: HTMLElement) => void;
  /** Opens a bar button's menu of choices. */
  openActionMenu: (sc: Screen, action: PageNavAction, button: HTMLElement) => void;
  /** The This Device sheet is open (the More view's This Device row opens it). */
  device: boolean;
  setDevice: (open: boolean) => void;
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
  /** What's at the top of each window's page, under its bar. */
  edges: Map<string, TopEdge>;
}

export interface TopEdge extends TopEdgeReading {
  /** iPad split view: the same over the detail column (the rest is the list column's). */
  detail?: { color: string; scrolled: boolean };
}

const isTransparent = (c: string) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
/**
 * What's at `x` (the middle) of a page's top edge: the first background behind it, and whether a scroller there has
 * moved. A page that runs under the bar (iOS) is read at its very top, under the status bar; one that starts below
 * the bar (its #root padded by --looper-bar-h, phone.css) is read right under the bar.
 */
function readTopEdge(doc: Document, win: Window, x = win.innerWidth / 2): TopEdge | null {
  // A page lifted over the bar for a sheet of its own: the bar keeps the look it had under the sheet's backdrop.
  if (doc.documentElement.hasAttribute('data-lifted')) return null;
  const top = doc.elementFromPoint(x, 1);
  // Nothing hit (a hidden or inert page): keep the last reading.
  if (!top || top === doc.documentElement) return null;
  const under = top !== doc.body && top.id !== 'root';
  const bar = parseFloat(doc.documentElement.style.getPropertyValue('--looper-bar-h')) || 0;
  const hit = under ? top : doc.elementFromPoint(x, bar + 1);
  if (!hit || hit === doc.documentElement) return null;
  let color = '';
  let scrolled = (doc.scrollingElement?.scrollTop ?? 0) > 0;
  for (let el: Element | null = hit; el; el = el.parentElement) {
    const cs = win.getComputedStyle(el);
    if (!scrolled && el.scrollTop > 0 && /auto|scroll/.test(cs.overflowY)) scrolled = true;
    if (!color && !isTransparent(cs.backgroundColor)) color = cs.backgroundColor;
  }
  return { color: color || win.getComputedStyle(doc.documentElement).backgroundColor, scrolled, under };
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
            if (was && was.color === edge.color && was.scrolled === edge.scrolled && was.under === edge.under && JSON.stringify(was.detail) === JSON.stringify(edge.detail)) return old;
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
        // The bar's height and the lift come as the frame sets them on the page's root.
        mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'data-lifted'] });
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
  slideCard(card, offset, axis);
  slideCard(under, offset === null ? null : (offset - card.clientWidth) * 0.3, 'x');
}

/**
 * A back swipe shows what's under the screen it moves: the screens covered there, which aren't drawn otherwise. It
 * stops once `settling` (the card under, on its way back) ends its move, or after `offAfter` ms.
 */
let peekToken = 0;
function setPeek(root: HTMLElement | null, on: boolean, offAfter = 0, settling?: HTMLElement | null): void {
  if (!root) return;
  const token = ++peekToken;
  if (on) return void (root.dataset.peek = '');
  const off = () => token === peekToken && delete root.dataset.peek;
  settling?.addEventListener('transitionend', off, { once: true });
  setTimeout(off, offAfter);
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

/** Where a menu opened from a bar button goes: `anchor`, what it lines up with, and anything else the frame needs. */
export interface MenuPlace {
  anchor: DOMRect;
}

const placeAtButton = (button: HTMLElement): MenuPlace => ({ anchor: button.getBoundingClientRect() });

/** The frame's model; `place` sets where a bar button's menu goes (by default at the button). */
export function usePhoneShell<P extends MenuPlace = MenuPlace>(controller: ShellController, os: PhoneOs, place?: (button: HTMLElement) => P): PhoneShell & MoreState<P> {
  const [more, setMore] = useState<(OpenMore & P) | null>(null);
  const [device, setDevice] = useState(false);
  const placed = (button: HTMLElement) => (place ?? (placeAtButton as (b: HTMLElement) => P))(button);
  const openMore = (sc: Screen, button: HTMLElement) => setMore({ ...moreFor(sc), w: sc.win.w, ...placed(button) });
  const openActionMenu = (sc: Screen, action: PageNavAction, button: HTMLElement) => setMore({ ...actionMenu(action), w: sc.win.w, ...placed(button) });
  const localLayers: BackLayer[] = [];
  if (device) localLayers.push(() => setDevice(false));
  if (more) localLayers.push(() => setMore(null));

  const s = useShellState(controller.store);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const vp = useViewport(probeRef);
  const navs = usePageNavs();
  const { screens, top } = useScreens(s, os, vp, navs);
  // Only iOS's bar takes the page's color and floats over it; Android's top app bar has its own.
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
  for (const sc of live) if (sc.pres !== 'root') layers.push(() => closeScreen(controller, sc));
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
  // iOS: Safari's own back swipe (from the edge, or across the content where nothing else takes a sideways drag) has
  // already slid the page away over its picture of the screen under it: WebKit starts it whenever there's an entry
  // to go back to, before the page sees the touch (ViewGestureController::canSwipeInDirection). What it asked to
  // close goes at once, without the frame or the page playing the back again (data-instant-back, until the top
  // screen has changed: a window closes when the computer answers).
  const instant = useRef<{ top: string | undefined; roots: HTMLElement[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const endInstant = () => {
    const was = instant.current;
    if (!was) return;
    instant.current = null;
    clearTimeout(was.timer);
    for (const r of was.roots) delete r.dataset.instantBack;
  };
  // Android: a back Chrome animated itself (its back gesture's transition, PopStateEvent.hasUAVisualTransition) goes at
  // once too. Any other back from outside the page (the system's gesture or button) is marked data-system-back for its
  // page, whose screen closes with predictive back's commit rather than the in-app Back's (web/motion.ts).
  const browserBack = (close: () => void, e: PopStateEvent) => {
    const roots = [document.documentElement, ...screens.map((x) => controller.frameOf(x.win.w)?.contentDocument?.documentElement)].filter((r): r is HTMLElement => !!r);
    if (os === 'android' && !(e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition) {
      for (const r of roots) r.dataset.systemBack = '';
      close();
      // Read by the screen the back changes, which renders at once; nothing else reads it.
      setTimeout(() => roots.forEach((r) => delete r.dataset.systemBack), 1000);
      return;
    }
    endInstant();
    for (const r of roots) r.dataset.instantBack = '';
    instant.current = { top: topW, roots, timer: setTimeout(endInstant, 3000) };
    close();
  };
  useEffect(() => {
    if (instant.current && instant.current.top !== topW) {
      clearTimeout(instant.current.timer);
      instant.current.timer = setTimeout(endInstant, LEAVE_MS + 100);
    }
    // The top screen as it changes.
  }, [topW]);
  const { goBack: historyBack } = useBack(layers, browserBack);

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
      if (moves && dx === null && commit) {
        finishBackSwipe(rootRef.current, w, speed);
        setPeek(rootRef.current, false, LEAVE_MS + 1000);
      } else if (moves) {
        // Let go short of going back: the screen under it moves back on the default spring (ios.css) before it hides.
        const under = dx === null ? rootRef.current?.querySelector<HTMLElement>(`.ph-win[data-under="${CSS.escape(w)}"] > .ph-card`) : null;
        setPeek(rootRef.current, dx !== null, ARRIVE_MS * 3, under);
        setDrag(rootRef.current, w, 'x', dx);
      }
      if (dx === null && commit) historyBack();
    },
  };

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

  useOverlay(controller, !!more || device);
  // The More view's This Device row asks for the sheet (after usePageNavs has set up __looperFrame).
  useEffect(() => {
    if (window.__looperFrame) window.__looperFrame.openDevice = () => setDevice(true);
  }, []);
  // An editor's Cancel asks before it throws its changes away (WindowActions), in the frame's own message box.
  useEffect(() => {
    if (window.__looperFrame) window.__looperFrame.askDiscard = (w) => controller.session.ask(w, discardQuestion(os)).then((r) => r === 0);
  }, [controller, os]);

  return { more, setMore, openMore, openActionMenu, device, setDevice, s, os, vp, tablet: isTablet(vp), screens, top, rootRef, probeRef, hooks, goBack: historyBack, edges };
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
            className={`ph-win pres-${sc.pres}${sc.covered ? ' covered' : sc.visible ? '' : ' hidden'}${sc.leaving ? ' leaving' : ''}${sc.behind ? ' behind' : ''}${sc.isTop ? ' top' : ''}`}
            style={style}
            inert={!sc.isTop || sc.leaving || blockedByShell}
            aria-hidden={!sc.isTop || undefined}
          >
            {sheet && <Scrim className="ph-scrim" onTap={() => sc.pres !== 'full-dialog' && os === 'android' && closeScreen(controller, sc)} />}
            <div className={`ph-card${ownsBottom ? ' owns-bottom' : ''}`} role={sheet ? 'dialog' : undefined} aria-modal={sheet || undefined} aria-label={sc.nav?.title || sc.win.title}>
              <DragArea enabled={sheet && dragToDismiss(sc.pres) && !sc.nav?.modal} root={shell.rootRef} w={sc.win.w} onDismiss={() => closeScreen(controller, sc)}>
                {/* The page has a sheet of its own open: the bar is dimmed with its backdrop and out of reach. */}
                <div className={`ph-bar-slot${sc.nav?.modal ? ' page-modal' : ''}`} inert={!!sc.nav?.modal}>
                  {renderBar(sc)}
                </div>
              </DragArea>
              <div className="ph-body">
                <PhoneIframe controller={controller} win={sc.win} os={os} hooks={hooks} safeBottom={safeBottom} lifted={!!sc.nav?.modal} />
              </div>
            </div>
          </div>
        );
      })}
      {!s.connected && !s.everConnected && (
        <div className="ph-connection" role="status">
          Connecting…
        </div>
      )}
    </>
  );
}

/**
 * Closes a window as its Back, swipe or backdrop does. An editor with unsaved changes goes through its own Cancel,
 * which asks first: "If people have unsaved changes in the sheet when they begin swiping to dismiss it, use an action
 * sheet to let them confirm their action" (HIG Sheets); "a basic dialog should appear to confirm that they want to
 * discard the unsaved changes" (Material 3 Dialogs).
 */
function closeScreen(controller: ShellController, sc: Screen): void {
  if (sc.nav?.unsaved && sc.nav.cancel) sc.nav.cancel.run();
  else controller.close(sc.win.w);
}

/** A sheet's bar: drag it down to close the sheet. */
function DragArea({ enabled, root, w, onDismiss, children }: { enabled: boolean; root: React.RefObject<HTMLDivElement | null>; w: string; onDismiss: () => void; children: ReactNode }) {
  const drag = useDragToDismiss({
    skip: 'button, input, a',
    extent: (bar) => (bar.closest('.ph-card') as HTMLElement | null)?.clientHeight ?? 600,
    onMove: (offset) => setDrag(root.current, w, 'y', offset),
    onDismiss,
  });
  if (!enabled) return <>{children}</>;
  return (
    <div className="ph-drag" {...drag}>
      {children}
    </div>
  );
}

/**
 * A screen's bars, as both phone frames draw them: one bar, or on a tablet's split page one over each column
 * (the list's with the window's own Back, `listBack`; the detail's with the page's; the inspector's title).
 */
export function screenBars(
  sc: Screen,
  tablet: boolean,
  run: { goBack: () => void; listBack: () => void; close: () => void },
): { kind: 'single'; bar: BarModel } | { kind: 'split'; split: NonNullable<PageNav['split']>; list: BarModel; detail: BarModel; inspector: BarModel | null } {
  const nav = sc.nav;
  const back = nav?.back ? run.goBack : undefined;
  const split = tablet ? nav?.split : undefined;
  if (split) {
    return {
      kind: 'split',
      split,
      list: barModel({ title: split.title, actions: split.actions, dismiss: sc.pres === 'push' ? { kind: 'back', run: run.listBack } : null }),
      detail: barModel({ title: nav?.title ?? '', subtitle: nav?.subtitle, back, cancel: nav?.cancel, confirm: nav?.confirm, actions: nav?.actions, dismiss: null }),
      // What the column's own screens report (a pushed detail's Back and title) goes over its title.
      inspector: split.inspector
        ? barModel({ title: nav?.inspectorBar?.title ?? split.inspector.title, subtitle: nav?.inspectorBar?.subtitle, back: nav?.inspectorBar?.back, dismiss: null })
        : null,
    };
  }
  return {
    kind: 'single',
    bar: barModel({
      title: nav?.title ?? sc.win.title,
      subtitle: nav?.subtitle,
      back,
      cancel: nav?.cancel,
      confirm: nav?.confirm,
      actions: nav?.actions,
      dismiss: dismissFor(sc.pres, { back: run.goBack, close: run.close }),
    }),
  };
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
  if (os === 'ios') return tablet || appleDevice(navigator.userAgent, navigator.maxTouchPoints) === 'iPad' ? 'iPad' : 'iPhone';
  return tablet ? 'Tablet' : 'Phone';
}

/** A pull-down or popup menu's state: the submenu path the user opened. */
export function useSubmenus(items: MenuItemSpec[]): { level: MenuItemSpec[]; title: string | null; open: (it: MenuItemSpec) => void; up: () => void } {
  const [path, setPath] = useState<MenuItemSpec[]>([]);
  useEffect(() => setPath([]), [items]);
  const last = path[path.length - 1];
  return {
    level: last?.submenu ?? items,
    title: last ? noMnemonic(last.label ?? '') : null,
    open: (it) => setPath((p) => [...p, it]),
    up: () => setPath((p) => p.slice(0, -1)),
  };
}
