import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../src/shared/remote-access';
import type { EngineEvent } from '../src/shared/types';
import { RemoteClients, CLIENT_GRACE_MS, PHONE_GRACE_MS, type ConnectionLike } from '../src/main/platform/clients';
import { IpcTable } from '../src/main/platform/ipc-table';
import { startupBitmap, startupSize, STARTUP_SIZES } from '../src/main/remote-access/startup-bitmap';
import { entryKey, memoryBackend, OfflineStore, READ_CHANNELS, SWEEP_DELAY_MS, type OfflineBackend, type StoredShell } from '../src/renderer/src/web/offline-store';
import { NOT_CONNECTED, Session, type SessionEnv, type ShellMessage, type SocketLike } from '../src/renderer/src/web/session';
import { reduceShell, restoreShell, ShellStore, storedShell, initialShellState } from '../src/renderer/src/web/store';

afterEach(() => {
  vi.useRealTimers();
});

// ---------- the store ----------

const open = (backend: OfflineBackend | null = memoryBackend(), version = '1.0.0') => OfflineStore.open({ version, backend });

const sessionsState = (...ids: string[]) => ({ sessions: ids.map((id) => ({ id, taskId: `task-${id}`, waiting: undefined })), limits: {} });

describe('the offline store', () => {
  it('keeps the answer of a read by its channel and arguments, bytes included', async () => {
    const store = await open();
    const bytes = new Uint8Array([1, 2, 250]);
    store.put('attachment:thumbnail', ['C:\\a.png'], { data: bytes });
    store.put('runs:list', ['t1', undefined], [{ runId: 'r1' }]);
    expect((store.get('attachment:thumbnail', ['C:\\a.png'])!.value as { data: Uint8Array }).data).toBe(bytes);
    expect(store.get('runs:list', ['t1', undefined])?.value).toEqual([{ runId: 'r1' }]);
    expect(store.get('runs:list', ['t1'])).toBeUndefined();
    expect(entryKey('runs:list', ['t1'])).toBe('runs:list\0["t1"]');
    expect(store.reads('tasks:list')).toBe(true);
    expect(store.reads('runtime:runNow')).toBe(false);
    for (const c of READ_CHANNELS) expect(c).not.toMatch(/runNow|save|remove|stop|close/);
  });

  it('writes what changed and loads it back, in a later page load', async () => {
    const backend = memoryBackend();
    const store = await open(backend);
    store.put('tasks:list', [], [{ id: 'a' }]);
    store.setShell({ windows: [], order: [], focused: null, minimized: [] });
    store.setLastLive(123);
    await store.flush();
    const again = await open(backend);
    expect(again.get('tasks:list', [])?.value).toEqual([{ id: 'a' }]);
    expect(again.shell()).toEqual({ windows: [], order: [], focused: null, minimized: [] });
    expect(again.lastLive()).toBe(123);
  });

  it('batches writes and flushes them when asked', async () => {
    vi.useFakeTimers();
    const backend = memoryBackend();
    const store = await open(backend);
    store.put('tasks:list', [], []);
    expect(backend.entries.size).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(backend.entries.size).toBe(1);
  });

  it('finds data of another app version invalid and clears it', async () => {
    const backend = memoryBackend();
    const old = await open(backend, '1.0.0');
    old.put('tasks:list', [], [{ id: 'a' }]);
    await old.flush();
    const next = await open(backend, '1.0.1');
    expect(next.get('tasks:list', [])).toBeUndefined();
    await next.flush();
    expect(backend.entries.size).toBe(0);
    expect(backend.meta?.version).toBe('1.0.1');
  });

  it('works in memory when IndexedDB fails', async () => {
    const broken: OfflineBackend = { load: () => Promise.reject(new Error('private mode')), save: () => Promise.reject(new Error('private mode')) };
    const store = await open(broken);
    store.put('tasks:list', [], [1]);
    await store.flush();
    expect(store.get('tasks:list', [])?.value).toEqual([1]);
  });

  it("clears everything when another device's welcome comes, and on clear()", async () => {
    const backend = memoryBackend();
    const store = await open(backend);
    store.welcome('d1');
    store.put('tasks:list', [], [1]);
    store.setShell({ windows: [], order: [], focused: null, minimized: [] });
    await store.flush();
    store.welcome('d1');
    expect(store.size).toBe(1);
    store.welcome('d2');
    expect([store.size, store.shell()]).toEqual([0, null]);
    await store.flush();
    expect(backend.entries.size).toBe(0);
    expect(backend.meta?.deviceId).toBe('d2');
    store.put('tasks:list', [], [2]);
    await store.clear();
    expect([store.size, backend.entries.size, backend.meta?.deviceId]).toEqual([0, 0, null]);
  });

  describe('events', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }] as never;

    it('update the answers already stored and never make one', async () => {
      const store = await open();
      store.put('tasks:list', [], []);
      store.put('folders:layout', [], {});
      store.put('info', [], { version: '1', settings: { view: 1 } });
      store.put('chat:get', ['c1'], { id: 'c1', rows: [] });
      store.put('sessions:activity', ['c1'], { id: 'c1', background: [] });
      store.put('runtime:list', [], [{ taskId: 'a', state: 'idle' }]);
      store.applyEvent({ type: 'tasks', tasks });
      store.applyEvent({ type: 'folders', folders: [] as never, layout: { f: ['a'] } });
      store.applyEvent({ type: 'projects', projects: [] });
      store.applyEvent({ type: 'settings', settings: { view: 2 } as never });
      store.applyEvent({ type: 'chat', state: { id: 'c1', rows: [1] } as never });
      store.applyEvent({ type: 'chat', state: { id: 'other', rows: [] } as never });
      store.applyEvent({ type: 'session:activity', activity: { id: 'c1', background: [1] } as never });
      store.applyEvent({ type: 'runtime', runtime: { taskId: 'a', state: 'running' } as never });
      store.applyEvent({ type: 'runtime', runtime: { taskId: 'b', state: 'idle' } as never });
      expect(store.get('tasks:list', [])?.value).toBe(tasks);
      expect(store.get('folders:layout', [])?.value).toEqual({ f: ['a'] });
      expect(store.get('info', [])?.value).toEqual({ version: '1', settings: { view: 2 } });
      expect(store.get('chat:get', ['c1'])?.value).toEqual({ id: 'c1', rows: [1] });
      expect(store.get('chat:get', ['other'])).toBeUndefined();
      expect(store.get('projects:list', [])).toBeUndefined();
      expect(store.get('sessions:activity', ['c1'])?.value).toEqual({ id: 'c1', background: [1] });
      expect(store.get('runtime:list', [])?.value).toEqual([
        { taskId: 'a', state: 'running' },
        { taskId: 'b', state: 'idle' },
      ]);
    });

    it('a record or a version re-asks the answers it affects, through the window that read them, once the events stop', async () => {
      vi.useFakeTimers();
      const store = await open();
      store.welcome('d1');
      store.put('runs:list', ['t1', 500], [], 'w-main');
      store.put('runs:list', ['t2', 500], [], 'w-main');
      store.put('runs:recent', [10, { hideSkipped: false, hideNoAction: false }], [], 'w-main');
      store.put('runs:messages', ['t1', 'r1'], { rows: [] }, 'w-run');
      store.put('versions:list', ['t1'], [], 'w-versions');
      store.put('versions:detail', ['t1', 3, false], {}, 'w-versions');
      store.put('runs:output', ['t1', 'r9'], 'x');
      const asked: unknown[][] = [];
      store.setRefresher((w, channel, args) => void asked.push([w, channel, args]));
      store.applyEvent({ type: 'record', record: { taskId: 't1', runId: 'r1' } as never });
      await vi.advanceTimersByTimeAsync(1500);
      store.applyEvent({ type: 'record', record: { taskId: 't1', runId: 'r1' } as never });
      store.applyEvent({ type: 'versions', taskId: 't1' });
      await vi.advanceTimersByTimeAsync(1999);
      expect(asked).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked.map((a) => `${a[0]} ${a[1]}`).sort()).toEqual(['w-main runs:list', 'w-main runs:recent', 'w-run runs:messages', 'w-versions versions:detail', 'w-versions versions:list']);
      expect(asked.find((a) => a[1] === 'runs:list')![2]).toEqual(['t1', 500]);
    });
  });

  describe('the sweep', () => {
    const seed = async () => {
      const store = await open();
      store.welcome('d1');
      return store;
    };
    const stored = (store: OfflineStore) => store.keys().map((e) => `${e.channel} ${JSON.stringify(e.args)}`).sort();

    it('drops what the connection no longer uses, 30 s after the welcome', async () => {
      vi.useFakeTimers();
      const store = await seed();
      store.put('tasks:list', [], [{ id: 't1' }]);
      store.put('sessions:state', [], sessionsState('c1'));
      store.put('runs:recent', [10, {}], [{ taskId: 't1', runId: 'r1' }]);
      store.put('runs:list', ['t1', 500], [{ runId: 'r2' }]);
      store.put('runs:list', ['gone', 500], [{ runId: 'r3' }]);
      store.put('runs:messages', ['t1', 'r1'], 1);
      store.put('runs:messages', ['t1', 'r2'], 1);
      store.put('runs:messages', ['t1', 'old'], 1);
      store.put('runs:messages', ['task-c1', 'c1', 'agent1'], 1);
      store.put('runs:output', ['gone', 'r3'], 1);
      store.put('versions:list', ['gone'], 1);
      store.put('chat:get', ['c1'], 1);
      store.put('chat:get', ['c2'], 1);
      store.put('sessions:activity', ['c2'], 1);
      store.put('sessions:backgroundOutput', ['c2', 'b1'], 1);
      store.put('sessions:fileThumbnail', ['t1', 'a.png'], 1);
      store.put('addons:list', [], []);
      store.setLastLive(1);
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS + 1);
      expect(stored(store)).toEqual(
        [
          'addons:list []',
          'chat:get ["c1"]',
          'runs:list ["t1",500]',
          'runs:messages ["t1","r1"]',
          'runs:messages ["t1","r2"]',
          'runs:messages ["task-c1","c1","agent1"]',
          'runs:recent [10,{}]',
          'sessions:fileThumbnail ["t1","a.png"]',
          'sessions:state []',
          'tasks:list []',
        ].sort(),
      );
    });

    it('drops other keyed answers nothing read in this connection, and keeps what it read again', async () => {
      vi.useFakeTimers();
      const store = await seed();
      store.put('sessions:fileThumbnail', ['t1', 'old.png'], 'a');
      store.put('sessions:fileThumbnail', ['t1', 'used.png'], 'b');
      store.put('versions:detail', ['t1', 1, false], 'c');
      store.put('info', [], {});
      store.welcome('d1');
      expect(store.get('sessions:fileThumbnail', ['t1', 'used.png'])?.value).toBe('b');
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS + 1);
      expect(stored(store)).toEqual(['info []', 'sessions:fileThumbnail ["t1","used.png"]']);
    });

    it('a rule needing the sessions or the tasks waits for that list to arrive in this connection', async () => {
      vi.useFakeTimers();
      const backend = memoryBackend();
      const before = await open(backend);
      before.welcome('d1');
      before.put('sessions:state', [], sessionsState('c1'));
      before.put('tasks:list', [], [{ id: 't1' }]);
      before.put('chat:get', ['c2'], 1);
      before.put('runs:list', ['gone', 500], []);
      await before.flush();
      const store = await open(backend);
      store.welcome('d1');
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS + 1);
      expect(stored(store)).toEqual(['chat:get ["c2"]', 'runs:list ["gone",500]', 'sessions:state []', 'tasks:list []']);
      store.applyEvent({ type: 'sessions', state: sessionsState('c1') as never });
      store.sweep();
      expect(stored(store)).not.toContain('chat:get ["c2"]');
      expect(stored(store)).toContain('runs:list ["gone",500]');
      store.applyEvent({ type: 'tasks', tasks: [{ id: 't1' }] as never });
      store.sweep();
      expect(stored(store)).not.toContain('runs:list ["gone",500]');
    });

    it("doesn't sweep once the connection is gone", async () => {
      vi.useFakeTimers();
      const store = await seed();
      store.put('sessions:fileThumbnail', ['t1', 'a.png'], 1);
      store.welcome('d1');
      store.disconnected();
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS + 1);
      expect(store.size).toBe(1);
    });
  });
});

