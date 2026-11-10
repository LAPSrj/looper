import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../src/shared/remote-access';
import { decodeBytes, encodeBytes } from '../src/main/platform/bytes';
import { RemoteClients, type ConnectionLike } from '../src/main/platform/clients';
import { caller, runAs, type CallContext } from '../src/main/platform/context';
import { SaveDelivery } from '../src/main/platform/deliver';
import { fromHostPath, joinFlavor, listDir, parentFlavor, toHostPath, type HostFilesDeps } from '../src/main/platform/host-files';
import { IpcTable, type IpcMainLike } from '../src/main/platform/ipc-table';
import { pickItem, serializeMenu, stripMnemonic, type MenuItemLike } from '../src/main/platform/menus';
import { RemoteClient, RemoteWindow } from '../src/main/platform/remote-window';
import { WindowSlots } from '../src/main/platform/slots';
import { decodeBytes as webDecode, encodeBytes as webEncode } from '../src/renderer/src/web/session';

const tmpDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-platform-'));
  tmpDirs.push(d);
  return d;
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A Remote Access connection after its hello; what it sends goes through JSON, as on the wire. */
function fakeConn(clientId?: string, device = { id: 'dev1', name: 'Phone' }, pageId?: string) {
  const sent: ServerMessage[] = [];
  let onMsg: (m: ClientMessage) => void = () => undefined;
  const closeCbs: (() => void)[] = [];
  const conn: ConnectionLike & { closes: number; sent: ServerMessage[]; deliver(m: ClientMessage): void; drop(): void; of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] } = {
    device,
    platform: 'web',
    clientId,
    pageId,
    closes: 0,
    sent,
    send(m) {
      sent.push(JSON.parse(JSON.stringify(m)));
      return true;
    },
    onMessage(cb) {
      onMsg = cb;
      return () => (onMsg = () => undefined);
    },
    onClose(cb) {
      closeCbs.push(cb);
      return () => undefined;
    },
    close() {
      conn.closes++;
    },
    deliver: (m) => onMsg(m),
    drop: () => closeCbs.splice(0).forEach((c) => c()),
    of: (t) => sent.filter((m) => m.t === t) as never,
  };
  return conn;
}

function setup(ipc = new IpcTable(), graceMs?: number) {
  const offers: { file: string; name: string; onDone: () => void }[] = [];
  const clients = new RemoteClients({
    ipc,
    log,
    version: '9.9.9',
    dir: tmp(),
    offerDownload: (file, name, onDone) => {
      offers.push({ file, name, onDone });
      return `tok${offers.length}`;
    },
    ...(graceMs !== undefined ? { graceMs } : {}),
    deliveryQuietMs: 50,
  });
  return { clients, ipc, offers };
}

let loneCount = 0;

