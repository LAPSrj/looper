// What the performance scripts share: launching the built app on seeded demo data, and measuring it.
// BENCH_ROOT: where its data and profile go (default %TEMP%\looper-bench).
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..', '..');
const DEMO = path.resolve(HERE, '..', 'screenshots');
export const ROOT = process.env.BENCH_ROOT || path.join(os.tmpdir(), 'looper-bench');
export const DATA = path.join(ROOT, 'home');
/** Rows in each added chat: one as long as the engine keeps (1,000), the rest of a size people keep open for a day. BENCH_CHATS: how many (20). */
export const CHAT_SIZES = Array.from({ length: Number(process.env.BENCH_CHATS || 20) }, (_, i) => (i === 0 ? 1000 : [400, 300, 200][i % 3]));
/** Tasks in the data: the demo's, then copies of them. BENCH_TASKS (20). */
export const TASKS = Number(process.env.BENCH_TASKS || 20);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    // A window covered by others keeps painting, as the screenshot driver's does, so the numbers don't depend on what's on top.
    args: [`--user-data-dir=${path.join(ROOT, 'profile')}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(process.env.BENCH_ARGS?.split(' ').filter(Boolean) ?? []), APP_DIR],
    // LOOPER_NO_MEMORY_TRIM: the app doesn't hand memory back on its own while measured (main/memory-trim.ts).
    env: { ...process.env, LOOPER_HOME: DATA, LOOPER_NO_MEMORY_TRIM: '1' },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // How late the main process's timer comes: on Windows that thread takes every window's input, so a step that holds
  // it freezes the app while the page's frames look fine (watch's mainFreeze).
  await app.evaluate(() => {
    const s = (globalThis.__benchMain = { worst: 0 });
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      s.worst = Math.max(s.worst, now - last - 20);
      last = now;
    }, 20);
  });
  mainOf.set(page, app);
  // BENCH_CSS: a stylesheet added to the main window, to try a CSS change before making it.
  if (process.env.BENCH_CSS) await page.addStyleTag({ content: process.env.BENCH_CSS });
  return { app, page };
}

/** The app of each main window's page, for its main process's freezes. */
const mainOf = new WeakMap();

export async function quit(app) {
  const proc = app.process();
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
  if (proc.exitCode === null) await new Promise((done) => proc.once('exit', done));
}

/**
 * Long tasks seen in `page` from now until it has been quiet for `quietMs`, as Chromium reports them, and for a
 * main window's page the longest the main process was held (mainFreeze).
 */
export async function watch(page, action, opts) {
  const app = mainOf.get(page);
  if (app) await app.evaluate(() => (globalThis.__benchMain.worst = 0));
  const out = await watchPage(page, action, opts);
  return app ? { ...out, mainFreeze: Math.round(await app.evaluate(() => globalThis.__benchMain.worst)) } : out;
}

async function watchPage(page, action, { quietMs = 1500, maxMs = 15_000 } = {}) {
  await page.evaluate(() => {
    window.__bench = { frames: [], start: performance.now(), gaps: [] };
    // Frame gaps too, since a long animation frame is only reported from 50 ms.
    let last = performance.now();
    const tick = (t) => {
      if (!window.__bench.running) return;
      window.__bench.gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    window.__bench.running = true;
    requestAnimationFrame(tick);
    window.__benchObs?.disconnect();
    window.__benchObs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__bench.frames.push({ start: e.startTime, ms: e.duration, blocking: e.blockingDuration });
    });
    window.__benchObs.observe({ type: 'long-animation-frame' });
  });
  const t0 = Date.now();
  await action();
  for (;;) {
    await sleep(250);
    const last = await page.evaluate(() => {
      const f = window.__bench.frames.at(-1);
      return f ? performance.now() - (f.start + f.ms) : performance.now() - window.__bench.start;
    });
    if (last >= quietMs || Date.now() - t0 > maxMs) break;
  }
  return page.evaluate(() => {
    const { frames, start, gaps } = window.__bench;
    window.__bench.running = false;
    const end = frames.length ? Math.max(...frames.map((f) => f.start + f.ms)) : start;
    return {
      worstFrame: Math.round(Math.max(0, ...gaps)),
      slowFrames: gaps.filter((g) => g > 25).length,
      busyMs: Math.round(end - start),
      longest: Math.round(Math.max(0, ...frames.map((f) => f.ms))),
      blocking: Math.round(frames.reduce((s, f) => s + f.blocking, 0)),
      longFrames: frames.length,
    };
  });
}

/** A window's long tasks from its start until it's been quiet for 1.5 s (`watch` would miss the ones before it was found). */
export async function loadCost(page) {
  await page.waitForLoadState('domcontentloaded');
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const frames = [];
        let timer;
        const done = () => {
          const end = frames.length ? Math.max(...frames.map((f) => f.startTime + f.duration)) : 0;
          resolve({
            busyMs: Math.round(end),
            longest: Math.round(Math.max(0, ...frames.map((f) => f.duration))),
            blocking: Math.round(frames.reduce((s, f) => s + f.blockingDuration, 0)),
            longFrames: frames.length,
          });
        };
        new PerformanceObserver((l) => {
          frames.push(...l.getEntries());
          clearTimeout(timer);
          timer = setTimeout(done, 1500);
        }).observe({ type: 'long-animation-frame', buffered: true });
        timer = setTimeout(done, 1500);
      }),
  );
}

/** How long each key took from the press to the next paint (Event Timing), typing `text` into the focused field. */
export async function typing(page, text) {
  await page.evaluate(() => {
    window.__keys = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'keydown') window.__keys.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  });
  await page.keyboard.type(text, { delay: 40 });
  await sleep(500);
  return page.evaluate((n) => {
    const d = [...window.__keys].sort((a, b) => a - b);
    // Event Timing leaves out events under 16 ms, so every key not listed was faster than that.
    return { keys: n, over16ms: d.length, worstMs: Math.round(d.at(-1) ?? 0) };
  }, text.length);
}

/** Every Looper process's memory (MB): the private bytes Windows charges it, and the working set. */
export async function memory(app) {
  // Garbage collected first in every window, so the number doesn't depend on when the last collection ran.
  for (const w of app.windows()) {
    const cdp = await w.context().newCDPSession(w);
    await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
  await sleep(500);
  // The JavaScript heaps, the part the app's own data and code take: the main process's and each window's.
  const mainHeap = await app.evaluate(() => process.memoryUsage().heapUsed);
  let windowHeaps = 0;
  for (const w of app.windows()) {
    const cdp = await w.context().newCDPSession(w);
    windowHeaps += (await cdp.send('Runtime.getHeapUsage').catch(() => ({ usedSize: 0 }))).usedSize;
    await cdp.detach().catch(() => undefined);
  }
  const heaps = { mainHeapMb: Math.round(mainHeap / 2 ** 20), windowHeapsMb: Math.round(windowHeaps / 2 ** 20) };
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type === 'Utility' ? `Utility ${m.serviceName ?? m.name ?? ''}`.trim() : m.type, ws: m.memory.workingSetSize, priv: m.memory.privateBytes ?? 0 })),
  );
  const mb = (kb) => Math.round(kb / 1024);
  // Task Manager's Memory column: each process's private working set.
  const pws = taskManagerKb(metrics.map((m) => m.pid));
  const byType = {};
  const tmByType = {};
  for (const m of metrics) {
    byType[m.type] = (byType[m.type] ?? 0) + mb(m.priv);
    tmByType[m.type] = (tmByType[m.type] ?? 0) + mb(pws.get(m.pid) ?? 0);
  }
  if (process.env.BENCH_MEMDUMP) await memoryDump(app);
  if (process.env.BENCH_HEAP) await heapSummary(app.windows()[0]);
  return {
    taskManagerMb: mb([...pws.values()].reduce((s, v) => s + v, 0)),
    privateMb: mb(metrics.reduce((s, m) => s + m.priv, 0)),
    workingSetMb: mb(metrics.reduce((s, m) => s + m.ws, 0)),
    processes: metrics.length,
    ...heaps,
    byType,
    tmByType,
  };
}

/** Each process's private working set (KB), as Task Manager's Memory column shows it. */
export function taskManagerKb(pids) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter "${pids.map((p) => `IDProcess=${p}`).join(' OR ')}" | ForEach-Object { "$($_.IDProcess) $($_.WorkingSetPrivate)" }`],
    { encoding: 'utf8' },
  );
  const kb = new Map();
  for (const line of out.trim().split(/\r?\n/)) {
    const [pid, bytes] = line.trim().split(' ').map(Number);
    if (pid) kb.set(pid, bytes / 1024);
  }
  return kb;
}

