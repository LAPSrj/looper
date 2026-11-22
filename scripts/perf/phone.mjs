// A phone's or tablet's screens for check.mjs and bench.mjs: Remote Access turned on in the running app, a device
// paired, and each screen opened as a person taps to it, on an iPhone (ios, WebKit), an iPad (ipad, WebKit), a Pixel
// (android, Chromium) or an Android tablet (android-tablet, Chromium). The tablets get the app's tablet layout, and each screen
// is checked to have drawn it. WebKit has no long-frame reports, so a screen's cost is its frame gaps while it's drawn,
// what it holds after, and the frame gaps of a steady scroll through it.
import { webkit, chromium, devices } from 'playwright-core';
import * as path from 'node:path';
import { ROOT, shoot, sleep } from './lib.mjs';
import { settle, noteConditions } from './machine.mjs';
import { mainThread } from './main-thread.mjs';

// The Android tablet is held sideways: a tablet's portrait width (712 px on a Galaxy Tab S4) is under Material's
// expanded width (840 dp), where the layout takes its rail and two panes, so only landscape draws the tablet layout.
export const DEVICE = { ios: devices['iPhone 15'], ipad: devices['iPad Pro 11'], android: devices['Pixel 7'], 'android-tablet': devices['Galaxy Tab S4 landscape'] };
const TABLET = new Set(['ipad', 'android-tablet']);
// Playwright's own Chromium in its new headless mode ("chromium" channel, the real browser rather than the headless shell),
// so the browser stays the version the repo installed instead of following Edge's updates.
export const launchBrowser = (os) => (os === 'ios' || os === 'ipad' ? webkit.launch() : chromium.launch({ channel: 'chromium' }));

// CDP slowdown that makes this PC's Chromium score a Pixel 7's 100 on Speedometer 2.0 (101 and 102 at 2, 328 at 1; Notebookcheck's Pixel 7 review);
// BENCH_CPU_SLOWDOWN overrides it (1 for none).
const ANDROID_CPU_SLOWDOWN = 2;
const slowdownOf = (os) => (os === 'android' || os === 'android-tablet' ? Number(process.env.BENCH_CPU_SLOWDOWN || ANDROID_CPU_SLOWDOWN) : 1);
/** Waits and timeouts grow with the slowdown, as everything the page does takes that much longer. */
let SLOW = 1;

