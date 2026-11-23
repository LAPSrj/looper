// The conformance check for phone and tablet screens: npm run ui-check
//
// Drives the built app's phone pages (scripts/perf/phone.mjs's devices and pairing): the iPhone 15 and iPad Pro 11 in WebKit,
// and the Pixel 7 and Galaxy Tab S4 held sideways in Chromium. It opens every screen of scripts/perf/screens.mjs's
// PHONE_SCREENS, then the Activity sheet of a chat that has subagents and background commands, a project's and a task's
// parts and the More screens, and asserts from the DOM what ios.md (iOS 27) and Material 3 say about them (inspect.mjs). Each
// failure prints with its screen and the measured value; the exit code is 1 when there is any.
//   npm run build && npm run ui-check
//   npm run ui-check -- --device ios,android     only these devices (iphone, ipad, android, android-tablet)
//   npm run ui-check -- --only Activity          only the screens whose name contains it
//   UI_CHECK_SHOTS=dir npm run ui-check          a screenshot of each screen in dir, to look at what failed
//   UI_CHECK_OUT=/tmp/x/out npm run ui-check     a build other than out/ (npx electron-vite build --outDir /tmp/x/out)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEVICE, launchBrowser, pairDevice, tab, tap } from '../perf/phone.mjs';
import { PHONE_SCREENS, PHONES } from '../perf/screens.mjs';
import { RULES, inspect, inspectPaneGroups } from './inspect.mjs';
import { REPO, ROOT, sleep, startApp, stopApp } from './app.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : '');
const only = arg('--only').toLowerCase();
const wantedDevices = arg('--device')
  ? arg('--device')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^iphone$/, 'ios'))
  : PHONES;
const unknown = wantedDevices.filter((d) => !PHONES.includes(d));
if (unknown.length) {
  console.error(`--device takes iphone, ipad, android and android-tablet, not "${unknown.join(', ')}"`);
  process.exit(2);
}
const SHOTS = process.env.UI_CHECK_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** Every failure: { device, screen, rule, what, measured }. */
const failures = [];
const seen = new Set();
const checked = [];

/** The first element matching `selector` that is shown and can be tapped (not under another window), the newest window's first. */
const visible = async (page, selector, timeout = 4000) => {
  const t0 = Date.now();
  for (;;) {
    for (const f of page.frames().slice().reverse()) {
      const all = f.locator(selector);
      const n = Math.min(await all.count().catch(() => 0), 8);
      for (let i = 0; i < n; i++) {
        const l = all.nth(i);
        if ((await l.isVisible().catch(() => false)) && (await l.click({ trial: true, timeout: 700 }).then(() => true, () => false))) return l;
      }
    }
    if (Date.now() - t0 > timeout) return null;
    await sleep(250);
  }
};

/** Closes every window over the main window, as the phone's own Close does. */
async function closeWindows(page) {
  const main = page.frames().find((f) => /frame\.html\?w=/.test(f.url()));
  for (const f of page.frames()) if (f !== main && /frame\.html\?w=/.test(f.url())) await f.evaluate(() => window.close()).catch(() => undefined);
  await sleep(900);
}

/** Back out of one pushed screen, by the bar's Back. */
async function back(page) {
  const b = await visible(page, '.ios-bar-row .ios-back, .md-bar-row .md-icon-btn[aria-label="Back"], .pg-inline-back', 2000);
  if (b) {
    await b.click().catch(() => undefined);
    await sleep(1200);
  }
}

/** Waits (up to 10 s) until no notification banner or snackbar is showing over the screen. */
async function bannersGone(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const shown = await page.evaluate(() => [...document.querySelectorAll('.ios-banner, .md-snackbar, .ws-toast')].some((el) => el.getBoundingClientRect().height > 0)).catch(() => false);
    if (!shown) return;
    await sleep(250);
  }
}

/**
 * Waits (up to 3 s) until nothing on the phone's page or in its windows is moving, so a screen still sliding in (a
 * push, a sheet) is measured where it lands. Endless animations (a spinner) don't count.
 */
