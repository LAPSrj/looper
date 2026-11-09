// What the page process's main thread does while one window opens: each task over 16 ms, split into self time by
// event (script, style, layout, paint…), with the scripts and functions that ran. In the Windows copy, after a build:
//   node scripts/perf/anatomy.mjs "session-name/x"           a window's route (its hash)
//   node scripts/perf/anatomy.mjs main "<script>"             a step in the main window: the script runs in its page
import * as path from 'node:path';
import { launch, quit, sleep, seeded, APP_DIR } from './lib.mjs';

const [target = 'session-name/x', script] = process.argv.slice(2);
await seeded();
const { app, page } = await launch();
await sleep(5000);
const cdp = await page.context().newCDPSession(page);
const events = [];
cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
const complete = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', {
  categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute,blink,loading,disabled-by-default-v8.compile',
  transferMode: 'ReportEvents',
});
await sleep(300);
if (target === 'main') await page.evaluate(script);
else {
  await app.evaluate(
    ({ BrowserWindow }, { hash, preload, html }) => {
      const w = new BrowserWindow({ width: 640, height: 480, title: 'Anatomy', webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      w.removeMenu();
      void w.loadFile(html, { hash });
    },
    { hash: target, preload: path.join(APP_DIR, 'out', 'preload', 'index.js'), html: path.join(APP_DIR, 'out', 'renderer', 'index.html') },
  );
}
await sleep(3000);
await cdp.send('Tracing.end');
await complete;
await quit(app);

const mains = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
const byThread = new Map();
for (const e of events) {
  if (e.ph !== 'X' || !mains.has(`${e.pid}:${e.tid}`) || e.dur === undefined) continue;
  const k = `${e.pid}:${e.tid}`;
  if (!byThread.has(k)) byThread.set(k, []);
  byThread.get(k).push(e);
}
const label = (e) => {
  const d = e.args?.data ?? e.args?.beginData ?? {};
  const where = d.url ? path.basename(String(d.url).split('?')[0]) : '';
  const fn = d.functionName ? ` ${d.functionName}` : '';
  return ['FunctionCall', 'EvaluateScript', 'v8.compile', 'v8.compileModule', 'v8.evaluateModule', 'TimerFire', 'EventDispatch'].includes(e.name) ? `${e.name} ${where}${fn}${d.type ? ` ${d.type}` : ''}`.trim() : e.name;
};
for (const [, list] of byThread) {
  list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  // Self time: each event's duration less its direct children's.
  const stack = [];
  for (const e of list) {
    e.self = e.dur;
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
    const parent = stack.at(-1);
    if (parent) {
      parent.self -= e.dur;
      e.top = parent.top ?? parent;
    }
    stack.push(e);
  }
  const tops = list.filter((e) => !e.top && e.dur > 16_000);
  console.log(`\n${tops.length} tasks over 16 ms, ${Math.round(tops.reduce((s, e) => s + e.dur, 0) / 1000)} ms in all`);
  for (const t of tops.sort((a, b) => b.dur - a.dur).slice(0, 6)) {
    const sums = new Map();
    for (const e of list) if (e === t || e.top === t) sums.set(label(e), (sums.get(label(e)) ?? 0) + e.self);
    console.log(`task ${(t.dur / 1000).toFixed(1)} ms at +${Math.round((t.ts - list[0].ts) / 1000)} ms:`);
    for (const [k, us] of [...sums].sort((a, b) => b[1] - a[1]).slice(0, 14)) if (us >= 500) console.log(`  ${(us / 1000).toFixed(1).padStart(7)}  ${k}`);
  }
}
