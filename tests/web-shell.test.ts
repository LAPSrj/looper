import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MenuItemSpec, ServerMessage } from '../src/shared/remote-access';
import { makeDir, type HostFilesDeps } from '../src/main/platform/host-files';
import { RemoteClient } from '../src/main/platform/remote-window';
import { withConnectSrc } from '../src/main/remote-access/server';
import {
  acceptAttr,
  allowedExtensions,
  breadcrumbs,
  fileSources,
  filterLabel,
  folderNameError,
  initialSource,
  joinPath,
  messageCancelId,
  messageDefaultId,
  messageResult,
  openCanceled,
  openResult,
  saveCanceled,
  saveToComputer,
  saveToDevice,
  splitDefaultPath,
  visibleEntries,
  withExtension,
} from '../src/renderer/src/web/dialog-flows';
import { eventMatches, findAccelerator, menuHover, menuKey, openNav, parseAccelerator, pickChecked, shortcutText, type KeyLike, type MenuNav } from '../src/renderer/src/web/menu-model';
import type { ShellMessage } from '../src/renderer/src/web/session';
import { childStack, frontWindow, initialShellState, isBlocked, mainWindow, reduceShell, topModal, type ShellState } from '../src/renderer/src/web/store';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const item = (id: string, label: string, extra: Partial<MenuItemSpec> = {}): MenuItemSpec => ({ id, type: 'normal', label, enabled: true, ...extra });
const sep = (id: string): MenuItemSpec => ({ id, type: 'separator', enabled: true });

// ---------- menus ----------

describe('menu keyboard navigation', () => {
  const sub = [item('3.0', 'Toolbar', { type: 'checkbox', checked: true }), item('3.1', 'Status Bar', { type: 'checkbox', checked: false })];
  const items: MenuItemSpec[] = [
    item('0', 'New Task'),
    item('1', 'Import Task', { enabled: false }),
    sep('2'),
    item('3', 'Panes', { type: 'submenu', submenu: sub }),
    item('4', 'Settings'),
  ];
  const press = (nav: MenuNav, ...keys: string[]) => {
    let n = nav;
    let effect = null as ReturnType<typeof menuKey>['effect'];
    for (const k of keys) ({ nav: n, effect } = menuKey(n, k));
    return { nav: n, effect, active: n[n.length - 1].active };
  };

  it('opens on the first item by keyboard and on none by mouse', () => {
    expect(openNav(items, true)[0].active).toBe(0);
    expect(openNav(items, false)[0].active).toBe(-1);
  });

  it('moves with the arrows past separators, wrapping, and to the ends with Home and End', () => {
    const nav = openNav(items, true);
    expect(press(nav, 'ArrowDown').active).toBe(1);
    expect(press(nav, 'ArrowDown', 'ArrowDown').active).toBe(3);
    expect(press(nav, 'ArrowUp').active).toBe(4);
    expect(press(nav, 'End').active).toBe(4);
    expect(press(nav, 'End', 'Home').active).toBe(0);
    expect(press(openNav(items, false), 'ArrowDown').active).toBe(0);
  });

  it('opens a submenu with Right or Enter and closes it with Left or Esc', () => {
    const nav = press(openNav(items, true), 'End', 'ArrowUp').nav;
    const opened = press(nav, 'ArrowRight');
    expect(opened.nav).toHaveLength(2);
    expect(opened.active).toBe(0);
    expect(press(nav, 'Enter').nav).toHaveLength(2);
    expect(press(opened.nav, 'ArrowLeft').nav).toHaveLength(1);
    expect(press(opened.nav, 'Escape')).toMatchObject({ effect: null });
    expect(press(opened.nav, 'Escape').nav).toHaveLength(1);
  });

  it('picks with Enter or Space, not a disabled item; Esc at the top closes', () => {
    const nav = openNav(items, true);
    expect(press(nav, 'Enter').effect).toEqual({ kind: 'pick', item: items[0] });
    expect(press(nav, ' ').effect).toEqual({ kind: 'pick', item: items[0] });
    expect(press(nav, 'ArrowDown', 'Enter').effect).toBeNull();
    expect(press(nav, 'Escape').effect).toEqual({ kind: 'close' });
    expect(press(nav, 'Tab').effect).toEqual({ kind: 'close' });
  });

  it('Left and Right past the edge ask for the neighbouring menu bar menu', () => {
    const nav = openNav(items, true);
    expect(press(nav, 'ArrowLeft').effect).toEqual({ kind: 'prev' });
    expect(press(nav, 'ArrowRight').effect).toEqual({ kind: 'next' });
  });

  it('jumps to the next item starting with a typed letter', () => {
    const nav = openNav(items, true);
    expect(press(nav, 's').active).toBe(4);
    expect(press(nav, 'P').active).toBe(3);
    expect(press(nav, 'i').active).toBe(1);
    expect(press(nav, 'z').active).toBe(0);
  });

  it('hovering moves the highlight and opens a submenu without highlighting in it', () => {
    const nav = menuHover(openNav(items, false), 0, 3);
    expect(nav).toHaveLength(2);
    expect(nav[1].active).toBe(-1);
    expect(menuHover(nav, 0, 4)).toHaveLength(1);
  });

  it('a checkbox pick reports the state it turns to', () => {
    expect(pickChecked(sub[0])).toBe(false);
    expect(pickChecked(sub[1])).toBe(true);
    expect(pickChecked(items[0])).toBeUndefined();
  });
});

