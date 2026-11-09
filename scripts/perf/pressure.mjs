// Whether Chromium's memory-pressure signal frees what hiding a window did (30-40 MB of the GPU process's
// committed memory), and what the next interaction costs after it. In the Windows copy, after a build.
import { launch, quit, sleep, seeded, memory, watch } from './lib.mjs';

const chats = await seeded();
const { app, page } = await launch();
await sleep(6000);
const select = (id) =>
  app.evaluate(({ BrowserWindow }, x) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'));
    main?.webContents.send('ui:event', { type: 'sessions-select', id: x });
  }, id);
await select(chats[0]);
await sleep(3000);
const show = (label, m) => console.log(label.padEnd(22), JSON.stringify({ taskManagerMb: m.taskManagerMb, privateMb: m.privateMb, ...m.byType }));
show('before', await memory(app));
for (const level of ['moderate', 'critical']) {
  // From the main process, as Looper would send it: through the main window's debugger, then detached.
  await app.evaluate(async ({ BrowserWindow }, lv) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: lv });
    wc.debugger.detach();
  }, level);
  await sleep(3000);
  show(`after ${level}`, await memory(app));
}
const step = await watch(page, () => select(chats[1]));
console.log('next chat switch', JSON.stringify(step));
await sleep(2000);
show('after the switch', await memory(app));
await quit(app);