/** BENCH_HEAP=1: what the main window's JavaScript heap holds, by constructor (and strings by size), from a heap snapshot. */
export async function heapSummary(page) {
  const cdp = await page.context().newCDPSession(page);
  const chunks = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await cdp.detach().catch(() => undefined);
  const snap = JSON.parse(chunks.join(''));
  const f = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const n = f.length;
  const [ti, ni, si] = [f.indexOf('type'), f.indexOf('name'), f.indexOf('self_size')];
  const by = new Map();
  for (let i = 0; i < snap.nodes.length; i += n) {
    const type = types[snap.nodes[i + ti]];
    const key = type === 'object' || type === 'closure' ? `${type} ${snap.strings[snap.nodes[i + ni]]}` : type;
    const e = by.get(key) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += snap.nodes[i + si];
    by.set(key, e);
  }
  const total = [...by.values()].reduce((s, e) => s + e.bytes, 0);
  console.log(`heap of "${page.url().split('#')[1] ?? 'main'}": ${(total / 2 ** 20).toFixed(1)} MB self size`);
  for (const [k, e] of [...by].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25)) console.log(`  ${(e.bytes / 2 ** 20).toFixed(2).padStart(7)} MB  ${String(e.count).padStart(8)}  ${k}`);
}

/** BENCH_MEMDUMP=1: Chromium's memory dump of every process, printed as MB per allocator (v8, partition_alloc, malloc, gpu, skia…). */
export async function memoryDump(app) {
  // DevTools tracing on the main window: it records every process, and as JSON (Electron's contentTracing writes protobuf).
  const page = app.windows()[0];
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const complete = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } },
    transferMode: 'ReportEvents',
  });
  await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' });
  await cdp.send('Tracing.end');
  await complete;
  await cdp.detach().catch(() => undefined);
  const names = new Map(events.filter((e) => e.ph === 'M' && e.name === 'process_name').map((e) => [e.pid, e.args?.name]));
  const last = new Map();
  for (const e of events) if (e.ph === 'v' && e.args?.dumps?.allocators) last.set(e.pid, e.args.dumps);
  for (const [pid, dumps] of last) {
    const sizes = [];
    for (const [name, a] of Object.entries(dumps.allocators)) {
      if (name.split('/').length > 2) continue;
      const size = a.attrs?.size?.value;
      if (size) sizes.push([name, parseInt(size, 16) / 2 ** 20]);
    }
    const footprint = dumps.process_totals?.private_footprint_bytes;
    console.log(`memory dump ${names.get(pid) ?? pid}${footprint ? ` (footprint ${Math.round(parseInt(footprint, 16) / 2 ** 20)} MB)` : ''}:`);
    for (const [n, v] of sizes.sort((x, y) => y[1] - x[1]).slice(0, 24)) if (v >= 0.5) console.log(`  ${v.toFixed(1).padStart(7)}  ${n}`);
  }
}

