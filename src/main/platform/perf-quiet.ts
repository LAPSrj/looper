/**
 * Quiet mode for the performance scripts (LOOPER_PERF_QUIET, set by scripts/perf/lib.mjs), so a measuring run
 * doesn't interrupt whoever uses the computer: no window takes the focus (show() shows it inactive, focus() does
 * nothing), and each window opens on another virtual desktop: the last one in Task View's order that isn't the current
 * one (VirtualDesktopIDs lists them in that order). There it's off this desktop's taskbar already; setSkipTaskbar would
 * take it out of the desktops altogether, and it would show on every one. With one desktop, or with
 * LOOPER_PERF_QUIET=current, it stays on this desktop, behind the other windows and off the taskbar.
 * The desktops are reached through IVirtualDesktopManager (koffi, loaded only here), which moves only this process's
 * own windows, and only once they're shown.
 */
import { BrowserWindow } from 'electron';

let quiet = false;

/** Whether windows open quietly: the creator shows them itself, inactive (window-places.ts). */
export function perfQuiet(): boolean {
  return quiet;
}

interface Desktops {
  /** The desktop to open on: the last one in Task View's order that isn't the current one; null with one desktop. */
  target(): Buffer | null;
  /** Move the window there; false when it didn't land. */
  move(w: BrowserWindow, to: Buffer): boolean;
  /** Put the window behind every other one. */
  toBack(w: BrowserWindow): void;
}

/** Turn quiet mode on when the scripts asked for it; before the first window opens. */
export async function usePerfQuiet(log: (line: string) => void): Promise<void> {
  const mode = process.env.LOOPER_PERF_QUIET;
  if (!mode) return;
  quiet = true;
  let desktops: Desktops | null = null;
  if (process.platform === 'win32') {
    try {
      desktops = await windowsDesktops();
    } catch (e) {
      log(`perf quiet mode: no virtual desktops (${(e as Error).message}); windows open behind the others`);
    }
  }
  const showInactive = BrowserWindow.prototype.showInactive;
  const placed = new WeakSet<BrowserWindow>();
  BrowserWindow.prototype.showInactive = function (this: BrowserWindow) {
    showInactive.call(this);
    if (placed.has(this)) return;
    placed.add(this);
    const to = mode === 'current' ? null : desktops?.target();
    // A menu level's window is made without a taskbar button, which leaves it on every desktop: it gets one to move.
    if (to && desktops) {
      this.setSkipTaskbar(false);
      if (desktops.move(this, to)) return;
    }
    this.setSkipTaskbar(true);
    // A topmost window (a menu level) would lose its topmost place behind the others.
    if (!this.isAlwaysOnTop()) desktops?.toBack(this);
  };
  BrowserWindow.prototype.show = function (this: BrowserWindow) {
    this.showInactive();
  };
  BrowserWindow.prototype.focus = function () {};
}

const guid = (s: string): Buffer => {
  const h = s.replace(/-/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
};

async function windowsDesktops(): Promise<Desktops> {
  const koffi = (await import('koffi')).default;
  const ole32 = koffi.load('ole32.dll');
  const user32 = koffi.load('user32.dll');
  const advapi = koffi.load('advapi32.dll');
  const CoInitializeEx = ole32.func('long __stdcall CoInitializeEx(void *reserved, uint32_t flags)');
  const CoCreateInstance = ole32.func('long __stdcall CoCreateInstance(void *clsid, void *outer, uint32_t ctx, void *iid, _Out_ void **out)');
  const RegGetValueW = advapi.func('long __stdcall RegGetValueW(void *hkey, const char16_t *sub, const char16_t *value, uint32_t flags, void *type, void *data, _Inout_ uint32_t *size)');
  const SetWindowPos = user32.func('int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)');
  const GetId = koffi.proto('long __stdcall GetWindowDesktopId(void *self, void *hwnd, void *id)');
  const Move = koffi.proto('long __stdcall MoveWindowToDesktop(void *self, void *hwnd, void *id)');
  // The main thread has COM already (S_FALSE); a thread without it gets an apartment.
  CoInitializeEx(null, 2);
  const out: unknown[] = [null];
  const hr = CoCreateInstance(guid('AA509086-5CA9-4C25-8F95-589D3C07B48A'), null, 0x17, guid('A5CD92FF-29BE-454C-8D04-D82879FB3F1B'), out);
  if (hr !== 0) throw new Error(`CoCreateInstance(VirtualDesktopManager) 0x${(hr >>> 0).toString(16)}`);
  const manager = out[0];
  // IVirtualDesktopManager's vtable: IUnknown's three, IsWindowOnCurrentVirtualDesktop, GetWindowDesktopId, MoveWindowToDesktop.
  const vtable = koffi.decode(koffi.decode(manager, 'void *'), 'void *', 6) as unknown[];
  const HKCU = 0xffffffff80000001n;
  const KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
  const reg = (name: string): Buffer | null => {
    const buf = Buffer.alloc(16 * 64);
    const size = [buf.length];
    return RegGetValueW(HKCU, KEY, name, 0x8 /* RRF_RT_REG_BINARY */, null, buf, size) === 0 ? buf.subarray(0, size[0]) : null;
  };
  const hwnd = (w: BrowserWindow) => w.getNativeWindowHandle().readBigUInt64LE(0);
  return {
    target() {
      const ids = reg('VirtualDesktopIDs');
      const current = reg('CurrentVirtualDesktop');
      if (!ids || !current) return null;
      for (let i = ids.length - 16; i >= 0; i -= 16) {
        const id = ids.subarray(i, i + 16);
        if (!id.equals(current)) return Buffer.from(id);
      }
      return null;
    },
    move(w, to) {
      if (koffi.call(vtable[5], Move, manager, hwnd(w), to) !== 0) return false;
      const got = Buffer.alloc(16);
      return koffi.call(vtable[4], GetId, manager, hwnd(w), got) === 0 && got.equals(to);
    },
    toBack(w) {
      // HWND_BOTTOM; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
      SetWindowPos(hwnd(w), 1n, 0, 0, 0, 0, 0x13);
    },
  };
}
