/**
 * The main process's freezes, for perf.log. On Windows the main process's thread also takes every window's input,
 * so while it's busy nothing in Looper responds, yet each page keeps drawing frames and its own watchdog sees
 * nothing. A timer ticks every STEP_MS; a tick that comes FREEZE_MS or more late is a freeze, logged with the named
 * work (IPC handlers, event broadcasts, menu rebuilds) that ran in it.
 */

const STEP_MS = 100;
const FREEZE_MS = 50;
/** Work under this isn't worth naming. */
const SPAN_MIN_MS = 2;
/** At most one line a second: the worst freeze of that second, with how many others it left out. */
const LINE_EVERY_MS = 1000;

interface Span {
  name: string;
  end: number;
  ms: number;
}
let spans: Span[] = [];

/** Run `fn`, naming the time it holds the thread (its synchronous part) for a freeze it's part of. */
export function mainSpan<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const end = performance.now();
    if (end - t0 >= SPAN_MIN_MS) spans.push({ name, end, ms: end - t0 });
  }
}

/** "ipc sessions:fileThumbnail 1720 ms ×31, menu bar 40 ms": the spans that ended in (from, to], biggest first. */
export function describeSpans(list: readonly Span[], from: number, to: number): string {
  const by = new Map<string, { ms: number; n: number }>();
  for (const s of list) {
    if (s.end <= from || s.end > to) continue;
    const t = by.get(s.name) ?? { ms: 0, n: 0 };
    t.ms += s.ms;
    t.n++;
    by.set(s.name, t);
  }
  return [...by]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 6)
    .map(([name, t]) => `${name} ${Math.round(t.ms)} ms${t.n > 1 ? ` ×${t.n}` : ''}`)
    .join(', ');
}

export function startStallWatch(log: (line: string) => void): void {
  let last = performance.now();
  let held: { ms: number; ran: string } | null = null;
  let left = 0;
  let lastLine = 0;
  setInterval(() => {
    const now = performance.now();
    const late = now - last - STEP_MS;
    if (late >= FREEZE_MS) {
      const ran = describeSpans(spans, last, now);
      if (!held || late > held.ms) {
        if (held) left++;
        held = { ms: late, ran };
      } else left++;
    }
    last = now;
    if (held && now - lastLine >= LINE_EVERY_MS) {
      log(`main process freeze ${Math.round(held.ms)} ms${held.ran ? ` | ran ${held.ran}` : ''}${left ? ` | ${left} more left out` : ''}`);
      held = null;
      left = 0;
      lastLine = now;
    }
    spans = spans.filter((s) => s.end > now - STEP_MS);
  }, STEP_MS).unref();
}