/** Frame gaps from the tap until 1 s passes without one over 25 ms. */
async function frames(page, action) {
  await page.evaluate(() => {
    // Its own buffer: a frame already asked for when the measurement ends stops here instead of writing into the next one's.
    const gaps = (window.__gaps = []);
    let last = performance.now();
    const tick = (t) => {
      if (window.__gaps !== gaps) return;
      gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  const t0 = Date.now();
  for (;;) {
    await sleep(250);
    const quiet = await page.evaluate(() => {
      const g = window.__gaps;
      let since = 0;
      for (let i = g.length - 1; i >= 0 && g[i] <= 25; i--) since += g[i];
      return since;
    });
    if (quiet >= 1000 || Date.now() - t0 > 15_000 * SLOW) break;
  }
  return page.evaluate(() => {
    const g = window.__gaps.slice(1);
    window.__gaps = null;
    return { worstFrameMs: Math.round(Math.max(0, ...g)) };
  });
}

/** Frame gaps from calling this until the returned function is called, which gives the median, 95th percentile and worst. */
async function gapsUntil(page, action) {
  await page.evaluate(() => {
    const gaps = (window.__sgaps = []);
    let last = performance.now();
    const tick = (t) => {
      if (window.__sgaps !== gaps) return;
      gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  const g = await page.evaluate(() => {
    const g = window.__sgaps.slice(1);
    window.__sgaps = null;
    return g;
  });
  const s = [...g].sort((a, b) => a - b);
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0);
  return { scrollMedianMs: at(0.5), scrollP95Ms: at(0.95), scrollWorstMs: Math.round(s.at(-1) ?? 0) };
}

/**
 * A steady scroll through the screen's own scroller (the one with the most to scroll that shows in the top window),
 * a step every frame from inside its page, as WebKit on a phone takes no wheel; null when nothing on the screen scrolls.
 */
async function scrollCost(page) {
  let best = null;
  for (const f of page.frames()) {
    const found = await f
      .evaluate(() => {
        const win = window.frameElement?.closest('.ph-win');
        if (win && !win.classList.contains('top')) return null;
        let pick = null;
        for (const el of document.querySelectorAll('*')) {
          if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
          const over = el.scrollHeight - el.clientHeight;
          const r = el.getBoundingClientRect();
          if (over <= 100 || r.width < 50 || r.bottom <= 0 || r.top >= innerHeight) continue;
          if (!pick || over > pick.over) pick = { el, over };
        }
        if (!pick) return null;
        pick.el.setAttribute('data-perf-scroll', '');
        return pick.over;
      })
      .catch(() => null);
    if (found && (!best || found > best.over)) {
      if (best) await best.f.evaluate(() => document.querySelector('[data-perf-scroll]')?.removeAttribute('data-perf-scroll')).catch(() => undefined);
      best = { f, over: found };
    } else if (found) await f.evaluate(() => document.querySelector('[data-perf-scroll]')?.removeAttribute('data-perf-scroll')).catch(() => undefined);
  }
  if (!best) return null;
  return gapsUntil(page, () =>
    best.f.evaluate(async () => {
      const el = document.querySelector('[data-perf-scroll]');
      let dir = el.scrollTop + el.clientHeight >= el.scrollHeight - 2 ? -1 : 1;
      for (let i = 0; i < 180; i++) {
        el.scrollTop += dir * 12;
        if (el.scrollTop <= 0) dir = 1;
        else if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) dir = -1;
        await new Promise((r) => requestAnimationFrame(r));
      }
      el.removeAttribute('data-perf-scroll');
    }),
  );
}

/** What a tablet's layout has that a phone's doesn't, found in the page and its windows' frames; the ones missing. */
async function tabletLayoutMissing(page, os, screen) {
  const facts = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() => {
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          return {
            root: !!document.querySelector('.ph-root.tablet'),
            page: document.documentElement.classList.contains('tablet'),
            topTabs: [...document.querySelectorAll('.ios-tab')].some(shown),
            rail: [...document.querySelectorAll('.phone-tabbar.rail')].some(shown),
            split: [...document.querySelectorAll('.pg-split')].some((el) => shown(el) && [...el.children].filter((c) => /pg-split-(lead|detail|pane)/.test(c.className) && shown(c)).length >= 2),
          };
        })
        .catch(() => null),
    ),
  );
  const any = (k) => facts.some((x) => x?.[k]);
  const missing = [];
  if (!any('root')) missing.push('the shell is not in its tablet layout');
  if (!any('page')) missing.push("the page isn't in its tablet layout (html.tablet)");
  if (os === 'ipad' && !screen.window && !any('topTabs')) missing.push("the tabs aren't in the top bar");
  if (os === 'android-tablet' && !screen.window && !any('rail')) missing.push('no navigation rail');
  if (screen.split && !any('split')) missing.push('no list column beside the detail');
  return missing;
}

/** Tap the first visible element with exactly this text (or matching this pattern), in the page or any of its windows' frames. */
export async function tap(page, text) {
  for (let i = 0; i < 20 * SLOW; i++) {
    for (const f of page.frames()) {
      const el = f.getByText(text, { exact: typeof text === 'string' }).first();
      if (await el.isVisible().catch(() => false)) return el.click({ timeout: 5000 * SLOW });
    }
    await sleep(250);
  }
  throw new Error(`nothing shows "${text}"`);
}

/** A tab of the main window's tab bar, which is inside the main window's frame. */
export async function tab(page, label, timeout = 5000 * SLOW) {
  const t0 = Date.now();
  for (;;) {
    for (const f of page.frames()) {
      const el = f.locator('button.phone-tab, button.ios-tab', { hasText: label }).first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    if (Date.now() - t0 > timeout) throw new Error(`no "${label}" tab`);
    await sleep(250);
  }
}

/** Elements in the page and in its windows' frames. */
const nodeCount = (page) => Promise.all(page.frames().map((f) => f.evaluate(() => document.getElementsByTagName('*').length).catch(() => 0))).then((n) => n.reduce((s, x) => s + x, 0));

/** Elements once the screen stops adding them: a conversation draws its older messages while the page is idle, so an early count swings by 300. */
async function settledCount(page) {
  let last = await nodeCount(page);
  for (let i = 0; i < 20 * SLOW; i++) {
    await sleep(500);
    const n = await nodeCount(page);
    if (n === last) return n;
    last = n;
  }
  return last;
}

/** main-thread.mjs's result as `<key>Ms` (and `<key>ProbeMs` when the probe ran beside it). */
const threadValues = (key, t) => (typeof t === 'number' ? { [`${key}Ms`]: t } : { [`${key}Ms`]: t.ms, [`${key}ProbeMs`]: t.probeMs });

/** Pairs `phone` (a browser page) with the app's main window `main` the way a person types its pairing code: true when the app accepted it. */
export async function pairDevice(main, phone, url, name) {
  const { code } = await main.evaluate(() => window.looper.remoteAccess.pairingCode());
  await phone.goto(url);
  return phone.evaluate(
    async ([c, n]) => (await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Looper-Request': '1' }, body: JSON.stringify({ code: c, name: n }) })).ok,
    [code, name],
  );
}

export async function phoneScreens(app, page, chats, screens, phones, wanted) {
  const measured = {};
  const broken = [];
  const url = await page.evaluate(async () => {
    const s = await window.looper.info();
    await window.looper.updateSettings({ remoteAccess: { ...s.settings.remoteAccess, enabled: true, sources: ['local'] } });
    for (let i = 0; i < 50; i++) {
      const st = await window.looper.remoteAccess.state();
      const local = st.sources?.find((x) => x.id === 'local' && x.phase === 'running');
      if (local?.url) return local.url;
      await new Promise((r) => setTimeout(r, 200));
    }
    const port = (await window.looper.info()).settings.remoteAccess.port;
    return port ? `http://127.0.0.1:${port}` : null;
  });
  if (!url) return { measured, broken: ['phones: Remote Access didn\'t start'] };
  for (const os of phones) {
    const browser = await launchBrowser(os);
    try {
      const context = await browser.newContext({ ...DEVICE[os] });
      const phone = await context.newPage();
      SLOW = slowdownOf(os);
      if (SLOW > 1) await (await context.newCDPSession(phone)).send('Emulation.setCPUThrottlingRate', { rate: SLOW });
      const errors = [];
      phone.on('pageerror', (e) => errors.push(e.message));
      const paired = await pairDevice(page, phone, url, 'Perf phone');
      if (!paired) {
        broken.push(`${os}: pairing failed`);
        continue;
      }
      const settledStart = await settle();
      const t0 = Date.now();
      await phone.goto(url);
      // The shell is up once its tab bar is.
      const up = await tab(phone, 'Dashboard', 30_000 * SLOW).then(() => true, () => false);
      if (!up) {
        broken.push(`${os}: the shell didn't show its tabs`);
        continue;
      }
      // What the start shows depends on the windows it restores, so only its time is measured.
      measured[`${os}: start`] = { readyMs: Date.now() - t0 };
      noteConditions(`${os}: start`, settledStart, t0);
      for (const s of screens) {
        const name = `${os}: ${s.name}`;
        if (!wanted(name)) continue;
        if (s.tab !== 'Dashboard') await (await tab(phone, 'Dashboard')).click().catch(() => undefined);
        await sleep(500);
        errors.length = 0;
        const settled = await settle();
        const busy = await mainThread(phone);
        const started = Date.now();
        const step = await frames(phone, async () => {
          await (await tab(phone, s.tab)).click({ timeout: 5000 * SLOW });
          // A tab keeps the screens pushed on it; tapping it again goes back to its root, as on a phone.
          if (s.taps?.length) {
            await sleep(300);
            await (await tab(phone, s.tab)).click({ timeout: 5000 * SLOW });
          }
          for (const text of s.taps ?? []) {
            await sleep(600);
            await tap(phone, text);
          }
        }).catch(async (e) => {
          broken.push(`${name}: ${e.message.split('\n')[0]}`);
          await phone.screenshot({ path: path.join(ROOT, `${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
          return null;
        });
        const thread = await busy.stop();
        if (!step) continue;
        if (errors.length) broken.push(`${name}: ${errors[0].slice(0, 200)}`);
        measured[name] = { ...step, ...threadValues('mainThread', thread), nodes: await settledCount(phone) };
        await shoot(phone, name);
        if (TABLET.has(os)) {
          const missing = await tabletLayoutMissing(phone, os, s);
          if (missing.length) broken.push(`${name}: not drawn as a tablet: ${missing.join(', ')}`);
        }
        const scrollBusy = await mainThread(phone);
        const scroll = await scrollCost(phone).catch((e) => (broken.push(`${name}: scrolling failed: ${e.message.split('\n')[0]}`), null));
        const scrollThread = await scrollBusy.stop();
        if (scroll) Object.assign(measured[name], scroll, threadValues('scrollMainThread', scrollThread));
        noteConditions(name, settled, started);
      }
    } catch (e) {
      broken.push(`${os}: ${e.message.split('\n')[0]}`);
    } finally {
      SLOW = 1;
      await browser.close();
    }
  }
  return { measured, broken };
}
