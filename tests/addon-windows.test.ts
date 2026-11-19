import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: {} }));
vi.mock('../src/main/platform', () => ({
  allWindows: () => [],
  ipc: { handle: () => undefined, on: () => undefined },
  showMessageBox: async () => ({ response: 0 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  windowOf: () => null,
  WindowSlots: class {},
  writeClipboard: () => undefined,
}));

import { closeRequestedWindows, openRequestedWindow, type AddonUiDeps } from '../src/main/addons';

/** A window that closes when asked, and says so once. */
class FakeWindow {
  destroyed = false;
  private closed: (() => void)[] = [];
  constructor(readonly name: string) {}
  on(event: string, cb: () => void): this {
    if (event === 'closed') this.closed.push(cb);
    return this;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cb of this.closed) cb();
  }
}

interface Opened {
  hash: string;
  title: string;
  width: number;
  height: number;
  parent: FakeWindow | null;
  opts: Record<string, unknown>;
  window: FakeWindow;
}

function setup(origins: Record<number, FakeWindow> = {}, main: FakeWindow | null = new FakeWindow('main')) {
  const opened: Opened[] = [];
  const deps = {
    host: { originOf: (_id: string, request: number) => origins[request] },
    hostKind: 'linux',
    mainWindow: () => main,
    hasPanes: () => true,
    openWindow: (hash: string, title: string, width: number, height: number, parent: FakeWindow | null, opts: Record<string, unknown>) => {
      const window = new FakeWindow(title);
      opened.push({ hash, title, width, height, parent, opts, window });
      return window;
    },
  } as unknown as AddonUiDeps;
  return { deps, opened, main };
}

const P = { view: 'password', title: 'Password' };

/** Whether the promise has settled yet. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  return done;
}

beforeEach(() => closeRequestedWindows('demo'));

describe('openRequestedWindow', () => {
  it('opens a fixed dialog over the window that sent the event, and resolves only when it closes', async () => {
    const sender = new FakeWindow('sender');
    const { deps, opened, main } = setup({ 5: sender });
    const done = openRequestedWindow(deps, 'demo', { ...P, params: { a: 1 }, request: 5 });
    expect(opened).toHaveLength(1);
    expect(opened[0].parent).toBe(sender);
    expect(opened[0].parent).not.toBe(main);
    expect(opened[0]).toMatchObject({ title: 'Password', width: 520, height: 460, opts: { resizable: false, contentSize: true, role: 'tool' } });
    expect(decodeURIComponent(opened[0].hash.split('/')[2])).toBe('password');
    expect(await settled(done)).toBe(false);
    opened[0].window.close();
    expect(await done).toEqual({});
  });

  it('opens over the main window without a request, with a request nothing is answering, or when the sender has closed', async () => {
    const gone = new FakeWindow('gone');
    gone.close();
    const { deps, opened, main } = setup({ 6: gone });
    void openRequestedWindow(deps, 'demo', { ...P, width: 400, height: 300 });
    void openRequestedWindow(deps, 'demo', { ...P, request: 99 });
    void openRequestedWindow(deps, 'demo', { ...P, request: 6 });
    expect(opened.map((o) => o.parent)).toEqual([main, main, main]);
    expect(opened[0]).toMatchObject({ width: 400, height: 300 });
  });

  it('opens a window of its own when there is no main window', () => {
    const { deps, opened } = setup({}, null);
    void openRequestedWindow(deps, 'demo', P);
    expect(opened[0].parent).toBeNull();
  });

  it("closes, and so resolves, when the addon's process stops", async () => {
    const { deps, opened } = setup();
    const a = openRequestedWindow(deps, 'demo', P);
    const other = openRequestedWindow(deps, 'other', P);
    closeRequestedWindows('demo');
    expect(opened[0].window.destroyed).toBe(true);
    expect(await a).toEqual({});
    expect(await settled(other)).toBe(false);
    closeRequestedWindows('other');
    expect(await other).toEqual({});
  });
});
