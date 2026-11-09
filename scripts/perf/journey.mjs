// A day's use of the main window, measured step by step: startup, chats, the tabs, scrolling a long chat, typing,
// opening the Engine Log, and the memory after startup and after use. `record(name, value)` gets each measurement.
import * as path from 'node:path';
import { sleep, launch, quit, watch, loadCost, typing, memory, profiled, ROOT } from './lib.mjs';

export async function journey(chats, record) {
  const t0 = Date.now();
  const { app, page } = await launch();
  const startup = await watch(page, async () => {}, { quietMs: 2000, maxMs: 30_000 });
  // From the process starting: when the main window's page began loading, and when it first painted content.
  const created = await app.evaluate(() => process.getCreationTime());
  const paint = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
  }));
  record('startup', { windowAtMs: Math.round(paint.origin - created), contentAtMs: Math.round(paint.origin + paint.fcp - created), wallMs: Date.now() - t0, ...startup });
  record('memory after startup', await memory(app));
  // As the main process selects a chat (a notification, Compact): the Chats tab with that chat, '' for its dashboard of live cards.
  const select = (id) =>
    app.evaluate(({ BrowserWindow }, x) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'));
      main?.webContents.send('ui:event', { type: 'sessions-select', id: x });
    }, id);
  // BENCH_QUICK=1: only startup and the memory with the long chat open, to compare switches.
  // What the app hands back once no window of it has had the focus for a minute (main/memory-trim.ts), sent as it sends it.
  const away = async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: 'critical' });
      wc.debugger.detach();
    });
    await sleep(3000);
    record('memory when away', await memory(app));
  };
  if (process.env.BENCH_QUICK) {
    await select(chats[0]);
    await sleep(4000);
    record('memory after use', await memory(app));
    await away();
    await quit(app);
    return;
  }
  record('chats tab', await watch(page, () => select('')));
  for (const [label, id] of [
    ['open long chat', chats[0]],
    ['switch to another chat', chats[1]],
    ['switch back to the long chat', chats[0]],
    ['back to the chats dashboard', ''],
  ]) {
    const step = await profiled(page, label, () => watch(page, () => select(id)));
    // A chat opens at its newest message: how far from the end it ended up (0 is right).
    const toEnd = id ? await page.evaluate(() => {
      const s = document.querySelector('.chat-scroll');
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1;
    }) : undefined;
    record(label, { ...step, ...(toEnd === undefined ? {} : { toEnd }) });
    // BENCH_SHOT: a screenshot after each step, to see that it did what its label says.
    if (process.env.BENCH_SHOT) await page.screenshot({ path: path.join(ROOT, `${label.replace(/\W+/g, '-')}.png`) });
  }
  // Down the chats dashboard: the cards out of view are drawn as they scroll in.
  const dash = await page.$('.sessions-dashboard');
  const box = await dash?.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  record(
    'scroll the chats dashboard',
    await profiled(page, 'scroll the chats dashboard', () =>
      watch(page, async () => {
        for (let i = 0; i < 30; i++) {
          await page.mouse.wheel(0, 300);
          await sleep(16);
        }
      }),
    ),
  );
  // The main window's tabs, clicked in the tab rail as a person would.
  for (const tab of ['Dashboard', 'Projects', 'Tasks', 'Chats']) {
    const label = `${tab} tab`;
    // By the tab's class: a text selector walks every text node of the page, and its time showed up as the app's.
    record(label, await profiled(page, label, () => watch(page, () => page.click(`.view-tab:has-text("${tab}")`))));
    if (process.env.BENCH_SHOT) await page.screenshot({ path: path.join(ROOT, `${tab}.png`) });
  }
  await select(chats[0]);
  await sleep(1500);
  await page.click('.chat-scroll');
  record(
    'scroll up the long chat',
    await profiled(page, 'scroll up the long chat', () =>
      watch(page, async () => {
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, -600);
          await sleep(16);
        }
      }),
    ),
  );
  await page.click('textarea');
  // BENCH_BEFORE_TYPING: a script run in the main window first, to try a change to the message box.
  if (process.env.BENCH_BEFORE_TYPING) await page.evaluate(process.env.BENCH_BEFORE_TYPING);
  record('typing in the message box', await profiled(page, 'typing in the message box', () => typing(page, 'check the sync script for the starter package and tell me')));
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  const before = app.windows().length;
  const opened = watch(page, () => page.evaluate(() => window.looper.commands.host('engine-log')));
  let log = null;
  for (let i = 0; i < 100 && !log; i++) {
    await sleep(100);
    log = app.windows().length > before ? app.windows().find((w) => w.url().includes('engine-log')) : null;
  }
  await opened;
  if (log) record('engine log window', await loadCost(log));
  await sleep(3000);
  record('memory after use', await memory(app));
  await away();
  await quit(app);
}
