import { useEffect, useRef } from 'react';
import { uiPlatformOf } from '../../../shared/ui-platform';
import { findToolbarItem, toolbarKey, type ToolbarGroup } from '../components/toolbar-model';
import { platform } from '../platform';
import type { MoreMenuInput } from './more-menu';
import type { NavCommand, PageNavAction, PageNavMenuEntry } from './nav-bar-model';

/**
 * What a page tells the phone frame (iOS/Android) about the screen it shows;
 * the frame draws its navigation bar and its More menu from it. Electron and
 * the desktop browser ignore it.
 */
export interface PageNav {
  /** The bar's title; unset = the window's title. */
  title?: string;
  /**
   * A short status line under the title ("2 subagents running"), as iOS 26's navigation bar subtitle; or its
   * forms longest first, and the bar shows the first that fits on its line.
   */
  subtitle?: string | readonly string[];
  /**
   * The page shows a deeper screen of its own (a task under the task list):
   * Back, the back gesture and Android's back button call this instead of
   * closing the window.
   */
  back?: () => void;
  /** Buttons at the bar's end (iOS) or the top app bar's actions (Android). */
  actions?: PageNavAction[];
  /**
   * The page draws its own bottom bar (tabs): the frame leaves the bottom safe
   * area to it. env(safe-area-inset-*) is 0 inside an iframe, so the frame sets
   * `--looper-safe-bottom` (px; 0 while the keyboard is up) on the page's <html>.
   */
  ownsBottom?: boolean;
  /**
   * The page's own large title shows at the top of its scroller (iOS, LargeTitle): the bar shows the title only once
   * the page begins to scroll, and hides it again back at the top (HIG Toolbars).
   */
  largeTitle?: boolean;
  /** A toolbar the phone doesn't draw (an addon's buttons, a terminal's text size): More starts with it. */
  toolbar?: ToolbarGroup[];
  /** The screen's More menu, from the command list: its items as data, and what picking one does. */
  more?: MoreMenuInput;
  /** An editor's Cancel: the bar's leading button (an xmark on iOS), in place of Back or Close. */
  cancel?: NavCommand;
  /** An editor's Save or Create: the bar's trailing button. */
  confirm?: NavCommand;
  /**
   * An editor has changes it hasn't saved: the frame's swipe down, Back and scrim close it through `cancel`, which asks
   * before discarding them (HIG Sheets; Material 3 Dialogs).
   */
  unsaved?: boolean;
  /**
   * The page shows a sheet of its own over the screen (PhoneSheet): the frame lifts the page over its bar, so the
   * sheet can reach the status bar and its backdrop dims the bar, which can't be used meanwhile.
   */
  modal?: boolean;
  /** iPad: what the inspector column's own screens put in its bar (a pushed detail's Back and title), over `split.inspector`'s title. */
  inspectorBar?: PanelBarNav;
  /**
   * iPad: the page shows a list column (`width` px) beside its screen. The bar
   * splits to match: this part over the list, the rest of the nav (title, back,
   * actions, More) over the detail column.
   */
  split?: PageNavSplit;
  /** iPad: the main window's tabs, which the frame draws as the tab bar near the top. */
  tabs?: PageNavTabs;
}

export interface PageNavSplit {
  width: number;
  title: string;
  actions?: PageNavAction[];
  /** The list has a large title of its own (LargeTitle): its bar title shows once the list begins to scroll. */
  largeTitle?: boolean;
  /** An inspector column at the trailing edge, and its title: the bar gives it a part of its own. */
  inspector?: { width: number; title: string };
}

/** The part of a bar a panel's screens fill: its title, the line under it, and Back from a pushed detail. */
export interface PanelBarNav {
  title?: string;
  subtitle?: string | readonly string[];
  back?: () => void;
}

export interface PageNavTabs {
  /** Each tab's id and its label. */
  items: readonly (readonly [string, string])[];
  value: string;
  select: (id: string) => void;
}

/** What the top frame offers its iframes, as `window.top.__looperFrame`. */
export interface PageNavHost {
  setNav(windowId: string, nav: PageNav | null): void;
  /** This Device's sheet, which the frame draws. */
  openDevice?(): void;
  /** Asks whether to discard a window's unsaved changes (the frame's own message box); true to discard. */
  askDiscard?(windowId: string): Promise<boolean>;
}

declare global {
  interface Window {
    __looperFrame?: PageNavHost;
  }
}

const phone = platform === 'ios' || platform === 'android';

/** Which toolbar and menu items this page shows (shared/ui-platform). */
export const uiHere = uiPlatformOf(platform);

function windowId(): string | null {
  return new URLSearchParams(window.location.search).get('w');
}

/** Asks the phone frame whether to discard this window's unsaved changes: true to discard, and true where no frame asks. */
export function askDiscard(): Promise<boolean> {
  const w = windowId();
  const host = window.top?.__looperFrame;
  return w && host?.askDiscard ? host.askDiscard(w) : Promise.resolve(true);
}

// ---------- the parts a page's components report ----------

/** One component's report; `latest` holds its current callbacks. */
export interface Part {
  order: number;
  seq: number;
  latest: { current: PageNav | null };
}

const parts = new Map<number, Part>();
let nextSeq = 0;

/** Where a NavBar's part goes: the phone frame, or a panel of the page that draws its own bar (PhoneSheet, the iPad's inspector column). */
export interface NavTarget {
  parts: Map<number, Part>;
  publish(): void;
}

