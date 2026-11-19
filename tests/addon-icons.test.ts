import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonIconError, addonIcons } from '../src/main/addon-icons';
import { DRAWN_ICON, MAX_ICON_SVG, parseSvgIcon } from '../src/shared/addon-icons';
import { ADDON_ICONS, addonIconKey, readAddonManifest } from '../src/shared/addons';
import { mainTabs } from '../src/shared/main-tabs';
import { keyId, LOOPER_KEYS } from '../src/shared/shortcuts';

const MANIFEST = {
  $type: 'looper/addon',
  $version: 2,
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  run: { on: 'wsl', command: ['node', '/opt/demo/addon.mjs'] },
  panes: [{ id: 'things', title: 'Things' }],
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h4"/></svg>';
const svgError = (text: string) => {
  const r = parseSvgIcon(text);
  return r.ok ? undefined : r.error;
};

describe('parseSvgIcon', () => {
  it('keeps shapes and their geometry, whatever else describes the file', () => {
    const r = parseSvgIcon(`<?xml version="1.0"?>
      <!-- A drawing -->
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="x">
        <title>Key</title>
        <path d="m2 21 9.6-9.6" stroke-linecap="round" />
        <g transform="translate(1 2)"><circle cx="15.5" cy="7.5" r="5.5" /><rect x="1" y="2" width="3" height="4" rx=".5" fill="currentColor" fill-rule="evenodd" /></g>
      </svg>`);
    expect(r).toEqual({
      ok: true,
      drawing: {
        box: 24,
        fill: 'none',
        stroke: 'currentColor',
        shapes: [
          ['path', { d: 'm2 21 9.6-9.6' }],
          ['g', { transform: 'translate(1 2)' }, [['circle', { cx: '15.5', cy: '7.5', r: '5.5' }], ['rect', { x: '1', y: '2', width: '3', height: '4', rx: '.5', fill: 'currentColor', 'fill-rule': 'evenodd' }]]],
        ],
      },
    });
  });

  it('fills a file that says nothing, in the icon’s color', () => {
    const r = parseSvgIcon(SVG);
    expect(r.ok && r.drawing).toMatchObject({ box: 16, fill: 'currentColor', stroke: 'none' });
  });

  it.each([
    ['<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>', '<script> isn\'t allowed'],
    ['<svg viewBox="0 0 16 16"><style>path{}</style><path d="M1 1"/></svg>', '<style> isn\'t allowed'],
    ['<svg viewBox="0 0 16 16"><image href="https://example.com/a.png"/></svg>', '<image> isn\'t allowed'],
    ['<svg viewBox="0 0 16 16"><use href="#a"/></svg>', '<use> isn\'t allowed'],
    ['<svg viewBox="0 0 16 16"><foreignObject><div/></foreignObject></svg>', '<foreignObject> isn\'t allowed'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1" onclick="alert(1)"/></svg>', '<path> can\'t have "onclick"'],
    ['<svg viewBox="0 0 16 16" onload="alert(1)"><path d="M1 1"/></svg>', '<svg> can\'t have "onload"'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1" style="fill:red"/></svg>', '<path> can\'t have "style"'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1" mask="url(#a)"/></svg>', '<path> can\'t have "mask"'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1" fill="red"/></svg>', 'fill="red" isn\'t allowed: use "none" or "currentColor"'],
    ['<svg viewBox="0 0 16 16" stroke="#000"><path d="M1 1"/></svg>', 'stroke="#000" isn\'t allowed: use "none" or "currentColor"'],
    ['<svg viewBox="0 0 16 16"><path d="url(#a)"/></svg>', 'its path data has other characters'],
    ['<svg viewBox="0 0 16 16"><circle r="javascript:1"/></svg>', 'r="javascript:1" isn\'t a number'],
    ['<svg viewBox="0 0 16 16"><g transform="url(#a)"><path d="M1 1"/></g></svg>', 'transform="url(#a)" isn\'t allowed'],
    ['<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 16 16"><path d="M1 1"/></svg>', 'it has a declaration, which isn’t allowed'],
    ['<svg viewBox="0 0 16 16"><![CDATA[x]]><path d="M1 1"/></svg>', 'it has a declaration, which isn’t allowed'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1"/>text</svg>', 'it has text outside its shapes'],
    ['<svg viewBox="0 0 16 16"></svg>', 'it has no shapes'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1">', 'it isn’t well-formed SVG'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1"/></g></svg>', 'it isn’t well-formed SVG'],
    ['<svg viewBox="0 0 16 16"><path d="M1 1"/></svg><path d="M1 1"/>', 'it has shapes outside <svg>'],
    ['<svg viewBox="0 0 24 16"><path d="M1 1"/></svg>', 'it needs a square viewBox that starts at 0 0, such as "0 0 24 24"'],
    ['<svg viewBox="2 2 16 16"><path d="M1 1"/></svg>', 'it needs a square viewBox that starts at 0 0, such as "0 0 24 24"'],
    ['<svg><path d="M1 1"/></svg>', 'it needs a square viewBox that starts at 0 0, such as "0 0 24 24"'],
    ['<path d="M1 1"/>', 'it doesn’t start with <svg>'],
    ['not svg', 'it has text outside its shapes'],
  ])('refuses %s', (text, error) => {
    expect(svgError(text)).toContain(error);
  });

  it('refuses an icon too long to send to every window', () => {
    expect(svgError(`<svg viewBox="0 0 16 16"><path d="M1 1${' 2 2'.repeat(MAX_ICON_SVG)}"/></svg>`)).toContain('over');
  });
});

describe('a manifest’s icons', () => {
  const read = (over: object) => readAddonManifest({ ...MANIFEST, ...over });
  const command = (over: object) => ({ id: 'c', label: 'C', menu: 'tools', in: { app: {} }, ...over });

  it('takes Looper’s names, its own SVG and the library’s, on tabs, panes and commands', () => {
    const r = read({
      icons: { vault: SVG },
      panesIcon: 'vault',
      tabs: [{ id: 'main', title: 'Main', view: 'v', icon: 'library:rocket' }],
      commands: [command({ icon: 'key', entries: [{ id: 'e', label: 'E', icon: 'vault' }] })],
    });
    expect(r.ok, !r.ok ? r.error : '').toBe(true);
  });

  it('refuses a name that doesn’t exist, wherever it is', () => {
    const unknown = (over: object, where: string) => {
      const r = read(over);
      expect(!r.ok && r.error).toBe(`${where} names an icon that doesn't exist: "rocket"`);
    };
    unknown({ panesIcon: 'rocket' }, 'panesIcon');
    unknown({ tabs: [{ id: 'main', title: 'Main', view: 'v', icon: 'rocket' }] }, 'tabs: "main"');
    unknown({ commands: [command({ icon: 'rocket' })] }, 'commands: "c"');
    unknown({ commands: [command({ entries: [{ id: 'e', label: 'E', icon: 'rocket' }] })] }, 'commands: "e"');
  });

  it('refuses an own icon it can’t draw, or one named as Looper’s', () => {
    const bad = read({ icons: { vault: '<svg viewBox="0 0 16 16"><script/></svg>' } });
    expect(!bad.ok && bad.error).toContain('icons: "vault": <script> isn\'t allowed');
    const taken = read({ icons: { key: SVG } });
    expect(!taken.ok && taken.error).toBe('icons: "key" is the name of one of Looper\'s icons');
    expect(read({ icons: { 'a:b': SVG } }).ok).toBe(false);
  });

  it('draws them from the main process, and leaves out of the list what no field names', () => {
    const r = read({ icons: { vault: SVG, locked: 'library:lock' }, commands: [command({ icon: 'library:rocket' }), command({ id: 'd', icon: 'key' })] });
    if (!r.ok) throw new Error(r.error);
    const icons = addonIcons(r.manifest);
    expect(Object.keys(icons).sort()).toEqual(['library:lock', 'library:rocket', 'locked', 'vault']);
    expect(icons.vault.startsWith(DRAWN_ICON)).toBe(true);
    expect(JSON.parse(icons['library:rocket'].slice(DRAWN_ICON.length))).toMatchObject({ box: 24, fill: 'none', stroke: 'currentColor' });
    expect(addonIconKey({ icons }, 'key')).toBe('key');
    expect(addonIconKey({ icons }, 'vault')).toBe(icons.vault);
    expect(addonIconKey({ icons }, 'constructor')).toBeUndefined();
    expect(addonIconKey({ icons }, undefined)).toBeUndefined();
  });

  it('refuses a library name it doesn’t have', () => {
    const r = read({ commands: [command({ icon: 'library:no-such-icon' })] });
    if (!r.ok) throw new Error(r.error);
    expect(addonIconError(r.manifest)).toBe('commands: "c" names an icon the library doesn\'t have: "library:no-such-icon"');
    const own = read({ icons: { x: 'library:no-such-icon' } });
    if (!own.ok) throw new Error(own.error);
    expect(addonIconError(own.manifest)).toBe('icons: "x" names an icon the library doesn\'t have: "library:no-such-icon"');
  });

  it('gives the panes tab its icon, and a window without one', () => {
    const addon = { id: 'a', name: 'A', enabled: true, tabs: [], panes: [{ id: 'p', title: 'P' }], icons: { vault: 'svg:{}' } };
    expect(mainTabs([{ ...addon, panesIcon: 'key' }]).at(-1)?.icon).toBe('key');
    expect(mainTabs([{ ...addon, panesIcon: 'vault' }]).at(-1)?.icon).toBe('svg:{}');
    expect(mainTabs([addon]).at(-1)?.icon).toBe('window');
  });
});

describe('the icon library', () => {
  const library = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon-library.json'), 'utf8')) as Record<string, unknown[]>;

  it('has every icon the list says, and every Looper icon is listed', () => {
    const list = fs.readFileSync(path.join(__dirname, '..', 'docs', 'addon-icon-list.md'), 'utf8');
    const listed = [...list.slice(list.indexOf('## The library')).matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(Object.keys(library).sort());
    for (const name of ADDON_ICONS) expect(list).toContain(`| \`${name}\` |`);
  });
});

describe('an addon’s keys', () => {
  const read = (accelerator: string, more: object = {}) => readAddonManifest({ ...MANIFEST, commands: [{ id: 'c', label: 'C', menu: 'tools', accelerator, in: { app: {} } }], ...more });

  it('takes a key with Ctrl, or a function key', () => {
    for (const key of ['CmdOrCtrl+Shift+K', 'Shift+CmdOrCtrl+K', 'CmdOrCtrl+Alt+Delete', 'F12', 'Shift+F11', 'CmdOrCtrl+F12']) expect(read(key).ok, key).toBe(true);
  });

  it('refuses one typing would reach, or that isn’t a key', () => {
    for (const key of ['K', 'Shift+K', 'Alt+K', 'Enter', 'CmdOrCtrl', 'CmdOrCtrl+CmdOrCtrl+K', 'Ctrl+K', 'CmdOrCtrl+key', 'F25']) expect(read(key).ok, key).toBe(false);
  });

  it('refuses one Looper uses, however its modifiers are ordered', () => {
    const r = read('Shift+CmdOrCtrl+T');
    expect(!r.ok && r.error).toBe('commands: "c" uses Shift+Ctrl+T, which Looper uses');
    expect(read('CmdOrCtrl+C').ok).toBe(false);
    expect(read('F1').ok).toBe(false);
  });

  it('refuses one key twice in a manifest, on a submenu’s item too', () => {
    const entry = { id: 'e', label: 'E', accelerator: 'CmdOrCtrl+Shift+K' };
    const r = readAddonManifest({ ...MANIFEST, commands: [{ id: 'c', label: 'C', menu: 'tools', accelerator: 'CmdOrCtrl+Shift+K', entries: [entry], in: { app: {} } }] });
    expect(!r.ok && r.error).toBe('commands: "e" uses Ctrl+Shift+K, which another command uses');
  });

  it('lists every key of Looper’s command list among the ones an addon can’t take', () => {
    const list = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'commands', 'list.ts'), 'utf8');
    const reserved = new Set(LOOPER_KEYS.map(keyId));
    const used = [...list.matchAll(/'((?:CmdOrCtrl|Shift|Alt)\+[^']+|F\d+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const key of used) expect(reserved.has(keyId(key)), key).toBe(true);
  });
});