async function settled(page) {
  const t0 = Date.now();
  const moving = () =>
    document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity));
  while (Date.now() - t0 < 3000) {
    const any = (await Promise.all(page.frames().map((f) => f.evaluate(moving).catch(() => false)))).some(Boolean);
    if (!any) return;
    await sleep(100);
  }
}

async function inspectScreen(page, device, os, screen) {
  await sleep(900);
  await settled(page);
  const tablet = device === 'ipad' || device === 'android-tablet';
    // A page Preview shows is the user's file, not Looper's screen, and its sandbox makes reading across it an error.
  const frames = page.frames().filter((f) => !/\/preview-frame\//.test(f.url()));
  const found = (await Promise.all(frames.map((f) => f.evaluate(inspect, { os: os === 'ios' || os === 'ipad' ? 'ios' : 'android', tablet }).catch(() => [])))).flat();
  checked.push(`${device}: ${screen}`);
  for (const x of found) {
    const key = [device, screen, x.rule, x.what, x.measured].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ device, screen, ...x });
  }
  // The top window keeps drawing: three seconds of requestAnimationFrame, none under 5 frames (a backdrop-filter over
  // another one once held the iPad's frames for seconds at a time, and its taps with them).
  const top = frames.filter((f) => /frame\.html\?w=/.test(f.url())).at(-1);
  if (top) {
    const second = () => top.evaluate(() => new Promise((res) => { let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => res(n), 1000); })).catch(() => null);
    const counts = [await second(), await second(), await second()];
    if (counts.some((n) => n !== null && n < 5)) failures.push({ device, screen, rule: 'frames-stall', what: 'the window', measured: `${counts.join(', ')} frames in three seconds` });
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${device}-${screen.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
}

const notReached = (device, screen, e) => {
  failures.push({ device, screen, rule: 'not-reached', what: 'the screen', measured: String(e?.message ?? e).split('\n')[0].slice(0, 160) });
};

async function root(page, label) {
  await closeWindows(page);
  const t = await tab(page, label);
  await t.click({ timeout: 5000 });
  await sleep(400);
  await (await tab(page, label)).click().catch(() => undefined);
  await sleep(900);
}

