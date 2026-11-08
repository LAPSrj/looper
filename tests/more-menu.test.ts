import { describe, expect, it, vi } from 'vitest';
import { hideOffPlatform, serializeMenu, type MenuLike } from '../src/main/platform/menus';
import { readAddonManifest } from '../src/shared/addons';
import type { MenuItemSpec } from '../src/shared/remote-access';
import { menuForPlatform, showsOn, uiPlatformOf } from '../src/shared/ui-platform';
import { findToolbarItem, groupsAtSeparators, toolbarFor, type ToolbarGroup } from '../src/renderer/src/components/toolbar-model';
import { composeMore, phoneMenu } from '../src/renderer/src/web/more-menu';

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
  const pick = vi.fn();
  const commands: MenuItemSpec[] = [
    item('new-task', 'New Task…'),
    sep('s1'),
    item('stop', 'Stop Task', { enabled: false }),
    item('run-now', 'Run Now'),
    item('delete', 'Delete Task', { destructive: true }),
  ];
  const more = { items: commands, run: pick };
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

  it('puts the toolbar first, then the screen’s commands', () => {
    const m = composeMore({ toolbar, more });
    expect(labels(m.items)).toEqual([
      'Dashboard',
      'New Task',
      '—',
      'New Chat in A',
      'New Chat in Project',
      'New Terminal',
      'Pick',
      '—',
      'New Task…',
      '—',
      'Run Now',
      '—',
      'Delete Task',
    ]);
    expect(m.items[0]).toMatchObject({ type: 'checkbox', checked: true });
    // The split button with entries is a submenu: its command, then its entries.
    expect(labels(m.items[6].submenu!)).toEqual(['Pick', '—', 'One']);
    // What can't be done now is left out, and Delete goes last in a group of its own.
    expect(labels(m.items)).not.toContain('Stop Task');
    expect(m.items[m.items.length - 1]).toMatchObject({ label: 'Delete Task', destructive: true });
  });

  it('runs the page’s own items itself, and a command’s pick through the screen’s run', () => {
    const m = composeMore({ toolbar, more });
    m.run.get(m.items.find((i) => i.label === 'New Terminal')!.id)!();
    expect(open).toHaveBeenCalledWith(0, 0);
    const runNow = m.items.find((i) => i.label === 'Run Now')!;
    m.run.get(runNow.id)!();
    expect(pick).toHaveBeenCalledWith('run-now');
  });

  it('takes no commands from a screen without any', () => {
    expect(labels(composeMore({ toolbar }).items)).not.toContain('Run Now');
  });

  it('is empty when there is nothing to offer', () => {
    expect(composeMore({}).items).toEqual([]);
  });
});

describe('an addon command’s marks', () => {
  const MANIFEST = {
    $type: 'looper/addon',
    $version: 1,
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    run: { on: 'wsl', command: ['node', 'addon.mjs'] },
    panes: [{ id: 'things', title: 'Things' }],
  };
  const withCommand = (over: object) => readAddonManifest({ ...MANIFEST, commands: [{ id: 'c', label: 'C', in: { app: { menu: 'tools' } }, ...over }] });

  it('accepts platforms, and rejects unknown, empty or repeated lists', () => {
    const r = withCommand({ platforms: ['desktop', 'web'] });
    expect(r.ok && r.manifest.commands[0].platforms).toEqual(['desktop', 'web']);
    expect(withCommand({ platforms: ['phone'] }).ok).toBe(false);
    expect(withCommand({ platforms: [] }).ok).toBe(false);
    expect(withCommand({ platforms: ['web', 'web'] }).ok).toBe(false);
  });

  it('accepts destructive, and carries it to the menu', () => {
    expect(withCommand({ destructive: true }).ok).toBe(true);
    expect(withCommand({ destructive: 'yes' }).ok).toBe(false);
    const { items } = serializeMenu({ items: [{ label: 'Delete Server', destructive: true }, { label: 'Stop Rest Mode' }] });
    expect(items.map((i) => i.destructive)).toEqual([true, undefined]);
  });
});
