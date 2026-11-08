import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLooperApi, type LooperTransport } from '../src/shared/api-client';
import { base64ToBytes, decodeBytes, encodeBytes, MAX_INLINE_FILE_BYTES, NOT_CONNECTED, Session, type ShellMessage, type SocketLike } from '../src/renderer/src/web/session';
import { guessDeviceName } from '../src/renderer/src/web/device-name';
import { initialShellState, reduceShell, windowSrc } from '../src/renderer/src/web/store';
import type { ServerMessage } from '../src/shared/remote-access';
import expected from './api-channels.json';

// ---------- the method → channel mapping ----------

/**
 * tests/api-channels.json was recorded by calling every function of the old
 * preload (ipcRenderer-based) with probe arguments; the shared client must
 * produce exactly the same IPC traffic and results.
 */
describe('createLooperApi', () => {
  const calls: unknown[][] = [];
  const replacer = (_: string, x: unknown) => (typeof x === 'function' ? 'fn' : x instanceof Uint8Array ? { u8: [...x] } : x);

  const files = [
    { name: 'f1.png', path: '/p/f1.png', arrayBuffer: async () => new Uint8Array([9]).buffer },
    { name: '', path: '', arrayBuffer: async () => new Uint8Array([1, 2]).buffer },
  ];

  const transport: LooperTransport = {
    invoke: (ch, ...a) => {
      calls.push(['invoke', ch, a]);
      return Promise.reject(new Error(`Error invoking remote method '${ch}': Error: boom ${ch}`));
    },
    send: (ch, ...a) => void calls.push(['send', ch, a]),
    on: (ch, cb) => {
      calls.push(['on', ch, [cb('x', 'y') ?? null]]);
      return () => void calls.push(['off', ch, []]);
    },
    files: async (fs) =>
      Promise.all(
        (fs as unknown as typeof files).map(async (f) =>
          f.path ? { name: f.name || f.path, path: f.path } : { name: f.name || 'pasted-image.png', data: new Uint8Array(await f.arrayBuffer()) },
        ),
      ),
    filePath: async (f) => (f as unknown as { path: string }).path,
  };

  const found: Record<string, { arity: number; calls: unknown; result: unknown }> = {};
  async function walk(obj: object, prefix: string): Promise<void> {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'function') {
        calls.length = 0;
        let r: unknown;
        if (p.endsWith('openLooperFile')) r = v(files[0]);
        else if (p.endsWith('attachFiles')) r = v('id', files);
        else if (/(^|\.)on(Event|Ui)$/.test(p)) r = v((...x: unknown[]) => x);
        else r = v(...Array.from({ length: Math.max(v.length, 1) }, (_, i) => `a${i}`));
        const result = await Promise.resolve(r).then(
          (x) => ({ ok: typeof x === 'function' ? 'unsub' : x }),
          (e: Error) => ({ err: e.message }),
        );
        found[p] = { arity: v.length, calls: JSON.parse(JSON.stringify(calls, replacer)), result: JSON.parse(JSON.stringify(result)) };
      } else if (v && typeof v === 'object') await walk(v, p);
    }
  }

  it('maps every method to the channel, arguments and error handling of the old preload', async () => {
    await walk(createLooperApi(transport), '');
    const want = JSON.parse(JSON.stringify(expected)) as typeof found;
    expect(Object.keys(found).sort()).toEqual(Object.keys(want).sort());
    for (const key of Object.keys(want)) expect(found[key], key).toEqual(want[key]);
  });
});

// ---------- bytes ----------

describe('bytes encoding', () => {
  it('round-trips Uint8Array anywhere in a value', () => {
    const v = { a: new Uint8Array([0, 1, 254, 255]), list: [{ b: new Uint8Array([]) }, 'x', 3, null], n: { deep: new Uint8Array(70000).fill(7) } };
    const enc = encodeBytes(v) as { a: { $bytes: string } };
    expect(enc.a).toEqual({ $bytes: 'AAH+/w==' });
    expect(JSON.parse(JSON.stringify(enc))).toEqual(enc);
    expect(decodeBytes(JSON.parse(JSON.stringify(enc)))).toEqual(v);
    expect(base64ToBytes('AAH+/w==')).toEqual(new Uint8Array([0, 1, 254, 255]));
  });

  it('leaves other values alone', () => {
    const v = { a: 1, b: ['x', { c: null }], $bytes: 5 };
    expect(decodeBytes(v)).toEqual(v);
    expect(encodeBytes(v)).toEqual(v);
  });
});

// ---------- session ----------

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.drop();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const welcome = (clientId = 'c1', resumed = false): ServerMessage => ({ t: 'welcome', device: { id: 'd', name: 'Phone' }, version: '1', clientId, resumed });