/** The demo data, with chats open in its projects whose openings are long compacted conversations. */
export async function seed() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.cpSync(path.join(DEMO, 'demo', 'home'), DATA, { recursive: true });
  // BENCH_ADDONS=1 keeps the demo's addon, for the screens that are an addon's.
  if (!process.env.BENCH_ADDONS) fs.rmSync(path.join(DATA, 'addons'), { recursive: true, force: true });
  addTasks(TASKS);
  addCatHarness();
  console.log(execFileSync('wsl.exe', ['-e', 'bash', '-c', 'bash "$(wslpath -a "$1")"', '_', path.join(DEMO, 'setup-wsl.sh')], { encoding: 'utf8' }).trim());
  // An image a run's message can show (check.mjs's Image window), in the demo projects' folder.
  execFileSync('wsl.exe', ['-e', 'bash', '-c', 'cp "$(wslpath -a "$1")" ~/looper-demo/perf-image.png', '_', path.join(APP_DIR, 'assets', 'icon.png')]);
  // Screenshots the chats' agents read, as real agents read theirs (the Files tab shows them as thumbnails).
  const shots = path.join(ROOT, 'shots');
  writeScreenshots(shots, SCREENSHOTS);
  execFileSync('wsl.exe', ['-e', 'bash', '-c', 'mkdir -p ~/looper-demo/shots && cp "$(wslpath -a "$1")"/*.png ~/looper-demo/shots/', '_', shots]);
  const home = execFileSync('wsl.exe', ['-e', 'bash', '-c', 'echo "$HOME"'], { encoding: 'utf8' }).trim();
  const images = Array.from({ length: SCREENSHOTS }, (_, k) => `${home}/looper-demo/shots/shot-${k}.png`);
  const { app, page } = await launch();
  await sleep(3000);
  await page.evaluate(async (n) => {
    const projects = await window.looper.projects.list();
    for (let i = 0; i < n; i++) await window.looper.projects.newChat(projects[i % projects.length].id);
  }, CHAT_SIZES.length);
  await sleep(3000);
  await quit(app);
  const openings = [];
  for (const dir of fs.readdirSync(path.join(DATA, 'tasks'))) {
    const runs = path.join(DATA, 'tasks', dir, 'runs');
    if (!fs.existsSync(runs)) continue;
    for (const run of fs.readdirSync(runs)) if (fs.existsSync(path.join(runs, run, 'opening.json'))) openings.push(path.join(runs, run, 'opening.json'));
  }
  if (openings.length < CHAT_SIZES.length) throw new Error(`only ${openings.length} chats were saved`);
  openings.forEach((file, i) => fs.writeFileSync(file, JSON.stringify(longChat(i, CHAT_SIZES[i], images))));
  return openings.map((f) => path.basename(path.dirname(f)));
}

