import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withMobileHead } from '../src/main/remote-access/pwa';
import { barLook, composite, paintTopEdge, parseColor, withOpacity } from '../src/renderer/src/web/top-bar';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** One rule's body from a stylesheet, by its exact selector. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(selector + ' {');
  return at < 0 ? null : css.slice(at, css.indexOf('}', at));
};

describe("iOS's bar over its page (WWDC25 284, HIG Toolbars)", () => {
  const grouped = 'rgb(242, 242, 247)';

  it('is transparent over a page that runs under it, with no edge and the large title showing until the page scrolls', () => {
    expect(barLook({ color: grouped, scrolled: false, under: true }, true)).toEqual({ background: undefined, edge: false, under: true, onDark: false, titleFaded: true });
  });

  it('shows the standard title and the scroll edge effect as soon as the page begins to scroll, still with no fill of its own', () => {
    const look = barLook({ color: 'rgb(255, 255, 255)', scrolled: true, under: true }, true);
    expect(look).toMatchObject({ background: undefined, edge: true, under: true, titleFaded: false });
  });

  it('takes the color of a page that starts below it, so the two read as one', () => {
    expect(barLook({ color: grouped, scrolled: false, under: false }, false)).toMatchObject({ background: grouped, under: false, titleFaded: false });
    expect(barLook({ color: grouped, scrolled: true, under: false }, false)).toMatchObject({ background: undefined, edge: true });
  });

  it('has a light title over a dark page top, and shows the title at once on a screen without a large title', () => {
    expect(barLook({ color: 'rgb(0, 0, 0)', scrolled: false, under: true }, false)).toMatchObject({ onDark: true, titleFaded: false });
    expect(barLook(undefined, true).titleFaded).toBe(true);
  });
});

