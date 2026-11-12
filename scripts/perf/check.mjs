// The performance regression check: every screen in screens.mjs and the journey in journey.mjs, measured on the
// seeded demo data (20 tasks, 20 chats) and compared with budgets.json. Exits 1 when a screen goes over its budget,
// fails to draw, or throws. In the Windows copy, after `npm run build`:
//   node scripts/perf/check.mjs            check
//   node scripts/perf/check.mjs --update   write budgets.json from this run (after a change that's meant to cost more)
//   node scripts/perf/check.mjs --only "window: Settings,ios:"   only the screens whose kind and name contain one of these
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.BENCH_ROOT ||= path.join(os.tmpdir(), 'looper-perf-check');
process.env.BENCH_ADDONS = '1';
const { launch, quit, watch, sleep, seeded, profiled, shoot, APP_DIR, CAT_HARNESS } = await import('./lib.mjs');
const { journey } = await import('./journey.mjs');
const { WINDOWS, MAIN_SCREENS, PHONE_SCREENS, PHONES } = await import('./screens.mjs');
const { phoneScreens } = await import('./phone.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGETS = path.join(HERE, 'budgets.json');
const update = process.argv.includes('--update');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const wanted = (name) => !only || only.toLowerCase().split(',').some((o) => name.toLowerCase().includes(o.trim()));

/** name → { metric: value }, and the screens that failed outright with why. */
const measured = {};
const broken = [];

/** Ids the routes' placeholders take, from the seeded data; what doesn't exist yet is made here. */
async function resolveIds(app, page, chats) {
  const ids = await page.evaluate(async () => {
    const L = window.looper;
    const [tasks, projects, templates, folders, info] = await Promise.all([L.tasks.list(), L.projects.list(), L.templates.list(), L.folders.list(), L.info()]);
    let task;
    let run;
    for (const t of tasks) {
      const runs = await L.runs.list(t.id, 1);
      if (runs[0]) {
        task = t.id;
        run = runs[0].runId ?? runs[0].id;
        break;
      }
    }
    const env = info.settings.environments[0];
    let projectFolder = (await L.projects.folders())[0]?.id;
    if (!projectFolder) projectFolder = (await L.projects.addFolder('Perf folder')).id;
    let folder = folders[0]?.id;
    if (!folder) folder = (await L.folders.add('Perf folder')).id;
    return { task, run, project: projects[0]?.id, template: templates[0]?.id, folder, projectFolder, env: env?.id, harness: env?.harnesses[0]?.id };
  });
  ids.chat = chats[0];
  const addon = await page.evaluate(async () => (await window.looper.addons.list())[0] ?? null).catch(() => null);
  if (addon) {
    ids.addon = addon.id;
    ids.addonView = addon.screens?.[0]?.id ?? addon.tab?.view ?? addon.panes?.[0]?.id;
  }
  // A message image: the PNG the seed put in the demo projects' folder, as a file an agent sent.
  const home = execFileSync('wsl.exe', ['-e', 'sh', '-c', 'echo $HOME'], { encoding: 'utf8' }).trim();
  ids.imageRow = `file:${home}/looper-demo/perf-image.png`;
  const made = await page.evaluate(async () => {
    const L = window.looper;
    const out = {};
    // A terminal session in the first project.
    const before = new Set((await L.sessions.state()).sessions.map((s) => s.id));
    await L.projects.newTerminal((await L.projects.list())[0].id);
    for (let i = 0; i < 50 && !out.terminal; i++) {
      out.terminal = (await L.sessions.state()).sessions.find((x) => x.kind === 'terminal' && !before.has(x.id))?.id;
      if (!out.terminal) await new Promise((r) => setTimeout(r, 200));
    }
    // A Remote Control helper, added as the Helpers window adds one; only while Remote Control is off, so no agent starts.
    const s = (await L.info()).settings;
    if (!s.remote?.enabled) {
      const helper = { id: 'h-perf', name: 'Helper', environmentId: 'wsl', cwd: '', instructions: '', idleRestartMin: 10 };
      await L.updateSettings({ remote: { ...s.remote, helpers: [...(s.remote?.helpers ?? []).filter((h) => h.id !== helper.id), helper] } });
      out.helper = helper.id;
    }
    return out;
  });
  Object.assign(ids, made);
  // A paired device, paired as a phone pairs.
  ids.remoteUrl = await remoteAccessUrl(page);
  if (ids.remoteUrl) {
    const { code } = await page.evaluate(() => window.looper.remoteAccess.pairingCode());
    await fetch(`${ids.remoteUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Looper-Request': '1' }, body: JSON.stringify({ code, name: 'Perf device' }) });
    ids.device = await page.evaluate(async () => (await window.looper.remoteAccess.state()).devices?.[0]?.id);
  }
  ids.builder = await startBuilder(app, ids);
  return ids;
}

/** Remote Access turned on with its local source; its address, or null when it didn't start. */
export async function remoteAccessUrl(page) {
  return page.evaluate(async () => {
    const s = await window.looper.info();
    await window.looper.updateSettings({ remoteAccess: { ...s.settings.remoteAccess, enabled: true, sources: ['local'] } });
    for (let i = 0; i < 50; i++) {
      const st = await window.looper.remoteAccess.state();
      const local = st.status?.sources?.find((x) => x.id === 'local' && x.phase === 'running');
      if (local?.url) return local.url.replace(/\/$/, '');
      await new Promise((r) => setTimeout(r, 200));
    }
    const port = (await window.looper.info()).settings.remoteAccess.port;
    return port ? `http://127.0.0.1:${port}` : null;
  });
}

/** A task builder on the cat harness, started from its setup window as the app starts one; its id. */
async function startBuilder(app, ids) {
  const opened = app.waitForEvent('window', { timeout: 20_000 });
  await openByHash(app, 'builder-setup', [620, 560]);
  const setup = await opened;
  await setup.waitForLoadState('domcontentloaded');
  await setup.waitForFunction(() => !!window.looper);
  const failed = await setup.evaluate((h) => window.looper.builder.start({ environmentId: 'wsl', harnessId: h, cwd: '/tmp' }).then(() => null, (e) => e.message), CAT_HARNESS);
  if (failed) broken.push(`Task builder: starting it failed: ${failed}`);
  await setup.waitForURL(/#builder\//, { timeout: 15_000 }).catch(() => undefined);
  const id = /#builder\/([^/]+)/.exec(setup.url())?.[1];
  if (!id) broken.push(`Task builder: its setup window stayed at ${setup.url().split('#')[1] ?? ''}`);
  return id ? decodeURIComponent(id) : undefined;
}

/** A window like the app's own (its preload, no menu) at `hash`; null: a blank page, to load the route into later. */
function openByHash(app, hash, size, contentSize = false) {
  return app.evaluate(({ BrowserWindow }, { hash: h, size: s, contentSize: c, preload, html }) => {
    const w = new BrowserWindow({ width: s[0], height: s[1], useContentSize: c, title: 'Perf', webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    w.removeMenu();
    if (h === null) void w.loadURL('about:blank');
    else void w.loadFile(html, { hash: h });
  }, { hash, size, contentSize, preload: path.join(APP_DIR, 'out', 'preload', 'index.js'), html: path.join(APP_DIR, 'out', 'renderer', 'index.html') });
}

/** What scrolls in a page: each element (the page itself too) whose content is larger than its box. */
function scrolling(page) {
  return page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll('*')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (el !== document.documentElement && !/auto|scroll/.test(cs.overflowX + cs.overflowY)) return false;
        return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''} holds ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`),
  );
}

/** BENCH_PROFILE or BENCH_TRACE set to a window's name: its load profiled or traced from a blank page (lib.mjs prints what it found). */
async function diagnose(app, screen, hash) {
  const opened = app.waitForEvent('window', { timeout: 20_000 });
  await openByHash(app, null, screen.size ?? [900, 700]);
  const page = await opened;
  await page.waitForLoadState('domcontentloaded');
  await profiled(page, screen.name, async () => {
    await app.evaluate(({ BrowserWindow }, { h, html }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'about:blank')?.loadFile(html, { hash: h }), { h: hash, html: path.join(APP_DIR, 'out', 'renderer', 'index.html') });
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 15_000 }).catch(() => undefined);
    await sleep(1500);
  });
  await page.close().catch(() => undefined);
  return null;
}

/** A copy of the first task or template as a Looper document, opened as double-clicking it does (a second start with the file). */
async function openDocument(app, page, kind) {
  const item = await page.evaluate(async (k) => (k === 'task' ? await window.looper.tasks.list() : await window.looper.templates.list())[0], kind);
  const { createdAt, updatedAt, ...rest } = item;
  const file = path.join(os.tmpdir(), `looper-perf.${kind === 'task' ? 'loopertask' : 'loopertpl'}`);
  fs.writeFileSync(file, JSON.stringify({ $type: `looper/${kind}`, $version: 3, $app: '0.0.0', ...rest, id: `${rest.id}-imported` }, null, 2));
  await app.evaluate(({ app: a }, f) => a.emit('second-instance', {}, ['Looper.exe', f], ''), file);
}

/** What makes the app open a `via` window itself. */
const VIA = {
  'import-task': (app, page) => openDocument(app, page, 'task'),
  'import-template': (app, page) => openDocument(app, page, 'template'),
  mcp: (_app, page) =>
    page.evaluate(() => {
      const server = { scope: 'user', name: 'perf', transport: 'stdio', command: 'cat', args: [], env: {}, url: '', headers: {}, raw: {} };
      void window.looper.agentSettings.editServer({ kind: 'claude-code', server, isNew: true, scopes: ['user'], taken: {} });
    }),
};

const fill = (hash, ids) => hash.replace(/\{(\w+)\}/g, (_, k) => (ids[k] === undefined ? `{${k}}` : encodeURIComponent(ids[k])));

/** Open `hash` in a window like the app's own, measure it as it loads, close it. */
async function measureWindow(app, main, screen, ids) {
  const hash = fill(screen.hash, ids);
  const missing = !screen.via && /\{(\w+)\}/.exec(hash);
  if (missing) return broken.push(`${screen.name}: no ${missing[1]} in the seeded data`);
  if (!screen.via && [process.env.BENCH_PROFILE, process.env.BENCH_TRACE].includes(screen.name)) return diagnose(app, screen, hash);
  const errors = [];
  const t0 = Date.now();
  const opened = app.waitForEvent('window', { timeout: 20_000 });
  if (screen.via) await VIA[screen.via](app, main);
  else await openByHash(app, hash, screen.size ?? [900, 700], !!screen.contentSize);
  const page = await opened.catch(() => null);
  if (!page) return broken.push(`${screen.name}: no window opened`);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.waitForLoadState('domcontentloaded');
  const drew = await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 15_000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const readyMs = Date.now() - t0;
  const cost = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frames = [];
        let timer;
        const done = () => resolve({ longestMs: Math.round(Math.max(0, ...frames.map((f) => f.duration))), blockingMs: Math.round(frames.reduce((s, f) => s + f.blockingDuration, 0)) });
        new PerformanceObserver((l) => {
          frames.push(...l.getEntries());
          clearTimeout(timer);
          timer = setTimeout(done, 1000);
        }).observe({ type: 'long-animation-frame', buffered: true });
        timer = setTimeout(done, 1000);
      }),
  );
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  // A dialog opens at a size that fits its content, as Win32 dialogs do: a scroll bar means its size needs updating.
  const scrolls = screen.fits ? await scrolling(page) : [];
  if (scrolls.length) broken.push(`${screen.name}: opens scrolling at ${screen.size.join('×')} (${scrolls.join('; ')})`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  const heapMb = Math.round(((await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20) * 10) / 10;
  await cdp.detach().catch(() => undefined);
  const rendererMb = await app.evaluate(({ BrowserWindow, app: a }, url) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url);
    const pid = w?.webContents.getOSProcessId();
    const m = a.getAppMetrics().find((x) => x.pid === pid);
    return m ? Math.round((m.memory.privateBytes ?? 0) / 1024) : 0;
  }, page.url());
  await shoot(page, `window ${screen.name}`);
  await page.close().catch(() => undefined);
  if (!drew) broken.push(`${screen.name}: drew nothing`);
  if (errors.length) broken.push(`${screen.name}: ${errors[0].slice(0, 200)}`);
  return { readyMs, ...cost, nodes, heapMb, rendererMb };
}

/** The main window's screens: the click that shows each, and what the window holds after it. */
async function measureMain(app, page, chats, terminal) {
  const selectChat = (id) =>
    app.evaluate(({ BrowserWindow }, x) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'));
      main?.webContents.send('ui:event', { type: 'sessions-select', id: x });
    }, id);
  for (const s of MAIN_SCREENS) {
    if (!wanted(`main: ${s.name}`)) continue;
    const errors = [];
    const onError = (e) => errors.push(e.message);
    page.on('pageerror', onError);
    const label = { dashboard: 'Dashboard', projects: 'Projects', tasks: 'Tasks', chats: 'Chats' }[s.tab];
    const action = async () => {
      if (s.chat) return selectChat(chats[0]);
      if (s.terminal) return terminal ? selectChat(terminal) : undefined;
      // An addon's tab is the rail's tab after Looper's four.
      if (s.addon) return page.locator('.view-tab').nth(4).click({ timeout: 5000 });
      await page.click(`.view-tab:has-text("${label}")`);
      if (s.detail) {
        await page.locator('.sidebar .task-item').first().click({ timeout: 5000 });
        await page.click(`.main .tab:has-text("${s.detail === 'runs' ? 'Runs' : 'Status'}")`, { timeout: 5000 });
      }
      if (s.project) await page.locator('.sidebar .task-item').first().click({ timeout: 5000 });
    };
    if (s.terminal && !terminal) {
      broken.push(`${s.name}: couldn't start a terminal session`);
      continue;
    }
    // Back to the Dashboard first, so each screen is drawn from another, as it is when someone goes to it.
    if (s.tab !== 'dashboard') await page.click('.view-tab:has-text("Dashboard")').catch(() => undefined);
    await sleep(500);
    const step = await watch(page, action).catch((e) => {
      broken.push(`${s.name}: ${e.message.split('\n')[0]}`);
      return null;
    });
    page.off('pageerror', onError);
    if (!step) continue;
    if (errors.length) broken.push(`${s.name}: ${errors[0].slice(0, 200)}`);
    const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    await shoot(page, `main ${s.name}`);
    measured[`main: ${s.name}`] = { worstFrameMs: step.worstFrame, longestMs: step.longest, mainFreezeMs: step.mainFreeze, nodes };
    console.log(`main: ${s.name}`, JSON.stringify(measured[`main: ${s.name}`]));
  }
}

const chats = await seeded();
// The journey first, on the data as seeded: the screens below turn on Remote Access and add a helper and a builder.
if (!only || wanted('journey:')) {
  const steps = {};
  await journey(chats, (name, value) => (steps[name] = value));
  for (const [name, v] of Object.entries(steps)) {
    const keep = Object.fromEntries(Object.entries(v).filter(([k, x]) => typeof x === 'number' && ['worstFrame', 'longest', 'mainFreeze', 'taskManagerMb', 'privateMb', 'toEnd', 'worstMs'].includes(k)));
    measured[`journey: ${name}`] = keep;
    console.log(`journey: ${name}`, JSON.stringify(keep));
  }
}
const { app, page } = await launch();
await sleep(3000);
const ids = await resolveIds(app, page, chats);
for (const w of WINDOWS) {
  if (!w.hash || !wanted(`window: ${w.name}`)) continue;
  // The lower of two opens: the first may meet the disk cold.
  const a = await measureWindow(app, page, w, ids);
  if (!a || typeof a === 'number') continue;
  const b = await measureWindow(app, page, w, ids);
  measured[`window: ${w.name}`] = b && typeof b === 'object' ? Object.fromEntries(Object.keys(a).map((k) => [k, Math.min(a[k], b[k])])) : a;
  console.log(`window: ${w.name}`, JSON.stringify(measured[`window: ${w.name}`]));
}
await measureMain(app, page, chats, ids.terminal);
if (PHONES.some((os) => wanted(`${os}:`)) || PHONE_SCREENS.some((s) => PHONES.some((os) => wanted(`${os}: ${s.name}`)))) {
  const phone = await phoneScreens(app, page, chats, PHONE_SCREENS, PHONES, wanted).catch((e) => {
    broken.push(`phones: ${e.message.split('\n')[0]}`);
    return {};
  });
  Object.assign(measured, phone.measured ?? {});
  broken.push(...(phone.broken ?? []));
}
await quit(app);

// A budget leaves room for the noise between runs: times double or 100 ms more (a window's first frame alone swings
// between 80 and 180 ms on battery saver), counts a fifth more, memory 15% more.
const budgetOf = (metric, v) => {
  if (metric === 'toEnd') return 0;
  if (/Ms$/.test(metric) && metric !== 'taskManagerMb') return Math.max(Math.round(v * 2), v + 100);
  if (metric === 'nodes') return Math.round(v * 1.2) + 20;
  if (metric === 'heapMb') return Math.round(v * 1.25 + 1);
  return Math.round(v * 1.15) + 2;
};
const metricKey = (k) => (k === 'worstFrame' ? 'worstFrameMs' : k === 'longest' ? 'longestMs' : k === 'worstMs' ? 'worstKeyMs' : k === 'mainFreeze' ? 'mainFreezeMs' : k);

const budgets = fs.existsSync(BUDGETS) ? JSON.parse(fs.readFileSync(BUDGETS, 'utf8')) : {};
const over = [];
for (const [name, values] of Object.entries(measured)) {
  for (const [k, v] of Object.entries(values)) {
    const metric = metricKey(k);
    if (update) {
      (budgets[name] ??= {})[metric] = budgetOf(metric, v);
      continue;
    }
    const limit = budgets[name]?.[metric];
    if (limit === undefined) over.push(`${name}: no budget for ${metric} (run with --update)`);
    else if (v > limit) over.push(`${name}: ${metric} ${v} over its budget of ${limit}`);
  }
}
for (const [name, values] of Object.entries(measured)) console.log(name.padEnd(48), Object.entries(values).map(([k, v]) => `${metricKey(k)} ${v}`).join('  '));
if (update) {
  const sorted = Object.fromEntries(Object.entries(budgets).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BUDGETS, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`\nwrote ${Object.keys(measured).length} budgets to ${path.relative(APP_DIR, BUDGETS)}`);
}
for (const b of broken) console.log(`BROKEN  ${b}`);
for (const o of over) console.log(`OVER    ${o}`);
console.log(broken.length || over.length ? `\nFAILED: ${broken.length} broken, ${over.length} over budget` : '\nPASSED');
process.exit(broken.length || over.length ? 1 : 0);