// ---------- the session without the computer ----------

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The network took the connection away. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  ofType<T extends ClientMessage['t']>(t: T): Extract<ClientMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as never;
  }
}

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const welcome = (over: Partial<Extract<ServerMessage, { t: 'welcome' }>> = {}): ServerMessage => ({ t: 'welcome', device: { id: 'd1', name: 'Phone' }, version: '1.0.0', clientId: 'c1', resumed: false, ...over });

async function start(env: Partial<SessionEnv> = {}, backend: OfflineBackend | null = memoryBackend()) {
  const offline = await open(backend);
  const sockets: FakeSocket[] = [];
  const shell: ShellMessage[] = [];
  const session = new Session({
    wsUrl: 'ws://localhost/api/ws',
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: memoryStorage(),
    platform: 'ios',
    fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
    visible: () => true,
    offline,
    ...env,
  });
  session.onShell((m) => shell.push(m));
  session.start();
  const connect = (msg: ServerMessage = welcome()) => {
    const s = sockets[sockets.length - 1];
    s.open();
    s.receive(msg);
    return s;
  };
  const answer = (socket: FakeSocket, value: unknown, which = -1) => {
    const inv = socket.ofType('invoke').at(which)!;
    socket.receive({ t: 'result', id: inv.id, ok: true, value });
  };
  const dialogs = () => shell.filter((m): m is Extract<ShellMessage, { t: 'dialog' }> => m.t === 'dialog');
  return { session, offline, sockets, shell, connect, answer, dialogs };
}

