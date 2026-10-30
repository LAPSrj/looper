import { useEffect, useRef } from 'react';
import { platform } from '../platform';

/**
 * What a page tells the phone frame (iOS/Android) about the screen it shows;
 * the frame draws its navigation bar from it. Electron and the desktop
 * browser ignore it.
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
  /** Buttons at the bar's end (iOS) or the top app bar's actions (Android). */
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
}

export interface PageNavAction {
  id: string;
  label: string;
  /** An ICONS key (components/icons.tsx); the label is its accessible name. */
  icon?: string;
  disabled?: boolean;
  run: () => void;
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

function windowId(): string | null {
  return new URLSearchParams(window.location.search).get('w');
}

/** Tell the phone frame what this page's screen is; cleared when the page unmounts it. */
export function usePageNav(nav: PageNav | null): void {
  const latest = useRef(nav);
  latest.current = nav;
  const key = nav ? JSON.stringify([nav.title, !!nav.back, nav.ownsBottom, nav.largeTitle, nav.actions?.map((a) => [a.id, a.label, a.icon, a.disabled])]) : '';
  useEffect(() => {
    if (!phone) return;
    const w = windowId();
    const host = window.top?.__looperFrame;
    if (!w || !host) return;
    const current = latest.current;
    // Callbacks go through `latest`, so a re-render with new closures doesn't need a new nav.
    host.setNav(
      w,
      current && {
        ...current,
        back: current.back && (() => latest.current?.back?.()),
        actions: current.actions?.map((a) => ({ ...a, run: () => latest.current?.actions?.find((x) => x.id === a.id)?.run() })),
      },
    );
    return () => host.setNav(w, null);
  }, [key]);
}

export const isPhone = phone;