describe('Session', () => {
  let store: Record<string, string>;
  let session: Session;
  let fetchMock: ReturnType<typeof vi.fn>;
  const last = () => FakeSocket.all[FakeSocket.all.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    store = {};
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ path: 'C:\\up\\big.bin' }) }));
    session = new Session({
      wsUrl: 'ws://x/api/ws',
      createSocket: (u) => new FakeSocket(u),
      storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) },
      platform: 'ios',
      fetch: fetchMock as unknown as typeof fetch,
    });
  });
  afterEach(() => {
    session.stop();
    vi.useRealTimers();
  });

  function connect(clientId = 'c1', resumed = false) {
    last().open();
    last().receive(welcome(clientId, resumed));
  }

  it('says hello with its platform, keeps the welcome clientId, and sends it again later', () => {
    session.start();
    last().open();
    expect(last().sent).toEqual([{ t: 'hello', platform: 'ios', pageId: expect.any(String) }]);
    last().receive(welcome('abc'));
    expect(store['looper.clientId']).toBe('abc');
    expect(session.isConnected()).toBe(true);
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().sent[0]).toEqual({ t: 'hello', platform: 'ios', clientId: 'abc', pageId: expect.any(String) });
  });

  it('keeps one pageId for the page load, in memory only, and sends X-Looper-Request with an upload', async () => {
    session.start();
    last().open();
    const pageId = last().sent[0].pageId as string;
    expect(pageId).toMatch(/^[0-9a-f]{24}$/);
    last().receive(welcome('abc'));
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().sent[0].pageId).toBe(pageId);
    expect(Object.values(store)).not.toContain(pageId);
    await session.upload(new File(['x'], 'a.txt'));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'X-Looper-Request': '1' } });
  });

  it('routes results by id, decoding bytes and turning errors into rejections', async () => {
    session.start();
    connect();
    const api = session.apiFor('w1');
    const a = api.readEngineLog();
    const b = api.canGuideRun('t', 'r');
    const sent = last().sent.filter((m) => m.t === 'invoke');
    expect(sent.map((m) => [m.w, m.channel, m.args])).toEqual([
      ['w1', 'engineLog:read', []],
      ['w1', 'run:canGuide', ['t', 'r']],
    ]);
    last().receive({ t: 'result', id: sent[1].id, ok: false, error: 'nope' });
    last().receive({ t: 'result', id: sent[0].id, ok: true, value: { $bytes: 'AQI=' } });
    await expect(a).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(b).rejects.toThrow('nope');
  });

  it('encodes bytes in invoke and send args', () => {
    session.start();
    connect();
    const t = session.transportFor('w1');
    t.invoke('x', new Uint8Array([1, 2])).catch(() => undefined);
    t.send('y', { d: new Uint8Array([3]) });
    expect(last().sent.slice(1).map((m) => m.args)).toEqual([[{ $bytes: 'AQI=' }], [{ d: { $bytes: 'Aw==' } }]]);
  });

  it('delivers events to the window they are for, with bytes decoded, until unsubscribed', () => {
    session.start();
    connect();
    const one = vi.fn();
    const two = vi.fn();
    const off = session.transportFor('w1').on('engine:event', one);
    session.transportFor('w2').on('engine:event', two);
    last().receive({ t: 'event', w: 'w1', channel: 'engine:event', args: [{ k: { $bytes: 'AQ==' } }] });
    expect(one).toHaveBeenCalledWith({ k: new Uint8Array([1]) });
    expect(two).not.toHaveBeenCalled();
    off();
    last().receive({ t: 'event', w: 'w1', channel: 'engine:event', args: [1] });
    expect(one).toHaveBeenCalledTimes(1);
    session.releaseWindow('w2');
    last().receive({ t: 'event', w: 'w2', channel: 'engine:event', args: [1] });
    expect(two).not.toHaveBeenCalled();
  });

  it('rejects invoke and drops send while disconnected, and rejects calls in flight when the connection drops', async () => {
    session.start();
    await expect(session.invoke('w', 'c', [])).rejects.toThrow(NOT_CONNECTED);
    connect();
    const inFlight = session.invoke('w', 'c', []);
    const sock = last();
    sock.drop();
    await expect(inFlight).rejects.toThrow(NOT_CONNECTED);
    const before = sock.sent.length;
    session.send('w', 'c', []);
    session.closeWindow('w');
    expect(sock.sent.length).toBe(before);
    await expect(session.invoke('w', 'c', [])).rejects.toThrow(NOT_CONNECTED);
  });

  it('reconnects after 0.5 s, 1 s, 2 s, 3 s, 3 s while visible, and starts over once welcomed', () => {
    session.start();
    expect(FakeSocket.all.length).toBe(1);
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = FakeSocket.all.length;
      last().drop();
      let waited = 0;
      while (FakeSocket.all.length === n) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([500, 1000, 2000, 3000, 3000]);
    connect();
    const n = FakeSocket.all.length;
    last().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('tells the shell to start over after a reconnect that was not resumed, and to reload after one that was', () => {
    const seen: string[] = [];
    session.onShell((m: ShellMessage) => seen.push(m.t));
    session.start();
    connect('c1');
    last().drop();
    vi.advanceTimersByTime(1000);
    connect('c2', false);
    last().drop();
    vi.advanceTimersByTime(1000);
    connect('c2', true);
    expect(seen).toEqual(['welcome', 'welcome', 'reset', 'welcome', 'resumed']);
    expect(store['looper.clientId']).toBe('c2');
  });

  it('emits shell messages, reports connection changes, and pings every 25 s', () => {
    const seen: ServerMessage[] = [];
    const conn: boolean[] = [];
    session.onShell((m) => seen.push(m as ServerMessage));
    session.onConnection((c) => conn.push(c));
    session.start();
    connect();
    last().receive({ t: 'clipboard', text: 'hi' });
    last().receive({ t: 'pong' });
    expect(seen.map((m) => m.t)).toEqual(['welcome', 'clipboard']);
    vi.advanceTimersByTime(25_000);
    last().receive({ t: 'pong' });
    vi.advanceTimersByTime(25_000);
    last().receive({ t: 'pong' });
    expect(last().sent.filter((m) => m.t === 'ping').length).toBe(2);
    last().drop();
    expect(conn).toEqual([true, false]);
  });

  it('sends shell actions in the wire format', () => {
    session.start();
    connect();
    session.pick('m1', 'i1', true);
    session.dismiss('m1');
    session.dialogResult('d1', { kind: 'message', response: 1, checkboxChecked: false });
    session.closeWindow('w');
    session.focusWindow('w');
    session.windowReady('w');
    session.pageClosed('w');
    session.setTitle('w', 'T');
    expect(last().sent.slice(1)).toEqual([
      { t: 'menu-pick', menuId: 'm1', itemId: 'i1', checked: true },
      { t: 'menu-dismiss', menuId: 'm1' },
      { t: 'dialog-result', dialogId: 'd1', result: { kind: 'message', response: 1, checkboxChecked: false } },
      { t: 'window-close', w: 'w' },
      { t: 'window-focus', w: 'w' },
      { t: 'window-ready', w: 'w' },
      { t: 'window-closed-by-page', w: 'w' },
      { t: 'window-title', w: 'w', title: 'T' },
    ]);
  });

  it('sends small files inside the message and uploads big ones', async () => {
    session.start();
    connect();
    const t = session.transportFor('w');
    const small = new File([new Uint8Array([5, 6])], '');
    const big = new File([new Uint8Array(MAX_INLINE_FILE_BYTES + 1)], 'big file.bin');
    const out = await t.files([small, big]);
    expect(out).toEqual([{ name: 'pasted-image.png', data: new Uint8Array([5, 6]) }, { name: 'big file.bin', path: 'C:\\up\\big.bin' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload?name=big%20file.bin');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: big });
    await expect(t.filePath(small)).resolves.toBe('C:\\up\\big.bin');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/upload?name=upload');
  });

  it('reports a failed upload', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 413, json: async () => ({}) });
    await expect(session.upload(new File([new Uint8Array(1)], 'a.bin'))).rejects.toThrow('a.bin');
  });
});