describe('a session while the computer is out of reach', () => {
  it('answers a read from what it kept, and rejects a read it has no answer for', async () => {
    const { session, connect, answer } = await start();
    const socket = connect();
    const p = session.invoke('w1', 'tasks:list', []);
    answer(socket, [{ id: 'a' }]);
    expect(await p).toEqual([{ id: 'a' }]);
    expect(session.isStale()).toBe(false);
    socket.drop();
    expect(session.isStale()).toBe(true);
    expect(await session.invoke('w1', 'tasks:list', [])).toEqual([{ id: 'a' }]);
    await expect(session.invoke('w1', 'runs:list', ['t1'])).rejects.toThrow(NOT_CONNECTED);
  });

  it('answers a read pending at the drop from what it kept, and rejects any other call', async () => {
    const { session, connect, answer, sockets } = await start();
    const socket = connect();
    const first = session.invoke('w1', 'projects:list', []);
    answer(socket, [{ id: 'p' }]);
    await first;
    const read = session.invoke('w1', 'projects:list', []);
    const miss = session.invoke('w1', 'folders:list', []);
    const write = session.invoke('w1', 'tasks:save', [{}]);
    socket.drop();
    expect(await read).toEqual([{ id: 'p' }]);
    await expect(miss).rejects.toThrow(NOT_CONNECTED);
    await expect(write).rejects.toThrow(NOT_CONNECTED);
    expect(sockets).toHaveLength(1);
  });

  it('keeps events in the store, so the next stale answer is current', async () => {
    const { session, connect, answer } = await start();
    const socket = connect();
    const p = session.invoke('w1', 'tasks:list', []);
    answer(socket, [{ id: 'a' }]);
    await p;
    session.on('w1', 'engine:event', () => undefined);
    socket.receive({ t: 'event', w: 'w1', channel: 'engine:event', args: [{ type: 'tasks', tasks: [{ id: 'a' }, { id: 'b' }] as never } satisfies EngineEvent] });
    socket.drop();
    expect(await session.invoke('w1', 'tasks:list', [])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('shows one local alert for a call that needs the computer, and the next one after it is answered', async () => {
    const { session, connect, dialogs } = await start();
    connect().drop();
    await expect(session.invoke('w1', 'runtime:runNow', ['t1'])).rejects.toThrow(NOT_CONNECTED);
    await expect(session.invoke('w1', 'runtime:pause', ['t1'])).rejects.toThrow(NOT_CONNECTED);
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]).toMatchObject({ dialogId: 'local-1', w: 'w1', kind: 'message', spec: { type: 'warning', title: 'Looper', message: 'Not connected to the host computer.', detail: 'Looper keeps trying to reconnect.', buttons: ['OK'] } });
    session.dialogResult('local-1', { kind: 'message', response: 0, checkboxChecked: false });
    await expect(session.invoke('w1', 'runtime:pause', ['t1'])).rejects.toThrow(NOT_CONNECTED);
    expect(dialogs().map((d) => d.dialogId)).toEqual(['local-1', 'local-2']);
  });

  it('answers a local alert without posting anything', async () => {
    const { session, sockets, connect } = await start();
    const first = connect();
    first.drop();
    await expect(session.invoke('w1', 'runtime:runNow', ['t1'])).rejects.toThrow();
    session.dialogResult('local-1', { kind: 'message', response: 0, checkboxChecked: false });
    const next = sockets[sockets.length - 1];
    next.open();
    expect(next.ofType('dialog-result')).toEqual([]);
  });

  it('shows the message of dialog:error in the local alert, and answers dialog:confirm as cancelled', async () => {
    const { session, connect, dialogs } = await start();
    connect().drop();
    await expect(session.invoke('w1', 'dialog:error', ['Could not save.'])).resolves.toBeUndefined();
    expect(dialogs()[0].spec).toMatchObject({ type: 'error', message: 'Could not save.', buttons: ['OK'] });
    expect(dialogs()[0].spec).not.toHaveProperty('detail', expect.any(String));
    session.dialogResult('local-1', { kind: 'message', response: 0, checkboxChecked: false });
    await expect(session.invoke('w1', 'dialog:error', ["Can't save the task.", 'Name: must not be empty\nPrompt: must not be empty'])).resolves.toBeUndefined();
    expect(dialogs()[1].spec).toMatchObject({ message: "Can't save the task.", detail: 'Name: must not be empty\nPrompt: must not be empty' });
    session.dialogResult('local-2', { kind: 'message', response: 0, checkboxChecked: false });
    await expect(session.invoke('w1', 'dialog:confirm', ['Delete it?'])).resolves.toBe(false);
    expect(dialogs()[2].spec).toMatchObject({ message: 'Not connected to the host computer.' });
  });

  it('shows the alert for a menu item picked while disconnected, and posts nothing', async () => {
    const { session, connect, dialogs, sockets } = await start();
    const socket = connect();
    session.pick('w1', '0.1');
    expect(socket.ofType('menu-pick')).toHaveLength(1);
    socket.drop();
    session.pick('w1', '0.1');
    expect(dialogs()).toHaveLength(1);
    expect(sockets.flatMap((s) => s.ofType('menu-pick'))).toHaveLength(1);
  });

  it('shows the alert for a chat message sent while disconnected, but not for a draft the page saves on its own', async () => {
    const { session, connect, dialogs } = await start();
    connect().drop();
    session.send('w1', 'chat:draft', ['c1', 'hel', []]);
    expect(dialogs()).toHaveLength(0);
    session.send('w1', 'chat:send', ['c1', 'hello', []]);
    expect(dialogs()).toHaveLength(1);
  });

  it('closes a window at once while disconnected, and tells the computer on reconnect', async () => {
    const { session, connect } = await start();
    const closed: string[] = [];
    session.onShell((m) => void (m.t === 'window-close' && closed.push(m.w)));
    connect().drop();
    session.closeWindow('w2');
    expect(closed).toEqual(['w2']);
    session.retryNow();
    const next = connect(welcome({ resumed: true }));
    expect(next.ofType('window-close')).toEqual([{ t: 'window-close', w: 'w2' }]);
  });

  it('remembers when the data was last live', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T14:32:00'));
    const { session, connect, offline } = await start();
    expect(session.lastLive()).toBeNull();
    const socket = connect();
    const at = Date.now();
    expect(session.lastLive()).toBe(at);
    await vi.advanceTimersByTimeAsync(2000);
    socket.drop();
    expect(session.lastLive()).toBe(at);
    expect(offline.lastLive()).toBe(at);
  });

  it('puts the number of waiting sessions on the app icon', async () => {
    const badges: number[] = [];
    const { session, connect, answer } = await start({ setBadge: (n) => void badges.push(n) });
    const socket = connect();
    const waiting = { reason: 'turn', text: 'Done', since: 1 };
    const p = session.invoke('w1', 'sessions:state', []);
    answer(socket, { sessions: [{ id: 'a', waiting }, { id: 'b' }], limits: {} });
    await p;
    socket.receive({ t: 'event', w: 'w1', channel: 'engine:event', args: [{ type: 'sessions', state: { sessions: [{ id: 'a', waiting }, { id: 'b', waiting }], limits: {} } }] });
    socket.receive({ t: 'event', w: 'w1', channel: 'engine:event', args: [{ type: 'sessions', state: { sessions: [{ id: 'a' }], limits: {} } }] });
    expect(badges).toEqual([1, 2, 0]);
  });

  it('puts the stored count on the icon at start', async () => {
    const backend = memoryBackend();
    const store = await open(backend);
    store.put('sessions:state', [], { sessions: [{ id: 'a', waiting: { reason: 'turn', text: '', since: 1 } }], limits: {} });
    await store.flush();
    const badges: number[] = [];
    await start({ setBadge: (n) => void badges.push(n) }, backend);
    expect(badges).toEqual([1]);
  });
});