const SCREENSHOTS = 24;

/**
 * `count` PNG screenshots in `dir`, half a desktop's size (1920 × 1080) and half a phone's (1290 × 2796): flat
 * panels and bars with lines of text-like marks, which compress and decode like real screenshots.
 */
function writeScreenshots(dir, count) {
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 0; k < count; k++) {
    const [width, height] = k % 2 ? [1290, 2796] : [1920, 1080];
    const png = new PNG({ width, height });
    let seed = 99 + k * 31;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const fill = (x0, y0, w, h, [r, g, b]) => {
      for (let y = y0; y < Math.min(height, y0 + h); y++) {
        for (let x = x0; x < Math.min(width, x0 + w); x++) {
          const i = (y * width + x) * 4;
          png.data[i] = r;
          png.data[i + 1] = g;
          png.data[i + 2] = b;
          png.data[i + 3] = 255;
        }
      }
    };
    fill(0, 0, width, height, [243, 243, 243]);
    fill(0, 0, width, 64, [251, 251, 251]);
    for (let y = 100; y < height - 60; y += 160 + Math.floor(rand() * 120)) {
      const x = 40 + Math.floor(rand() * 200);
      const w = width - x - 40 - Math.floor(rand() * 300);
      fill(x, y, w, 120, [255, 255, 255]);
      // Lines of "text": runs of dark marks of word-like lengths.
      for (let line = y + 20; line < y + 100; line += 26) {
        for (let cx = x + 16; cx < x + w - 60; ) {
          const word = 20 + Math.floor(rand() * 70);
          for (let c = 0; c < word; c += 7) fill(cx + c, line, 5, 12, rand() < 0.15 ? [0, 95, 184] : [36, 36, 36]);
          cx += word + 12;
        }
      }
    }
    fs.writeFileSync(path.join(dir, `shot-${k}.png`), PNG.sync.write(png));
  }
}

