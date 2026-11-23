import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '../src/shared/chat';
import type { MenuItemSpec } from '../src/shared/remote-access';

// The renderer's modules, read by their path at run time as chat-window.test.ts reads ChatRows: the tests' type check
// (tsconfig.node.json) doesn't take the renderer's JSX.
const at = (p: string) => '../src/renderer/src/' + p;
type Props = Record<string, unknown> & { children?: ReactNode };
let AttachmentList: FunctionComponent<{ items: Attachment[]; onRemove?: (a: Attachment) => void }>;
let IosBrowserBarRow: FunctionComponent<Props>;
let MenuLevel: FunctionComponent<Props>;
let IosPopUp: FunctionComponent<Props>;
let popUpItems: (options: { text: string; selected: boolean; disabled: boolean }[]) => MenuItemSpec[];

beforeAll(async () => {
  const element = { dataset: {}, classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false }, style: {} };
  Object.assign(globalThis, {
    window: { looper: {}, performance, addEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) },
    document: { documentElement: element, addEventListener: () => undefined },
  });
  ({ AttachmentList } = (await import(/* @vite-ignore */ at('components/ChatRows'))) as { AttachmentList: typeof AttachmentList });
  ({ IosBrowserBarRow } = (await import(/* @vite-ignore */ at('web/NavBarRow'))) as { IosBrowserBarRow: typeof IosBrowserBarRow });
  ({ MenuLevel } = (await import(/* @vite-ignore */ at('web/IosMenu'))) as { MenuLevel: typeof MenuLevel });
  ({ IosPopUp, popUpItems } = (await import(/* @vite-ignore */ at('components/ui'))) as { IosPopUp: typeof IosPopUp; popUpItems: typeof popUpItems });
});
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe("the iOS file browser's bar (a folder picker sheet)", () => {
  const draw = (canBack: boolean, confirm: boolean) =>
    renderToStaticMarkup(
      createElement(IosBrowserBarRow, {
        title: createElement('h1', null, 'asana-mcp'),
        canBack,
        onBack: () => undefined,
        actions: [{ id: 'new-folder', label: 'New Folder', icon: 'newProject', run: () => undefined }],
        confirm: confirm ? { label: 'Choose', disabled: false, run: () => undefined } : undefined,
        onClose: () => undefined,
      }),
    );
  const lead = (html: string) => /<div class="ios-bar-lead">([\s\S]*?)<\/div>\s*<h1>/.exec(html)?.[1] ?? '';

  it('puts Close at the leading edge, as HIG Sheets puts a sheet\'s Cancel, with Done at the trailing one', () => {
    const html = draw(false, true);
    expect(lead(html)).toContain('aria-label="Close"');
    expect(html.indexOf('aria-label="Close"')).toBeLessThan(html.indexOf('asana-mcp'));
    expect(html.indexOf('aria-label="Choose"')).toBeGreaterThan(html.indexOf('aria-label="New Folder"'));
  });

  it('shows Back in its place once there is a folder to go back to, never Cancel, Done and Back together, and no Forward', () => {
    const html = draw(true, true);
    expect(lead(html)).toContain('aria-label="Back"');
    expect(html).not.toContain('aria-label="Close"');
    for (const h of [html, draw(false, true), draw(true, false)]) expect(h).not.toContain('Forward');
  });

  it('keeps Close beside Back in a sheet without Done (a folder being looked at)', () => {
    const l = lead(draw(true, false));
    expect(l.indexOf('aria-label="Back"')).toBeGreaterThanOrEqual(0);
    expect(l.indexOf('aria-label="Back"')).toBeLessThan(l.indexOf('aria-label="Close"'));
  });
});

describe("an iOS menu's submenu item", () => {
  it('shows its icon while closed, as its open header does', () => {
    const items: MenuItemSpec[] = [
      { id: 'pull', type: 'normal', label: 'Pull', icon: 'download', enabled: true },
      { id: 's1', type: 'separator', enabled: true },
      { id: 'branch', type: 'submenu', label: 'Branch: main', icon: 'download', enabled: true, submenu: [{ id: 'main', type: 'radio', label: 'main', checked: true, enabled: true }] },
    ];
    const html = renderToStaticMarkup(createElement(MenuLevel, { items, onItem: () => undefined }));
    const branch = /<button[^>]*aria-haspopup="true"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
    expect(branch).toContain('Branch: main');
    expect(branch).toMatch(/class="ios-menu-lead"><svg/);
  });
});

describe("an image's thumbnail while it loads", () => {
  const shot: Attachment = { name: 'IMG_1366.png', path: '/att/20261122-201240-1dsb-IMG_1366.png', image: true };

  it('is its tile, empty, at a thumbnail\'s size, not the file name', () => {
    const html = renderToStaticMarkup(createElement(AttachmentList, { items: [shot], onRemove: () => undefined }));
    expect(html).toMatch(/<img class="chat-thumb-blank"[^>]*width="120" height="120"/);
    expect(html).not.toContain('<span>IMG_1366.png</span>');
  });

  it('has the size of the thumbnail it waits for, from the size Looper read as the image was attached', () => {
    // An iPhone screenshot, 1179 x 2556: its thumbnail is fitted in 220 x 120.
    const att: Attachment = { name: 'IMG_1367.png', path: '/att/20261122-201241-x2ab-IMG_1367.png', image: true, width: 1179, height: 2556 };
    const html = renderToStaticMarkup(createElement(AttachmentList, { items: [att] }));
    expect(html).toMatch(/<img class="chat-thumb-blank"[^>]*width="55" height="120"/);
  });
});

describe("iOS's pop-up button (SelectInput)", () => {
  it('is a button that opens the menu out of its value, the select only holding the value', () => {
    const html = renderToStaticMarkup(
      createElement(IosPopUp, { id: 'env', value: 'wsl', onChange: () => undefined }, createElement('option', { value: 'win' }, 'Windows'), createElement('option', { value: 'wsl' }, 'WSL')),
    );
    expect(html).toMatch(/<button type="button" id="env" class="select-hit" aria-haspopup="menu"/);
    expect(html).toMatch(/<select hidden=""[^>]*tabindex="-1"/);
    expect(html).not.toMatch(/<select[^>]*id="env"/);
  });

  it("lists the select's options as the menu's items, the chosen one checked and a & kept as text", () => {
    const items = popUpItems([
      { text: ' Q & A ', selected: false, disabled: false },
      { text: 'WSL', selected: true, disabled: false },
    ]);
    expect(items).toEqual([
      { id: '0', type: 'radio', label: 'Q && A', checked: false, enabled: true },
      { id: '1', type: 'radio', label: 'WSL', checked: true, enabled: true },
    ]);
  });
});
