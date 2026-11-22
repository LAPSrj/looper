import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bottomBarGroups, type ToolbarGroup } from '../src/renderer/src/components/toolbar-model';

const ids = (groups: { id: string }[][]) => groups.map((g) => g.map((it) => it.id));

// Now's toolbar as ActivityPanel gives it: the desktop's two groups, and where a phone puts them.
const now: ToolbarGroup[] = [
  {
    id: 'calls',
    items: [
      { id: 'previous', label: 'Previous Tool Call', icon: 'previous' },
      { id: 'next', label: 'Next Tool Call', icon: 'next' },
      { id: 'latest', label: 'Follow the Latest Tool Call', icon: 'latest', pressed: true },
    ],
  },
  { id: 'view', items: [{ id: 'list', label: 'Tool Call List', icon: 'list' }] },
];
const nowPlaces = { leading: [['previous', 'next']], trailing: [['list', 'source'], ['latest']] };

describe("a phone's bottom toolbar", () => {
  it("puts Now's Previous and Next in one group at the leading end, and the list and Latest each in its own at the trailing end", () => {
    const { leading, trailing } = bottomBarGroups(now, nowPlaces, 'mobile');
    expect(ids(leading)).toEqual([['previous', 'next']]);
    expect(ids(trailing)).toEqual([['list'], ['latest']]);
  });

  it('shares a group with the Markdown source when it shows, and skips an id that shows nothing', () => {
    const withSource = [now[0], { id: 'view', items: [...now[1].items, { id: 'source', label: 'Markdown Source', icon: 'source' }] }];
    expect(ids(bottomBarGroups(withSource, nowPlaces, 'mobile').trailing)).toEqual([['list', 'source'], ['latest']]);
  });

  it('keeps a text item apart from symbols, as HIG Toolbars and WWDC25 356 ask', () => {
    const groups: ToolbarGroup[] = [{ id: 'g', items: [{ id: 'select', label: 'Select' }, { id: 'share', label: 'Share', icon: 'share' }, { id: 'copy', label: 'Copy', icon: 'copy' }, { id: 'done', label: 'Done' }] }];
    expect(ids(bottomBarGroups(groups, { leading: [], trailing: [['select', 'share', 'copy', 'done']] }, 'mobile').trailing)).toEqual([['select'], ['share', 'copy'], ['done']]);
  });

  it('leaves out no item the desktop shows: one the places miss goes after the trailing groups', () => {
    const { trailing } = bottomBarGroups(now, { leading: [['previous', 'next']], trailing: [['list']] }, 'mobile');
    expect(ids(trailing)).toEqual([['list'], ['latest']]);
  });

  it("leaves out what doesn't show on the platform", () => {
    const marked: ToolbarGroup[] = [{ id: 'g', items: [{ id: 'a', label: 'A', icon: 'a' }, { id: 'b', label: 'B', icon: 'b', platforms: ['desktop'] }] }];
    expect(ids(bottomBarGroups(marked, { leading: [['a', 'b']], trailing: [] }, 'mobile').leading)).toEqual([['a']]);
  });
});

const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const sources = walk(renderer)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => [path.relative(renderer, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')] as const);

describe("a phone's bottom toolbar's glass", () => {
  // The scroll edge under the toolbar blurs with a backdrop-filter; a glass button blurring again over it held the
  // iPad's frames for seconds (WebKit, in the Activity sheet), and "glass cannot sample other glass" (WWDC25 323).
  it("doesn't blur again over the scroll edge's blur", () => {
    const css = fs.readFileSync(path.join(renderer, 'phone.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const edgeBlurs = rules.some((r) => /\.bottom-toolbar-host[^,{]*::after/.test(r.sel) && /(^|;|\s)backdrop-filter:\s*(?!none)/.test(r.body));
    expect(edgeBlurs).toBe(true);
    const unblurred = rules.find((r) => /\.bottom-toolbar :is\([^)]*\.ios-icon-btn[^)]*\.ios-bar-group[^)]*\)/.test(r.sel) && /(^|;|\s)backdrop-filter:\s*none/.test(r.body));
    expect(unblurred?.sel).toBeTruthy();
  });
});

describe("a content's toolbar", () => {
  it('draws a bottom toolbar only through BottomToolbar', () => {
    for (const [file, text] of sources) {
      if (file !== 'components/BottomToolbar.tsx') expect(text, file).not.toMatch(/className=["{`](?:[^"}`]*\s)?bottom-toolbar(?:-[a-z]+)?(?=[\s"}`])/);
    }
  });

  // A Toolbar with `inline` draws a strip of buttons inside a phone's content. A screen's commands for what it shows go in
  // BottomToolbar; these strips stay, each for the reason given (components.md, BottomToolbar).
  const INLINE: Record<string, { count: number; why: string }> = {
    'components/BottomToolbar.tsx': { count: 1, why: "the desktop's pane toolbar; a phone draws the bottom toolbar instead" },
    'components/Composer.tsx': { count: 1, why: "the message box's own row of pickers, above the keyboard" },
    'SessionsApp.tsx': { count: 1, why: "a chat card's buttons on the Overview, one strip per card" },
    'components/ActivityPanel.tsx': { count: 1, why: "ScriptNow: a REPL call's pager inside Now, whose bottom toolbar is Now's" },
  };

  it('keeps an inline strip of buttons only where a list allows it', () => {
    const found: Record<string, number> = {};
    for (const [file, text] of sources) {
      const n = text.match(/<Toolbar\s+inline\b/g)?.length ?? 0;
      if (n) found[file] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(INLINE).map(([f, v]) => [f, v.count])));
  });
});
