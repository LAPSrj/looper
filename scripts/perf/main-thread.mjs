// Main-thread time: how long a page's main thread is busy while a screen opens or scrolls, so screens that all draw
// within one 17 ms frame can still be compared. Chromium (the desktop's windows, Android) reports it itself: CDP's
// Performance.getMetrics TaskDuration, the time the renderer's main thread spent running tasks, read before and after,
// with nothing added to the page. The desktop's windows share one renderer (process-per-site), so the main window's
// session sees a window opening too. WebKit (iPhone, iPad) has no CDP, so there a probe in the page measures it: a
// chain of 0 ms timers, which the browser spaces 4 ms apart once they nest; whatever the thread runs between two of them
// makes the second late, and the time late adds up to the time busy. The probe leaves the thread idle between its
// timers, so requestIdleCallback (newest-first.ts) still runs; a loop of messages would never let it.
// BENCH_MAIN_THREAD_PROBE=1 runs the probe in Chromium too, as mainThreadProbeMs, to compare the two.

/** Start measuring `page`'s main thread; `stop()` gives the milliseconds it was busy since. */
export async function mainThread(page) {
  const cdp = await page
    .context()
    .newCDPSession(page)
    .catch(() => null);
  if (!cdp) return probe(page);
  await cdp.send('Performance.enable');
  const read = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
  const before = await read();
  const both = process.env.BENCH_MAIN_THREAD_PROBE ? await probe(page) : null;
  return {
    async stop() {
      const out = Math.round(((await read()) - before) * 1000);
      await cdp.detach().catch(() => undefined);
      return both ? { ms: out, probeMs: await both.stop() } : out;
    },
  };
}

async function probe(page) {
  // A short idle stretch first gives the spacing the timers keep while nothing else runs.
  await page.evaluate(
    () =>
      new Promise((ready) => {
        const p = (window.__mainThread = { gaps: [], on: true, last: performance.now() });
        const tick = () => {
          const now = performance.now();
          p.gaps.push(now - p.last);
          p.last = now;
          if (p.on) setTimeout(tick, 0);
        };
        setTimeout(tick, 0);
        setTimeout(() => {
          const g = p.gaps.slice(5).sort((a, b) => a - b);
          p.base = g[g.length >> 1] ?? 4;
          p.gaps = [];
          ready();
        }, 300);
      }),
  );
  return {
    async stop() {
      return page.evaluate(() => {
        const p = window.__mainThread;
        p.on = false;
        return Math.round(p.gaps.reduce((s, g) => s + Math.max(0, g - p.base), 0));
      });
    },
  };
}
