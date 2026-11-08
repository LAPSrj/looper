import { DESKTOP_ONLY, showsOn } from '../shared/ui-platform';
import { stripMnemonic } from './platform/menus';

type MenuItem = Electron.MenuItemConstructorOptions;

const SEPARATOR: MenuItem = { type: 'separator' };
const OPEN_WINDOW_ID = 'open-window-';

/** The computer's open windows, in alphabetical order, with numbers as access keys (Win32: dynamic items). */
export function openWindowItems<W extends { getTitle(): string }>(windows: W[], show: (w: W) => void): MenuItem[] {
  return [...windows]
    .sort((a, b) => a.getTitle().localeCompare(b.getTitle()))
    .map((w, i) => {
      const n = i + 1;
      return {
        id: `${OPEN_WINDOW_ID}${n}`,
        label: `${n < 10 ? '&' : ''}${n} ${w.getTitle().replace(/&/g, '&&')}`,
        platforms: DESKTOP_ONLY,
        click: () => show(w),
      };
    });
}

/** Without what the desktop doesn't show, what the app menu has and what macOS lists itself; no separator left at an edge or doubled. */
function forMac(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (!showsOn(item.platforms, 'desktop') || item.id === 'settings' || item.id === 'about' || item.id?.startsWith(OPEN_WINDOW_ID)) continue;
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push({
      ...item,
      ...(typeof item.label === 'string' ? { label: stripMnemonic(item.label) } : {}),
      ...(Array.isArray(item.submenu) ? { submenu: forMac(item.submenu) } : {}),
    });
  }
  while (out[out.length - 1]?.type === 'separator') out.pop();
  return out;
}

/**
 * Fit a Windows-shaped template to the macOS menu bar: the app menu with About and
 * Settings first, the system's Edit menu after File when the template has none, and
 * the Window menu before Help. With its role, macOS adds the open windows to it
 * (electron_menu_controller.mm, Electron 45.2.1: NSApp setWindowsMenu).
 */
export function macMenuBar(template: MenuItem[], app: { about: () => void; settings: () => void }): MenuItem[] {
  const [file, ...rest] = forMac(template);
  const ownWindow = rest.find((m) => m.id === 'window');
  const others = rest.filter((m) => m !== ownWindow);
  const ownItems = Array.isArray(ownWindow?.submenu) ? ownWindow.submenu : [];
  const window: MenuItem = {
    role: 'window',
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, SEPARATOR, ...ownItems, ...(ownItems.length ? [SEPARATOR] : []), { role: 'front' }],
  };
  const helpAt = others.findIndex((m) => m.id === 'help');
  const beforeWindow = helpAt < 0 ? others : others.slice(0, helpAt);
  const afterWindow = helpAt < 0 ? [] : others.slice(helpAt);
  return [
    {
      label: 'Looper',
      submenu: [
        { label: 'About Looper', click: app.about },
        SEPARATOR,
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: app.settings },
        SEPARATOR,
        { role: 'services' },
        SEPARATOR,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        SEPARATOR,
        { role: 'quit' },
      ],
    },
    file,
    ...(rest.some((m) => m.id === 'edit') ? [] : [{ role: 'editMenu' } as MenuItem]),
    ...beforeWindow,
    window,
    ...afterWindow,
  ];
}