async function phoneTour(page, device, os, chatTitle) {
  const step = async (name, fn) => {
    if (only && !`${device}: ${name}`.toLowerCase().includes(only)) return;
    try {
      await fn(name);
    } catch (e) {
      notReached(device, name, e);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${device}-FAILED-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
    }
  };
  const look = (name) => inspectScreen(page, device, os, name);
  const click = async (selector, timeout) => {
    const l = await visible(page, selector, timeout);
    if (!l) throw new Error(`nothing shows ${selector}`);
    await l.click({ timeout: 5000 });
    await sleep(1500);
  };
  const part = (name) => `.pg-segmented-wrap button:has-text("${name}"), [role=tab]:has-text("${name}"), .md-tab:has-text("${name}")`;

  // The screens of the perf list: the tabs and each kind of pushed screen.
  for (const s of PHONE_SCREENS) {
    await step(s.name, async () => {
      await root(page, s.tab);
      for (const text of s.taps ?? []) {
        await sleep(600);
        await tap(page, text);
      }
      await look(s.name);
    });
  }

  // The fixture addon's pane (fixture-addon/): a few hundred items in 22 groups. Every group is a list section.
  await step('Addon pane groups', async () => {
    const groups = async (name, min = 10) => {
      await look(name);
      const found = (await Promise.all(page.frames().map((f) => f.evaluate(inspectPaneGroups, min).catch(() => [])))).flat();
      for (const x of found) failures.push({ device, screen: name, ...x });
    };
    await root(page, 'More');
    await tap(page, 'Passwords');
    await sleep(2500);
    await groups('Addon pane groups');
    // A search leaves the groups with a match.
    const field = await visible(page, '.pg-search input', 3000);
    if (!field) throw new Error('nothing shows the pane search');
    await field.fill('photos');
    await sleep(1200);
    await groups('Addon pane groups: search', 1);
  });

  // The Git addon's Clone Repository sheet: its rows (a path, a pop-up button) and its folder picker.
  await step('Git: Clone Repository', async (name) => {
    await root(page, 'Projects');
    const main = page.frames().find((f) => /frame\.html\?w=/.test(f.url()));
    await main.evaluate(() => window.looper.addons.open('git', 'clone'));
    await sleep(2500);
    await look(name);
    const folder = await visible(page, '.path-row, .path-browse', 3000);
    if (!folder) throw new Error('no Folder row');
    await folder.click();
    await sleep(2500);
    await look(`${name}: folder picker`);
    const close = await visible(page, '.ios-files-bar [aria-label="Close"], .md-own-card header [aria-label="Close"]', 2000);
    if (close) await close.click();
    else await page.keyboard.press('Escape').catch(() => undefined);
    await closeWindows(page);
  });

  await step('Chats overview', async () => {
    await root(page, 'Chats');
    await tap(page, 'Overview');
    await look('Chats overview');
  });

  await step('Task: Runs', async () => {
    await root(page, 'Tasks');
    await tap(page, 'Development');
    await sleep(600);
    await tap(page, 'Issue triage');
    await sleep(1000);
    await click(part('Runs'), 3000);
    await look('Task: Runs');
    const row = await visible(page, '.pg-row.tappable', 2000);
    if (row) {
      await row.click();
      await sleep(2500);
      await look('Task: a run');
    }
  });

  await step('Project parts', async () => {
    await root(page, 'Projects');
    await tap(page, 'Web app');
    await sleep(1000);
    for (const seg of ['Status', 'Tasks', 'Chats', 'Git']) {
      const l = await visible(page, part(seg), 2500);
      if (!l) continue;
      await l.click();
      await sleep(1800);
      await look(`Project: ${seg}`);
    }
    const row = await visible(page, '.pg-row.tappable', 2000);
    if (row) {
      await row.click();
      await sleep(1800);
      await look('Project: Git row');
    }
  });

  await step('Chat Activity', async () => {
    await root(page, 'Chats');
    const seg = await visible(page, part('Chats'), 2500);
    if (seg) {
      await seg.click();
      await sleep(1200);
    }
    await tap(page, new RegExp('^' + chatTitle.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await sleep(3000);
    await look('Chat');
    await click('[aria-label="Activity"]', 6000);
    await look('Chat: Activity');
    for (const name of ['Background', 'Subagents', 'Files', 'Now']) {
      // A notification banner (a demo task's error) covers the sheet's top for a few seconds; the tabs are under it.
      await bannersGone(page);
      const l = await visible(page, part(name), 3000);
      // iOS: tabs a segmented control can't hold are a pop-up button (TabBar), whose menu lists them.
      // TabBar's overflow 'sections' (the Activity sheet): rows that open the tab, Back returning to them.
      const rowTab = l ? null : await visible(page, '.tab-sections .pg-row', 1500);
      const popUp = l || rowTab ? null : await visible(page, '.tabs-popup .select-hit', 1500);
      if (!l && !popUp && !rowTab) {
        notReached(device, `Chat: Activity ${name}`, 'no such tab');
        continue;
      }
      if (l) await l.click();
      else if (rowTab) {
        const r = await visible(page, `.tab-sections .pg-row:has-text("${name}")`, 1500);
        if (!r) {
          notReached(device, `Chat: Activity ${name}`, 'no such row');
          continue;
        }
        await r.click();
      } else {
        await popUp.click();
        await sleep(900);
        const item = await visible(page, `.ios-menu-item:has-text("${name}")`, 2000);
        if (!item) {
          notReached(device, `Chat: Activity ${name}`, 'no such item in the tabs menu');
          await page.keyboard.press('Escape').catch(() => undefined);
          continue;
        }
        await item.click();
      }
      await sleep(1800);
      await look(`Chat: Activity ${name}`);
      const row = name === 'Background' || name === 'Subagents' ? await visible(page, '.pg-sheet .pg-row.tappable, .pg-row.tappable', 2500) : null;
      if (row) {
        await row.click();
        await sleep(2500);
        await look(`Chat: Activity ${name} item`);
        await back(page);
      } else if (name === 'Background' || name === 'Subagents') notReached(device, `Chat: Activity ${name} item`, 'the tab lists nothing to open');
    }
  });

  // Preview: an HTML file with an image in a folder next to it, opened as a device opens a file the agent sent. The
  // image loads from the file's folder, and the sheet runs to the screen's bottom edge.
  await step('Preview: HTML file', async (name) => {
    await root(page, 'Chats');
    const dir = path.join(ROOT, 'projects', 'preview');
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'assets', 'icon.png'), path.join(dir, 'img', 'a.png'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Preview</title><img src="img/a.png" alt="Icon" width="64" height="64">');
    const main = page.frames().find((f) => /frame\.html\?w=/.test(f.url()));
    await main.evaluate((p) => window.looper.sessions.openFile('ui-check', 'ui-check', p, false), path.join(dir, 'index.html'));
    await sleep(3500);
    await look(name);
    const frame = page.frames().find((f) => /\/preview-frame\//.test(f.url()));
    const loaded = frame ? await frame.evaluate(() => document.images.length > 0 && [...document.images].every((i) => i.complete && i.naturalWidth > 0)).catch(() => false) : false;
    if (!loaded) failures.push({ device, screen: name, rule: 'preview-files', what: "the image in the page's folder", measured: frame ? 'not loaded' : 'no page' });
    const close = await visible(page, '.ios-own-sheet header [aria-label="Close"], .md-own-card header [aria-label="Close"]', 2000);
    if (close) await close.click();
    else await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(900);
  });

  for (const label of ['Agent Settings', 'Settings', 'Instructions', 'About Looper', 'This Device']) {
    await step(`More: ${label}`, async () => {
      await root(page, 'More');
      await tap(page, new RegExp(`^${label}$`, 'i'));
      await sleep(2200);
      await look(`More: ${label}`);
      if (label === 'Settings') {
        const row = await visible(page, '.pg-row.tappable', 2000);
        if (row) {
          await row.click();
          await sleep(1800);
          await look('More: Settings section');
        }
      }
      await closeWindows(page);
      if (label === 'This Device') {
        await page.keyboard.press('Escape').catch(() => undefined);
        await sleep(800);
        if (await visible(page, '.ios-own-sheet, .md-sheet-layer', 500)) await page.mouse.click(5, 5).catch(() => undefined);
        await sleep(800);
      }
    });
  }
}

const { app, page: main, url, chat } = await startApp();
let broken = false;
try {
  for (const device of wantedDevices) {
    const browser = await launchBrowser(device);
    try {
      const context = await browser.newContext({ ...DEVICE[device] });
      const phone = await context.newPage();
      phone.on('pageerror', (e) => failures.push({ device, screen: 'page', rule: 'page-error', what: 'the page', measured: e.message.slice(0, 160) }));
      if (!(await pairDevice(main, phone, url, 'UI check phone'))) throw new Error('pairing failed');
      await phone.goto(url);
      await tab(phone, 'Dashboard', 30_000);
      await sleep(3000);
      await phoneTour(phone, device, device, chat.title);
    } catch (e) {
      notReached(device, 'start', e);
    } finally {
      await browser.close();
    }
  }
} catch (e) {
  console.error(e);
  broken = true;
} finally {
  await stopApp(app);
}

const order = Object.keys(RULES);
failures.sort((a, b) => wantedDevices.indexOf(a.device) - wantedDevices.indexOf(b.device) || order.indexOf(a.rule) - order.indexOf(b.rule));
for (const f of failures) console.log(`FAIL ${f.device}: ${f.screen}: ${RULES[f.rule] ?? f.rule}: ${f.what}: ${f.measured}`);
const byRule = {};
for (const f of failures) (byRule[f.rule] ??= new Set()).add(f.device);
console.log(`\n${checked.length} screens checked on ${wantedDevices.join(', ')}; ${failures.length} failures`);
for (const [rule, devices] of Object.entries(byRule)) console.log(`  ${rule}: ${failures.filter((f) => f.rule === rule).length} on ${[...devices].join(', ')}`);
process.exit(broken ? 2 : failures.length ? 1 : 0);
