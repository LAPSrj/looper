import { describe, expect, it, vi } from 'vitest';
import { macMenuBar, openWindowItems } from '../src/main/window-menu';

type MenuItem = Electron.MenuItemConstructorOptions;

const names = (items: MenuItem[]) => items.map((i) => (i.type === 'separator' ? '—' : (i.label ?? i.role)));
const sub = (item: MenuItem | undefined) => item?.submenu as MenuItem[];
const app = { about: vi.fn(), settings: vi.fn() };

describe('openWindowItems', () => {
  const win = (title: string) => ({ getTitle: () => title });

  it('lists the windows in the order given (the order they opened), numbered as access keys, and escapes & in a title', () => {
    const items = openWindowItems([win('Tasks'), win('R&D'), win('Chats')], () => {}, () => {});
    expect(items.map((i) => i.label)).toEqual(['&1 Tasks', '&2 R&&D', '&3 Chats']);
    expect(items.every((i) => i.platforms?.join() === 'desktop')).toBe(true);
  });

  it('names nine windows and no More Windows… with nine open; a pick shows its window', () => {
    const show = vi.fn();
    const windows = Array.from({ length: 9 }, (_v, i) => win(`W${i + 1}`));
    const items = openWindowItems(windows, show, () => {});
    expect(items.map((i) => i.label)).toEqual(windows.map((w, i) => `&${i + 1} ${w.getTitle()}`));
    (items[0].click as () => void)();
    expect(show).toHaveBeenCalledWith(windows[0]);
  });

  it('names the first nine and adds More Windows… past them, which opens over the window whose menu it was', () => {
    const more = vi.fn();
    const windows = Array.from({ length: 12 }, (_v, i) => win(`W${i + 1}`));
    const items = openWindowItems(windows, () => {}, more);
    expect(items.map((i) => i.label)).toEqual([...windows.slice(0, 9).map((w, i) => `&${i + 1} ${w.getTitle()}`), '&More Windows…']);
    const from = {} as Electron.BaseWindow;
    (items[9].click as (item: unknown, w: unknown) => void)({}, from);
    expect(more).toHaveBeenCalledWith(from);
  });
});

describe('macMenuBar', () => {
  const template: MenuItem[] = [
    { id: 'file', label: '&File', submenu: [{ label: '&New' }, { type: 'separator' }, { id: 'settings', label: 'S&ettings', platforms: ['mobile'] }, { id: 'templates', label: 'Temp&lates', platforms: ['mobile'] }] },
    { id: 'view', label: '&View', submenu: [{ label: 'R&&D &Tools' }] },
    { id: 'tools', label: 'T&ools', submenu: [{ id: 'settings', label: 'S&ettings' }, { label: 'Temp&lates' }] },
    { id: 'window', label: '&Window', submenu: [{ label: '&History' }, { type: 'separator' }, ...openWindowItems([{ getTitle: () => 'Looper' }], () => {}, () => {})] },
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