/** A client of its own, for tests that need a window without the dispatcher. */
function lone(): { client: RemoteClient; win: RemoteWindow; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const client = new RemoteClient(`c${++loneCount}`, { id: 'd', name: 'Phone' }, 'web', { dir: tmp(), offerDownload: () => 't', log });
  client.setConnection((m) => {
    sent.push(JSON.parse(JSON.stringify(m)));
    return true;
  });
  const win = client.openWindow({ role: 'workspace', hash: '', title: 'Looper', width: 1400, height: 900, resizable: true, modal: false, parent: null });
  client.main = win;
  return { client, win, sent };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('bytes', () => {
  it('round-trips Uint8Arrays as { $bytes } and leaves other values alone', () => {
    const data = new Uint8Array([1, 2, 250]);
    const plain = { a: [1, { b: 'x' }] };
    expect(encodeBytes(plain)).toBe(plain);
    const enc = encodeBytes({ files: [{ name: 'p.png', data }], n: 3 }) as { files: { data: { $bytes: string } }[] };
    expect(enc.files[0].data).toEqual({ $bytes: Buffer.from(data).toString('base64') });
    const dec = decodeBytes(JSON.parse(JSON.stringify(enc))) as { files: { data: Uint8Array }[]; n: number };
    expect(dec.files[0].data).toBeInstanceOf(Uint8Array);
    expect([...dec.files[0].data]).toEqual([1, 2, 250]);
    expect(dec.n).toBe(3);
  });

  it('encodes bytes in an object every time it appears, not only the first', () => {
    const shared = { name: 'p.png', data: new Uint8Array([7, 8]) };
    const enc = encodeBytes({ a: shared, list: [shared, shared] }) as { a: { data: unknown }; list: { data: unknown }[] };
    const want = { $bytes: Buffer.from([7, 8]).toString('base64') };
    expect(enc.a.data).toEqual(want);
    expect(enc.list[0].data).toEqual(want);
    expect(enc.list[1].data).toEqual(want);
    expect(shared.data).toBeInstanceOf(Uint8Array);
  });
});

describe('IPC table', () => {
  it('mirrors registrations into ipcMain and runs a remote invoke with the window as sender', async () => {
    const calls: string[] = [];
    const electron: IpcMainLike = {
      handle: (c) => void calls.push(`handle ${c}`),
      on: (c) => void calls.push(`on ${c}`),
      removeHandler: (c) => void calls.push(`removeHandler ${c}`),
      removeListener: (c) => void calls.push(`removeListener ${c}`),
    };
    const ipc = new IpcTable(electron);
    const { client, win } = lone();
    let seen: { sender: unknown; ctx: CallContext | undefined; arg: unknown } | null = null;
    ipc.handle('files:put', async (e, file: { data: Uint8Array }) => {
      await flush();
      seen = { sender: e.sender, ctx: caller(), arg: file.data };
      return { echo: file.data };
    });
    const r = await ipc.invoke({ client, window: win }, 'files:put', [{ data: { $bytes: Buffer.from('hi').toString('base64') } }]);
    expect(seen!.sender).toBe(win.webContents);
    expect(seen!.ctx?.window).toBe(win);
    expect(seen!.arg).toBeInstanceOf(Uint8Array);
    expect(r).toEqual({ ok: true, value: { echo: { $bytes: Buffer.from('hi').toString('base64') } } });
    expect(() => ipc.handle('files:put', () => 1)).toThrow(/second handler/);
    ipc.removeHandler('files:put');
    expect(calls).toEqual(['handle files:put', 'removeHandler files:put']);
  });

  it('answers an error with its plain message, and an unknown channel too', async () => {
    const ipc = new IpcTable();
    const { client, win } = lone();
    ipc.handle('boom', () => {
      throw new Error('The task is gone.');
    });
    expect(await ipc.invoke({ client, window: win }, 'boom', [])).toEqual({ ok: false, error: 'The task is gone.' });
    expect((await ipc.invoke({ client, window: win }, 'nope', [])).ok).toBe(false);
  });

  it('delivers an argument the web page left out as undefined, as Electron does, so default parameters apply', async () => {
    const ipc = new IpcTable();
    const { client, win } = lone();
    // Like runs:list and runs:messages: `runs.list(id)` and `runs.messages(id, runId, undefined, raw)`.
    ipc.handle('runs:list', (_e, id: string, limit = 200) => ({ id, limit }));
    ipc.handle('runs:messages', (_e, id: string, runId: string, agentId?: string, raw?: boolean) => [id, runId, agentId, raw]);
    // What the web client's Session puts on the wire, through JSON.
    const wire = (args: unknown[]) => JSON.parse(JSON.stringify(webEncode(args))) as unknown[];
    expect(await ipc.invoke({ client, window: win }, 'runs:list', wire(['t1', undefined]))).toEqual({ ok: true, value: { id: 't1', limit: 200 } });
    expect(await ipc.invoke({ client, window: win }, 'runs:list', wire(['t1', 50]))).toEqual({ ok: true, value: { id: 't1', limit: 50 } });
    const r = await ipc.invoke({ client, window: win }, 'runs:messages', wire(['t1', 'r1', undefined, false]));
    // And back: the answer's undefined reaches the page as undefined, a null stays null.
    expect(r.ok).toBe(true);
    expect(webDecode(JSON.parse(JSON.stringify(r.ok && r.value)))).toEqual(['t1', 'r1', undefined, false]);
    expect(webDecode(JSON.parse(JSON.stringify(encodeBytes([null, undefined]))))).toEqual([null, undefined]);
  });

  it('sends to every listener, even after one throws; removeListener takes one off', () => {
    const ipc = new IpcTable();
    const { client, win } = lone();
    const got: unknown[] = [];
    const errors: unknown[] = [];
    const a = (_e: unknown, x: unknown) => void got.push(['a', x]);
    ipc.on('ch', a);
    ipc.on('ch', () => {
      throw new Error('bad');
    });
    ipc.on('ch', (e, x) => void got.push(['c', x, (e.sender as unknown) === win.webContents, caller()?.client === client]));
    ipc.send({ client, window: win }, 'ch', [7], (err) => errors.push(err));
    expect(got).toEqual([['a', 7], ['c', 7, true, true]]);
    expect(errors).toHaveLength(1);
    ipc.removeListener('ch', a);
    got.length = 0;
    ipc.send({ client, window: win }, 'ch', [8], () => undefined);
    expect(got).toEqual([['c', 8, true, true]]);
  });
});

describe('menus', () => {
  /** Electron's MenuItem click wrapper: flip checkbox/radio, then the template's click(item, window, event). */
  function item(o: Partial<MenuItemLike> & { onClick?: (it: MenuItemLike, w: unknown) => void }): MenuItemLike {
    const it: MenuItemLike = {
      type: 'normal',
      enabled: true,
      visible: true,
      checked: false,
      ...o,
      click(event: unknown, w: unknown) {
        if (it.type === 'checkbox' || it.type === 'radio') it.checked = !it.checked;
        o.onClick?.(it, w);
        void event;
      },
    };
    return it;
  }

  it('serializes labels, ids, checks, accelerators and roles; leaves out quit, hidden items and stray separators', () => {
    const sep = () => item({ type: 'separator' });
    const menu = {
      items: [
        item({
          label: '&File',
          type: 'submenu',
          submenu: {
            items: [
              item({ label: '&New Task…', accelerator: 'CmdOrCtrl+N' }),
              sep(),
              sep(),
              item({ label: 'Hidden', visible: false }),
              item({ label: 'Fish && &Chips', enabled: false }),
              item({ label: 'Close &Window', accelerator: 'Alt+F4', registerAccelerator: false }),
              sep(),
              item({ label: 'E&xit', role: 'quit' }),
            ],
          },
        }),
        item({ label: '&Toolbar', type: 'checkbox', checked: true }),
        item({ label: '&Copy', role: 'copy' }),
      ],
    };
    const { items, byId } = serializeMenu(menu);
    expect(items).toEqual([
      {
        id: '0',
        type: 'submenu',
        label: 'File',
        access: 0,
        enabled: true,
        submenu: [
          { id: '0.0', type: 'normal', label: 'New Task…', access: 0, enabled: true, accelerator: 'CmdOrCtrl+N' },
          { id: '0.1', type: 'separator', enabled: true },
          { id: '0.4', type: 'normal', label: 'Fish & Chips', access: 7, enabled: false },
          { id: '0.5', type: 'normal', label: 'Close Window', access: 6, enabled: true, accelerator: 'Alt+F4', registerAccelerator: false },
        ],
      },
      { id: '1', type: 'checkbox', label: 'Toolbar', access: 0, enabled: true, checked: true },
      { id: '2', type: 'normal', label: 'Copy', access: 0, enabled: true, role: 'copy' },
    ]);
    expect(byId.get('0.0')?.label).toBe('&New Task…');
    expect(stripMnemonic('Save && E&xit')).toBe('Save & Exit');
    // The computer's own window draws its menu bar from the same data, and keeps Exit.
    const own = serializeMenu(menu, 'desktop', true).items[0].submenu!;
    expect(own[own.length - 1]).toEqual({ id: '0.7', type: 'normal', label: 'Exit', access: 1, enabled: true, role: 'quit' });
  });

  it('a pick runs the click as the caller, with the checkbox state the client reports', () => {
    const { client, win, sent } = lone();
    const clicks: unknown[] = [];
    const menu = {
      items: [
        item({ label: 'Toolbar', type: 'checkbox', checked: true, onClick: (it, w) => clicks.push([it.checked, w === win, caller()?.window === win]) }),
        item({ label: 'Off', enabled: false, onClick: () => clicks.push('disabled ran') }),
        item({ label: 'Copy', role: 'copy', onClick: () => clicks.push('role ran') }),
      ],
    };
    client.popup(win, menu, 10, 20);
    const m = sent.find((x) => x.t === 'menu') as Extract<ServerMessage, { t: 'menu' }>;
    expect(m).toMatchObject({ w: win.w, x: 10, y: 20 });
    client.pick(m.menuId, '0', false);
    client.pick(m.menuId, '0', false); // the popup is gone after its pick
    expect(clicks).toEqual([[false, true, true]]);
    // Disabled and role items don't run here.
    pickItem(menu.items[1], win, win.webContents);
    pickItem(menu.items[2], win, win.webContents);
    expect(clicks).toHaveLength(1);
  });

  it("a window's menu bar takes picks by menuId = w and stays", () => {
    const { client, win, sent } = lone();
    const clicks: string[] = [];
    win.setMenu({ items: [item({ label: 'File', type: 'submenu', submenu: { items: [item({ label: 'Settings…', onClick: () => clicks.push('settings') })] } })] });
    expect(sent.find((x) => x.t === 'window-menu')).toMatchObject({ w: win.w, menu: [{ id: '0', submenu: [{ id: '0.0', label: 'Settings…' }] }] });
    client.pick(win.w, '0.0', undefined);
    client.pick(win.w, '0.0', undefined);
    expect(clicks).toEqual(['settings', 'settings']);
  });
});

describe('call context', () => {
  it('carries through awaits and timers, and ends with the client', async () => {
    const { client, win } = lone();
    expect(caller()).toBeUndefined();
    const ctx = { client, window: win };
    const seen = await runAs(ctx, async () => {
      await flush();
      await new Promise((r) => setTimeout(r, 5));
      return caller();
    });
    expect(seen).toBe(ctx);
    expect(caller()).toBeUndefined();
    let later: CallContext | undefined | 'unset' = 'unset';
    runAs(ctx, () => setTimeout(() => (later = caller()), 5));
    client.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(later).toBeUndefined();
  });
});

describe('remote windows', () => {
  it('close emits close then closed and tells the client; a prevented close keeps it', () => {
    const { clients } = setup();
    const conn = fakeConn();
    clients.attach(conn);
    const main = clients.list()[0].main!;
    const events: string[] = [];
    let prevent = true;
    main.on('close', (e: { preventDefault(): void }) => {
      events.push('close');
      if (prevent) e.preventDefault();
    });
    main.on('closed', () => events.push('closed'));
    conn.deliver({ t: 'window-close', w: main.w });
    expect(events).toEqual(['close']);
    expect(main.isDestroyed()).toBe(false);
    expect(conn.of('window-close')).toHaveLength(0);
    prevent = false;
    conn.deliver({ t: 'window-closed-by-page', w: main.w });
    expect(events).toEqual(['close', 'close', 'closed']);
    expect(main.isDestroyed()).toBe(true);
    expect(conn.of('window-close')).toEqual([{ t: 'window-close', w: main.w }]);
  });

  it('closing a parent closes its children; ids never collide with Electron ones', () => {
    const { client, win } = lone();
    const child = client.openWindow({ role: 'editor', hash: 'settings', title: 'Settings', width: 720, height: 640, resizable: true, modal: true, parent: win });
    expect(win.id).toBeGreaterThanOrEqual(1_000_000);
    expect(child.spec()).toMatchObject({ parent: win.w, modal: true, hash: 'settings' });
    expect(child.getParentWindow()).toBe(win);
    const order: string[] = [];
    child.on('closed', () => order.push('child'));
    win.on('closed', () => order.push('main'));
    win.close();
    expect(order).toEqual(['child', 'main']);
    expect(client.main).toBeNull();
  });

  it('webContents.send becomes an event with encoded bytes; window-ready fires ready-to-show once and did-finish-load each time', () => {
    const { win, sent } = lone();
    win.webContents.send('ui:event', { type: 'x', data: new Uint8Array([9]) });
    expect(sent.at(-1)).toEqual({ t: 'event', w: win.w, channel: 'ui:event', args: [{ type: 'x', data: { $bytes: 'CQ==' } }] });
    const fired: string[] = [];
    win.on('ready-to-show', () => fired.push('ready'));
    win.webContents.on('did-finish-load', () => fired.push('load'));
    win.pageReady();
    win.pageReady();
    expect(fired).toEqual(['ready', 'load', 'load']);
    win.load('builder/b1');
    win.load('builder/b1');
    expect(sent.filter((m) => m.t === 'window-load')).toEqual([{ t: 'window-load', w: win.w, hash: 'builder/b1' }]);
  });
});

describe('dialogs', () => {
  it("resolves with the client's answer, checked; a malformed one counts as a cancel", async () => {
    const { client, win, sent } = lone();
    const p = client.dialog(win, 'message', { message: 'Delete?', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 });
    const d = sent.find((m) => m.t === 'dialog') as Extract<ServerMessage, { t: 'dialog' }>;
    client.answer(d.dialogId, { kind: 'message', response: 0, checkboxChecked: true });
    expect(await p).toEqual({ kind: 'message', response: 0, checkboxChecked: true });
    const q = client.dialog(win, 'message', { message: 'Delete?', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 });
    const d2 = sent.filter((m) => m.t === 'dialog').at(-1) as Extract<ServerMessage, { t: 'dialog' }>;
    client.answer(d2.dialogId, { kind: 'message', response: 7, checkboxChecked: false });
    expect((await q).response).toBe(1);
  });

  it('closing the client cancels open dialogs: a message box its cancelId, a file dialog canceled', async () => {
    const { client, win } = lone();
    const a = client.dialog(win, 'message', { message: 'Save?', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, destructiveId: 1 });
    const b = client.dialog(win, 'message', { message: 'Sure?', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 0 });
    const c = client.dialog(win, 'open', { properties: ['openFile'] });
    const s = client.dialog(win, 'save', {});
    client.dispose();
    expect((await a).response).toBe(2);
    expect((await b).response).toBe(0);
    expect(await c).toEqual({ kind: 'open', canceled: true, filePaths: [] });
    expect(await s).toEqual({ kind: 'save', canceled: true });
  });

  it('save to the device: the file is offered once written and quiet, then its folder goes after the download', async () => {
    const { clients, offers } = setup();
    const conn = fakeConn();
    clients.attach(conn);
    const client = clients.list()[0];
    const file = client.deliver('report.md');
    expect(file.endsWith(`${path.sep}report.md`)).toBe(true);
    expect(file.includes(`${path.sep}outgoing${path.sep}`)).toBe(true);
    fs.writeFileSync(file, 'hello');
    await vi.waitFor(() => expect(offers).toHaveLength(1), { timeout: 2000 });
    expect(conn.of('download')).toEqual([{ t: 'download', token: 'tok1', name: 'report.md' }]);
    offers[0].onDone();
    await vi.waitFor(() => expect(fs.existsSync(path.dirname(file))).toBe(false), { timeout: 2000 });
  });
});

describe('save delivery watcher', () => {
  it('waits until the file has stopped changing for the quiet time', () => {
    vi.useFakeTimers();
    const file = path.join(tmp(), 'out.txt');
    let ready = 0;
    let expired = 0;
    const w = new SaveDelivery({ file, quietMs: 500, pollMs: 100, maxAgeMs: 10_000, onReady: () => ready++, onExpire: () => expired++ });
    vi.advanceTimersByTime(1000); // nothing written yet
    expect(ready).toBe(0);
    fs.writeFileSync(file, 'a');
    vi.advanceTimersByTime(300);
    fs.appendFileSync(file, 'bb'); // still being written
    vi.advanceTimersByTime(300);
    expect(ready).toBe(0);
    vi.advanceTimersByTime(600);
    expect(ready).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(ready).toBe(1);
    expect(expired).toBe(0);
    w.stop();
  });

  it('gives up on a file that never comes', () => {
    vi.useFakeTimers();
    let expired = 0;
    new SaveDelivery({ file: path.join(tmp(), 'never.txt'), pollMs: 100, maxAgeMs: 1000, onReady: () => undefined, onExpire: () => expired++ });
    vi.advanceTimersByTime(1500);
    expect(expired).toBe(1);
  });
});

describe('dispatcher', () => {
  it('hello: welcome and the main window; invoke answers with the result', async () => {
    const { clients, ipc } = setup();
    ipc.handle('tasks:list', (e) => [{ id: 't1', sender: (e.sender as { id: number }).id }]);
    const mains: RemoteWindow[] = [];
    clients.onMainWindow((w) => mains.push(w));
    const conn = fakeConn();
    clients.attach(conn);
    expect(conn.sent[0]).toMatchObject({ t: 'welcome', device: { name: 'Phone' }, version: '9.9.9', resumed: false });
    const open = conn.of('window-open');
    expect(open).toEqual([{ t: 'window-open', w: mains[0].w, role: 'workspace', modal: false, hash: '', title: 'Looper', width: 1400, height: 900, resizable: true }]);
    conn.deliver({ t: 'invoke', id: 1, w: mains[0].w, channel: 'tasks:list', args: [] });
    await vi.waitFor(() => expect(conn.of('result')).toEqual([{ t: 'result', id: 1, ok: true, value: [{ id: 't1', sender: mains[0].id }] }]));
  });

  it('a window that closed while the tab was away goes when the tab reloads it or closes it', () => {
    const { clients } = setup();
    const first = fakeConn();
    clients.attach(first);
    const client = clients.list()[0];
    const id = (first.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    const editor = client.openWindow({ role: 'editor', hash: 'editor/x', title: 'Edit Task', width: 700, height: 600, resizable: true, modal: false, parent: null });
    first.drop();
    editor.close();
    const second = fakeConn(id);
    clients.attach(second);
    expect(second.of('window-open').map((m) => m.hash)).toEqual(['']);
    // The tab still shows it: its page loads again after the resume, or the user clicks its ×.
    second.deliver({ t: 'window-ready', w: editor.w });
    second.deliver({ t: 'window-close', w: editor.w });
    expect(second.of('window-close')).toEqual([
      { t: 'window-close', w: editor.w },
      { t: 'window-close', w: editor.w },
    ]);
  });

  it('resumes a client within its grace period, and closes its windows after it', () => {
    vi.useFakeTimers();
    const { clients } = setup(new IpcTable(), 1000);
    const first = fakeConn();
    clients.attach(first);
    const client = clients.list()[0];
    const id = (first.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    const settings = client.openWindow({ role: 'editor', hash: 'settings', title: 'Settings', width: 720, height: 640, resizable: true, modal: true, parent: client.main });
    settings.setMenu({ items: [{ label: 'View', type: 'normal', enabled: true, visible: true }] });
    const pending = client.dialog(settings, 'message', { message: 'Sure?', buttons: ['OK'], defaultId: 0, cancelId: 0 });
    first.drop();
    vi.advanceTimersByTime(900);
    // Back in time: the same windows, menus and the open dialog.
    const second = fakeConn(id);
    clients.attach(second);
    expect(second.sent[0]).toMatchObject({ t: 'welcome', clientId: id, resumed: true });
    expect(second.of('window-open').map((m) => m.hash)).toEqual(['', 'settings']);
    expect(second.of('window-menu')).toHaveLength(1);
    expect(second.of('dialog')).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(settings.isDestroyed()).toBe(false);
    // Gone for good: after the grace period its windows close and its dialogs cancel.
    second.drop();
    const closed: string[] = [];
    client.main!.on('closed', () => closed.push('main'));
    settings.on('closed', () => closed.push('settings'));
    vi.advanceTimersByTime(1000);
    expect(closed).toEqual(['settings', 'main']);
    expect(clients.list()).toHaveLength(0);
    const third = fakeConn(id);
    clients.attach(third);
    expect(third.sent[0]).toMatchObject({ t: 'welcome', resumed: false });
    expect((third.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId).not.toBe(id);
    return expect(pending).resolves.toMatchObject({ response: 0 });
  });

  it("another device's id, or a tab whose id is still connected, gets a new client", () => {
    const { clients } = setup();
    const a = fakeConn();
    clients.attach(a);
    const id = (a.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    const dup = fakeConn(id);
    clients.attach(dup);
    expect(dup.sent[0]).toMatchObject({ resumed: false });
    a.drop();
    const other = fakeConn(id, { id: 'dev2', name: 'Laptop' });
    clients.attach(other);
    expect(other.sent[0]).toMatchObject({ resumed: false });
  });

  it('the same page reconnecting before its old socket is noticed dead takes the client over', async () => {
    const { clients, ipc } = setup();
    let ran = 0;
    ipc.on('probe', () => void ran++);
    const old = fakeConn(undefined, undefined, 'page1');
    clients.attach(old);
    const id = (old.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    const client = clients.list()[0];
    const next = fakeConn(id, undefined, 'page1');
    clients.attach(next);
    expect(next.sent[0]).toMatchObject({ t: 'welcome', clientId: id, resumed: true });
    expect(next.of('window-open').map((m) => m.hash)).toEqual(['']);
    expect(old.closes).toBe(1);
    expect(clients.list()).toEqual([client]);
    // The old socket's late messages and its eventual close change nothing.
    old.deliver({ t: 'send', w: client.main!.w, channel: 'probe', args: [] });
    next.deliver({ t: 'send', w: client.main!.w, channel: 'probe', args: [] });
    old.drop();
    expect(ran).toBe(1);
    expect(client.connected).toBe(true);
    expect(client.disposed).toBe(false);
  });

  it('a reloaded page (a new pageId) gets its windows back once the old socket is gone', () => {
    const { clients } = setup();
    const old = fakeConn(undefined, undefined, 'page1');
    clients.attach(old);
    const id = (old.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    old.drop();
    const next = fakeConn(id, undefined, 'page2');
    clients.attach(next);
    expect(next.sent[0]).toMatchObject({ clientId: id, resumed: true });
    expect(old.closes).toBe(0);
  });

  it('a duplicated tab (same clientId, another pageId) is told apart from a reconnect', () => {
    const { clients } = setup();
    const a = fakeConn(undefined, undefined, 'page1');
    clients.attach(a);
    const id = (a.sent[0] as Extract<ServerMessage, { t: 'welcome' }>).clientId;
    const dup = fakeConn(id, undefined, 'page2');
    clients.attach(dup);
    expect(dup.sent[0]).toMatchObject({ resumed: false });
    expect(a.closes).toBe(0);
    expect(clients.list()).toHaveLength(2);
  });

  it('disconnectAll gives every client its grace period; disposeDevice closes that device\'s clients at once', () => {
    vi.useFakeTimers();
    const { clients } = setup(new IpcTable(), 1000);
    const a = fakeConn();
    const b = fakeConn(undefined, { id: 'dev2', name: 'Laptop' });
    clients.attach(a);
    clients.attach(b);
    const [ca, cb] = clients.list();
    const main = ca.main!;
    const pending = ca.dialog(main, 'message', { message: 'Sure?', buttons: ['OK'], defaultId: 0, cancelId: 0 });
    clients.disconnectAll();
    expect(ca.connected).toBe(false);
    expect(ca.disposed).toBe(false);
    a.drop();
    vi.advanceTimersByTime(900);
    expect(ca.disposed).toBe(false);
    clients.disposeDevice('dev1');
    expect(ca.disposed).toBe(true);
    expect(main.isDestroyed()).toBe(true);
    expect(clients.list()).toEqual([cb]);
    vi.advanceTimersByTime(5000);
    expect(cb.disposed).toBe(true);
    return expect(pending).resolves.toMatchObject({ response: 0 });
  });

  it("drops messages naming another client's windows, menus or dialogs", async () => {
    const { clients, ipc } = setup();
    let ran = 0;
    ipc.handle('tasks:remove', () => void ran++);
    ipc.on('context-menu:tasks-empty', () => void ran++);
    const a = fakeConn();
    const b = fakeConn(undefined, { id: 'dev2', name: 'Laptop' });
    clients.attach(a);
    clients.attach(b);
    const [ca, cb] = clients.list();
    const aw = ca.main!;
    const clicks: string[] = [];
    aw.setMenu({ items: [{ label: 'Delete', type: 'normal', enabled: true, visible: true, click: () => clicks.push('x') }] });
    const pending = ca.dialog(aw, 'message', { message: 'Delete?', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 });
    const d = a.of('dialog')[0];
    b.deliver({ t: 'invoke', id: 5, w: aw.w, channel: 'tasks:remove', args: ['t1'] });
    b.deliver({ t: 'send', w: aw.w, channel: 'context-menu:tasks-empty', args: [] });
    b.deliver({ t: 'menu-pick', menuId: aw.w, itemId: '0' });
    b.deliver({ t: 'dialog-result', dialogId: d.dialogId, result: { kind: 'message', response: 0, checkboxChecked: false } });
    b.deliver({ t: 'window-close', w: aw.w });
    await flush();
    expect(ran).toBe(0);
    expect(clicks).toEqual([]);
    expect(aw.isDestroyed()).toBe(false);
    expect(b.of('result')).toEqual([]);
    expect(cb.main!.isDestroyed()).toBe(false);
    // The owner still can.
    a.deliver({ t: 'dialog-result', dialogId: d.dialogId, result: { kind: 'message', response: 0, checkboxChecked: false } });
    expect((await pending).response).toBe(0);
  });
});

describe('host file browser', () => {
  const win: HostFilesDeps = {
    host: 'windows',
    places: () => [],
    distros: async () => ['Ubuntu'],
    defaultDistro: () => 'Ubuntu',
    convert: async () => undefined,
  };

  it('converts between a WSL environment and a Windows host without spawning wslpath', async () => {
    expect(await toHostPath('/home/me/proj', 'posix', win)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
    expect(await toHostPath('/', 'posix', win, 'Debian')).toBe('\\\\wsl.localhost\\Debian\\');
    expect(await toHostPath('/mnt/c/Users/me', 'posix', win)).toBe('C:\\Users\\me');
    expect(await toHostPath('C:\\x', 'posix', win)).toBeNull();
    expect(fromHostPath('\\\\wsl.localhost\\Ubuntu\\home\\me', 'posix', win)).toBe('/home/me');
    expect(fromHostPath('\\\\wsl$\\Ubuntu\\', 'posix', win)).toBe('/');
    expect(fromHostPath('\\\\wsl.localhost\\Debian\\home', 'posix', win, 'Ubuntu')).toBeNull();
    expect(fromHostPath('D:\\work\\a', 'posix', win)).toBe('/mnt/d/work/a');
    expect(fromHostPath('C:\\', 'posix', win)).toBe('/mnt/c');
  });

  it('joins and walks up in either flavor, stopping at a root', () => {
    expect(joinFlavor('C:\\', 'Users', 'windows')).toBe('C:\\Users');
    expect(joinFlavor('/home', 'me', 'posix')).toBe('/home/me');
    expect(parentFlavor('C:\\Users\\me', 'windows')).toBe('C:\\Users');
    expect(parentFlavor('C:\\Users', 'windows')).toBe('C:\\');
    expect(parentFlavor('C:\\', 'windows')).toBeNull();
    expect(parentFlavor('\\\\wsl.localhost\\Ubuntu\\', 'windows')).toBeNull();
    expect(parentFlavor('\\\\wsl.localhost\\Ubuntu\\home', 'windows')).toBe('\\\\wsl.localhost\\Ubuntu\\');
    expect(parentFlavor('/home/me', 'posix')).toBe('/home');
    expect(parentFlavor('/', 'posix')).toBeNull();
  });

  it('lists a folder, folders first, with paths in the asked flavor', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'b-folder'));
    fs.writeFileSync(path.join(dir, 'a-file.txt'), 'xyz');
    const posix: HostFilesDeps = { ...win, host: 'posix' };
    const r = await listDir(posix, dir);
    expect(r.path).toBe(dir);
    expect(r.parent).toBe(path.dirname(dir));
    expect(r.entries.map((e) => [e.name, e.dir, e.size])).toEqual([
      ['b-folder', true, undefined],
      ['a-file.txt', false, 3],
    ]);
    expect(r.entries[0].path).toBe(path.join(dir, 'b-folder'));
    expect(r.home).toBe(posix.home ?? os.homedir());
  });

  it('starts at Host Computer: home and its well-known folders, the drives, then the projects, each once', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'Documents'));
    fs.mkdirSync(path.join(dir, 'Downloads'));
    fs.mkdirSync(path.join(dir, 'proj'));
    const posix: HostFilesDeps = {
      ...win,
      host: 'posix',
      home: dir,
      places: () => [
        { name: 'Proj', cwd: path.join(dir, 'proj') },
        { name: 'At home', cwd: dir },
      ],
    };
    const start = await listDir(posix);
    expect(start.path).toBeNull();
    expect(start.home).toBe(dir);
    expect(start.entries.map((e) => [e.name, e.place])).toEqual([
      ['Home', 'home'],
      ['Documents', 'documents'],
      ['Downloads', 'downloads'],
      ['File System', 'drive'],
      ['Proj', 'project'],
    ]);
    // Electron's own place for a well-known folder wins over the one in home.
    const moved = path.join(dir, 'proj');
    const withKnown = await listDir({ ...posix, places: () => [], known: (k) => (k === 'documents' ? moved : undefined) });
    expect(withKnown.entries.find((e) => e.place === 'documents')?.path).toBe(moved);
  });
});

describe('window slots', () => {
  it('keeps one window per client and key', () => {
    const slots = new WindowSlots();
    const { client, win } = lone();
    const other = lone();
    const child = client.openWindow({ role: 'tool', hash: 'recycle-bin', title: 'Recycle Bin', width: 1, height: 1, resizable: true, modal: false, parent: null });
    runAs({ client, window: win }, () => slots.set(child));
    expect(runAs({ client, window: win }, () => slots.get())).toBe(child);
    expect(runAs({ client: other.client, window: other.win }, () => slots.get())).toBeUndefined();
    expect(slots.get()).toBeUndefined(); // the desktop has none
    expect(slots.all()).toEqual([child]);
    child.close();
    expect(slots.all()).toEqual([]);
  });
});
