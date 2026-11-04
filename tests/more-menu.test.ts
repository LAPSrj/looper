import { describe, expect, it, vi } from 'vitest';
import { hideOffPlatform, serializeMenu, type MenuLike } from '../src/main/platform/menus';
import { AddonPaneContentSchema, AddonScreenSchema, readAddonManifest } from '../src/shared/addons';
import type { MenuItemSpec } from '../src/shared/remote-access';
import { menuForPlatform, showsOn, uiPlatformOf } from '../src/shared/ui-platform';
import { findToolbarItem, groupsAtSeparators, toolbarFor, type ToolbarGroup } from '../src/renderer/src/components/toolbar-model';
import { composeMore, phoneMenu, THIS_DEVICE_ITEM } from '../src/renderer/src/web/more-menu';

const labels = (items: MenuItemSpec[]): string[] => items.map((i) => (i.type === 'separator' ? '—' : (i.label ?? '')));
const item = (id: string, label: string, extra: Partial<MenuItemSpec> = {}): MenuItemSpec => ({ id, type: 'normal', label, enabled: true, ...extra });
const sep = (id: string): MenuItemSpec => ({ id, type: 'separator', enabled: true });

describe('platform marks', () => {
  it('shows unmarked items everywhere and marked ones only where listed', () => {
    expect(showsOn(undefined, 'mobile')).toBe(true);
    expect(showsOn(['desktop'], 'mobile')).toBe(false);
    expect(showsOn(['desktop', 'web'], 'web')).toBe(true);
  });

  it('names each renderer and client platform', () => {
    expect(uiPlatformOf('electron')).toBe('desktop');
    expect(uiPlatformOf('web')).toBe('web');
    expect(uiPlatformOf('ios')).toBe('mobile');
    expect(uiPlatformOf('android')).toBe('mobile');
  });

  it('filters a menu and the separators the hidden items leave', () => {
    const menu: MenuItemSpec[] = [
      item('0', 'Open Folder', { platforms: ['desktop'] }),
      sep('1'),
      item('2', 'Settings'),
      sep('3'),
      { id: '4', type: 'submenu', label: 'View', enabled: true, submenu: [item('4.0', 'Toolbar', { platforms: ['desktop', 'web'] }), item('4.1', 'Dashboard')] },
      sep('5'),
      item('6', 'Reload', { platforms: ['desktop'] }),
    ];
    const out = menuForPlatform(menu, 'mobile');
    expect(labels(out)).toEqual(['Settings', '—', 'View']);
    expect(labels(out[2].submenu!)).toEqual(['Dashboard']);
    expect(out.some((i) => 'platforms' in i)).toBe(false);
  });
});

describe('serializeMenu and platforms', () => {
  const menu = (): MenuLike => ({
    items: [
      {
        id: 'file',
        label: '&File',
        submenu: {
          items: [
            { id: 'settings', label: 'S&ettings…', glyph: 'settings' },
            { type: 'separator' },
            { label: 'Open &Folder', platforms: ['desktop'] },
            { id: '17', label: 'Numbered' },
          ],
        },
      },
    ],
  });

  it("leaves out what the client's platform doesn't show, and carries keys and icons", () => {
    const { items } = serializeMenu(menu(), 'mobile');
    const file = items[0];
    expect(file.key).toBe('file');
    expect(labels(file.submenu!)).toEqual(['Settings…', '—', 'Numbered']);
    expect(file.submenu![0]).toMatchObject({ key: 'settings', icon: 'settings' });
    // Electron's own numeric ids aren't keys.
    expect(file.submenu![2].key).toBeUndefined();
  });

  it('keeps the marks for the client when no platform is given', () => {
    const { items } = serializeMenu(menu());
    expect(items[0].submenu![2]).toMatchObject({ label: 'Open Folder', platforms: ['desktop'] });
  });

  it('hides the off-platform items of a window menu, which serializing then leaves out', () => {
    const m = menu();
    hideOffPlatform(m, 'web');
    expect(m.items[0].submenu!.items[2].visible).toBe(false);
    expect(labels(serializeMenu(m).items[0].submenu!)).toEqual(['Settings…', '—', 'Numbered']);
  });
});