// ---------- shell state and small helpers ----------

describe('reduceShell', () => {
  const open = (w: string, hash = ''): ServerMessage => ({ t: 'window-open', w, role: 'tool', modal: false, hash, title: w, width: 100, height: 100, resizable: true });

  it('tracks windows, menus and dialogs', () => {
    let s = initialShellState;
    s = reduceShell(s, open('w1') as ShellMessage);
    s = reduceShell(s, open('w2', 'settings') as ShellMessage);
    s = reduceShell(s, { t: 'window-menu', w: 'w1', menu: [] });
    s = reduceShell(s, { t: 'window-title', w: 'w2', title: 'Settings' });
    s = reduceShell(s, { t: 'menu', menuId: 'm', w: 'w1', items: [], x: 1, y: 2 });
    s = reduceShell(s, { t: 'dialog', dialogId: 'd', w: 'w2', kind: 'message', spec: { message: 'm', buttons: ['OK'], defaultId: 0, cancelId: 0 } });
    expect(s.windows.map((x) => [x.w, x.title, x.menu])).toEqual([['w1', 'w1', []], ['w2', 'Settings', null]]);
    expect(s.menus).toHaveLength(1);
    expect(s.dialogs).toHaveLength(1);
    s = reduceShell(s, { t: 'window-close', w: 'w2' });
    expect(s.windows.map((x) => x.w)).toEqual(['w1']);
    expect(s.dialogs).toHaveLength(0);
    s = reduceShell(s, { t: 'resumed' });
    expect(s.windows[0].nonce).toBe(1);
    s = reduceShell(s, { t: 'reset' });
    expect(s.windows).toEqual([]);
    expect(s.menus).toEqual([]);
  });

  it('addresses a window by id with its route in the hash', () => {
    expect(windowSrc({ w: 'a b', hash: 'settings' } as never)).toBe('/index.html?w=a%20b#settings');
    expect(windowSrc({ w: 'w1', hash: '' } as never)).toBe('/index.html?w=w1');
  });
});

describe('guessDeviceName', () => {
  it('names phones and browsers', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('iPhone');
    expect(guessDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5)).toBe('iPad');
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537')).toBe('Android phone');
    expect(guessDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36')).toBe('Chrome on Windows');
    expect(guessDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows');
    expect(guessDeviceName('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Firefox on Linux');
  });
});