/** The parts' reports as one: later orders override fields, toolbars add up. Callbacks run the part's current ones. */
export function mergeNavs(list: { order: number; seq: number; nav: PageNav | null; latest: { current: PageNav | null } }[]): PageNav | null {
  const sorted = [...list].filter((p) => p.nav).sort((a, b) => a.order - b.order || a.seq - b.seq);
  if (!sorted.length) return null;
  const out: PageNav = {};
  for (const { nav, latest } of sorted) {
    const n = nav!;
    if (n.title !== undefined) out.title = n.title;
    if (n.subtitle !== undefined) out.subtitle = n.subtitle;
    if (n.back) out.back = () => latest.current?.back?.();
    if (n.actions) out.actions = n.actions.map((a) => wrapAction(a, () => latest.current?.actions));
    if (n.split) {
      out.split = {
        ...n.split,
        actions: n.split.actions?.map((a) => wrapAction(a, () => latest.current?.split?.actions)),
      };
    }
    if (n.tabs) out.tabs = { ...n.tabs, select: (id) => latest.current?.tabs?.select(id) };
    if (n.ownsBottom !== undefined) out.ownsBottom = n.ownsBottom;
    if (n.largeTitle !== undefined) out.largeTitle = n.largeTitle;
    if (n.modal !== undefined) out.modal = n.modal;
    if (n.inspectorBar) out.inspectorBar = { ...n.inspectorBar, back: n.inspectorBar.back && (() => latest.current?.inspectorBar?.back?.()) };
    if (n.cancel) out.cancel = { ...n.cancel, run: () => latest.current?.cancel?.run() };
    if (n.confirm) out.confirm = { ...n.confirm, run: () => latest.current?.confirm?.run() };
    if (n.unsaved) out.unsaved = true;
    if (n.toolbar) out.toolbar = [...(out.toolbar ?? []), ...wrapToolbar(n.toolbar, () => latest.current?.toolbar)];
    if (n.more) out.more = { items: n.more.items, toolbar: n.more.toolbar, run: (id) => latest.current?.more?.run(id) };
  }
  return out;
}

/** A bar button whose callbacks, and its menu's, look up the part's current ones by id. */
function wrapAction(a: PageNavAction, current: () => PageNavAction[] | undefined): PageNavAction {
  const now = () => current()?.find((x) => x.id === a.id);
  const wrap = (e: PageNavMenuEntry): PageNavMenuEntry => ({ ...e, run: () => findMenuEntry(now()?.menu, e.id)?.run(), ...(e.submenu ? { submenu: e.submenu.map(wrap) } : {}) });
  return { ...a, run: () => now()?.run(), menu: a.menu?.map(wrap) };
}

function findMenuEntry(entries: PageNavMenuEntry[] | undefined, id: string): PageNavMenuEntry | undefined {
  for (const e of entries ?? []) {
    const found = e.id === id && !e.separator ? e : findMenuEntry(e.submenu, id);
    if (found) return found;
  }
  return undefined;
}

/** A toolbar whose callbacks look up the part's current ones by id. */
function wrapToolbar(groups: ToolbarGroup[], current: () => ToolbarGroup[] | undefined): ToolbarGroup[] {
  return groups.map((g) => ({
    ...g,
    items: g.items.map((it) => {
      const now = () => findToolbarItem(current(), it.id);
      return {
        ...it,
        run: it.run ? () => now()?.run?.() : it.run,
        menu: it.menu && {
          ...it.menu,
          open: it.menu.open && ((x: number, y: number) => (now() as { menu?: { open?: (x: number, y: number) => void } } | undefined)?.menu?.open?.(x, y)),
          items: it.menu.items?.map((e) => ({ ...e, run: () => findToolbarItem(current(), `${it.id}/${e.id}`)?.run?.() })),
        },
      };
    }),
  }));
}

const merged = (from: Map<number, Part>) => mergeNavs([...from.values()].map((p) => ({ ...p, nav: p.latest.current })));

function publish(): void {
  const w = windowId();
  const host = window.top?.__looperFrame;
  if (!w || !host) return;
  host.setNav(w, merged(parts));
}

const frameTarget: NavTarget = { parts, publish };

/** A panel's target: the reports of the NavBars inside it, merged as the frame merges a page's, go to `onNav`. */
export function panelNavTarget(onNav: (nav: PageNav | null) => void): NavTarget {
  const own = new Map<number, Part>();
  return { parts: own, publish: () => onNav(merged(own)) };
}

/** A nav's JSON key: what it shows, without its callbacks. */
function navKey(nav: PageNav | null): string {
  if (!nav) return '';
  const { toolbar, ...rest } = nav;
  return JSON.stringify(rest, (_k, v) => (typeof v === 'function' ? true : v)) + toolbarKey(toolbar);
}

/**
 * Tell the phone frame what this page's screen is; cleared when the component
 * unmounts. Several components of a page may report (the page, its toolbar,
 * an editor's footer): their reports merge, a higher `order` overriding a
 * lower one's fields and adding its toolbar after the lower one's. Inside a
 * panel with a bar of its own, `target` is that panel's (panelNavTarget).
 */
export function usePageNav(nav: PageNav | null, order = 0, target: NavTarget = frameTarget): void {
  const part = useRef<Part | null>(null);
  if (!part.current) part.current = { order, seq: nextSeq++, latest: { current: nav } };
  part.current.latest.current = nav;
  const key = navKey(nav);
  useEffect(() => {
    if (!phone) return;
    const p = part.current!;
    target.parts.set(p.seq, p);
    return () => {
      target.parts.delete(p.seq);
      target.publish();
    };
  }, [target]);
  useEffect(() => {
    if (phone) target.publish();
  }, [key, target]);
}

export const isPhone = phone;

// A page that replaces another in the same window (New Task with Agent's setup, then its builder) starts without the old page's bar.
if (phone) publish();