describe('toolbar model', () => {
  const groups: ToolbarGroup[] = [
    { id: 'a', items: [{ id: 'run', label: 'Run' }, { id: 'folder', label: 'Folder', platforms: ['desktop'] }] },
    { id: 'b', platforms: ['desktop'], items: [{ id: 'pane', label: 'Pane' }] },
    { id: 'c', items: [{ id: 'new', label: 'New', menu: { label: 'New in', items: [{ id: 'p1', label: 'P1', run: () => {} }, { id: 'x', label: 'X', platforms: ['web'], run: () => {} }] } }] },
  ];

  it('keeps what shows on a platform and drops emptied groups', () => {
    const out = toolbarFor(groups, 'mobile');
    expect(out.map((g) => g.id)).toEqual(['a', 'c']);
    expect(out[0].items.map((i) => i.id)).toEqual(['run']);
    expect(out[1].items[0].menu!.items!.map((e) => e.id)).toEqual(['p1']);
  });

  it('finds items and split-button entries by id', () => {
    expect(findToolbarItem(groups, 'run')?.label).toBe('Run');
    expect(findToolbarItem(groups, 'new/p1')?.label).toBe('P1');
    expect(findToolbarItem(groups, 'nope')).toBeUndefined();
  });

  it('splits an addon toolbar at its separators', () => {
    const out = groupsAtSeparators([{ id: 'a' }, { separator: true }, { separator: true }, { id: 'b' }], (t: { id: string }) => ({ id: t.id, label: t.id }), 'g');
    expect(out.map((g) => g.items.map((i) => i.id))).toEqual([['a'], ['b']]);
  });
});

describe('phoneMenu', () => {
  it('hides unavailable items and puts the ones marked destructive last', () => {
    const out = phoneMenu([
      item('1', 'Run Now'),
      item('2', 'Delete Task', { destructive: true }),
      item('3', 'Stop Task', { enabled: false, destructive: true }),
      sep('s'),
      item('4', 'Edit Task…'),
      // The mark decides, not the label: Stop Rest Mode ends nothing.
      item('5', 'Stop Rest Mode'),
    ]);
    expect(labels(out)).toEqual(['Run Now', '—', 'Edit Task…', 'Stop Rest Mode', '—', 'Delete Task']);
    expect(out[out.length - 1].destructive).toBe(true);
  });

  it('drops submenus left empty', () => {
    const out = phoneMenu([{ id: 's', type: 'submenu', label: 'Sub', enabled: true, submenu: [item('a', 'A', { enabled: false })] }, item('b', 'B')]);
    expect(labels(out)).toEqual(['B']);
  });
});

