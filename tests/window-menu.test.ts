import { describe, expect, it, vi } from 'vitest';
import { macMenuBar, openWindowItems, phoneOnly, windowMenu } from '../src/main/window-menu';

type MenuItem = Electron.MenuItemConstructorOptions;

const names = (items: MenuItem[]) => items.map((i) => (i.type === 'separator' ? '—' : (i.label ?? i.role)));
const sub = (item: MenuItem | undefined) => item?.submenu as MenuItem[];
const app = { about: vi.fn(), settings: vi.fn() };

describe('windowMenu', () => {
  it('separates its groups, leaving out the empty ones, and stays off a phone by default', () => {
    const menu = windowMenu([[{ label: 'A' }], [], [{ label: 'B' }]]);
    expect(names(sub(menu))).toEqual(['A', '—', 'B']);
    expect(menu.platforms).toEqual(['desktop', 'web']);
  });
});

describe('openWindowItems', () => {
  const win = (title: string) => ({ getTitle: () => title });

  it('lists the windows alphabetically with numbers as access keys, and escapes & in a title', () => {
    const items = openWindowItems([win('Tasks'), win('R&D'), win('Chats')], () => {});
    expect(items.map((i) => i.label)).toEqual(['&1 Chats', '&2 R&&D', '&3 Tasks']);
    expect(items.every((i) => i.platforms?.join() === 'desktop')).toBe(true);
  });

  it('gives no access key past 9, and a pick shows its window', () => {
    const show = vi.fn();
    const windows = Array.from({ length: 10 }, (_v, i) => win(`W${String(i).padStart(2, '0')}`));
    const items = openWindowItems(windows, show);
    expect(items[8].label).toBe('&9 W08');
    expect(items[9].label).toBe('10 W09');
    (items[0].click as () => void)();
    expect(show).toHaveBeenCalledWith(windows[0]);
  });
});

describe('phoneOnly', () => {
  it('marks copies for a phone without their keys', () => {
    expect(phoneOnly([{ label: 'Next', accelerator: 'F9' }])).toEqual([{ label: 'Next', platforms: ['mobile'] }]);
  });
});

describe('macMenuBar', () => {
  const template: MenuItem[] = [
    { id: 'file', label: '&File', submenu: [{ label: '&New' }, { type: 'separator' }, ...phoneOnly([{ id: 'settings', label: 'S&ettings' }, { id: 'templates', label: 'Temp&lates' }])] },
    { id: 'view', label: '&View', submenu: [{ label: 'R&&D &Tools' }] },
    { id: 'tools', label: 'T&ools', submenu: [{ id: 'settings', label: 'S&ettings' }, { label: 'Temp&lates' }] },
    windowMenu([[{ label: '&History' }], openWindowItems([{ getTitle: () => 'Looper' }], () => {})]),
    { id: 'help', label: '&Help', submenu: [{ label: '&Instructions' }, { type: 'separator' }, { id: 'about', label: '&About Looper' }] },
  ];

  it('puts the app menu first, the system Edit after File, and Window before Help', () => {
    const bar = macMenuBar(template, app);
    expect(names(bar)).toEqual(['Looper', 'File', 'editMenu', 'View', 'Tools', 'Window', 'Help']);
    expect(bar[5].role).toBe('window');
  });

  it('keeps a template’s own Edit menu, so its Find stays', () => {
    const bar = macMenuBar([template[0], { id: 'edit', label: '&Edit', submenu: [{ label: '&Find…' }] }], app);
    expect(names(bar)).toEqual(['Looper', 'File', 'Edit', 'Window']);
    expect(names(sub(bar[2]))).toEqual(['Find…']);
  });

  it('moves About and Settings to the app menu, whatever window the template is for', () => {
    for (const t of [template, [template[0]]]) {
      const bar = macMenuBar(t, app);
      const looper = sub(bar[0]);
      expect(names(looper).slice(0, 3)).toEqual(['About Looper', '—', 'Settings…']);
      expect(looper[2].accelerator).toBe('CmdOrCtrl+,');
      expect(looper[0].click).toBe(app.about);
      expect(looper[2].click).toBe(app.settings);
    }
    const bar = macMenuBar(template, app);
    expect(names(sub(bar.find((m) => m.label === 'Tools')))).toEqual(['Templates']);
    expect(names(sub(bar.find((m) => m.label === 'Help')))).toEqual(['Instructions']);
  });

  it('drops what only a phone has and the separators that leaves, and keeps a literal &', () => {
    const bar = macMenuBar(template, app);
    expect(names(sub(bar.find((m) => m.label === 'File')))).toEqual(['New']);
    expect(names(sub(bar.find((m) => m.label === 'View')))).toEqual(['R&D Tools']);
  });

  it('leaves the list of open windows to macOS', () => {
    const bar = macMenuBar(template, app);
    expect(names(sub(bar.find((m) => m.role === 'window')))).toEqual(['minimize', 'zoom', '—', 'History', '—', 'front']);
    expect(names(sub(macMenuBar([template[0]], app).find((m) => m.role === 'window')))).toEqual(['minimize', 'zoom', '—', 'front']);
  });
});