describe('accelerators', () => {
  const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

  it('reads Electron accelerators, CmdOrCtrl as Ctrl (Cmd on a Mac)', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+N', false)).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'n' });
    expect(parseAccelerator('CmdOrCtrl+N', true)).toMatchObject({ ctrl: false, meta: true });
    expect(parseAccelerator('Shift+F5', false)).toMatchObject({ shift: true, key: 'f5' });
    expect(parseAccelerator('Esc', false)).toMatchObject({ key: 'escape' });
    expect(parseAccelerator('CmdOrCtrl+,', false)).toMatchObject({ ctrl: true, key: ',' });
    expect(parseAccelerator('Ctrl+Plus', false)).toMatchObject({ key: '+' });
    expect(parseAccelerator('Hyper+X', false)).toBeNull();
    expect(parseAccelerator('Ctrl+', false)).toBeNull();
  });

  it('matches a key press exactly, modifiers included, by the key or the physical key', () => {
    const ctrlN = parseAccelerator('CmdOrCtrl+N', false)!;
    expect(eventMatches(ctrlN, key('n', 'KeyN', { ctrlKey: true }))).toBe(true);
    expect(eventMatches(ctrlN, key('N', 'KeyN', { ctrlKey: true }))).toBe(true);
    expect(eventMatches(ctrlN, key('n', 'KeyN', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(eventMatches(ctrlN, key('n', 'KeyN'))).toBe(false);
    // A layout where the key gives another character still matches the key under it.
    expect(eventMatches(ctrlN, key('т', 'KeyN', { ctrlKey: true }))).toBe(true);
    expect(eventMatches(parseAccelerator('CmdOrCtrl+,', false)!, key('<', 'Comma', { ctrlKey: true }))).toBe(true);
    expect(eventMatches(parseAccelerator('F5', false)!, key('F5', 'F5'))).toBe(true);
    expect(eventMatches(parseAccelerator('Shift+F5', false)!, key('F5', 'F5'))).toBe(false);
  });

  it('finds the item in the front window menus, leaving registerAccelerator:false and roles to the page', () => {
    const menu: MenuItemSpec[] = [
      item('0', 'File', {
        type: 'submenu',
        submenu: [item('0.0', 'New Task', { accelerator: 'CmdOrCtrl+N' }), item('0.1', 'Settings', { accelerator: 'CmdOrCtrl+,' })],
      }),
      item('1', 'Task', {
        type: 'submenu',
        submenu: [
          item('1.0', 'Run Now', { accelerator: 'F5', enabled: false }),
          item('1.1', 'Close Tab', { accelerator: 'CmdOrCtrl+W', registerAccelerator: false }),
          item('1.2', 'Copy', { role: 'copy', accelerator: 'CmdOrCtrl+C' }),
        ],
      }),
    ];
    expect(findAccelerator(menu, key(',', 'Comma', { ctrlKey: true }), false)?.id).toBe('0.1');
    // Disabled, but still its key: the frame keeps F5 from reloading the tab.
    expect(findAccelerator(menu, key('F5', 'F5'), false)).toMatchObject({ id: '1.0', enabled: false });
    expect(findAccelerator(menu, key('w', 'KeyW', { ctrlKey: true }), false)).toBeNull();
    expect(findAccelerator(menu, key('c', 'KeyC', { ctrlKey: true }), false)).toBeNull();
    expect(findAccelerator(menu, key('n', 'KeyN', { metaKey: true }), false)).toBeNull();
    expect(findAccelerator(menu, key('n', 'KeyN', { metaKey: true }), true)?.id).toBe('0.0');
  });

  it('shows shortcut text, with the edit roles’ own keys', () => {
    expect(shortcutText(item('a', 'x', { accelerator: 'CmdOrCtrl+Shift+N' }), false)).toBe('Ctrl+Shift+N');
    expect(shortcutText(item('a', 'x', { accelerator: 'CmdOrCtrl+N' }), true)).toBe('Cmd+N');
    expect(shortcutText(item('a', 'x', { accelerator: 'Shift+F6' }), false)).toBe('Shift+F6');
    expect(shortcutText(item('a', 'x', { accelerator: 'Esc' }), false)).toBe('Esc');
    expect(shortcutText(item('a', 'x', { accelerator: 'CmdOrCtrl+,' }), false)).toBe('Ctrl+,');
    expect(shortcutText(item('a', 'x', { role: 'paste' }), false)).toBe('Ctrl+V');
    expect(shortcutText(item('a', 'x'), false)).toBe('');
  });
});

// ---------- dialogs ----------

describe('dialog results', () => {
  it('message boxes: the response and checkbox, Esc giving cancelId (else the last button)', () => {
    expect(messageResult(1, true)).toEqual({ kind: 'message', response: 1, checkboxChecked: true });
    expect(messageCancelId({ message: 'm', buttons: ['Yes', 'No'], cancelId: 0 })).toBe(0);
    expect(messageCancelId({ message: 'm', buttons: ['Save', "Don't Save", 'Cancel'] })).toBe(2);
    expect(messageDefaultId({ message: 'm', buttons: ['A', 'B'], defaultId: 1 })).toBe(1);
    expect(messageDefaultId({ message: 'm', buttons: ['A', 'B'], defaultId: 5 })).toBe(0);
  });

  it('file dialogs: picked paths, a save path, This Device, and cancels', () => {
    expect(openResult(['C:\\a.txt'])).toEqual({ kind: 'open', canceled: false, filePaths: ['C:\\a.txt'] });
    expect(openResult([])).toEqual(openCanceled);
    expect(saveToComputer('C:\\x\\t.loopertask')).toEqual({ kind: 'save', canceled: false, filePath: 'C:\\x\\t.loopertask' });
    expect(saveToDevice('t.loopertask')).toEqual({ kind: 'save', canceled: false, deliver: true, filePath: 't.loopertask' });
    expect(saveCanceled).toEqual({ kind: 'save', canceled: true });
  });

  it('the server takes each shape as it is, and This Device keeps the name the user typed', async () => {
    const sent: ServerMessage[] = [];
    const client = new RemoteClient('c', { id: 'd', name: 'Phone' }, 'web', { dir: tmp(), offerDownload: () => 't', log: { error: () => undefined, warn: () => undefined } });
    client.setConnection((m) => {
      sent.push(m);
      return true;
    });
    const win = client.openWindow({ hash: '', title: 'Looper', width: 100, height: 100, resizable: true, modal: false, parent: null });
    const last = () => (sent.filter((m) => m.t === 'dialog').at(-1) as Extract<ServerMessage, { t: 'dialog' }>).dialogId;
    const m = client.dialog(win, 'message', { message: 'Delete?', buttons: ['Yes', 'No'], cancelId: 1 });
    client.answer(last(), messageResult(0, false));
    expect(await m).toEqual({ kind: 'message', response: 0, checkboxChecked: false });
    const o = client.dialog(win, 'open', { properties: ['openDirectory'] });
    client.answer(last(), openResult(['C:\\proj']));
    expect(await o).toEqual({ kind: 'open', canceled: false, filePaths: ['C:\\proj'] });
    const s = client.dialog(win, 'save', {});
    client.answer(last(), saveToDevice('mine.md'));
    expect(await s).toEqual({ kind: 'save', canceled: false, deliver: true, filePath: 'mine.md' });
    const c = client.dialog(win, 'save', {});
    client.answer(last(), saveToComputer('C:\\x.md'));
    expect(await c).toEqual({ kind: 'save', canceled: false, filePath: 'C:\\x.md' });
  });
});

describe('file dialog choice flow', () => {
  it('offers This Device except for folders, and opens on the source last used for the kind', () => {
    expect(fileSources('open', { properties: ['openFile'] })).toEqual(['computer', 'device']);
    expect(fileSources('open', { properties: ['openDirectory'] })).toEqual(['computer']);
    expect(fileSources('save', {})).toEqual(['computer', 'device']);
    expect(initialSource('open', { properties: ['openFile'] }, 'device')).toBe('device');
    expect(initialSource('open', { properties: ['openDirectory'] }, 'device')).toBe('computer');
    expect(initialSource('save', {}, null)).toBe('computer');
    expect(initialSource('save', {}, 'nonsense')).toBe('computer');
  });

  it('turns the filters into an accept list, a filter line and the files shown', () => {
    const filters = [{ name: 'Looper Task', extensions: ['loopertask'] }];
    expect(acceptAttr(filters)).toBe('.loopertask');
    expect(acceptAttr([{ name: 'All files', extensions: ['*'] }])).toBeUndefined();
    expect(acceptAttr(undefined)).toBeUndefined();
    expect(allowedExtensions([{ name: 'A', extensions: ['MD', '.txt'] }])).toEqual(['md', 'txt']);
    expect(filterLabel(filters)).toBe('Looper Task (*.loopertask)');
    expect(filterLabel(undefined)).toBe('All files (*.*)');
    const entries = [
      { name: 'sub', path: '/x/sub', dir: true },
      { name: 'a.loopertask', path: '/x/a.loopertask', dir: false },
      { name: 'b.md', path: '/x/b.md', dir: false },
    ];
    expect(visibleEntries(entries, { files: true, extensions: ['loopertask'] }).map((e) => e.name)).toEqual(['sub', 'a.loopertask']);
    expect(visibleEntries(entries, { files: false, extensions: null }).map((e) => e.name)).toEqual(['sub']);
    expect(visibleEntries(entries, { files: true, extensions: null })).toHaveLength(3);
  });

  it('Save As fills in the name, starts in the default folder and adds the extension', () => {
    expect(splitDefaultPath('task-1.loopertask')).toEqual({ dir: null, name: 'task-1.loopertask' });
    expect(splitDefaultPath('C:\\Users\\me\\a.md')).toEqual({ dir: 'C:\\Users\\me', name: 'a.md' });
    expect(splitDefaultPath('C:\\a.md')).toEqual({ dir: 'C:\\', name: 'a.md' });
    expect(splitDefaultPath('/home/me/a.md')).toEqual({ dir: '/home/me', name: 'a.md' });
    expect(splitDefaultPath(undefined)).toEqual({ dir: null, name: '' });
    expect(withExtension('report', [{ name: 'Markdown', extensions: ['md'] }])).toBe('report.md');
    expect(withExtension('report.MD', [{ name: 'Markdown', extensions: ['md'] }])).toBe('report.MD');
    expect(withExtension('report', undefined)).toBe('report');
    expect(joinPath('C:\\', 'x')).toBe('C:\\x');
    expect(joinPath('C:\\Users', 'x')).toBe('C:\\Users\\x');
    expect(joinPath('\\\\wsl.localhost\\Ubuntu\\home', 'x')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\x');
    expect(joinPath('/home', 'x')).toBe('/home/x');
  });

  it('shows the path as clickable parts after This Computer', () => {
    expect(breadcrumbs(null)).toEqual([{ label: 'This Computer', path: null }]);
    expect(breadcrumbs('C:\\Users\\me').map((c) => [c.label, c.path])).toEqual([
      ['This Computer', null],
      ['C:', 'C:\\'],
      ['Users', 'C:\\Users'],
      ['me', 'C:\\Users\\me'],
    ]);
    expect(breadcrumbs('\\\\wsl.localhost\\Ubuntu\\home').map((c) => [c.label, c.path])).toEqual([
      ['This Computer', null],
      ['wsl.localhost\\Ubuntu', '\\\\wsl.localhost\\Ubuntu\\'],
      ['home', '\\\\wsl.localhost\\Ubuntu\\home'],
    ]);
    expect(breadcrumbs('/home/me').map((c) => c.path)).toEqual([null, '/', '/home', '/home/me']);
  });

  it('checks a new folder name before asking the computer', () => {
    expect(folderNameError('New folder')).toBeNull();
    expect(folderNameError('  ')).toMatch(/Type a name/);
    expect(folderNameError('a/b')).toMatch(/can't contain/);
    expect(folderNameError('a\\b')).toMatch(/can't contain/);
    expect(folderNameError('..')).toMatch(/\.\./);
    expect(folderNameError('a?')).toMatch(/characters/);
  });
});

// ---------- the window stack ----------

describe('shell window stack', () => {
  const open = (w: string, extra: Partial<Extract<ServerMessage, { t: 'window-open' }>> = {}): ShellMessage =>
    ({ t: 'window-open', w, modal: false, hash: w === 'main' ? '' : w, title: w, width: 400, height: 300, resizable: true, ...extra }) as ShellMessage;
  const run = (...msgs: ShellMessage[]): ShellState => msgs.reduce(reduceShell, initialShellState);

  it('keeps the windows back to front, a focused one coming forward', () => {
    let s = run(open('main'), open('editor'), open('templates'));
    expect(childStack(s).map((x) => x.w)).toEqual(['editor', 'templates']);
    expect(frontWindow(s)?.w).toBe('templates');
    s = reduceShell(s, { t: 'window-focus', w: 'editor' });
    expect(childStack(s).map((x) => x.w)).toEqual(['templates', 'editor']);
    expect(frontWindow(s)?.w).toBe('editor');
    s = reduceShell(s, { t: 'window-focus', w: 'main' });
    expect(frontWindow(s)?.w).toBe('main');
    expect(mainWindow(s)?.w).toBe('main');
    s = reduceShell(s, { t: 'window-close', w: 'editor' });
    expect(s.order).toEqual(['templates', 'main']);
  });

  it('a modal window stays in front and blocks every other one', () => {
    let s = run(open('main'), open('settings', { modal: true, parent: 'main' }), open('editor'));
    expect(childStack(s).map((x) => x.w)).toEqual(['editor', 'settings']);
    expect(topModal(s)?.w).toBe('settings');
    expect(frontWindow(s)?.w).toBe('settings');
    expect(isBlocked(s, 'main')).toBe(true);
    expect(isBlocked(s, 'editor')).toBe(true);
    expect(isBlocked(s, 'settings')).toBe(false);
    s = reduceShell(s, { t: 'window-close', w: 'settings' });
    expect(isBlocked(s, 'main')).toBe(false);
  });

  it('a new route reloads the iframe, and a re-sent spec keeps its menu', () => {
    let s = run(open('main'), open('builder-setup'), { t: 'window-menu', w: 'builder-setup', menu: [] });
    s = reduceShell(s, open('builder-setup', { width: 1180, height: 760, hash: 'builder-setup' }));
    s = reduceShell(s, { t: 'window-load', w: 'builder-setup', hash: 'builder/b1' });
    const win = s.windows.find((x) => x.w === 'builder-setup')!;
    expect([win.hash, win.nonce, win.width, win.menu]).toEqual(['builder/b1', 1, 1180, []]);
  });

  it('queues toasts (a few at most) and path requests, and drops windows on reset', () => {
    let s = run(open('main'));
    for (let i = 0; i < 6; i++) s = reduceShell(s, { t: 'notify', title: `t${i}`, body: '', taskId: 'task' });
    expect(s.toasts.map((t) => t.title)).toEqual(['t2', 't3', 't4', 't5']);
    s = reduceShell(s, { t: 'toast-done', id: s.toasts[0].id });
    expect(s.toasts).toHaveLength(3);
    s = reduceShell(s, { t: 'show-path', path: 'C:\\x', isDir: true });
    expect(s.paths).toMatchObject([{ path: 'C:\\x', isDir: true }]);
    s = reduceShell(s, { t: 'reset' });
    expect([s.windows, s.order, s.paths]).toEqual([[], [], []]);
  });

  it('a lost connection drops the popup menu; reconnecting counts as a reconnect', () => {
    let s = run(open('main'), { t: 'menu', menuId: 'm1', w: 'main', items: [] });
    s = reduceShell(s, { t: 'connected', connected: true });
    expect(s.everConnected).toBe(true);
    s = reduceShell(s, { t: 'connected', connected: false });
    expect(s.menus).toEqual([]);
    expect(s.everConnected).toBe(true);
  });
});

// ---------- main-process pieces ----------

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-web-shell-'));
  tmpDirs.push(d);
  return d;
}

describe('New Folder on the computer', () => {
  const deps: HostFilesDeps = { host: 'posix', places: () => [], distros: async () => [], defaultDistro: () => undefined, convert: async () => undefined };

  it('makes the folder and answers its path', async () => {
    const dir = tmp();
    expect(await makeDir(deps, dir, ' New folder ')).toBe(path.join(dir, 'New folder'));
    expect(fs.statSync(path.join(dir, 'New folder')).isDirectory()).toBe(true);
  });

  it('refuses separators, dot names, empty names and a name already there', async () => {
    const dir = tmp();
    await expect(makeDir(deps, dir, 'a/b')).rejects.toThrow(/can't contain/);
    await expect(makeDir(deps, dir, 'a\\b')).rejects.toThrow(/can't contain/);
    await expect(makeDir(deps, dir, '..')).rejects.toThrow(/can't be a folder name/);
    await expect(makeDir(deps, dir, '')).rejects.toThrow(/Type a name/);
    await expect(makeDir(deps, '', 'x')).rejects.toThrow(/No folder/);
    fs.mkdirSync(path.join(dir, 'taken'));
    await expect(makeDir(deps, dir, 'taken')).rejects.toThrow(/already/);
    expect(fs.readdirSync(dir)).toEqual(['taken']);
  });
});

describe('served index.html', () => {
  const html = `<meta\n      http-equiv="Content-Security-Policy"\n      content="default-src 'self'; script-src 'self'"\n    />`;

  it("adds the WebSocket's address to the meta CSP", () => {
    expect(withConnectSrc(html, 'localhost:38123')).toContain(`content="default-src 'self'; script-src 'self'; connect-src 'self' ws://localhost:38123 wss://localhost:38123"`);
    const has = html.replace("script-src 'self'", "connect-src 'self' https://x");
    expect(withConnectSrc(has, 'h.ts.net')).toContain("connect-src 'self' https://x ws://h.ts.net wss://h.ts.net");
    expect(withConnectSrc(html, null)).toBe(html);
  });
});
