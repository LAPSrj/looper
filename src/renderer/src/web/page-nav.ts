import { useEffect, useRef } from 'react';
import { uiPlatformOf } from '../../../shared/ui-platform';
import { findToolbarItem, toolbarKey, type ToolbarGroup } from '../components/toolbar-model';
import { platform } from '../platform';
import { findMoreAction, type MoreGroup } from './more-menu';
import type { NavCommand, PageNavAction } from './nav-bar-model';

/**
 * What a page tells the phone frame (iOS/Android) about the screen it shows;
 * the frame draws its navigation bar and its More menu from it. Electron and
 * the desktop browser ignore it.
 */
export interface PageNav {
  /** The bar's title; unset = the window's title. */
  title?: string;
  /**
   * The page shows a deeper screen of its own (a task under the task list):
   * Back, the back gesture and Android's back button call this instead of
   * closing the window.
   */
  back?: () => void;
  /**
   * Buttons at the bar's end (iOS) or the top app bar's actions (Android). An
   * action with the id of a toolbar item stands for it: the More menu leaves
   * that item out.
   */
  actions?: PageNavAction[];
  /**
   * The page draws its own bottom bar (tabs): the frame leaves the bottom safe
   * area to it. env(safe-area-inset-*) is 0 inside an iframe, so the frame sets
   * `--looper-safe-bottom` (px; 0 while the keyboard is up) on the page's <html>.
   */
  ownsBottom?: boolean;
  /**
   * The page's own large title shows (iOS); the bar shows the title only once
   * it scrolls away. The frame watches the element marked `data-large-title`;
   * without one, the bar shows the title.
   */
  largeTitle?: boolean;
  /** The screen's toolbar, which the phone doesn't draw: the default More menu starts with it. */
  toolbar?: ToolbarGroup[];
  /** A designed More menu in place of the default one: only what applies to the screen (more-menu.ts). */
  more?: MoreGroup[];
  /** An editor's Cancel: the bar's leading button (an xmark on iOS), in place of Back or Close. */
  cancel?: NavCommand;
  /** An editor's Save or Create: the bar's trailing button. */
  confirm?: NavCommand;
  /** The page shows a sheet of its own over the screen: the frame's bar can't be used meanwhile. */
  modal?: boolean;
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
  /** The list has a large title of its own (data-large-title): its bar title shows once that scrolls away. */
  largeTitle?: boolean;
  /** An inspector column at the trailing edge, and its title: the bar gives it a part of its own. */
  inspector?: { width: number; title: string };
}

export interface PageNavTabs {
  items: readonly (readonly [string, string])[];
  value: string;
  select: (id: string) => void;
}

/** What the top frame offers its iframes, as `window.top.__looperFrame`. */
export interface PageNavHost {
  setNav(windowId: string, nav: PageNav | null): void;
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

// ---------- the parts a page's components report ----------

/** One component's report; `latest` holds its current callbacks. */
interface Part {
  order: number;
  seq: number;
  latest: { current: PageNav | null };
}

const parts = new Map<number, Part>();
let nextSeq = 0;

/** The parts' reports as one: later orders override fields, toolbars add up. Callbacks run the part's current ones. */
export function mergeNavs(list: { order: number; seq: number; nav: PageNav | null; latest: { current: PageNav | null } }[]): PageNav | null {
  const sorted = [...list].filter((p) => p.nav).sort((a, b) => a.order - b.order || a.seq - b.seq);
  if (!sorted.length) return null;
  const out: PageNav = {};
  for (const { nav, latest } of sorted) {
    const n = nav!;
    if (n.title !== undefined) out.title = n.title;
    if (n.back) out.back = () => latest.current?.back?.();
    if (n.actions) out.actions = n.actions.map((a) => ({ ...a, run: () => latest.current?.actions?.find((x) => x.id === a.id)?.run() }));
    if (n.split) {
      out.split = {
        ...n.split,
        actions: n.split.actions?.map((a) => ({ ...a, run: () => latest.current?.split?.actions?.find((x) => x.id === a.id)?.run() })),
      };
    }
    if (n.tabs) out.tabs = { ...n.tabs, select: (id) => latest.current?.tabs?.select(id) };
    if (n.ownsBottom !== undefined) out.ownsBottom = n.ownsBottom;
    if (n.largeTitle !== undefined) out.largeTitle = n.largeTitle;
    if (n.modal !== undefined) out.modal = n.modal;
    if (n.cancel) out.cancel = { ...n.cancel, run: () => latest.current?.cancel?.run() };
    if (n.confirm) out.confirm = { ...n.confirm, run: () => latest.current?.confirm?.run() };
    if (n.toolbar) out.toolbar = [...(out.toolbar ?? []), ...wrapToolbar(n.toolbar, () => latest.current?.toolbar)];
    if (n.more) {
      out.more = n.more.map((g) =>
        g.map((r) => ('action' in r ? { action: { ...r.action, run: () => findMoreAction(latest.current?.more, r.action.id)?.run() } } : r)),
      );
    }
  }
  return out;
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

function publish(): void {
  const w = windowId();
  const host = window.top?.__looperFrame;
  if (!w || !host) return;
  host.setNav(w, mergeNavs([...parts.values()].map((p) => ({ ...p, nav: p.latest.current }))));
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
 * lower one's fields and adding its toolbar after the lower one's.
 */
export function usePageNav(nav: PageNav | null, order = 0): void {
  const part = useRef<Part | null>(null);
  if (!part.current) part.current = { order, seq: nextSeq++, latest: { current: nav } };
  part.current.latest.current = nav;
  const key = navKey(nav);
  useEffect(() => {
    if (!phone) return;
    const p = part.current!;
    parts.set(p.seq, p);
    return () => {
      parts.delete(p.seq);
      publish();
    };
  }, []);
  useEffect(() => {
    if (phone) publish();
  }, [key]);
}

export const isPhone = phone;
