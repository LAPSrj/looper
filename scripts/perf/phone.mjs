// A phone's screens for check.mjs: Remote Access turned on in the running app, a device paired, and each screen
// opened in WebKit with an iPhone's screen (iOS) or Edge with a Pixel's (Android), as a person taps to it.
// WebKit has no long-frame reports, so a screen's cost is its frame gaps while it's drawn, and what it holds after.
import { webkit, chromium, devices } from 'playwright-core';
import * as path from 'node:path';
import { ROOT, shoot, sleep } from './lib.mjs';

const DEVICE = { ios: devices['iPhone 15'], android: devices['Pixel 7'] };

/** Frame gaps from the tap until 1 s passes without one over 25 ms. */
async function frames(page, action) {
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const tick = (t) => {
      window.__gaps.push(t - last);
      last = t;
      if (window.__gaps) requestAnimationFrame(tick);
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
    if (quiet >= 1000 || Date.now() - t0 > 15_000) break;
  }
  return page.evaluate(() => {
    const g = window.__gaps.slice(1);
    window.__gaps = null;
    return { worstFrameMs: Math.round(Math.max(0, ...g)) };
  });
}

/** Tap the first visible element with exactly this text (or matching this pattern), in the page or any of its windows' frames. */
async function tap(page, text) {
  for (let i = 0; i < 20; i++) {
    for (const f of page.frames()) {
      const el = f.getByText(text, { exact: typeof text === 'string' }).first();
      if (await el.isVisible().catch(() => false)) return el.click({ timeout: 5000 });
    }
    await sleep(250);
  }
  throw new Error(`nothing shows "${text}"`);
}

/** A tab of the main window's tab bar, which is inside the main window's frame. */
async function tab(page, label, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    for (const f of page.frames()) {
      const el = f.locator('button.phone-tab', { hasText: label }).first();
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
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const n = await nodeCount(page);
    if (n === last) return n;
    last = n;
  }
  return last;
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
    const browser = os === 'ios' ? await webkit.launch() : await chromium.launch({ channel: 'msedge' });
    try {
      const context = await browser.newContext({ ...DEVICE[os] });
      const phone = await context.newPage();
      const errors = [];
      phone.on('pageerror', (e) => errors.push(e.message));
      const { code } = await page.evaluate(() => window.looper.remoteAccess.pairingCode());
      await phone.goto(url);
      const paired = await phone.evaluate(
        async (c) => (await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Looper-Request': '1' }, body: JSON.stringify({ code: c, name: 'Perf phone' }) })).ok,
        code,
      );
      if (!paired) {
        broken.push(`${os}: pairing failed`);
        continue;
      }
      const t0 = Date.now();
      await phone.goto(url);
      // The shell is up once its tab bar is.
      const up = await tab(phone, 'Dashboard', 30_000).then(() => true, () => false);
      if (!up) {
        broken.push(`${os}: the shell didn't show its tabs`);
        continue;
      }
      // What the start shows depends on the windows it restores, so only its time is measured.
      measured[`${os}: start`] = { readyMs: Date.now() - t0 };
      for (const s of screens) {
        const name = `${os}: ${s.name}`;
        if (!wanted(name)) continue;
        if (s.tab !== 'Dashboard') await (await tab(phone, 'Dashboard')).click().catch(() => undefined);
        await sleep(500);
        errors.length = 0;
        const step = await frames(phone, async () => {
          await (await tab(phone, s.tab)).click({ timeout: 5000 });
          // A tab keeps the screens pushed on it; tapping it again goes back to its root, as on a phone.
          if (s.taps?.length) {
            await sleep(300);
            await (await tab(phone, s.tab)).click({ timeout: 5000 });
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
        if (!step) continue;
        if (errors.length) broken.push(`${name}: ${errors[0].slice(0, 200)}`);
        measured[name] = { ...step, nodes: await settledCount(phone) };
        await shoot(phone, name);
      }
    } catch (e) {
      broken.push(`${os}: ${e.message.split('\n')[0]}`);
    } finally {
      await browser.close();
    }
  }
  return { measured, broken };
}
