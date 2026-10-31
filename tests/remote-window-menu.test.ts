import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ServerMessage } from '../src/shared/remote-access';
import type { MenuItemLike } from '../src/main/platform/menus';
import { RemoteClient } from '../src/main/platform/remote-window';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function lone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-menu-'));
  dirs.push(dir);
  const sent: ServerMessage[] = [];
  const client = new RemoteClient('c1', { id: 'd', name: 'Phone' }, 'web', { dir, offerDownload: () => 't', log: quiet });
  client.setConnection((m) => {
    sent.push(JSON.parse(JSON.stringify(m)));
    return true;
  });
  const win = client.openWindow({ hash: '', title: 'Looper', width: 1400, height: 900, resizable: true, modal: false, parent: null });
  client.main = win;
  return { client, win, menus: () => sent.filter((m) => m.t === 'window-menu') };
}

const file = (label: string, click?: Function): MenuItemLike => ({ label, type: 'submenu', enabled: true, visible: true, submenu: { items: [{ label: 'Open', type: 'normal', enabled: true, visible: true, click }] } });

it('setMenu sends a menu bar once, and again only when its items differ', () => {
  const { win, menus } = lone();
  win.setMenu({ items: [file('File')] });
  expect(menus()).toHaveLength(1);
  win.setMenu({ items: [file('File')] });
  expect(menus()).toHaveLength(1);
  win.setMenu({ items: [file('Task')] });
  expect(menus()).toHaveLength(2);
  win.setMenu(null);
  expect(menus()).toHaveLength(3);
  win.setMenu({ items: [file('Task')] });
  expect(menus()).toHaveLength(4);
});

it('a skipped setMenu still points picks at the new menu items', () => {
  const { client, win, menus } = lone();
  const clicks: string[] = [];
  win.setMenu({ items: [file('File', () => clicks.push('old'))] });
  win.setMenu({ items: [file('File', () => clicks.push('new'))] });
  expect(menus()).toHaveLength(1);
  client.pick(win.w, '0.0', undefined);
  expect(clicks).toEqual(['new']);
});