describe('composeMore', () => {
  const menu: MenuItemSpec[] = [
    {
      id: '0',
      key: 'file',
      type: 'submenu',
      label: 'File',
      enabled: true,
      submenu: [item('0.0', 'New Task…', { key: 'new-task' }), sep('0.1'), item('0.2', 'Settings…', { key: 'settings' })],
    },
    {
      id: '1',
      key: 'task',
      type: 'submenu',
      label: 'Task',
      enabled: true,
      submenu: [
        item('1.0', 'Run Now', { key: 'task-run-now' }),
        item('1.1', 'Stop Task', { key: 'task-stop', enabled: false }),
        item('1.2', 'Delete Task', { key: 'task-delete', destructive: true }),
        item('1.3', 'Open Working Directory', { key: 'task-work-folder', platforms: ['desktop'] }),
      ],
    },
    { id: '2', type: 'submenu', label: 'View', enabled: true, submenu: [item('2.0', 'Toolbar', { platforms: ['desktop', 'web'] })] },
  ];
  const run = vi.fn();
  const open = vi.fn();
  const toolbar: ToolbarGroup[] = [
    {
      id: 'g1',
      items: [
        { id: 'dashboard', label: 'Dashboard', pressed: true, run },
        { id: 'new-task', label: 'New Task', icon: 'newTask', run },
        { id: 'stop', label: 'Stop', enabled: false, run },
      ],
    },
    {
      id: 'g2',
      items: [
        { id: 'new-chat', label: 'New Chat in A', run, menu: { label: 'New Chat in Project', open } },
        { id: 'new-terminal', label: 'New Terminal', run: null, menu: { label: 'New Terminal in Project', open } },
        { id: 'pick', label: 'Pick', run, menu: { label: 'Pick in', items: [{ id: 'one', label: 'One', run }] } },
        { id: 'folder', label: 'Open Working Directory', platforms: ['desktop'], run },
      ],
    },
  ];

  it('defaults to the toolbar, then the menu bar as submenus, then This Device on the root screen', () => {
    const m = composeMore({ toolbar, barIds: ['new-task'], menu, device: 'This Device' });
    expect(labels(m.items)).toEqual([
      'Dashboard',
      '—',
      'New Chat in A',
      'New Chat in Project',
      'New Terminal',
      'Pick',
      '—',
      'File',
      'Task',
      '—',
      'This Device',
    ]);
    expect(m.items[0]).toMatchObject({ type: 'checkbox', checked: true });
    // The split button with entries is a submenu: its command, then its entries.
    expect(labels(m.items[5].submenu!)).toEqual(['Pick', '—', 'One']);
    // The Task menu without what doesn't apply on a phone or can't be done now; Delete last.
    expect(labels(m.items[8].submenu!)).toEqual(['Run Now', '—', 'Delete Task']);
    expect(m.items[m.items.length - 1].id).toBe(THIS_DEVICE_ITEM);
  });

  it("runs the page's own items itself and leaves the menu bar's to the computer", () => {
    const m = composeMore({ toolbar, menu });
    m.run.get(m.items.find((i) => i.label === 'New Terminal')!.id)!();
    expect(open).toHaveBeenCalledWith(0, 0);
    const file = m.items.find((i) => i.label === 'File')!;
    expect(m.run.has(file.submenu![0].id)).toBe(false);
    expect(file.submenu![0].id).toBe('0.0');
  });

  it('builds a designed menu from actions, toolbar items, whole menus and single items, flattened', () => {
    const del = vi.fn();
    const m = composeMore({
      toolbar,
      menu,
      more: [
        [{ item: 'task-run-now' }, { item: 'task-stop' }, { toolbar: 'new-task' }],
        [{ menu: 'file' }],
        [{ action: { id: 'gone', label: 'Hidden', disabled: true, run: del } }, { action: { id: 'del', label: 'Delete Everything', run: del } }, { item: 'task-work-folder' }],
      ],
    });
    expect(labels(m.items)).toEqual(['Run Now', 'New Task', '—', 'New Task…', '—', 'Settings…', '—', 'Delete Everything']);
    m.run.get(m.items[m.items.length - 1].id)!();
    expect(del).toHaveBeenCalled();
  });

  it('finds a menu by its label too, as an addon names it', () => {
    const m = composeMore({ menu, more: [[{ menu: '&Task' }]] });
    expect(labels(m.items)).toEqual(['Run Now', '—', 'Delete Task']);
  });

  it('is empty when there is nothing to offer', () => {
    expect(composeMore({ menu: null }).items).toEqual([]);
  });
});

