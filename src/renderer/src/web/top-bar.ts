// No DOM types: the unit tests (node tsconfig) load this file.
import { darkColor } from './nav-stack';

/** What's at the top of a window's page, under its iOS bar (phone-shell.tsx reads it). */
export interface TopEdgeReading {
  /** The page's color there: under the status bar when the page runs under the bar, else right under the bar. */
  color: string;
  /** The page's content there has scrolled up, under the bar. */
  scrolled: boolean;
  /** The page draws under the bar (its scroller starts at the screen's top); else it starts below it. */
  under: boolean;
}

export interface BarLook {
  /** The bar's own fill: only over a page that starts below it, the page's color, so the two read as one. */
  background?: string;
  /** The hard scroll edge effect: the page has scrolled under the bar. */
  edge: boolean;
  /** The bar is transparent over the page, which runs under it. */
  under: boolean;
  /** Over a dark page top (a terminal), the title is light. */
  onDark: boolean;
  /** The title waits: the page's large title shows and nothing has scrolled yet. */
  titleFaded: boolean;
}

/**
 * The iOS 26 bar over its page: "the bar background is now transparent by default", the content runs under it with
 * "a visual treatment" once it scrolls there (WWDC25 284), and "a large title transitions to a standard title as people
 * begin scrolling the content, and transitions back to large when people scroll to the top" (HIG Toolbars).
 */
export function barLook(edge: TopEdgeReading | undefined, largeTitle: boolean): BarLook {
  const scrolled = !!edge?.scrolled;
  return {
    background: edge && !edge.scrolled && !edge.under ? edge.color : undefined,
    edge: scrolled,
    under: !!edge?.under,
    onDark: !!edge && !edge.scrolled && darkColor(edge.color),
    titleFaded: largeTitle && !scrolled,
  };
}

export type Rgba = [number, number, number, number];

/** A computed or written CSS color (rgb(), rgba(), #rgb, #rrggbb, #rrggbbaa, transparent); null for anything else. */
export function parseColor(c: string | null | undefined): Rgba | null {
  const s = (c ?? '').trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex && [3, 6, 8].includes(hex.length)) {
    const full = hex.length === 3 ? [...hex].map((h) => h + h).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/.exec(s);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, a))];
}

/** `color` with its alpha multiplied by an element's `opacity` (a scrim fading in). */
export function withOpacity(color: string, opacity: string | number): string {
  const c = parseColor(color);
  const o = Number(opacity);
  if (!c || !Number.isFinite(o) || o >= 1) return color;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] * Math.max(0, o)})`;
}

/** Layers painted bottom first over `base`, as one opaque `rgb()`: what the screen shows where they all are. */
export function composite(layers: readonly (string | null | undefined)[], base: string): string {
  const start = parseColor(base) ?? [255, 255, 255, 1];
  let [r, g, b] = start;
  for (const layer of layers) {
    const c = parseColor(layer);
    if (!c || c[3] <= 0) continue;
    const a = c[3];
    r = c[0] * a + r * (1 - a);
    g = c[1] * a + g * (1 - a);
    b = c[2] * a + b * (1 - a);
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/** The fixed strip at the top of the served page (pwa.ts), as much of an element as paintTopEdge needs. */
export interface TopEdgeStrip {
  style: { backgroundColor: string };
  dataset: Record<string, string | undefined>;
  cloneNode(deep: boolean): unknown;
  replaceWith(node: unknown): void;
}

export interface TopEdgeDocument {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): Iterable<unknown>;
}

/**
 * Gives Safari the color at the top of the screen. WebKit fills the area behind the status bar with the color of the
 * fixed element at the top of the page, and blurs it when there's none (WKWebView _updateFixedColorExtensionViews,
 * _shouldHideTopScrollPocket). It samples that element only when the page loads, when a fixed element comes or goes
 * (WebPage::didAddOrRemoveViewportConstrainedObjects) or when the insets change, never because a color changed; so a
 * new color is a new strip, put in place of the old one. theme-color follows too, for whatever still reads it.
 * Returns whether anything changed.
 */
export function paintTopEdge(doc: TopEdgeDocument, color: string): boolean {
  const strip = doc.querySelector('.ios-top-edge') as TopEdgeStrip | null;
  let changed = false;
  if (strip && strip.dataset.color !== color) {
    const next = strip.cloneNode(false) as TopEdgeStrip;
    next.style.backgroundColor = color;
    next.dataset.color = color;
    strip.replaceWith(next);
    changed = true;
  }
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]') as Iterable<{ content: string; removeAttribute(name: string): void }>) {
    if (meta.content === color) continue;
    // A media query would hand the other scheme's color back; the screen's own color holds for both.
    meta.removeAttribute('media');
    meta.content = color;
    changed = true;
  }
  return changed;
}