describe('a session checking its connection', () => {
  it('drops a socket that answers no ping within 3 s of check(), and connects again at once', async () => {
    vi.useFakeTimers();
    const { session, connect, sockets } = await start();
    const socket = connect();
    session.check();
    expect(socket.ofType('ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(socket.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closed).toBe(true);
    expect(session.isConnected()).toBe(false);
    expect(sockets).toHaveLength(2);
  });

  it('keeps a socket that answers, whatever the message', async () => {
    vi.useFakeTimers();
    const { session, connect, sockets } = await start();
    const socket = connect();
    session.check();
    socket.receive({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.closed).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(session.isConnected()).toBe(true);
  });

  it('check() with no socket connects now and resets the back-off', async () => {
    vi.useFakeTimers();
    const { session, sockets } = await start();
    sockets[0].drop();
    sockets[0].drop();
    expect(sockets).toHaveLength(1);
    session.retryNow();
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(3);
  });

  it('coming back to the app checks the connection', async () => {
    vi.useFakeTimers();
    const { session, connect } = await start();
    const socket = connect();
    session.setVisible(false);
    session.setVisible(true);
    expect(socket.ofType('visibility').map((m) => m.visible)).toEqual([false, true]);
    expect(socket.ofType('ping')).toHaveLength(1);
  });

  it('the regular ping drops a socket silent for 10 s', async () => {
    vi.useFakeTimers();
    const { connect, sockets } = await start();
    const socket = connect();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.ofType('ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(socket.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closed).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it('retries after 0.5, 1, 2 and then 3 s while the page is visible', async () => {
    vi.useFakeTimers();
    const { sockets } = await start();
    for (const [delay, count] of [[500, 2], [1000, 3], [2000, 4], [3000, 5], [3000, 6]] as const) {
      sockets[sockets.length - 1].drop();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count);
    }
  });

  it('retries after 1, 2, 5 and then 10 s while the page is hidden', async () => {
    vi.useFakeTimers();
    const { sockets } = await start({ visible: () => false });
    for (const [delay, count] of [[1000, 2], [2000, 3], [5000, 4], [10_000, 5], [10_000, 6]] as const) {
      sockets[sockets.length - 1].drop();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count);
    }
  });
});

describe('a session meeting a server of another version', () => {
  it('reloads the page once per server version, and carries on when the reload brings no change', async () => {
    const reload = vi.fn();
    const { session, connect } = await start({ version: '1.0.0', reload, sessionStorage: memoryStorage() });
    const socket = connect(welcome({ version: '1.1.0' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.isConnected()).toBe(false);
    socket.receive(welcome({ version: '1.1.0' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.isConnected()).toBe(true);
  });

  it('a server of the same version reloads nothing', async () => {
    const reload = vi.fn();
    const { session, connect } = await start({ version: '1.0.0', reload });
    connect();
    expect(reload).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
  });

  it('a stored device that is another one finds the data gone', async () => {
    const { offline, connect } = await start();
    connect(welcome({ device: { id: 'd1', name: 'Phone' } }));
    offline.put('tasks:list', [], [1]);
    connect(welcome({ device: { id: 'd2', name: 'Phone' } }));
    expect(offline.get('tasks:list', [])).toBeUndefined();
  });
});

// ---------- launching without the computer ----------

const stored: StoredShell = {
  windows: [
    { w: 'main', role: 'workspace', modal: false, hash: '', title: 'Looper', width: 1400, height: 900, resizable: true, menu: [{ id: '0', type: 'normal', label: 'New Task', enabled: true }] },
    { w: 'chat1', role: 'workspace', parent: 'main', modal: false, hash: 'sessions/c1', title: 'Chat', width: 800, height: 600, resizable: true, menu: null },
  ],
  order: ['main', 'chat1', 'gone'],
  focused: 'chat1',
  minimized: ['gone'],
};

describe('the shell restored from a stored stack', () => {
  it('has the windows, their order and focus, not connected but counted as having been', () => {
    const s = restoreShell(stored);
    expect(s.windows.map((w) => [w.w, w.nonce])).toEqual([['main', 0], ['chat1', 0]]);
    expect(s.windows[0].menu).toEqual(stored.windows[0].menu);
    expect([s.order, s.focused, s.minimized, s.connected, s.everConnected]).toEqual([['main', 'chat1'], 'chat1', [], false, true]);
  });

  it('keeps what an iframe needs to load again, not its nonce', () => {
    const s = reduceShell(restoreShell(stored), { t: 'reload', w: 'main' });
    expect(s.windows[0].nonce).toBe(1);
    expect(storedShell(s).windows[0]).not.toHaveProperty('nonce');
    expect(storedShell(restoreShell(storedShell(s)))).toEqual(storedShell(s));
  });

  it('a session started from it begins with those windows, and its first welcome is a reconnect', async () => {
    vi.useFakeTimers();
    const offline = await open();
    offline.setShell(stored);
    const { session, sockets, shell } = await start({ offline, restored: true });
    const store = new ShellStore(session);
    expect(store.getState().windows.map((w) => w.w)).toEqual(['main', 'chat1']);
    expect(session.isStale()).toBe(true);
    const socket = sockets[0];
    socket.open();
    socket.receive(welcome({ resumed: true }));
    expect(shell.map((m) => m.t)).toContain('resumed');
    expect(store.getState().windows.map((w) => w.nonce)).toEqual([1, 1]);
    expect(session.isStale()).toBe(false);
  });

  it('a reset drops the stored windows', async () => {
    const offline = await open();
    offline.setShell(stored);
    const { session, sockets } = await start({ offline, restored: true });
    const store = new ShellStore(session);
    sockets[0].open();
    sockets[0].receive(welcome({ resumed: false }));
    expect(store.getState().windows).toEqual([]);
  });

  it('a session not started from it ignores the stored stack, and saves the windows while connected', async () => {
    vi.useFakeTimers();
    const offline = await open();
    offline.setShell(stored);
    const { session, connect } = await start({ offline });
    const store = new ShellStore(session);
    expect(store.getState().windows).toEqual([]);
    connect();
    store.dispatch({ t: 'window-open', w: 'main', role: 'workspace', modal: false, hash: '', title: 'Looper', width: 1, height: 1, resizable: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(offline.shell()).toBe(stored);
    await vi.advanceTimersByTimeAsync(1);
    expect(offline.shell()?.windows.map((w) => w.w)).toEqual(['main']);
    expect(initialShellState.windows).toEqual([]);
  });
});

// ---------- how long the server keeps a phone's windows ----------

function fakeConn(platform: string, clientId?: string) {
  const closeCbs: (() => void)[] = [];
  const conn: ConnectionLike & { drop(): void } = {
    device: { id: 'dev1', name: 'Phone' },
    platform,
    clientId,
    send: () => true,
    onMessage: () => () => undefined,
    onClose(cb) {
      closeCbs.push(cb);
      return () => undefined;
    },
    drop: () => closeCbs.splice(0).forEach((c) => c()),
  };
  return conn;
}

describe('how long the server keeps the windows of a client that left', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const clients = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-offline-'));
    dirs.push(dir);
    return new RemoteClients({ ipc: new IpcTable(), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, version: '1', dir, offerDownload: () => 't' });
  };

  it('a phone app keeps them for 24 hours, a browser tab for 2 minutes', async () => {
    vi.useFakeTimers();
    const c = clients();
    const web = fakeConn('web');
    const ios = fakeConn('ios');
    const android = fakeConn('android');
    for (const conn of [web, ios, android]) c.attach(conn);
    expect(c.list()).toHaveLength(3);
    for (const conn of [web, ios, android]) conn.drop();
    await vi.advanceTimersByTimeAsync(CLIENT_GRACE_MS + 1);
    expect(c.list().map((x) => x.platform).sort()).toEqual(['android', 'ios']);
    await vi.advanceTimersByTimeAsync(PHONE_GRACE_MS - CLIENT_GRACE_MS);
    expect(c.list()).toHaveLength(0);
  });

  it('a phone coming back within a day finds its windows', async () => {
    vi.useFakeTimers();
    const c = clients();
    const first = fakeConn('ios');
    c.attach(first);
    const id = c.list()[0].id;
    first.drop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const sent: ServerMessage[] = [];
    const back = { ...fakeConn('ios', id), send: (m: ServerMessage) => (sent.push(m), true) };
    c.attach(back);
    expect(sent.find((m) => m.t === 'welcome')).toMatchObject({ resumed: true, clientId: id });
  });
});

// ---------- the launch screens ----------

describe('the launch screens', () => {
  it('are found by their size in pixels', () => {
    expect(startupSize(1170, 2532)).toMatchObject({ width: 390, height: 844, ratio: 3 });
    expect(startupSize(828, 1792)).toMatchObject({ width: 414, height: 896, ratio: 2 });
    expect(startupSize(1242, 2688)).toMatchObject({ width: 414, height: 896, ratio: 3 });
    expect(startupSize(100, 100)).toBeUndefined();
    expect(new Set(STARTUP_SIZES.map((s) => `${s.width * s.ratio}x${s.height * s.ratio}`)).size).toBe(STARTUP_SIZES.length);
  });

  it('are the grouped background with an empty top bar and tab bar in the iOS bar colors, and no text', () => {
    const size = startupSize(1170, 2532)!;
    const px = (img: ReturnType<typeof startupBitmap>, x: number, y: number) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i + 2], img.data[i + 1], img.data[i], img.data[i + 3]];
    };
    const light = startupBitmap(size, false);
    expect([light.width, light.height, light.data.length]).toEqual([1170, 2532, 1170 * 2532 * 4]);
    expect(px(light, 5, 5)).toEqual([0xf9, 0xf9, 0xf9, 255]);
    expect(px(light, 600, 1200)).toEqual([0xf2, 0xf2, 0xf7, 255]);
    expect(px(light, 5, 2530)).toEqual([0xf9, 0xf9, 0xf9, 255]);
    const dark = startupBitmap(size, true);
    expect(px(dark, 600, 1200)).toEqual([0, 0, 0, 255]);
    expect(px(dark, 5, 5)).toEqual([0x16, 0x16, 0x17, 255]);
    // Only these few colors are used: nothing is drawn on it.
    const colors = new Set<string>();
    for (let y = 0; y < light.height; y += 7) for (let x = 0; x < light.width; x += 7) colors.add(px(light, x, y).join());
    expect(colors.size).toBe(3);
  });
});