describe('addon platform marks and mobileMore', () => {
  const MANIFEST = {
    $type: 'looper/addon',
    $version: 1,
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    run: { on: 'wsl', command: ['node', 'addon.mjs'] },
    panes: [{ id: 'things', title: 'Things' }],
  };

  it('accepts platforms on main-toolbar buttons and tools', () => {
    const r = readAddonManifest({
      ...MANIFEST,
      tools: [{ id: 't', label: 'Things', pane: 'things', platforms: ['desktop', 'web'] }],
      toolbar: [{ id: 'b', label: 'Open', tool: 't', platforms: ['mobile'] }],
    });
    expect(r.ok && r.manifest.toolbar[0].platforms).toEqual(['mobile']);
    expect(r.ok && r.manifest.tools[0].platforms).toEqual(['desktop', 'web']);
  });

  it('rejects unknown, empty or repeated platform lists', () => {
    expect(readAddonManifest({ ...MANIFEST, toolbar: [{ id: 'b', label: 'B', platforms: ['phone'] }] }).ok).toBe(false);
    expect(readAddonManifest({ ...MANIFEST, toolbar: [{ id: 'b', label: 'B', platforms: [] }] }).ok).toBe(false);
    expect(readAddonManifest({ ...MANIFEST, toolbar: [{ id: 'b', label: 'B', platforms: ['web', 'web'] }] }).ok).toBe(false);
  });

  const screen = {
    toolbar: [{ id: 'new', label: 'New', platforms: ['mobile'] }, { separator: true }, { id: 'refresh', label: 'Refresh', icon: 'refresh', iconOnly: true }],
    menuBar: [
      { label: '&File', items: [{ id: 'export', label: 'Export…', platforms: ['desktop'] }] },
      { label: '&View', platforms: ['desktop', 'web'], items: [{ id: 'compact', label: 'Compact', checked: false }] },
    ],
    body: [],
  };

  it('accepts platforms on screen toolbar items and menu-bar menus and items, and a mobileMore naming them', () => {
    const r = AddonScreenSchema.safeParse({ ...screen, mobileMore: [[{ toolbar: 'new' }, { item: 'export' }], [{ menu: 'File' }]] });
    expect(r.success).toBe(true);
    const pane = AddonPaneContentSchema.safeParse({ items: [], toolbar: screen.toolbar, menuBar: screen.menuBar, mobileMore: [[{ menu: 'view' }]] });
    expect(pane.success).toBe(true);
  });

  it('rejects a mobileMore that names nothing on the screen', () => {
    const r = AddonScreenSchema.safeParse({ ...screen, mobileMore: [[{ toolbar: 'nope' }, { menu: 'Edit' }, { item: 'missing' }]] });
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(messages).toEqual(['mobileMore names no toolbar button "nope"', 'mobileMore names no menu "Edit"', 'mobileMore names no menu item "missing"']);
    expect(AddonScreenSchema.safeParse({ ...screen, mobileMore: [] }).success).toBe(false);
    expect(AddonScreenSchema.safeParse({ ...screen, mobileMore: [[{ toolbar: 'new', menu: 'File' }]] }).success).toBe(false);
  });

  it('accepts destructive on menu items, screen toolbar buttons and main-toolbar buttons, and carries it to the menu', () => {
    const r = AddonScreenSchema.safeParse({
      toolbar: [{ id: 'del', label: 'Delete Server', icon: 'delete', destructive: true }],
      menuBar: [{ label: '&Edit', items: [{ id: 'del', label: '&Delete Server', destructive: true }] }],
      body: [],
    });
    expect(r.success).toBe(true);
    expect(readAddonManifest({ ...MANIFEST, toolbar: [{ id: 'b', label: 'Stop All', destructive: true }] }).ok).toBe(true);
    expect(AddonScreenSchema.safeParse({ toolbar: [{ id: 'a', label: 'A', destructive: 'yes' }], body: [] }).success).toBe(false);
    const { items } = serializeMenu({ items: [{ label: 'Delete Server', destructive: true }, { label: 'Stop Rest Mode' }] });
    expect(items.map((i) => i.destructive)).toEqual([true, undefined]);
  });

  it('leaves a screen with none of these as it was', () => {
    expect(AddonScreenSchema.safeParse({ toolbar: [{ id: 'a', label: 'A' }], body: [] }).success).toBe(true);
  });
});