describe('the color at the top of the screen', () => {
  it('reads computed and written colors', () => {
    expect(parseColor('rgb(242, 242, 247)')).toEqual([242, 242, 247, 1]);
    expect(parseColor('rgba(0, 0, 0, 0.2)')).toEqual([0, 0, 0, 0.2]);
    expect(parseColor('rgb(0 0 0 / 55%)')).toEqual([0, 0, 0, 0.55]);
    expect(parseColor(' #f2f2f7')).toEqual([242, 242, 247, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseColor('var(--ios-bar)')).toBeNull();
  });

  it("dims the screen's color under a sheet's scrim (black at 20%, ios.md: Sheets) and an alert's", () => {
    expect(composite(['rgb(242, 242, 247)', 'rgba(0, 0, 0, 0.2)'], '#fff')).toBe('rgb(194, 194, 198)');
    expect(composite(['rgb(255, 255, 255)', 'rgba(41, 41, 58, 0.23)'], '#fff')).toBe('rgb(206, 206, 210)');
  });

  it("is the hard scroll edge effect over what scrolled under the bar, in both themes (ios.md: Scroll edge effects)", () => {
    expect(composite(['rgb(0, 136, 255)', 'rgba(255, 255, 255, 0.85)'], '#fff')).toBe('rgb(217, 237, 255)');
    expect(composite(['rgb(28, 28, 40)', 'rgba(0, 0, 0, 0.55)'], '#000')).toBe('rgb(13, 13, 18)');
  });

  it('skips transparent and unreadable layers, and counts a fading layer by its opacity', () => {
    expect(composite(['transparent', 'none', 'rgb(10, 20, 30)'], '#fff')).toBe('rgb(10, 20, 30)');
    expect(withOpacity('rgba(0, 0, 0, 0.2)', '0.5')).toBe('rgba(0, 0, 0, 0.1)');
    expect(withOpacity('rgb(1, 2, 3)', '1')).toBe('rgb(1, 2, 3)');
  });
});

/** As much of a document as paintTopEdge touches: the strip and the theme-color tags. */
function fakeDocument() {
  const replaced: unknown[] = [];
  const strip = (color: string) => {
    const el = {
      style: { backgroundColor: color },
      dataset: {} as Record<string, string | undefined>,
      cloneNode: () => strip(''),
      replaceWith: (next: unknown) => {
        replaced.push(next);
        doc.strip = next as typeof el;
      },
    };
    return el;
  };
  const metas = [
    { content: '#f8f9ff', media: '(prefers-color-scheme: light)' as string | undefined, removeAttribute(this: { media?: string }) { this.media = undefined; } },
    { content: '#111418', media: '(prefers-color-scheme: dark)' as string | undefined, removeAttribute(this: { media?: string }) { this.media = undefined; } },
  ];
  const doc = {
    strip: strip('#f2f2f7'),
    metas,
    replaced,
    querySelector: (s: string) => (s === '.ios-top-edge' ? doc.strip : null),
    querySelectorAll: (s: string) => (s === 'meta[name="theme-color"]' ? metas : []),
  };
  return doc;
}

describe("Safari's color behind the status bar", () => {
  it('is a new fixed strip for each color, as WebKit samples the top only when a fixed element comes or goes', () => {
    const doc = fakeDocument();
    const first = doc.strip;
    expect(paintTopEdge(doc, 'rgb(194, 194, 198)')).toBe(true);
    expect(doc.replaced).toHaveLength(1);
    expect(doc.strip).not.toBe(first);
    expect(doc.strip.style.backgroundColor).toBe('rgb(194, 194, 198)');
    // The same color again leaves the strip and the tags as they are.
    expect(paintTopEdge(doc, 'rgb(194, 194, 198)')).toBe(false);
    expect(doc.replaced).toHaveLength(1);
  });

  it("sets theme-color to the screen's own color for both schemes", () => {
    const doc = fakeDocument();
    paintTopEdge(doc, 'rgb(0, 0, 0)');
    expect(doc.metas.map((m) => [m.content, m.media])).toEqual([
      ['rgb(0, 0, 0)', undefined],
      ['rgb(0, 0, 0)', undefined],
    ]);
  });

  it("the served page's strip has no transition: WebKit would keep the color it read halfway", () => {
    const out = withMobileHead('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
    const style = /\.ios-top-edge\{position:fixed[^}]*\}/.exec(out)?.[0] ?? '';
    expect(style).toMatch(/background-color:#f2f2f7/);
    expect(style).not.toMatch(/transition/);
  });
});

describe("the frame's bar floats over the page (ios.css, phone.css)", () => {
  const ios = read('src/renderer/src/web/ios.css');
  const page = read('src/renderer/src/phone.css');

  it('puts the bar over the page instead of above it, so the page runs to the screen top', () => {
    expect(rule(ios, '.ios .ph-bar-slot')).toMatch(/position: absolute;[\s\S]*top: 0;/);
  });

  it("draws the kit's hard scroll edge effect (white at 85% with a 6 pt blur; black at 55% in dark) behind the buttons once the page scrolls", () => {
    expect(ios).toMatch(/--ios-edge-hard: rgba\(255, 255, 255, 0\.85\);/);
    expect(ios).toMatch(/--ios-edge-hard: rgba\(0, 0, 0, 0\.55\);/);
    const effect = ios.slice(ios.indexOf('.ios-bar.under.edge::before'));
    expect(effect.slice(0, effect.indexOf('}'))).toMatch(/background: var\(--ios-edge-hard\);[\s\S]*backdrop-filter: blur\(6px\);/);
    expect(ios).toMatch(/\.ios-bar\.under:is\(\.edge, :has\(\.edge\)\) :is\([^)]*\.ios-icon-btn[^)]*\) \{\s*-webkit-backdrop-filter: none;/);
  });

  it("starts a page's content below the bar and lets its scrollers carry it under the bar", () => {
    expect(page).toMatch(/html\.phone-window\[data-under-bar\]:not\(\[data-lifted\]\) #root \{\s*padding-top: var\(--looper-bar-h, 0px\);/);
    // Every page's content starts below the bar; only a screen's or column's first list and a conversation go under it.
    expect(page).toMatch(/#root > :is\(\.phone-page, \.editor-window\) \{\s*margin-top: calc\(-1 \* var\(--looper-bar-h, 0px\)\);\s*height: calc\(100% \+ var\(--looper-bar-h, 0px\)\);\s*padding-top: var\(--looper-bar-h, 0px\);/);
    expect(page).toMatch(/\.phone-main > \.phone-screen > :is\(\.pg-scroll:first-child, \.pg-search \+ \.pg-scroll\)::before,[^{]*\{\s*content: '';\s*display: block;\s*flex: none;\s*height: var\(--looper-bar-h, 0px\);/);
    expect(page).toMatch(/\.chat-app:first-child > \.builder-chat > \.chat-scroll::before \{\s*content: '';[^}]*height: var\(--looper-bar-h, 0px\);/);
  });
});