/** A Claude Code harness whose command is `cat` in WSL: a task builder (which takes only Claude Code or Codex) starts on it without running an agent. */
export const CAT_HARNESS = 'perf-cat';
function addCatHarness() {
  const file = path.join(DATA, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.environments.find((e) => e.id === 'wsl').harnesses.push({ id: CAT_HARNESS, name: 'Perf cat', kind: 'claude-code', command: 'cat', args: [], env: {} });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** Copies of the demo's tasks, with their run history, until there are `total`, each in its original's folder. */
export function addTasks(total) {
  const file = path.join(DATA, 'tasks.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const originals = [...store.tasks];
  for (let i = 0; store.tasks.length < total; i++) {
    const from = originals[i % originals.length];
    const id = `${from.id}-${Math.floor(i / originals.length) + 2}`;
    store.tasks.push({ ...from, id, name: `${from.name} ${Math.floor(i / originals.length) + 2}` });
    store.layout[from.folderId ?? '']?.push(id);
    const dir = path.join(DATA, 'tasks', from.id);
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(DATA, 'tasks', id), { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

/**
 * A chat shaped like a day of Claude Code work, as the engine keeps one (at most 1,000 rows): turns of a prompt,
 * sometimes thinking, short replies in Markdown and runs of tool calls with their inputs, results and diffs. The mix
 * and sizes are the averages of large real transcripts: about 60% tool rows holding 1-2 MB, 30% replies of ~550
 * characters, and the rest prompts and thinking. Generated, so no one's conversation is in it.
 */
export function longChat(n, count, images = []) {
  let seed = 7 + n * 7919;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const WORDS = 'the a sync script starter package config route handler page layout theme build release test fixture cache index query user session token header footer style image upload export import module service worker queue retry timeout branch commit deploy staging server client form field value error warning check update remove rename move file folder path line block hook plugin template component'.split(' ');
  const sentence = (min = 6, max = 18) => {
    const s = Array.from({ length: between(min, max) }, () => pick(WORDS)).join(' ');
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  };
  const file = () => `/home/dev/projects/site-${n}/${pick(['src', 'app', 'lib', 'tests'])}/${pick(WORDS)}-${pick(WORDS)}.${pick(['ts', 'tsx', 'php', 'css', 'json', 'md'])}`;
  const code = (lines) => Array.from({ length: lines }, (_, i) => `${'  '.repeat(between(0, 3))}${pick(['const', 'if (', 'return', 'export function', '$', 'await', '//'])} ${pick(WORDS)}${pick(['(', ' = ', '.', ' => ', ': '])}${pick(WORDS)}${pick([');', ';', ' {', '', ' }'])} ${i % 7 === 0 ? `// ${sentence(3, 8)}` : ''}`);
  const reply = () => {
    const parts = [sentence(10, 30)];
    const r = rand();
    if (r < 0.3) parts.push(Array.from({ length: between(2, 5) }, () => `- \`${pick(WORDS)}.${pick(['ts', 'php'])}\`: ${sentence(5, 12)}`).join('\n'));
    else if (r < 0.4) parts.push(['```ts', ...code(between(3, 12)), '```'].join('\n'));
    else if (r < 0.47) parts.push(['| file | change |', '|---|---|', ...Array.from({ length: between(2, 5) }, () => `| \`${pick(WORDS)}.ts\` | ${sentence(4, 9)} |`)].join('\n'));
    if (rand() < 0.4) parts.push(sentence(8, 24));
    return parts.join('\n\n');
  };
  const numbered = (lines) => code(lines).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n');
  const tool = () => {
    const name = pick(['Bash', 'Bash', 'Bash', 'Bash', 'Read', 'Read', 'Read', 'Edit', 'Edit', 'Grep', 'Write', 'Glob', 'TodoWrite', 'Task']);
    if (name === 'Bash') {
      const command = `${pick(['npm run', 'git', 'php', 'node', 'ls -la', 'curl -s'])} ${pick(WORDS)} ${pick(WORDS)}`;
      const input = { command, description: sentence(3, 7) };
      return { tool: name, input, text: `command: ${command}\ndescription: ${input.description}`, preview: command, result: code(between(2, rand() < 0.1 ? 160 : 40)).join('\n') };
    }
    if (name === 'Read') {
      // One read in five is a screenshot the agent took to look at its work.
      if (images.length && rand() < 0.2) {
        const f = pick(images);
        return { tool: name, input: { file_path: f }, file: f, text: `file_path: ${f}`, preview: f, result: 'Read image' };
      }
      const f = file();
      return { tool: name, input: { file_path: f }, file: f, text: `file_path: ${f}`, preview: f, result: numbered(between(20, rand() < 0.1 ? 600 : 150)) };
    }
    if (name === 'Edit' || name === 'Write') {
      const f = file();
      const old = code(between(1, 8));
      const next = code(between(1, 10));
      const lines = [...code(3).map((l) => ` ${l}`), ...old.map((l) => `-${l}`), ...next.map((l) => `+${l}`), ...code(3).map((l) => ` ${l}`)];
      const input = name === 'Edit' ? { file_path: f, old_string: old.join('\n'), new_string: next.join('\n') } : { file_path: f, content: code(between(20, 120)).join('\n') };
      return { tool: name, input, file: f, text: Object.entries(input).map(([k, v]) => `${k}: ${v}`).join('\n'), preview: f, result: `The file ${f} has been updated.`, patch: [{ oldStart: 10, oldLines: old.length + 6, newStart: 10, newLines: next.length + 6, lines }] };
    }
    if (name === 'Grep' || name === 'Glob') {
      const pattern = pick(WORDS);
      return { tool: name, input: { pattern }, text: `pattern: ${pattern}`, preview: pattern, result: Array.from({ length: between(3, 40) }, () => `${file()}:${between(1, 400)}: ${sentence(3, 9)}`).join('\n') };
    }
    if (name === 'TodoWrite') {
      const todos = Array.from({ length: between(3, 8) }, () => ({ content: sentence(3, 8), status: pick(['pending', 'in_progress', 'completed']) }));
      return { tool: name, input: { todos }, text: JSON.stringify({ todos }, null, 2), preview: `${todos.length} todos`, result: 'Todos have been modified successfully.' };
    }
    const prompt = Array.from({ length: between(3, 8) }, () => sentence()).join(' ');
    return { tool: 'Task', input: { description: sentence(2, 5), prompt, subagent_type: 'general-purpose' }, text: `description: ${sentence(2, 5)}\nprompt: ${prompt}`, preview: sentence(2, 5), result: Array.from({ length: between(4, 12) }, () => sentence(10, 25)).join('\n\n') };
  };
  const history = [];
  const push = (row) => history.push({ id: `c${history.length}`, ts: new Date(Date.UTC(2026, 10, 1) + history.length * 20_000).toISOString(), ...row });
  for (let turn = 0; history.length < count; turn++) {
    const text = turn === 0 ? `Chat ${n} message 0: check the sync script for the starter package and tell me what changed.` : Array.from({ length: between(1, 4) }, () => sentence()).join(' ');
    push({ kind: 'prompt', preview: text.slice(0, 80), text });
    if (rand() < 0.5) push({ kind: 'thinking', preview: sentence(4, 8), text: Array.from({ length: between(2, 8) }, () => sentence()).join(' ') });
    for (let step = between(3, 12); step > 0 && history.length < count; step--) {
      if (rand() < 0.32) {
        const t = reply();
        push({ kind: 'agent', preview: t.split('\n')[0].slice(0, 80), text: t });
      } else push({ kind: 'tool', toolUseId: `toolu_${n}_${history.length}`, ...tool() });
    }
    if (history.length < count) {
      const t = reply();
      push({ kind: 'agent', preview: t.split('\n')[0].slice(0, 80), text: t });
    }
  }
  return { kind: 'compact', from: `bench-${n}`, label: `Compacted from bench chat ${n}`, history };
}

/**
 * BENCH_PROFILE=<step name>: a CPU profile of that step, saved in BENCH_ROOT, and the functions with the most
 * self time printed. Build with LOOPER_NO_MINIFY=1 first for readable names.
 */
export async function profiled(page, name, fn) {
  if (process.env.BENCH_TRACE === name) return traced(page, name, fn);
  if (process.env.BENCH_PROFILE !== name) return fn();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const out = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync(path.join(ROOT, `${name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(profile));
  const self = new Map();
  const dt = (profile.endTime - profile.startTime) / 1000 / profile.samples.length;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const id of profile.samples) {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  console.log(`top self time in "${name}" (ms):`);
  for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${ms.toFixed(1).padStart(7)}  ${k}`);
  return out;
}

/** BENCH_TRACE=<step name>: the browser's own work in that step (style, layout, paint…), summed by event, with how many objects each layout touched. */
export async function traced(page, name, fn) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const complete = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' });
  const out = await fn();
  await cdp.send('Tracing.end');
  await complete;
  const main = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const sums = new Map();
  let layouts = 0;
  let dirty = 0;
  let total = 0;
  for (const e of events) {
    if (e.ph !== 'X' || !main.has(`${e.pid}:${e.tid}`)) continue;
    const s = sums.get(e.name) ?? { ms: 0, n: 0 };
    s.ms += e.dur / 1000;
    s.n++;
    sums.set(e.name, s);
    if (e.name === 'Layout' && e.args?.beginData) {
      layouts++;
      dirty += e.args.beginData.dirtyObjects ?? 0;
      total += e.args.beginData.totalObjects ?? 0;
    }
  }
  console.log(`browser work in "${name}" (ms, count):`);
  for (const [k, s] of [...sums].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)) console.log(`  ${s.ms.toFixed(1).padStart(7)}  ${String(s.n).padStart(5)}  ${k}`);
  if (layouts) console.log(`  layouts ${layouts}: on average ${Math.round(dirty / layouts)} dirty of ${Math.round(total / layouts)} objects`);
  // What made layout or style dirty: the reason and the node, most frequent first.
  const why = new Map();
  for (const e of events) {
    if (e.name !== 'LayoutInvalidationTracking' && e.name !== 'StyleRecalcInvalidationTracking') continue;
    const d = e.args?.data ?? {};
    const k = `${e.name.replace('InvalidationTracking', '')}: ${d.reason ?? '?'} on ${d.nodeName ?? '?'}`;
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  return out;
}


/** The seeded data's chats; BENCH_KEEP=1 reuses the data the last run seeded, when it's there. */
export async function seeded() {
  const file = path.join(ROOT, 'chats.json');
  const chats = process.env.BENCH_KEEP && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : await seed();
  fs.writeFileSync(file, JSON.stringify(chats));
  return chats;
}
