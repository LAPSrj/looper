import { app, BrowserWindow } from 'electron';

/** How long no Looper window has the focus before its memory is handed back, and how often again after that. */
const AWAY_MS = 60_000;
const AGAIN_MS = 10 * 60_000;

/**
 * While nobody uses Looper (no window of it has the focus), it hands back the memory Chromium keeps for speed:
 * raster tiles, GPU and font caches, and the free room in the V8 heaps of every process, through Chromium's own
 * memory-pressure signal. Measured with scripts/perf/pressure.mjs on 20 tasks and 20 chats: 278 → 201 MB in Task
 * Manager (committed memory 370 → 290 MB), and the next chat switch still drew in one frame. LOOPER_NO_MEMORY_TRIM
 * (the performance scripts set it) leaves it off, so their numbers compare from run to run.
 */
export function startMemoryTrim(onTrim?: (ms: number) => void): void {
  if (process.env.LOOPER_NO_MEMORY_TRIM) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const away = () => {
    if (timer) return;
    timer = setTimeout(function trimNow() {
      timer = setTimeout(trimNow, AGAIN_MS);
      const t0 = performance.now();
      void trim().then(() => onTrim?.(Math.round(performance.now() - t0)));
    }, AWAY_MS);
  };
  const back = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // Focus moving from one Looper window to another blurs one first: only no focused window afterwards counts.
  app.on('browser-window-blur', () => setImmediate(() => !BrowserWindow.getFocusedWindow() && away()));
  app.on('browser-window-focus', back);
  if (!BrowserWindow.getFocusedWindow()) away();
}

async function trim(): Promise<void> {
  const wc = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.webContents;
  // DevTools open on it has the debugger: nothing then.
  if (!wc || wc.debugger.isAttached()) return;
  try {
    wc.debugger.attach('1.3');
    // Chromium sends it on to every process (DevTools protocol, Memory.simulatePressureNotification).
    await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: 'critical' });
  } catch {
    /* a window closing under it; the next time will do */
  } finally {
    try {
      wc.debugger.detach();
    } catch {
      /* not attached */
    }
  }
}
