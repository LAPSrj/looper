// The computer's state while the perf scripts measure. Counts and memory don't depend on it, but timings do, so
// before each timed step `settle()` waits for a quiet computer: the CPU's use from Windows' own counters
// (GetSystemTimes), no keyboard or mouse input for a few seconds (GetLastInputInfo: it holds while someone types or
// moves the mouse, and goes on once they stop), and a blank page's frames in a browser of its own (the control: when
// it can't keep its frames, nothing else can). It waits up to BENCH_QUIET_WAIT_S (180 s), then measures anyway and says
// the computer was busy; after one such wait the next ones wait only BENCH_QUIET_RECHECK_S (15 s) until it's quiet
// again, so a busy computer doesn't make a run take hours. `noteConditions` keeps what each result was measured in.
//   BENCH_QUIET_CPU      most CPU use (%) of the whole computer, over the last 2 s, that counts as quiet (20)
//   BENCH_QUIET_IDLE_S   seconds without input that count as quiet (5)
//   BENCH_QUIET_FRAME_MS the control's longest frame that counts as quiet (34: two frames at 60 Hz)
//   BENCH_NO_SETTLE=1    measure at once, as before (the conditions are still recorded); --no-wait does the same
import { chromium } from 'playwright-core';

const env = (k, d) => Number(process.env[k] || d);
const CPU_LIMIT = env('BENCH_QUIET_CPU', 20);
const IDLE_MS = env('BENCH_QUIET_IDLE_S', 5) * 1000;
const FRAME_LIMIT = env('BENCH_QUIET_FRAME_MS', 34);
const WAIT_MS = env('BENCH_QUIET_WAIT_S', 180) * 1000;
const RECHECK_MS = env('BENCH_QUIET_RECHECK_S', 15) * 1000;
const ON = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win32 = null;
async function api() {
  if (win32 || !ON) return win32;
  const koffi = (await import('koffi')).default;
  const kernel32 = koffi.load('kernel32.dll');
  const user32 = koffi.load('user32.dll');
  koffi.struct('LASTINPUTINFO', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
  win32 = {
    GetSystemTimes: kernel32.func('int __stdcall GetSystemTimes(_Out_ uint64_t *idle, _Out_ uint64_t *kernel, _Out_ uint64_t *user)'),
    GetTickCount: kernel32.func('uint32_t __stdcall GetTickCount()'),
    GetLastInputInfo: user32.func('int __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *info)'),
  };
  return win32;
}

/** The CPU's use since the last sample (%), every 500 ms, for the last minute. */
const samples = [];
let sampler = null;
let lastTimes = null;
async function startSampler() {
  if (sampler || !(await api())) return;
  const read = () => {
    const i = [0], k = [0], u = [0];
    win32.GetSystemTimes(i, k, u);
    return [Number(i[0]), Number(k[0]), Number(u[0])];
  };
  lastTimes = read();
  sampler = setInterval(() => {
    const now = read();
    const idle = now[0] - lastTimes[0];
    const total = now[1] - lastTimes[1] + (now[2] - lastTimes[2]);
    lastTimes = now;
    samples.push({ t: Date.now(), cpu: total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0 });
    while (samples.length > 120) samples.shift();
  }, 500);
  sampler.unref();
}

/** The most CPU use (%) in a sample from `since` on. */
function cpuSince(since) {
  const s = samples.filter((x) => x.t >= since);
  return s.length ? Math.round(Math.max(...s.map((x) => x.cpu))) : null;
}

/** Milliseconds since the last keyboard or mouse input, and when that was (Date.now() time). */
function lastInput() {
  if (!win32) return { idleMs: Infinity, at: 0 };
  const info = { cbSize: 8, dwTime: 0 };
  win32.GetLastInputInfo(info);
  const idleMs = (win32.GetTickCount() - info.dwTime) >>> 0;
  return { idleMs, at: Date.now() - idleMs };
}

let control = null;
/** The control's longest frame (ms) over one second: a blank page in a headless Chromium of its own. */
async function controlFrame() {
  if (!control) {
    const browser = await chromium.launch({ channel: 'chromium' });
    const page = await browser.newPage();
    await page.goto('about:blank');
    control = { browser, page };
  }
  return control.page.evaluate(
    () =>
      new Promise((done) => {
        const gaps = [];
        let last = performance.now();
        const end = last + 1000;
        const tick = (t) => {
          gaps.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else done(Math.round(Math.max(...gaps.slice(1))));
        };
        requestAnimationFrame(tick);
      }),
  );
}

let busyStreak = false;

/**
 * Wait until the computer is quiet, up to the limit. What it was like: `quiet`, the CPU's use (%), seconds since the
 * last input, the control's longest frame, how long it waited, and `why` it wasn't quiet.
 */
export async function settle() {
  await startSampler();
  const t0 = Date.now();
  if (!ON) return { quiet: true, waitedS: 0 };
  const limit = busyStreak ? RECHECK_MS : WAIT_MS;
  // The CPU's use needs two samples of its own.
  if (samples.length < 4) await sleep(2000);
  for (;;) {
    const input = lastInput();
    const cpu = cpuSince(Date.now() - 2000) ?? 0;
    const why = [];
    if (input.idleMs < IDLE_MS) why.push('in use');
    if (cpu > CPU_LIMIT) why.push(`CPU ${cpu}%`);
    const frame = why.length ? null : await controlFrame().catch(() => null);
    if (frame !== null && frame > FRAME_LIMIT) why.push(`a blank page's frame took ${frame} ms`);
    const c = { quiet: !why.length, cpu, idleS: Math.min(9999, Math.round(input.idleMs / 1000)), controlMs: frame, waitedS: Math.round((Date.now() - t0) / 1000) };
    if (process.env.BENCH_NO_SETTLE || process.argv.includes('--no-wait') || !why.length || Date.now() - t0 >= limit) {
      busyStreak = !c.quiet;
      return why.length ? { ...c, why: why.join(', ') } : c;
    }
    await sleep(1000);
  }
}

/** name → what its timings were measured in: settle()'s result, the CPU's peak during the step, and whether anyone used the computer during it. */
export const conditions = new Map();

/** Keep `settled` (settle()'s result before the step that began at `start`) as the conditions of `name`'s timings. */
export function noteConditions(name, settled, start) {
  const input = lastInput();
  const during = { ...settled };
  const peak = cpuSince(start);
  if (peak !== null) during.cpuDuring = peak;
  if (input.at > start) {
    during.quiet = false;
    during.why = [settled.why, 'in use during the step'].filter(Boolean).join(', ');
  }
  conditions.set(name, during);
  return during;
}

/** The conditions as one short line for the printed results. */
export function conditionText(c) {
  if (!c) return '';
  const parts = [`CPU ${c.cpu}%`, `idle ${c.idleS} s`];
  if (c.controlMs !== null && c.controlMs !== undefined) parts.push(`control ${c.controlMs} ms`);
  if (c.waitedS) parts.push(`waited ${c.waitedS} s`);
  return `[${c.quiet ? 'quiet' : `busy: ${c.why}`}; ${parts.join(', ')}]`;
}

export async function closeMachine() {
  if (sampler) clearInterval(sampler);
  sampler = null;
  await control?.browser.close().catch(() => undefined);
  control = null;
}
